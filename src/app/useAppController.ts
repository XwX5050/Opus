import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentPort } from "../document/DocumentPort";
import { DocumentPortError } from "../document/DocumentPort";
import {
  documentReducer,
  initialDocumentState,
  type DocumentAction,
} from "../document/documentReducer";
import type { OpenedFile } from "../document/types";
import type { OpenPathSubscriptions } from "../document/tauriDocumentPort";

export type EventSubscriber = (
  port: DocumentPort,
  onFiles: (files: ReadonlyArray<OpenedFile>) => void,
  onDirectory?: (path: string) => void,
  onError?: (error: DocumentPortError) => void,
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
  const [closeDocumentId, setCloseDocumentId] = useState<string | null>(null);
  const [closeSaving, setCloseSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dispatch = useCallback((action: DocumentAction) => {
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

  const addOpenedFiles = useCallback((files: ReadonlyArray<OpenedFile>) => {
    for (const openedFile of files) {
      dispatch({ type: "fileOpened", id: nextId(), file: openedFile });
    }
  }, [dispatch, nextId]);

  const openFiles = useCallback(async () => {
    setError(null);
    try {
      addOpenedFiles(await port.chooseAndOpenFiles());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [addOpenedFiles, port]);

  const openPath = useCallback(async (path: string) => {
    setError(null);
    try {
      addOpenedFiles([await port.openPath(path)]);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [addOpenedFiles, port]);

  const newDocument = useCallback(() => {
    dispatch({ type: "newDocument", id: nextId() });
  }, [dispatch, nextId]);

  const performSave = useCallback(async (
    id: string | null,
    chooseTarget: boolean,
  ): Promise<boolean> => {
    if (!id || savingIds.current.has(id)) return false;
    const before = stateRef.current.tabs.find((tab) => tab.id === id);
    if (!before || before.pendingSave) return false;
    savingIds.current.add(id);
    setError(null);
    try {
      let target;
      if (chooseTarget || before.path === null) {
        target = await port.chooseSavePath(before.title);
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
        const completed = dispatch({
          type: "saveSucceeded",
          requestId: pending.requestId,
          result,
        });
        return completed.tabs.some(
          (tab) => tab.id === id && !tab.pendingSave && tab.status !== "conflict",
        );
      } catch (caught) {
        const failure = caught instanceof DocumentPortError
          ? caught
          : new DocumentPortError("io", errorMessage(caught), { cause: caught });
        dispatch({ type: "saveFailed", requestId: pending.requestId, error: failure });
        setError(failure.message);
        return false;
      }
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      savingIds.current.delete(id);
    }
  }, [dispatch, port]);

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
    dispatch({ type: "closeConfirmed", id, disposition: "saved" });
  }, [dispatch]);

  const confirmClose = useCallback(async (choice: CloseChoice) => {
    const id = closeDocumentId;
    if (!id) return;
    if (choice === "cancel") {
      if (closeSaving) return;
      setCloseDocumentId(null);
      return;
    }
    if (choice === "discard") {
      if (closeSaving) return;
      setCloseDocumentId(null);
      dispatch({ type: "closeConfirmed", id, disposition: "discarded" });
      return;
    }
    if (closeSaving) return;
    setCloseSaving(true);
    try {
      const saved = await save(id);
      const document = stateRef.current.tabs.find((tab) => tab.id === id);
      if (saved && document?.status === "clean" && !document.pendingSave) {
        dispatch({ type: "closeConfirmed", id, disposition: "saved" });
        setCloseDocumentId(null);
      }
    } finally {
      setCloseSaving(false);
    }
  }, [closeDocumentId, closeSaving, dispatch, save]);

  const reopenClosed = useCallback(() => {
    dispatch({ type: "reopenLastClosed" });
  }, [dispatch]);

  useEffect(() => {
    if (!subscribeToEvents) return;
    let disposed = false;
    let subscription: OpenPathSubscriptions | null = null;
    void subscribeToEvents(
      port,
      addOpenedFiles,
      undefined,
      (eventError) => setError(eventError.message),
    ).then(async (created) => {
      subscription = created;
      if (disposed) await created.dispose();
      else await created.ready();
    }).catch((caught) => {
      if (!disposed) setError(errorMessage(caught));
    });
    return () => {
      disposed = true;
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
