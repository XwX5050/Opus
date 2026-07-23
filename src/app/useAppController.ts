import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentPort } from "../document/DocumentPort";
import { DocumentPortError } from "../document/DocumentPort";
import {
  documentReducer,
  initialDocumentState,
  type DocumentAction,
} from "../document/documentReducer";
import type { DocumentSnapshot, OpenedFile } from "../document/types";
import type { OpenPathSubscriptions } from "../document/tauriDocumentPort";

export type EventSubscriber = (
  port: DocumentPort,
  onFiles: (files: ReadonlyArray<OpenedFile>) => void,
  onDirectory?: (path: string) => void,
  onError?: (error: DocumentPortError) => void,
  signal?: AbortSignal,
) => Promise<OpenPathSubscriptions>;

export type CloseChoice = "save" | "discard" | "cancel";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function useAppController(
  port: DocumentPort,
  subscribeToEvents: EventSubscriber | null = null,
) {
  const [state, setState] = useState(initialDocumentState);
  const stateRef = useRef(state);
  const idSequence = useRef(0);
  const savingIds = useRef(new Set<string>());
  const closeSavingRef = useRef(false);
  const closeOperationSequence = useRef(0);
  const mountedRef = useRef(true);
  const lifecycleGenerationRef = useRef(0);
  const [closeDocumentId, setCloseDocumentId] = useState<string | null>(null);
  const [closeSaving, setCloseSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable consumer IDs (tab IDs) that currently hold an asset scope.
  const acquiredScopeIds = useRef(new Set<string>());
  // Per-consumer promise chain serializing backend scope operations, so a
  // release (or a re-acquire after close→reopen with the same tab ID) can
  // never overtake a still-pending acquire and leak a registry reference.
  const scopeOperationChains = useRef(new Map<string, Promise<void>>());

  useEffect(() => {
    mountedRef.current = true;
    lifecycleGenerationRef.current += 1;
    return () => {
      mountedRef.current = false;
      lifecycleGenerationRef.current += 1;
    };
  }, []);

  const isCurrent = useCallback((generation: number) =>
    mountedRef.current && lifecycleGenerationRef.current === generation, []);

  const dispatch = useCallback((action: DocumentAction) => {
    if (!mountedRef.current) return stateRef.current;
    const next = documentReducer(stateRef.current, action);
    stateRef.current = next;
    setState(next);
    return next;
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const nextId = useCallback(() => {
    idSequence.current += 1;
    return `document-${idSequence.current}`;
  }, []);

  const enqueueScopeOperation = useCallback((id: string, operation: () => Promise<void>) => {
    const previous = scopeOperationChains.current.get(id) ?? Promise.resolve();
    const next = previous.then(operation).catch(() => {
      // Individual operations handle their own errors; the chain must not break.
    });
    scopeOperationChains.current.set(id, next);
    void next.then(() => {
      if (scopeOperationChains.current.get(id) === next) {
        scopeOperationChains.current.delete(id);
      }
    });
  }, []);

  const acquireDocumentScope = useCallback((tab: DocumentSnapshot) => {
    if (tab.path === null || acquiredScopeIds.current.has(tab.id)) return;
    const path = tab.path;
    acquiredScopeIds.current.add(tab.id);
    enqueueScopeOperation(tab.id, async () => {
      try {
        await port.acquireDocumentScope(tab.id, path);
      } catch {
        acquiredScopeIds.current.delete(tab.id);
      }
    });
  }, [enqueueScopeOperation, port]);

  const releaseDocumentScope = useCallback((id: string) => {
    if (!acquiredScopeIds.current.delete(id)) return;
    enqueueScopeOperation(id, async () => {
      try {
        await port.releaseAssetScope(id);
      } catch {
        // Scope release is best-effort; the registry is ref-counted per consumer.
      }
    });
  }, [enqueueScopeOperation, port]);

  const addOpenedFiles = useCallback((files: ReadonlyArray<OpenedFile>) => {
    for (const openedFile of files) {
      const id = nextId();
      const before = stateRef.current;
      const next = dispatch({ type: "fileOpened", id, file: openedFile });
      // Only a genuinely new tab acquires a scope; duplicate-path opens just
      // focus the existing tab and must not leak a reference.
      const added = next.tabs.find(
        (tab) => tab.id === id && !before.tabs.some((tab) => tab.id === id),
      );
      if (added) acquireDocumentScope(added);
    }
  }, [acquireDocumentScope, dispatch, nextId]);

  const openFiles = useCallback(async () => {
    const generation = lifecycleGenerationRef.current;
    setError(null);
    try {
      const files = await port.chooseAndOpenFiles();
      if (isCurrent(generation)) addOpenedFiles(files);
    } catch (caught) {
      if (isCurrent(generation)) setError(errorMessage(caught));
    }
  }, [addOpenedFiles, isCurrent, port]);

  const openPath = useCallback(async (path: string) => {
    const generation = lifecycleGenerationRef.current;
    setError(null);
    try {
      const file = await port.openPath(path);
      if (isCurrent(generation)) addOpenedFiles([file]);
    } catch (caught) {
      if (isCurrent(generation)) setError(errorMessage(caught));
    }
  }, [addOpenedFiles, isCurrent, port]);

  const newDocument = useCallback(() => {
    dispatch({ type: "newDocument", id: nextId() });
  }, [dispatch, nextId]);

  const performSave = useCallback(async (
    id: string | null,
    chooseTarget: boolean,
  ): Promise<boolean> => {
    const generation = lifecycleGenerationRef.current;
    if (!id || savingIds.current.has(id)) return false;
    const before = stateRef.current.tabs.find((tab) => tab.id === id);
    if (!before || before.pendingSave) return false;
    savingIds.current.add(id);
    setError(null);
    try {
      let target;
      if (chooseTarget || before.path === null) {
        target = await port.chooseSavePath(before.title);
        if (!isCurrent(generation)) return false;
        if (!target) return false;
      }

      const latest = stateRef.current.tabs.find((tab) => tab.id === id);
      if (!latest || latest.pendingSave) return false;
      const requested = dispatch({
        type: "saveRequested",
        id,
        ...(target ? { target } : {}),
      });
      const pending = requested.tabs.find((tab) => tab.id === id)?.pendingSave;
      if (!pending) {
        setError("保存目标与已打开的文档冲突");
        return false;
      }

      try {
        const result = await port.write(pending);
        if (!isCurrent(generation)) return false;
        const completed = dispatch({
          type: "saveSucceeded",
          requestId: pending.requestId,
          result,
        });
        const succeeded = completed.tabs.some(
          (tab) => tab.id === id && !tab.pendingSave && tab.status !== "conflict",
        );
        if (!succeeded) {
          const failure = new DocumentPortError(
            "conflict",
            "保存完成时检测到目标路径冲突，文件仍处于未保存状态",
          );
          setError(failure.message);
        }
        return succeeded;
      } catch (caught) {
        const failure = caught instanceof DocumentPortError
          ? caught
          : new DocumentPortError("io", errorMessage(caught), { cause: caught });
        if (isCurrent(generation)) {
          dispatch({ type: "saveFailed", requestId: pending.requestId, error: failure });
          setError(failure.message);
        }
        return false;
      }
    } catch (caught) {
      if (isCurrent(generation)) setError(errorMessage(caught));
      return false;
    } finally {
      savingIds.current.delete(id);
    }
  }, [dispatch, isCurrent, port]);

  const save = useCallback(
    (id = stateRef.current.activeId) => performSave(id, false),
    [performSave],
  );

  const saveAs = useCallback(
    (id = stateRef.current.activeId) => performSave(id, true),
    [performSave],
  );

  const close = useCallback((id: string) => {
    const document = stateRef.current.tabs.find((tab) => tab.id === id);
    if (!document || document.pendingSave) return;
    if (document.status === "dirty" || document.status === "conflict" || document.status === "missing") {
      setCloseDocumentId(id);
      return;
    }
    const next = dispatch({ type: "closeConfirmed", id, disposition: "saved" });
    if (!next.tabs.some((tab) => tab.id === id)) releaseDocumentScope(id);
  }, [dispatch, releaseDocumentScope]);

  const confirmClose = useCallback(async (choice: CloseChoice) => {
    const id = closeDocumentId;
    if (!id || closeSavingRef.current) return;
    if (choice === "cancel") {
      setCloseDocumentId(null);
      return;
    }
    if (choice === "discard") {
      setCloseDocumentId(null);
      const next = dispatch({ type: "closeConfirmed", id, disposition: "discarded" });
      if (!next.tabs.some((tab) => tab.id === id)) releaseDocumentScope(id);
      return;
    }
    const generation = lifecycleGenerationRef.current;
    const operationToken = closeOperationSequence.current + 1;
    closeOperationSequence.current = operationToken;
    closeSavingRef.current = true;
    setCloseSaving(true);
    try {
      const saved = await save(id);
      if (!isCurrent(generation)) return;
      const document = stateRef.current.tabs.find((tab) => tab.id === id);
      if (saved && document?.status === "clean" && !document.pendingSave) {
        const next = dispatch({ type: "closeConfirmed", id, disposition: "saved" });
        if (!next.tabs.some((tab) => tab.id === id)) releaseDocumentScope(id);
        setCloseDocumentId(null);
      }
    } finally {
      if (closeOperationSequence.current === operationToken) {
        closeSavingRef.current = false;
        if (isCurrent(generation)) setCloseSaving(false);
      }
    }
  }, [closeDocumentId, dispatch, isCurrent, releaseDocumentScope, save]);

  const reopenClosed = useCallback(() => {
    const reopeningId = stateRef.current.recentlyClosed[0]?.document.id;
    const before = stateRef.current;
    const next = dispatch({ type: "reopenLastClosed" });
    if (!reopeningId) return;
    const added = next.tabs.find(
      (tab) =>
        tab.id === reopeningId &&
        !before.tabs.some((tab) => tab.id === reopeningId),
    );
    if (added) acquireDocumentScope(added);
  }, [acquireDocumentScope, dispatch]);

  // Release every still-held scope when the controller unmounts, keeping the
  // same acquire-then-release serialization as tab closes.
  useEffect(() => {
    const acquired = acquiredScopeIds.current;
    return () => {
      for (const id of [...acquired]) releaseDocumentScope(id);
    };
  }, [releaseDocumentScope]);

  useEffect(() => {
    if (!subscribeToEvents) return;
    const abortController = new AbortController();
    let disposed = false;
    let subscription: OpenPathSubscriptions | null = null;
    void subscribeToEvents(
      port,
      (files) => { if (!abortController.signal.aborted) addOpenedFiles(files); },
      undefined,
      (eventError) => { if (!abortController.signal.aborted) setError(eventError.message); },
      abortController.signal,
    ).then(async (created) => {
      subscription = created;
      if (disposed || abortController.signal.aborted) await created.dispose();
      else await created.ready();
    }).catch((caught) => {
      if (!disposed) setError(errorMessage(caught));
    });
    return () => {
      disposed = true;
      abortController.abort();
      if (subscription) void subscription.dispose();
    };
  }, [addOpenedFiles, port, subscribeToEvents]);

  return {
    state,
    closeDocumentId,
    closeSaving,
    error,
    newDocument,
    openFiles,
    openPath,
    activate: (id: string) => dispatch({ type: "activate", id }),
    changeText: (id: string, text: string) => dispatch({ type: "textChanged", id, text }),
    save,
    saveAs,
    close,
    confirmClose,
    reopenClosed,
  };
}
