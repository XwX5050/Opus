import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentPort, WorkspaceRoot } from "../document/DocumentPort";
import { DocumentPortError } from "../document/DocumentPort";
import {
  documentReducer,
  initialDocumentState,
  normalizePathKey,
  type DocumentAction,
} from "../document/documentReducer";
import {
  DEFAULT_SIDEBAR_PREFERENCES,
  normalizeSidebarPreferences,
  type DiskEvent,
  type DocumentSnapshot,
  type DocumentState,
  type OpenedFile,
  type PersistedSession,
  type RecentItem,
  type RecoveryDraftInfo,
  type SidebarPreferences,
} from "../document/types";
import {
  draftFromSnapshot,
  draftIdForTab,
  needsRecoveryDraft,
} from "../recovery/drafts";
import {
  clampEditorPreferences,
  normalizeEditorPreferences,
  normalizeThemePreference,
  DEFAULT_EDITOR_PREFERENCES,
  DEFAULT_THEME_PREFERENCE,
  type EditorPreferences,
  type ThemePreference,
} from "../theme/preferences";
import type { OpenPathSubscriptions } from "../document/tauriDocumentPort";

export type EventSubscriber = (
  port: DocumentPort,
  onFiles: (files: ReadonlyArray<OpenedFile>) => void,
  onDirectory?: (path: string) => void,
  onError?: (error: DocumentPortError) => void,
  signal?: AbortSignal,
) => Promise<OpenPathSubscriptions>;

export type CloseChoice = "save" | "discard" | "cancel";

export interface SaveFailure {
  readonly id: string;
  readonly message: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Disk-event paths are canonical; tab paths are user-supplied. */
const findTabByPath = (
  state: DocumentState,
  path: string,
): DocumentSnapshot | undefined => {
  const key = normalizePathKey(path);
  return state.tabs.find(
    (tab) => tab.path !== null && normalizePathKey(tab.path) === key,
  );
};

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
  const [saveError, setSaveError] = useState<SaveFailure | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceRoot | null>(null);
  const [recent, setRecent] = useState<ReadonlyArray<RecentItem>>([]);
  const [theme, setThemeState] =
    useState<ThemePreference>(DEFAULT_THEME_PREFERENCE);
  const [editorPreferences, setEditorPreferencesState] =
    useState<EditorPreferences>(DEFAULT_EDITOR_PREFERENCES);
  const [sidebarPreferences, setSidebarPreferences] =
    useState<SidebarPreferences>(DEFAULT_SIDEBAR_PREFERENCES);
  const [recoveryDrafts, setRecoveryDrafts] =
    useState<ReadonlyArray<RecoveryDraftInfo> | null>(null);
  const workspacePathRef = useRef<string | null>(null);
  // Stable consumer IDs (tab IDs) that currently hold an asset scope.
  const acquiredScopeIds = useRef(new Set<string>());
  // Stable consumer IDs (tab IDs, `workspace:<path>`) that hold a disk watch.
  const watchedIds = useRef(new Set<string>());
  // Per-tab debounce timers for recovery drafts, the tab IDs whose draft is
  // known to be persisted (so it must be discarded once the tab is clean),
  // and each tab's last-scheduled draft signature (status + text) so an
  // unrelated state change never resets a tab's debounce. Signatures hold
  // the status and text by reference: strings are immutable, so identity
  // comparison detects changes without copying multi-megabyte documents.
  const draftTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const persistedDraftIds = useRef(new Set<string>());
  const draftSignatures = useRef(
    new Map<string, { status: DocumentSnapshot["status"]; text: string }>(),
  );
  // Session saves are suppressed until the persisted session has been loaded,
  // so a slow load can never be overwritten by the empty launch state.
  const sessionLoadedRef = useRef(false);
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

  // Disk watches follow the same consumer discipline as asset scopes: one
  // watch per tab id (or `workspace:<path>`), acquired on genuine opens,
  // released through releaseScope. Watching is best-effort — a watch failure
  // must never roll back the asset scope or block editing.
  const watchConsumer = useCallback((
    id: string,
    target: string,
    kind: "document" | "workspace",
  ) => {
    if (watchedIds.current.has(id)) return;
    watchedIds.current.add(id);
    enqueueScopeOperation(id, async () => {
      try {
        if (kind === "workspace") await port.watchWorkspace(id, target);
        else await port.watchDocument(id, target);
      } catch {
        watchedIds.current.delete(id);
      }
    });
  }, [enqueueScopeOperation, port]);

  const releaseScope = useCallback((id: string) => {
    const hadScope = acquiredScopeIds.current.delete(id);
    const hadWatch = watchedIds.current.delete(id);
    if (!hadScope && !hadWatch) return;
    // The scope release is enqueued first so cross-consumer ordering of
    // acquire/release matches the pre-watch behavior.
    if (hadScope) {
      enqueueScopeOperation(id, async () => {
        try {
          await port.releaseAssetScope(id);
        } catch {
          // Scope release is best-effort; the registry is ref-counted per consumer.
        }
      });
    }
    if (hadWatch) {
      enqueueScopeOperation(id, async () => {
        try {
          await port.unwatch(id);
        } catch {
          // Watch release is best-effort; the backend refcounts per consumer.
        }
      });
    }
  }, [enqueueScopeOperation, port]);

  const rememberRecent = useCallback((item: RecentItem) => {
    setRecent((current) => [
      item,
      ...current.filter(
        (entry) => normalizePathKey(entry.path) !== normalizePathKey(item.path),
      ),
    ].slice(0, 10));
  }, []);

  // Live UI edits clamp to the nearest valid value; stored data is repaired
  // to defaults at load time instead (see theme/preferences).
  const setTheme = useCallback(
    (value: ThemePreference) => setThemeState(normalizeThemePreference(value)),
    [],
  );
  const setEditorPreferences = useCallback(
    (value: EditorPreferences) =>
      setEditorPreferencesState(clampEditorPreferences(value)),
    [],
  );

  const addOpenedFiles = useCallback((
    files: ReadonlyArray<OpenedFile>,
    options: { trackRecent?: boolean } = {},
  ) => {
    const trackRecent = options.trackRecent ?? true;
    for (const openedFile of files) {
      const id = nextId();
      const before = stateRef.current;
      const next = dispatch({ type: "fileOpened", id, file: openedFile });
      // Only a genuinely new tab acquires a scope; duplicate-path opens just
      // focus the existing tab and must not leak a reference.
      const added = next.tabs.find(
        (tab) => tab.id === id && !before.tabs.some((tab) => tab.id === id),
      );
      if (added) {
        acquireDocumentScope(added);
        if (added.path) watchConsumer(added.id, added.path, "document");
      }
      if (trackRecent) rememberRecent({ path: openedFile.path, kind: "file" });
    }
  }, [acquireDocumentScope, dispatch, nextId, rememberRecent, watchConsumer]);

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
        } else {
          // A save that landed at a new path (save-as, first save of an
          // untitled document) must move the scope and watch to the new
          // location. Release old then acquire new under the same stable tab
          // id, serialized through the per-consumer chain so refcounts stay
          // balanced.
          const savedTab = completed.tabs.find((tab) => tab.id === id);
          const oldPath = latest.path;
          const newPath = savedTab?.path ?? null;
          const retargeted =
            savedTab !== undefined &&
            newPath !== null &&
            (oldPath === null ||
              normalizePathKey(oldPath, pending.pathPlatform) !==
                normalizePathKey(newPath, pending.pathPlatform));
          if (retargeted) {
            releaseScope(id);
            acquireDocumentScope(savedTab);
            watchConsumer(id, newPath, "document");
          }
        }
        return succeeded;
      } catch (caught) {
        const failure = caught instanceof DocumentPortError
          ? caught
          : new DocumentPortError("io", errorMessage(caught), { cause: caught });
        if (isCurrent(generation)) {
          dispatch({ type: "saveFailed", requestId: pending.requestId, error: failure });
          // A failed close-save keeps the close dialog alive and reports
          // through the inline alert; a standalone save failure surfaces the
          // retry / save-as dialog instead.
          if (closeSavingRef.current) setError(failure.message);
          else setSaveError({ id, message: failure.message });
        }
        return false;
      }
    } catch (caught) {
      if (isCurrent(generation)) setError(errorMessage(caught));
      return false;
    } finally {
      savingIds.current.delete(id);
    }
  }, [acquireDocumentScope, dispatch, isCurrent, port, releaseScope, watchConsumer]);

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
    if (!next.tabs.some((tab) => tab.id === id)) releaseScope(id);
  }, [dispatch, releaseScope]);

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
      if (!next.tabs.some((tab) => tab.id === id)) releaseScope(id);
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
        if (!next.tabs.some((tab) => tab.id === id)) releaseScope(id);
        setCloseDocumentId(null);
      }
    } finally {
      if (closeOperationSequence.current === operationToken) {
        closeSavingRef.current = false;
        if (isCurrent(generation)) setCloseSaving(false);
      }
    }
  }, [closeDocumentId, dispatch, isCurrent, releaseScope, save]);

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
    if (added) {
      acquireDocumentScope(added);
      if (added.path) watchConsumer(added.id, added.path, "document");
    }
  }, [acquireDocumentScope, dispatch, watchConsumer]);

  // Release every still-held scope and watch when the controller unmounts,
  // keeping the same acquire-then-release serialization as tab closes.
  useEffect(() => {
    const acquired = acquiredScopeIds.current;
    const watched = watchedIds.current;
    return () => {
      for (const id of new Set([...acquired, ...watched])) releaseScope(id);
    };
  }, [releaseScope]);

  // Workspace scopes use a stable `workspace:<path>` consumer ID, distinct
  // from the tab ID scheme, and follow the same discipline as tabs: acquire
  // only for a genuinely new workspace, serialize operations per consumer.
  const acquireWorkspaceScope = useCallback((root: WorkspaceRoot) => {
    const consumerId = `workspace:${root.path}`;
    if (acquiredScopeIds.current.has(consumerId)) return;
    acquiredScopeIds.current.add(consumerId);
    enqueueScopeOperation(consumerId, async () => {
      try {
        await port.acquireWorkspaceScope(consumerId, root.path);
      } catch {
        acquiredScopeIds.current.delete(consumerId);
      }
    });
  }, [enqueueScopeOperation, port]);

  const openWorkspaceRoot = useCallback((root: WorkspaceRoot) => {
    if (workspacePathRef.current === root.path) return;
    const previous = workspacePathRef.current;
    workspacePathRef.current = root.path;
    if (previous) releaseScope(`workspace:${previous}`);
    if (mountedRef.current) setWorkspace(root);
    acquireWorkspaceScope(root);
    watchConsumer(`workspace:${root.path}`, root.path, "workspace");
    rememberRecent({ path: root.path, kind: "folder" });
  }, [acquireWorkspaceScope, releaseScope, rememberRecent, watchConsumer]);

  const openWorkspace = useCallback(async () => {
    const generation = lifecycleGenerationRef.current;
    setError(null);
    try {
      const root = await port.chooseWorkspace();
      if (root && isCurrent(generation)) openWorkspaceRoot(root);
    } catch (caught) {
      if (isCurrent(generation)) setError(errorMessage(caught));
    }
  }, [isCurrent, openWorkspaceRoot, port]);

  const openWorkspacePath = useCallback(async (path: string) => {
    const generation = lifecycleGenerationRef.current;
    setError(null);
    try {
      const root = await port.openWorkspacePath(path);
      if (isCurrent(generation)) openWorkspaceRoot(root);
    } catch (caught) {
      if (isCurrent(generation)) setError(errorMessage(caught));
    }
  }, [isCurrent, openWorkspaceRoot, port]);

  const closeWorkspace = useCallback(() => {
    const previous = workspacePathRef.current;
    if (!previous) return;
    workspacePathRef.current = null;
    setWorkspace(null);
    releaseScope(`workspace:${previous}`);
  }, [releaseScope]);

  useEffect(() => {
    if (!subscribeToEvents) return;
    const abortController = new AbortController();
    let disposed = false;
    let subscription: OpenPathSubscriptions | null = null;
    void subscribeToEvents(
      port,
      (files) => { if (!abortController.signal.aborted) addOpenedFiles(files); },
      (path) => { if (!abortController.signal.aborted) void openWorkspacePath(path); },
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
  }, [addOpenedFiles, openWorkspacePath, port, subscribeToEvents]);

  const reloadFromDisk = useCallback(async (id: string) => {
    const tab = stateRef.current.tabs.find((candidate) => candidate.id === id);
    if (!tab?.path) return;
    const generation = lifecycleGenerationRef.current;
    try {
      const fresh = await port.openPath(tab.path);
      // The reducer decides atomically: still-clean tabs reload, anything
      // else becomes a conflict without losing local text.
      if (isCurrent(generation)) dispatch({ type: "externalChanged", id, file: fresh });
    } catch (caught) {
      if (!isCurrent(generation)) return;
      if (caught instanceof DocumentPortError && caught.code === "not_found") {
        dispatch({ type: "externalMissing", id });
      }
    }
  }, [dispatch, isCurrent, port]);

  const handleDiskEvent = useCallback((event: DiskEvent) => {
    if (event.kind === "moved") {
      const tab = findTabByPath(stateRef.current, event.from);
      // Dirty/conflicted tabs keep their path (and watch) so the user's
      // buffer stays saveable at the location it was opened from.
      if (!tab || tab.status !== "clean" || tab.pendingSave) return;
      const next = dispatch({ type: "externalMoved", from: event.from, to: event.to });
      const moved = next.tabs.find((candidate) => candidate.id === tab.id);
      if (moved && moved.path !== null && moved.path !== tab.path) {
        if (watchedIds.current.delete(moved.id)) {
          enqueueScopeOperation(moved.id, async () => {
            try {
              await port.unwatch(moved.id);
            } catch {
              // Watch release is best-effort.
            }
          });
        }
        watchConsumer(moved.id, moved.path, "document");
      }
      return;
    }

    const tab = findTabByPath(stateRef.current, event.path);
    // Events while a save is in flight are suppressed: the write itself is
    // version-checked, and a reload here could clobber the pending snapshot.
    if (!tab || tab.pendingSave) return;
    if (event.kind === "missing") {
      dispatch({ type: "externalMissing", id: tab.id });
      return;
    }
    // Echoes of our own completed saves carry the version we just wrote.
    if (tab.version !== null && tab.version === event.version) return;
    void reloadFromDisk(tab.id);
  }, [dispatch, enqueueScopeOperation, port, reloadFromDisk, watchConsumer]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void port.subscribeToDiskEvents((event) => {
      if (!disposed) handleDiskEvent(event);
    }).then((created) => {
      if (disposed) created();
      else unsubscribe = created;
    }).catch(() => {
      // Watching is best-effort; the app works without disk events.
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [handleDiskEvent, port]);

  // Recovery drafts: while a tab holds content that closing would lose, a
  // snapshot is persisted 2 seconds after the last change; once the tab is
  // clean or closed, its draft is discarded. Each tab's debounce is keyed by
  // its draft-relevant content (status + text, compared by identity), so
  // typing in one tab never resets (and thereby starves) another dirty
  // tab's timer.
  useEffect(() => {
    const needing = new Map(
      state.tabs
        .filter(needsRecoveryDraft)
        .map((tab) => [tab.id, { status: tab.status, text: tab.text }] as const),
    );
    for (const id of [...draftSignatures.current.keys()]) {
      if (!needing.has(id)) {
        draftSignatures.current.delete(id);
        const timer = draftTimers.current.get(id);
        if (timer) {
          clearTimeout(timer);
          draftTimers.current.delete(id);
        }
      }
    }
    for (const id of [...persistedDraftIds.current]) {
      if (!needing.has(id)) {
        persistedDraftIds.current.delete(id);
        // The backend processes draft commands in issue order (the Tauri
        // command queue is FIFO per client), so this discard can never
        // overtake the last write issued for the same draft id.
        void port.discardDraft(draftIdForTab(id)).catch(() => {
          // Already gone (restored elsewhere or never flushed); harmless.
        });
      }
    }
    for (const [id, signature] of needing) {
      const previous = draftSignatures.current.get(id);
      if (
        previous &&
        previous.status === signature.status &&
        previous.text === signature.text
      ) {
        continue;
      }
      draftSignatures.current.set(id, signature);
      const existing = draftTimers.current.get(id);
      if (existing) clearTimeout(existing);
      draftTimers.current.set(id, setTimeout(() => {
        draftTimers.current.delete(id);
        const tab = stateRef.current.tabs.find((candidate) => candidate.id === id);
        if (!tab || !needsRecoveryDraft(tab)) return;
        persistedDraftIds.current.add(id);
        void port.writeDraft(draftFromSnapshot(tab)).catch(() => {
          persistedDraftIds.current.delete(id);
          // Drop the signature too, so the next state change re-arms the
          // debounce instead of starving this tab after a transient failure.
          draftSignatures.current.delete(id);
        });
      }, 2000));
    }
  }, [port, state]);

  // Cancel pending debounce timers on unmount; the close-requested flush is
  // the real quit path, an unmounted controller has nothing left to persist.
  useEffect(() => {
    const timers = draftTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const flushDrafts = useCallback(async () => {
    for (const timer of draftTimers.current.values()) clearTimeout(timer);
    draftTimers.current.clear();
    const writes = stateRef.current.tabs
      .filter(needsRecoveryDraft)
      .map((tab) => {
        persistedDraftIds.current.add(tab.id);
        return port.writeDraft(draftFromSnapshot(tab)).catch(() => {
          persistedDraftIds.current.delete(tab.id);
        });
      });
    await Promise.all(writes);
  }, [port]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void port.onCloseRequested(async () => {
      await flushDrafts();
    }).then((created) => {
      if (disposed) created();
      else unsubscribe = created;
    }).catch(() => {});
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [flushDrafts, port]);

  // Launch: load the persisted session, surface leftover recovery drafts,
  // then reopen the previous workspace and tabs (skipping ones that fail).
  useEffect(() => {
    const generation = lifecycleGenerationRef.current;
    void (async () => {
      let session: PersistedSession | null = null;
      try {
        session = await port.loadSession();
      } catch {
        // A broken session store must never block startup.
      }
      if (!isCurrent(generation)) return;
      sessionLoadedRef.current = true;
      if (session) {
        setRecent(session.recent);
        setThemeState(normalizeThemePreference(session.theme));
        setEditorPreferencesState(
          normalizeEditorPreferences(session.editorPreferences),
        );
        setSidebarPreferences(normalizeSidebarPreferences(session.sidebar));
      }

      let drafts: ReadonlyArray<RecoveryDraftInfo> = [];
      try {
        drafts = await port.listDrafts();
      } catch {
        // A broken recovery store must never block startup.
      }
      if (!isCurrent(generation)) return;
      if (drafts.length) setRecoveryDrafts(drafts);

      if (session?.workspacePath) {
        try {
          const root = await port.openWorkspacePath(session.workspacePath);
          if (isCurrent(generation)) openWorkspaceRoot(root);
        } catch {
          if (isCurrent(generation)) {
            setError(`无法打开上次会话中的文件夹：${session.workspacePath}`);
          }
        }
      }
      for (const path of session?.openPaths ?? []) {
        if (!isCurrent(generation)) return;
        try {
          const opened = await port.openPath(path);
          if (!isCurrent(generation)) return;
          addOpenedFiles([opened], { trackRecent: false });
        } catch {
          if (isCurrent(generation)) {
            setError(`无法打开上次会话中的文件：${path}`);
          }
        }
      }
      if (session?.activePath) {
        const tab = findTabByPath(stateRef.current, session.activePath);
        if (tab) dispatch({ type: "activate", id: tab.id });
      }
    })();
  }, [addOpenedFiles, dispatch, isCurrent, openWorkspaceRoot, port]);

  // Persist the session (recent items, tab order, active tab, workspace,
  // theme, editor and sidebar preferences) whenever any of them change.
  // Draft content is persisted separately.
  const sessionTabKey = state.tabs.map((tab) => tab.path ?? "").join("\n");
  const sessionActivePath =
    state.tabs.find((tab) => tab.id === state.activeId)?.path ?? null;
  const sessionWorkspacePath = workspace?.path ?? null;
  useEffect(() => {
    if (!sessionLoadedRef.current) return;
    const tabs = stateRef.current.tabs;
    void port.saveSession({
      recent,
      openPaths: tabs
        .map((tab) => tab.path)
        .filter((path): path is string => path !== null),
      activePath:
        tabs.find((tab) => tab.id === stateRef.current.activeId)?.path ?? null,
      workspacePath: workspacePathRef.current,
      theme,
      editorPreferences,
      sidebar: sidebarPreferences,
    }).catch(() => {
      // Session persistence is best-effort.
    });
  }, [
    port,
    recent,
    sessionTabKey,
    sessionActivePath,
    sessionWorkspacePath,
    theme,
    editorPreferences,
    sidebarPreferences,
  ]);

  const dismissSaveError = useCallback(() => setSaveError(null), []);

  // Returned so callers (and tests) can await the whole save chain.
  const retrySave = useCallback((): Promise<boolean> | undefined => {
    const failure = saveError;
    setSaveError(null);
    return failure ? save(failure.id) : undefined;
  }, [save, saveError]);

  const saveErrorSaveAs = useCallback((): Promise<boolean> | undefined => {
    const failure = saveError;
    setSaveError(null);
    return failure ? saveAs(failure.id) : undefined;
  }, [saveAs, saveError]);

  const loadDiskVersion = useCallback(async (id: string) => {
    const tab = stateRef.current.tabs.find((candidate) => candidate.id === id);
    if (!tab?.path) return;
    const generation = lifecycleGenerationRef.current;
    try {
      const fresh = await port.openPath(tab.path);
      if (isCurrent(generation)) dispatch({ type: "diskVersionLoaded", id, file: fresh });
    } catch (caught) {
      if (isCurrent(generation)) setError(errorMessage(caught));
    }
  }, [dispatch, isCurrent, port]);

  const keepLocalVersion = useCallback((id: string) => {
    dispatch({ type: "conflictKeptLocal", id });
  }, [dispatch]);

  const restoreDraft = useCallback(async (info: RecoveryDraftInfo) => {
    const generation = lifecycleGenerationRef.current;
    try {
      const draft = await port.readDraft(info.draftId);
      if (!isCurrent(generation)) return;
      const id = nextId();
      const before = stateRef.current;
      const next = dispatch({ type: "documentRestored", id, draft });
      const added = next.tabs.find(
        (tab) => tab.id === id && !before.tabs.some((tab) => tab.id === id),
      );
      if (added) {
        acquireDocumentScope(added);
        if (added.path) watchConsumer(added.id, added.path, "document");
      }
      setRecoveryDrafts((current) =>
        current?.filter((entry) => entry.draftId !== info.draftId) ?? current,
      );
      // The restored tab re-persists itself under its own draft id.
      void port.discardDraft(info.draftId).catch(() => {});
    } catch (caught) {
      if (isCurrent(generation)) setError(errorMessage(caught));
    }
  }, [acquireDocumentScope, dispatch, isCurrent, nextId, port, watchConsumer]);

  const discardRecoveryDraft = useCallback(async (info: RecoveryDraftInfo) => {
    try {
      await port.discardDraft(info.draftId);
    } catch {
      // Already gone; the dialog entry is removed either way.
    }
    if (mountedRef.current) {
      setRecoveryDrafts((current) =>
        current?.filter((entry) => entry.draftId !== info.draftId) ?? current,
      );
    }
  }, [port]);

  const openRecent = useCallback(async (item: RecentItem) => {
    const generation = lifecycleGenerationRef.current;
    setError(null);
    try {
      if (item.kind === "file") {
        const opened = await port.openPath(item.path);
        if (isCurrent(generation)) addOpenedFiles([opened]);
      } else {
        const root = await port.openWorkspacePath(item.path);
        if (isCurrent(generation)) openWorkspaceRoot(root);
      }
    } catch (caught) {
      if (!isCurrent(generation)) return;
      // Only a confirmed not_found removes the entry; transient errors keep it.
      if (caught instanceof DocumentPortError && caught.code === "not_found") {
        setRecent((current) =>
          current.filter(
            (entry) => normalizePathKey(entry.path) !== normalizePathKey(item.path),
          ),
        );
      }
      setError(errorMessage(caught));
    }
  }, [addOpenedFiles, isCurrent, openWorkspaceRoot, port]);

  return {
    state,
    closeDocumentId,
    closeSaving,
    error,
    saveError,
    workspace,
    recent,
    theme,
    editorPreferences,
    setTheme,
    setEditorPreferences,
    sidebarPreferences,
    setSidebarPreferences,
    recoveryDrafts,
    newDocument,
    openFiles,
    openPath,
    openWorkspace,
    openWorkspacePath,
    closeWorkspace,
    activate: (id: string) => dispatch({ type: "activate", id }),
    changeText: (id: string, text: string) => dispatch({ type: "textChanged", id, text }),
    save,
    saveAs,
    close,
    confirmClose,
    reopenClosed,
    dismissSaveError,
    retrySave,
    saveErrorSaveAs,
    loadDiskVersion,
    keepLocalVersion,
    restoreDraft,
    discardRecoveryDraft,
    openRecent,
  };
}
