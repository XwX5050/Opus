import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentPort, WorkspaceRoot } from "../document/DocumentPort";
import { DocumentPortError } from "../document/DocumentPort";
import {
  documentReducer,
  initialDocumentState,
  normalizePathKey,
  titleFromPath,
  type DocumentAction,
} from "../document/documentReducer";
import { detectPathPlatform } from "../document/platform";
import {
  DEFAULT_OUTLINE_PREFERENCES,
  DEFAULT_SIDEBAR_PREFERENCES,
  normalizeOutlinePreferences,
  normalizeSidebarPreferences,
  type DiskEvent,
  type DocumentSnapshot,
  type OpenedFile,
  type OutlinePreferences,
  type PersistedSession,
  type RecentItem,
  type RecoveryDraftInfo,
  type SidebarPreferences,
} from "../document/types";
import {
  decideDiskEvent,
  findTabByPath,
  isReadCommitCurrent,
  readCurrentDiskVersion,
} from "../document/externalChanges";
import { createSaveFlow, type SaveFailure, type SaveFlow } from "../document/saveFlow";
import { createDraftScheduler, type DraftScheduler } from "../recovery/draftScheduler";
import { restoreDraft as runRestoreDraft } from "../recovery/restoreDraft";
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
import type { EditorViewMode } from "../editor/viewMode";
import {
  translateDocument,
  type TranslationPartial,
  type TranslationTextRange,
} from "../translate/translate";
import {
  DEFAULT_TRANSLATION_SETTINGS,
  normalizeTranslationSettings,
  translationKeySlot,
  translationSettingsSignature,
  type TranslationSettings,
  type TranslationViewState,
} from "../translate/types";

export type EventSubscriber = (
  port: DocumentPort,
  onFiles: (files: ReadonlyArray<OpenedFile>) => void,
  onDirectory?: (path: string) => void,
  onError?: (error: DocumentPortError) => void,
  signal?: AbortSignal,
) => Promise<OpenPathSubscriptions>;

export type CloseChoice = "save" | "discard" | "cancel";

export interface TabTranslation {
  readonly state: TranslationViewState;
  readonly visible: boolean;
}

/**
 * Re-exported from the save flow: the controller's retry surface consumes this
 * payload, and `saveFlow` is its single definition.
 */
export type { SaveFailure } from "../document/saveFlow";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Reported when a restore is refused because the draft's document is already
 * open with newer unsaved edits: the recovered text landed nowhere, so the
 * draft is kept (both on disk and in the dialog) and the refusal is explained.
 */
const RESTORE_REFUSED_MESSAGE = "目标文档包含未保存的修改，草稿未合并（草稿已保留）";

/**
 * Reported after a successful restore whose owner draft could not be written:
 * the recovered text is in a tab, but the crash copy remains only as the
 * leftover draft for the next launch.
 */
const RESTORE_DRAFT_WRITE_FAILED_MESSAGE =
  "已恢复文档，但新的恢复草稿写入失败；原草稿已保留，下次启动仍可再次恢复";

/** Path-key platform, resolved once from the webview user agent. */
const PATH_PLATFORM = detectPathPlatform();

/**
 * Returns the map with `id` moved to `mode`, storing only non-default modes
 * ("editing" is the default, so it deletes the entry). Pure: returns the
 * input unchanged when the mode already matches.
 */
const withViewMode = (
  current: ReadonlyMap<string, EditorViewMode>,
  id: string,
  mode: EditorViewMode,
): ReadonlyMap<string, EditorViewMode> => {
  if ((current.get(id) ?? "editing") === mode) return current;
  const next = new Map(current);
  if (mode === "editing") next.delete(id);
  else next.set(id, mode);
  return next;
};

export function useAppController(
  port: DocumentPort,
  subscribeToEvents: EventSubscriber | null = null,
) {
  const [state, setState] = useState(initialDocumentState);
  const stateRef = useRef(state);
  const idSequence = useRef(0);
  const closeSavingRef = useRef(false);
  const closeOperationSequence = useRef(0);
  const mountedRef = useRef(true);
  const lifecycleGenerationRef = useRef(0);
  // The port is a stable prop in production, but the save flow and draft
  // scheduler are created once per controller and read it through a ref so a
  // later prop identity change cannot pin them to a stale instance.
  const portRef = useRef(port);
  useEffect(() => {
    portRef.current = port;
  }, [port]);
  // One save flow per controller: its per-tab lock is instance-private, so a
  // fresh instance per render would defeat reentrancy protection.
  const saveFlowRef = useRef<SaveFlow | null>(null);
  // One draft scheduler per controller; same reasoning — timers and confirmed
  // draft bookkeeping live in the instance.
  const draftSchedulerRef = useRef<DraftScheduler | null>(null);
  // Draft ids with a restore transaction in flight, so a double-click can
  // never adopt the same recovered text twice (the second adopt would append
  // a duplicate tab).
  const restoringDraftIds = useRef(new Set<string>());
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
  const [outlinePreferences, setOutlinePreferences] =
    useState<OutlinePreferences>(DEFAULT_OUTLINE_PREFERENCES);
  // Per-tab view-mode memory: only non-default modes are stored, so a tab
  // without an entry (including every new tab) is in "editing". Entries are
  // pruned as soon as their tab closes — a closed-and-reopened document
  // always returns to "editing".
  const [viewModes, setViewModes] =
    useState<ReadonlyMap<string, EditorViewMode>>(new Map());
  // Per-tab presentation open state, mirroring viewModes: an entry exists
  // only while its tab is open, and a closed-and-reopened document starts
  // with no presentation. Entries are pruned as soon as their tab closes.
  const [presentationTabs, setPresentationTabs] =
    useState<ReadonlySet<string>>(new Set());
  const [translationSettings, setTranslationSettingsState] =
    useState<TranslationSettings>(DEFAULT_TRANSLATION_SETTINGS);
  // Per-tab translation view memory: an entry exists only once the user has
  // translated this tab in this session. `visible` says whether the editor
  // is currently showing the translation; the cached result is kept while
  // hidden so re-showing costs no API calls. Entries are pruned with their
  // tab and dropped whenever the tab's text changes.
  const [translations, setTranslations] = useState<
    ReadonlyMap<string, TabTranslation>
  >(new Map());
  const [recoveryDrafts, setRecoveryDrafts] =
    useState<ReadonlyArray<RecoveryDraftInfo> | null>(null);
  const workspacePathRef = useRef<string | null>(null);
  // Stable consumer IDs (tab IDs) that currently hold an asset scope.
  const acquiredScopeIds = useRef(new Set<string>());
  // Per-consumer disk-watch bookkeeping: the exact target each consumer
  // currently watches, mirroring the backend's per-consumer refcount. Tracked
  // by value so a retarget (rename, move, save-as) can tell whether the
  // recorded watch still matches the old target before unwatching — an
  // unwatch issued after another handler already retargeted the same consumer
  // would drop the fresh watch, since the backend releases every watch the
  // consumer holds on one unwatch call.
  const watchedTargets = useRef(
    new Map<string, { target: string; kind: "document" | "workspace" }>(),
  );
  // Session saves are suppressed until the persisted session has been loaded,
  // so a slow load can never be overwritten by the empty launch state.
  const sessionLoadedRef = useRef(false);
  // Bumped on every explicit user open (Finder/drag-drop open events, file
  // picker, new document, reopen). If any explicit open has happened by the
  // time session restore finishes, that document keeps focus instead of the
  // restored session's active tab.
  const explicitOpenVersionRef = useRef(0);
  // Per-consumer promise chain serializing backend scope operations, so a
  // release (or a re-acquire after close→reopen with the same tab ID) can
  // never overtake a still-pending acquire and leak a registry reference.
  const scopeOperationChains = useRef(new Map<string, Promise<void>>());
  // Abort controllers for in-flight per-tab translations. The entry in the
  // map also serves as a run token: a completion that no longer matches it
  // (cancelled, superseded by a newer run, or dropped on text change) must
  // not write its result.
  const translationControllers = useRef(new Map<string, AbortController>());
  // Viewport-range provider of the active tab's editor (character offsets
  // into the displayed text), fed by AppShell for viewport-priority
  // translation scheduling; null means no preference (document order). The
  // shell owns the registration: it re-points the provider whenever the
  // active tab changes and clears it when that editor's view goes away, so
  // translation runs only read it (and must never clear it — that would
  // starve every later run until the next tab change). A plain ref on
  // purpose: view/scroll changes must never re-render the shell.
  const translationViewportProviderRef = useRef<
    (() => TranslationTextRange | null) | null
  >(null);

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
  // must never roll back the asset scope or block editing. The recorded
  // target is compared by value, so re-watching a target the consumer already
  // watches is a no-op and a retarget never double-registers.
  const watchConsumer = useCallback((
    id: string,
    target: string,
    kind: "document" | "workspace",
  ) => {
    const current = watchedTargets.current.get(id);
    if (current?.target === target && current.kind === kind) return;
    const record = { target, kind };
    watchedTargets.current.set(id, record);
    enqueueScopeOperation(id, async () => {
      try {
        if (kind === "workspace") await port.watchWorkspace(id, target);
        else await port.watchDocument(id, target);
      } catch {
        // Only a failure of the registration this record represents clears it.
        // A rename / disk move / save-as retarget that already replaced the
        // record owns a newer backend registration, and deleting it here would
        // orphan that bookkeeping: the tab's later close would skip its
        // unwatch and leak the backend watch for the consumer id.
        if (watchedTargets.current.get(id) === record) {
          watchedTargets.current.delete(id);
        }
      }
    });
  }, [enqueueScopeOperation, port]);

  const releaseScope = useCallback((id: string) => {
    const hadScope = acquiredScopeIds.current.delete(id);
    const hadWatch = watchedTargets.current.delete(id);
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

  // Retargets a consumer's document watch from its current target to a new
  // path: the old watch is released first, then the new one is registered,
  // both serialized through the consumer's operation chain so the backend
  // never observes a gap-ordered release after a re-registration. The release
  // only fires when the recorded watch still matches `expectedTarget` — a
  // caller whose tab was already retargeted elsewhere (a disk moved event
  // racing the caller's own retarget) must not unwatch the fresh watch.
  const releaseWatch = useCallback((id: string, expectedTarget: string) => {
    const current = watchedTargets.current.get(id);
    if (!current || current.target !== expectedTarget) return false;
    watchedTargets.current.delete(id);
    enqueueScopeOperation(id, async () => {
      try {
        await port.unwatch(id);
      } catch {
        // Watch release is best-effort; the backend refcounts per consumer.
      }
    });
    return true;
  }, [enqueueScopeOperation, port]);

  const rememberRecent = useCallback((item: RecentItem) => {
    setRecent((current) => [
      item,
      ...current.filter(
        (entry) => normalizePathKey(entry.path, PATH_PLATFORM) !== normalizePathKey(item.path, PATH_PLATFORM),
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
  const setTranslationSettings = useCallback(
    (value: TranslationSettings) =>
      setTranslationSettingsState(normalizeTranslationSettings(value).settings),
    [],
  );

  const viewModeOf = useCallback(
    (id: string | null | undefined): EditorViewMode =>
      (id ? viewModes.get(id) : undefined) ?? "editing",
    [viewModes],
  );

  // Mirror of the viewModes state for callbacks that must read the current
  // mode without depending on state identity (state updaters stay pure —
  // StrictMode double-invokes them, so ref mutations happen outside).
  const viewModesRef = useRef(viewModes);
  useEffect(() => {
    viewModesRef.current = viewModes;
  }, [viewModes]);

  // Same mirror for the per-tab translation state, read by the save /
  // changeText guards and the tab-close prune.
  const translationsRef = useRef(translations);
  useEffect(() => {
    translationsRef.current = translations;
  }, [translations]);

  const setViewMode = useCallback((id: string, mode: EditorViewMode) => {
    setViewModes((current) => withViewMode(current, id, mode));
  }, []);

  const toggleReading = useCallback((id: string) => {
    const target =
      (viewModesRef.current.get(id) ?? "editing") === "reading" ? "editing" : "reading";
    setViewModes((current) => withViewMode(current, id, target));
  }, []);

  const presentationOpenOf = useCallback(
    (id: string | null | undefined): boolean =>
      Boolean(id && presentationTabs.has(id)),
    [presentationTabs],
  );

  const openPresentation = useCallback((id: string) => {
    setPresentationTabs((current) =>
      current.has(id) ? current : new Set(current).add(id),
    );
  }, []);

  const closePresentation = useCallback((id: string) => {
    setPresentationTabs((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  const translationOf = useCallback(
    (id: string | null | undefined): TabTranslation | undefined =>
      id ? translations.get(id) : undefined,
    [translations],
  );

  // Drops a tab's translation state: aborts any in-flight request and
  // removes the entry. Idempotent, so callers (cancel, prune, text change)
  // never need to check whether an entry exists first.
  const dropTranslation = useCallback((id: string) => {
    translationControllers.current.get(id)?.abort();
    translationControllers.current.delete(id);
    setTranslations((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);

  const setTranslationViewportProvider = useCallback((
    provider: (() => TranslationTextRange | null) | null,
  ) => {
    translationViewportProviderRef.current = provider;
  }, []);

  /**
   * Starts a translation run whose credentials are already confirmed. Split
   * from startTranslation so the credential-store lookup — which is
   * asynchronous, and so can never be a synchronous guard — gates the run
   * without nesting the whole pipeline inside its callback.
   */
  const beginTranslation = useCallback((id: string, settings: TranslationSettings, generation: number) => {
    const tab = stateRef.current.tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    const controller = new AbortController();
    translationControllers.current.set(id, controller);
    setTranslations((current) => {
      const next = new Map(current);
      next.set(id, { state: { phase: "translating" }, visible: true });
      return next;
    });
    const text = tab.text;
    // Batch completions update the translating state under the same per-run
    // guards as the final result: a partial only lands while this run is
    // still current and the source text is unchanged, so it can never
    // resurrect a cancelled, superseded, or text-invalidated run.
    const applyPartial = (partial: TranslationPartial) => {
      if (!isCurrent(generation)) return;
      if (translationControllers.current.get(id) !== controller) return;
      const latest = stateRef.current.tabs.find(
        (candidate) => candidate.id === id,
      );
      if (!latest || latest.text !== text) return;
      setTranslations((current) => {
        const next = new Map(current);
        next.set(id, {
          state: {
            phase: "translating",
            translatedText: partial.text,
            completedBatches: partial.completedBatches,
            totalBatches: partial.totalBatches,
          },
          visible: true,
        });
        return next;
      });
    };
    void translateDocument(port, settings, text, {
      signal: controller.signal,
      concurrency: settings.concurrency,
      onPartial: applyPartial,
      // Viewport priority: the getter is read fresh for every batch the
      // scheduler picks, so in-flight viewport changes re-prioritize
      // immediately. A null provider (or one returning null) means document
      // order.
      priority: {
        visibleRange: () => translationViewportProviderRef.current?.() ?? null,
      },
    })
      .then((translatedText) => {
        if (!isCurrent(generation)) return;
        // The controller map entry is the run token; a cancelled or dropped
        // run fails the identity check and never writes its result. The text
        // check closes the frame between a text replacement committing and
        // the invalidating effect running.
        if (translationControllers.current.get(id) !== controller) return;
        const latest = stateRef.current.tabs.find(
          (candidate) => candidate.id === id,
        );
        if (!latest || latest.text !== text) {
          translationControllers.current.delete(id);
          return;
        }
        translationControllers.current.delete(id);
        // The provider stays registered: it is owned by the shell, which
        // re-points it at the active tab's editor and clears it when that
        // view goes away. A run that ended (or was dropped or errored) is no
        // reason to unregister it — the getter is only read while a run
        // schedules, and clearing it here would starve every later run of the
        // same tab of viewport priority, since the shell's registration
        // effect does not re-run without a tab change.
        setTranslations((current) => {
          const next = new Map(current);
          next.set(id, {
            state: { phase: "ready", translatedText },
            visible: true,
          });
          return next;
        });
      })
      .catch((caught) => {
        if (!isCurrent(generation)) return;
        if (translationControllers.current.get(id) !== controller) return;
        translationControllers.current.delete(id);
        // An errored run never leaves the translation on screen: the error
        // banner surfaces through the entry's phase while `visible: false`
        // keeps the editor and the save path live, so a failed request can
        // never lock the user out of editing or saving the original text.
        setTranslations((current) => {
          const next = new Map(current);
          next.set(id, {
            state: { phase: "error", error: errorMessage(caught) },
            visible: false,
          });
          return next;
        });
      });
  }, [isCurrent, port]);

  /** Runs whose credential-store lookup has not answered yet. */
  const translationStartsRef = useRef(new Set<string>());

  const startTranslation = useCallback((id: string) => {
    const settings = translationSettings;
    // The check is re-run per click instead of being cached: a key saved in
    // the settings dialog must be usable immediately, and only the backend
    // knows which slots hold one (the frontend can never read the secret).
    // Rejected lookups count as "no key" — the run must not start on a
    // credential the backend could not confirm.
    if (translationStartsRef.current.has(id)) return;
    translationStartsRef.current.add(id);
    const generation = lifecycleGenerationRef.current;
    void port
      .hasTranslationKey(translationKeySlot(settings))
      .catch(() => false)
      .then((keyPresent) => {
        translationStartsRef.current.delete(id);
        if (!isCurrent(generation)) return;
        if (!keyPresent) {
          setError("请先在设置中配置翻译 API");
          return;
        }
        beginTranslation(id, settings, generation);
      });
  }, [beginTranslation, isCurrent, port, translationSettings]);

  const toggleTranslation = useCallback((id: string) => {
    const current = translationsRef.current.get(id);
    if (!current) {
      startTranslation(id);
      return;
    }
    if (current.state.phase === "translating") {
      // Second click cancels the in-flight request and forgets it.
      dropTranslation(id);
      return;
    }
    if (current.state.phase === "ready") {
      // Hide/show the in-memory result; entries are bound to the settings
      // signature they ran under (see the signature effect), so a result that
      // still exists is always current and re-showing never re-calls the API.
      setTranslations((entries) => {
        const next = new Map(entries);
        next.set(id, { state: current.state, visible: !current.visible });
        return next;
      });
      return;
    }
    // Error state: the toggle retries the failed run from scratch.
    startTranslation(id);
  }, [dropTranslation, startTranslation]);

  // Prune view-mode and presentation memory for tabs that no longer exist.
  const viewModeTabIdsKey = state.tabs.map((tab) => tab.id).join("\n");
  useEffect(() => {
    const open = new Set(state.tabs.map((tab) => tab.id));
    setViewModes((current) => {
      if ([...current.keys()].every((id) => open.has(id))) return current;
      const next = new Map(current);
      for (const id of [...next.keys()]) {
        if (!open.has(id)) next.delete(id);
      }
      return next;
    });
    setPresentationTabs((current) => {
      if ([...current].every((id) => open.has(id))) return current;
      const next = new Set(current);
      for (const id of [...next]) {
        if (!open.has(id)) next.delete(id);
      }
      return next;
    });
    // Keyed on the open tab ids; the reducer's tab list is the source of truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewModeTabIdsKey]);

  // Per-tab translation memory is pruned with its tab, mirroring viewModes:
  // a closed-and-reopened document starts untranslated (the disk-level
  // segment cache still makes retranslation cheap).
  const translationTabIdsKey = state.tabs.map((tab) => tab.id).join("\n");
  useEffect(() => {
    const open = new Set(state.tabs.map((tab) => tab.id));
    for (const id of [...translationsRef.current.keys()]) {
      if (!open.has(id)) dropTranslation(id);
    }
    // Keyed on the open tab ids; the reducer's tab list is the source of truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translationTabIdsKey]);

  // A translation is bound to the exact text it was produced from. Only tabs
  // with a live translation entry need the comparison: a tab without one has
  // nothing to drop, and skipping it keeps the keystroke path O(1) even for a
  // pressure-sized document. A hidden translation's first live edit still
  // drops its entry, which then removes it from the compared set.
  const translationTextsRef = useRef(new Map<string, string>());
  useEffect(() => {
    const seen = translationTextsRef.current;
    for (const tab of state.tabs) {
      const previous = seen.get(tab.id);
      if (
        previous !== undefined &&
        translationsRef.current.has(tab.id) &&
        previous !== tab.text
      ) {
        dropTranslation(tab.id);
      }
      seen.set(tab.id, tab.text);
    }
    for (const id of [...seen.keys()]) {
      if (!state.tabs.some((tab) => tab.id === id)) seen.delete(id);
    }
  });

  // A per-tab translation is bound to the settings signature it ran under
  // (endpoint, model, target language, concurrency — the API key never
  // changes output, so it is not part of the signature). When the signature
  // changes, every cached result and in-flight run is dropped: re-showing can
  // never surface a stale translation produced under different settings, and
  // the next toggle translates under the new ones.
  const lastTranslationSignatureRef = useRef(
    translationSettingsSignature(DEFAULT_TRANSLATION_SETTINGS),
  );
  const translationSettingsKey = translationSettingsSignature(translationSettings);
  useEffect(() => {
    if (translationSettingsKey === lastTranslationSignatureRef.current) return;
    lastTranslationSignatureRef.current = translationSettingsKey;
    for (const id of [...translationsRef.current.keys()]) dropTranslation(id);
    // The signature is the only input; dropTranslation is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translationSettingsKey, dropTranslation]);

  const addOpenedFiles = useCallback((
    files: ReadonlyArray<OpenedFile>,
    options: { trackRecent?: boolean; activate?: boolean } = {},
  ) => {
    const trackRecent = options.trackRecent ?? true;
    const activate = options.activate ?? true;
    if (activate) explicitOpenVersionRef.current += 1;
    for (const openedFile of files) {
      const id = nextId();
      const before = stateRef.current;
      const next = dispatch({
        type: "fileOpened",
        id,
        file: openedFile,
        pathPlatform: PATH_PLATFORM,
        activate,
      });
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
    return activate ? stateRef.current.activeId : null;
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
      if (isCurrent(generation)) return addOpenedFiles([file]);
    } catch (caught) {
      if (isCurrent(generation)) setError(errorMessage(caught));
    }
    return null;
  }, [addOpenedFiles, isCurrent, port]);

  const newDocument = useCallback(() => {
    // A new document is an explicit user action: it claims launch-window
    // focus the same way an explicit open does, so a restored session's
    // active tab must not steal activation from it.
    explicitOpenVersionRef.current += 1;
    dispatch({ type: "newDocument", id: nextId() });
  }, [dispatch, nextId]);

  /**
   * One SaveFlow per controller. The host exposes only controller-level
   * primitives; per-tab locking, target selection, reducer-owned write
   * requests, completion classification and failure routing stay in the flow.
   */
  const getSaveFlow = useCallback((): SaveFlow => {
    if (saveFlowRef.current === null) {
      saveFlowRef.current = createSaveFlow({
        getState: () => stateRef.current,
        dispatch,
        generation: () => lifecycleGenerationRef.current,
        isCurrent,
        chooseSavePath: (suggestedName) =>
          portRef.current.chooseSavePath(suggestedName),
        write: (request) => portRef.current.write(request),
        translationVisible: (tabId) =>
          translationsRef.current.get(tabId)?.visible ?? false,
        pathPlatform: PATH_PLATFORM,
        clearBanner: () => setError(null),
        showBanner: (message) => setError(message),
        reportSaveFailure: (failure) => setSaveError(failure),
        onRetarget: (tabId, tab) => {
          // Ordering matters: release the old grant first, then re-acquire the
          // document scope and register the watch for the new path. All three
          // are serialized through the consumer's operation chain.
          releaseScope(tabId);
          acquireDocumentScope(tab);
          if (tab.path !== null) watchConsumer(tabId, tab.path, "document");
        },
      });
    }
    return saveFlowRef.current;
  }, [acquireDocumentScope, dispatch, isCurrent, releaseScope, watchConsumer]);

  const save = useCallback((id = stateRef.current.activeId) => {
    // The close dialog raises its latch before calling save; that is the only
    // attempt that bypasses the visible-translation guard. Standalone save is
    // blocked while a translation covers the buffer, while Save As picks a new
    // destination and close is the user's explicit decision to leave.
    const intent = closeSavingRef.current ? "close" : "save";
    return getSaveFlow()
      .save(id ?? undefined, intent)
      .then((outcome) => outcome.kind === "saved");
  }, [getSaveFlow]);

  const saveAs = useCallback(
    (id = stateRef.current.activeId) =>
      getSaveFlow()
        .save(id ?? undefined, "save-as")
        .then((outcome) => outcome.kind === "saved"),
    [getSaveFlow],
  );

  /**
   * One draft scheduler per controller; timers, reference-based signatures
   * and confirmed-draft bookkeeping live in the instance. The host reads tabs
   * from `stateRef` so a timer never writes a snapshot captured before the
   * latest edit.
   */
  const getDraftScheduler = useCallback((): DraftScheduler => {
    if (draftSchedulerRef.current === null) {
      draftSchedulerRef.current = createDraftScheduler({
        getTabs: () => stateRef.current.tabs,
        writeDraft: (draft) => portRef.current.writeDraft(draft),
        discardDraft: (draftId) => portRef.current.discardDraft(draftId),
      });
    }
    return draftSchedulerRef.current;
  }, []);

  const changeText = useCallback((id: string, text: string) => {
    // Same guard as save: edits reaching the controller while a translation
    // is visible (visible also covers the in-flight phase) are dropped so
    // the original text can never be corrupted. An errored translation is
    // never visible, so editing resumes immediately after a failure.
    if (translationsRef.current.get(id)?.visible) return;
    dispatch({ type: "textChanged", id, text });
  }, [dispatch]);

  const close = useCallback((id: string) => {
    const document = stateRef.current.tabs.find((tab) => tab.id === id);
    if (!document || document.pendingSave) return;
    if (document.status === "dirty" || document.status === "conflict" || document.status === "missing") {
      setCloseDocumentId(id);
      return;
    }
    const next = dispatch({
      type: "closeConfirmed",
      id,
      disposition: "saved",
      pathPlatform: PATH_PLATFORM,
    });
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
      const next = dispatch({
        type: "closeConfirmed",
        id,
        disposition: "discarded",
        pathPlatform: PATH_PLATFORM,
      });
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
        const next = dispatch({
          type: "closeConfirmed",
          id,
          disposition: "saved",
          pathPlatform: PATH_PLATFORM,
        });
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
    const closed = stateRef.current.recentlyClosed[0]?.document;
    const reopeningId = closed?.id;
    const before = stateRef.current;
    const next = dispatch({ type: "reopenLastClosed", pathPlatform: PATH_PLATFORM });
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
    if (!added || added.path === null) return;
    // The snapshot is reopened in memory first (the tab appears instantly),
    // then the disk is re-read: a clean snapshot follows the disk's current
    // content — the file may have changed while it was closed — while a dirty
    // snapshot keeps the local draft and only surfaces a conflict when the
    // saved version actually moved. The commit is guarded on generation, path
    // and the snapshot's saved version, so a stale read can never overwrite a
    // newer save or land on a tab that was retargeted meanwhile.
    const path = added.path;
    const expectedVersion = added.version;
    const closedStatus = closed.status;
    const request = {
      tabId: reopeningId,
      path,
      expectedVersion,
      generation: lifecycleGenerationRef.current,
      purpose: "explicit" as const,
    };
    void (async () => {
      try {
        const fresh = await port.openPath(path);
        // Same commit precondition as a guarded external read: a Save As,
        // rename, save or close in flight must not let this read land on a
        // tab that moved past the snapshot it was started from.
        if (
          !isReadCommitCurrent(
            stateRef.current,
            request,
            lifecycleGenerationRef.current,
            PATH_PLATFORM,
          )
        ) {
          return;
        }
        // Reopen keeps its own rules, unlike an explicit conflict-dialog
        // load: a clean snapshot follows any disk difference (including text
        // changed under an unchanged version), while a dirty snapshot only
        // surfaces a conflict when the saved version actually moved.
        if (closedStatus === "clean") {
          if (fresh.version !== expectedVersion || fresh.text !== closed.text) {
            dispatch({ type: "externalChanged", id: reopeningId, file: fresh });
          }
        } else if (expectedVersion !== null && fresh.version !== expectedVersion) {
          dispatch({ type: "externalChanged", id: reopeningId, file: fresh });
        }
      } catch (caught) {
        if (
          !isReadCommitCurrent(
            stateRef.current,
            request,
            lifecycleGenerationRef.current,
            PATH_PLATFORM,
          )
        ) {
          return;
        }
        if (caught instanceof DocumentPortError && caught.code === "not_found") {
          dispatch({ type: "externalMissing", id: reopeningId });
        }
      }
    })();
  }, [acquireDocumentScope, dispatch, watchConsumer, port]);

  /**
   * Renames the document behind a tab in place. `newBaseName` carries no
   * extension: the original extension and directory of the tab's path are
   * kept. On success the tab follows to the canonical path returned by the
   * backend regardless of its status, and recent entries pointing at the old
   * path are re-pointed the same way disk moves update paths. The disk watch
   * is retargeted under the same consumer id — unwatch the old path, then
   * watch the new one, serialized through the consumer's operation chain — so
   * later external modifications of the new path still reach the tab. On
   * failure nothing is committed and the error propagates to the caller.
   */
  const renameDocument = useCallback(async (tabId: string, newBaseName: string) => {
    const tab = stateRef.current.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.path === null) {
      throw new Error(`No open document for tab: ${tabId}`);
    }
    const oldPath = tab.path;
    const newPath = await port.renameDocument(oldPath, newBaseName);
    const stillOpen = stateRef.current.tabs.some(
      (candidate) => candidate.id === tabId,
    );
    dispatch({
      type: "tabRenamed",
      id: tabId,
      path: newPath,
      title: titleFromPath(newPath, PATH_PLATFORM),
    });
    setRecent((current) =>
      current.map((entry) =>
        normalizePathKey(entry.path, PATH_PLATFORM) ===
        normalizePathKey(oldPath, PATH_PLATFORM)
          ? { ...entry, path: newPath }
          : entry,
      ),
    );
    if (!stillOpen) {
      // The tab was closed while the rename was in flight; its close already
      // released the watch under the tab's consumer id, so nothing to retarget.
      return;
    }
    if (
      normalizePathKey(newPath, PATH_PLATFORM) ===
      normalizePathKey(oldPath, PATH_PLATFORM)
    ) {
      // Renamed onto the current name: nothing moved, keep the existing watch.
      return;
    }
    // The backend's own rename may already have surfaced as a disk moved
    // event that retargeted the watch; releaseWatch only unwatches when the
    // recorded watch still targets the old path, so the fresh watch survives.
    releaseWatch(tabId, oldPath);
    watchConsumer(tabId, newPath, "document");
  }, [dispatch, port, releaseWatch, watchConsumer]);

  // Release every still-held scope and watch when the controller unmounts,
  // keeping the same acquire-then-release serialization as tab closes.
  useEffect(() => {
    const acquired = acquiredScopeIds.current;
    const watched = watchedTargets.current;
    return () => {
      for (const id of new Set([...acquired, ...watched.keys()])) {
        releaseScope(id);
      }
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
    // Best-effort: clear the backend workspace anchor so later workspace
    // commands with the stale root are rejected.
    void port.closeWorkspace().catch(() => {});
  }, [port, releaseScope]);

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

  /**
   * Watcher-driven reload. The guarded read validates the lifecycle, path and
   * saved version captured at read start; a self-save echo (`unchanged`) and a
   * read that lost its tab are ignored, a vanished file marks the tab missing,
   * and any other read failure stays silent because no user action asked for
   * this load.
   */
  const reloadFromDisk = useCallback(async (id: string) => {
    const tab = stateRef.current.tabs.find((candidate) => candidate.id === id);
    if (!tab?.path) return;
    const outcome = await readCurrentDiskVersion(
      {
        tabId: id,
        path: tab.path,
        expectedVersion: tab.version,
        generation: lifecycleGenerationRef.current,
        purpose: "watch",
      },
      {
        openPath: (path) => portRef.current.openPath(path),
        getState: () => stateRef.current,
        getGeneration: () => lifecycleGenerationRef.current,
        pathPlatform: PATH_PLATFORM,
      },
    );
    if (outcome.kind === "loaded") {
      // The reducer decides atomically: still-clean tabs reload, anything
      // else becomes a conflict without losing text.
      dispatch({ type: "externalChanged", id, file: outcome.file });
    } else if (outcome.kind === "missing") {
      dispatch({ type: "externalMissing", id });
    }
  }, [dispatch]);

  const handleDiskEvent = useCallback((event: DiskEvent) => {
    const decision = decideDiskEvent(stateRef.current, event, PATH_PLATFORM);
    switch (decision.kind) {
      case "ignore":
        return;
      case "missing":
        dispatch({ type: "externalMissing", id: decision.tabId });
        return;
      case "reload":
        // Covers changed events and the target side of an atomic replace.
        void reloadFromDisk(decision.tabId);
        return;
      case "moved": {
        const next = dispatch({
          type: "externalMoved",
          from: decision.from,
          to: decision.to,
          pathPlatform: PATH_PLATFORM,
        });
        const moved = next.tabs.find((tab) => tab.id === decision.tabId);
        // Only a reducer that actually changed the tab's path retargets the
        // consumer; an unchanged path keeps its existing scope and watch.
        if (
          moved === undefined ||
          moved.path === null ||
          moved.path === decision.previousPath
        ) {
          return;
        }
        // Release the old-path watch only while it is still recorded at the
        // tab's own previous path (a concurrent retarget already moved it on,
        // nothing to drop here), then register the new path under the same
        // consumer id.
        releaseWatch(moved.id, decision.previousPath);
        // The asset scope grants the document's parent directory, so it only
        // needs a release/re-acquire when the move crossed a directory
        // boundary; a same-parent rename keeps the existing grant, which
        // already covers the new path.
        if (decision.scopeChanged) {
          releaseScope(moved.id);
          acquireDocumentScope(moved);
        }
        watchConsumer(moved.id, moved.path, "document");
        return;
      }
    }
  }, [acquireDocumentScope, dispatch, releaseScope, releaseWatch, reloadFromDisk, watchConsumer]);

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

  // Recovery drafts: the scheduler reconciles a per-tab 2s debounce (forced at
  // worst every 5s of continuous typing) with the latest tab snapshots. It
  // compares draft-relevant metadata by identity, so typing in one tab never
  // resets (and thereby starves) another dirty tab's timer, and unchanged
  // content is never rewritten after a completed or failed write.
  useEffect(() => {
    getDraftScheduler().sync(state.tabs);
  }, [getDraftScheduler, state]);

  // Cancel pending debounce timers on unmount; the close-requested flush is
  // the real quit path, an unmounted controller has nothing left to persist.
  // Mount-only: re-running this cleanup would clear timers the scheduler just
  // re-armed on every state change.
  useEffect(() => {
    const scheduler = getDraftScheduler();
    return () => scheduler.cancelTimers();
  }, [getDraftScheduler]);

  const flushDrafts = useCallback(
    () => getDraftScheduler().flush(),
    [getDraftScheduler],
  );

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
        // Recent entries recorded while the session was still loading
        // (Finder opens, drag-drop) must survive: merge instead of replacing,
        // so the persisted history is applied without clobbering newer items.
        setRecent((current) => {
          const merged = [...current];
          for (const entry of session.recent) {
            if (!merged.some(
              (existing) =>
                normalizePathKey(existing.path, PATH_PLATFORM) === normalizePathKey(entry.path, PATH_PLATFORM),
            )) {
              merged.push(entry);
            }
          }
          return merged.slice(0, 10);
        });
        setThemeState(normalizeThemePreference(session.theme));
        setEditorPreferencesState(
          normalizeEditorPreferences(session.editorPreferences),
        );
        setSidebarPreferences(normalizeSidebarPreferences(session.sidebar));
        setOutlinePreferences(normalizeOutlinePreferences(session.outline));
        setTranslationSettingsState(
          normalizeTranslationSettings(session.translationSettings).settings,
        );
      }

      let drafts: ReadonlyArray<RecoveryDraftInfo> = [];
      try {
        drafts = await port.listDrafts();
      } catch {
        // A broken recovery store must never block startup.
      }
      if (!isCurrent(generation)) return;
      if (drafts.length) setRecoveryDrafts(drafts);

      // A workspace the user explicitly opened during the launch window
      // (folder picker, drag-drop, recent entry) wins over the persisted
      // one — restore only fills the gap when no workspace is open yet.
      if (session?.workspacePath && workspacePathRef.current === null) {
        try {
          const root = await port.openWorkspacePath(session.workspacePath);
          if (isCurrent(generation)) openWorkspaceRoot(root);
        } catch {
          if (isCurrent(generation)) {
            setError(`无法打开上次会话中的文件夹：${session.workspacePath}`);
          }
        }
      }
      // Restored tabs must never steal focus from a document the user
      // explicitly opened at launch (Finder double-click, drag-drop, argv).
      for (const path of session?.openPaths ?? []) {
        if (!isCurrent(generation)) return;
        try {
          const opened = await port.openPath(path);
          if (!isCurrent(generation)) return;
          addOpenedFiles([opened], { trackRecent: false, activate: false });
        } catch {
          if (isCurrent(generation)) {
            setError(`无法打开上次会话中的文件：${path}`);
          }
        }
      }
      if (session?.activePath && explicitOpenVersionRef.current === 0) {
        const tab = findTabByPath(stateRef.current, session.activePath, PATH_PLATFORM);
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
      outline: outlinePreferences,
      translationSettings,
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
    outlinePreferences,
    translationSettings,
  ]);

  const dismissSaveError = useCallback(() => setSaveError(null), []);

  // Clears the alert banner only. Every `setError` producer keeps its own
  // state (a failed save still owns `saveError`, a conflict its tab status),
  // so dismissing the message never hides the condition behind it.
  const dismissError = useCallback(() => setError(null), []);

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
    // `readCurrentDiskVersion` classifies not_found as `missing` without
    // carrying the error, but the conflict dialog's explicit load predates
    // that classification and reports the read error while keeping the tab
    // conflicted. Capture the thrown error on its way through the guarded
    // read so that behavior survives the extraction.
    let readError: unknown;
    // The explicit purpose commits the loaded file even when its version
    // equals the expected one: this is a user-requested replacement, not a
    // watcher echo that must be ignored.
    const outcome = await readCurrentDiskVersion(
      {
        tabId: id,
        path: tab.path,
        expectedVersion: tab.version,
        generation,
        purpose: "explicit",
      },
      {
        openPath: async (path) => {
          try {
            return await portRef.current.openPath(path);
          } catch (error) {
            readError = error;
            throw error;
          }
        },
        getState: () => stateRef.current,
        getGeneration: () => lifecycleGenerationRef.current,
        pathPlatform: PATH_PLATFORM,
      },
    );
    if (outcome.kind === "loaded") {
      dispatch({ type: "diskVersionLoaded", id, file: outcome.file });
    } else if (outcome.kind === "missing") {
      // A vanished file on an explicit load is reported to the user and the
      // tab keeps its conflict buffer; only watcher-driven missing events
      // transition the tab to `missing`.
      if (isCurrent(generation)) setError(errorMessage(readError));
    } else if (outcome.kind === "error") {
      // This load came from the conflict dialog's explicit action, so a
      // failure must be reported instead of silently ignored.
      setError(errorMessage(outcome.error));
    }
    // `unchanged` never occurs for an explicit read; `stale` means the tab
    // moved past the read and must be left alone.
  }, [dispatch, isCurrent]);

  const keepLocalVersion = useCallback((id: string) => {
    dispatch({ type: "conflictKeptLocal", id });
  }, [dispatch]);

  const restoreDraft = useCallback(async (info: RecoveryDraftInfo) => {
    // A double click, or a retry while the first transaction is still running,
    // must not adopt the same recovered text twice: both calls would read the
    // same leftover and each append a tab. The guard is keyed by draft id and
    // always released, so a later retry after a refusal or failure still works.
    if (restoringDraftIds.current.has(info.draftId)) return;
    restoringDraftIds.current.add(info.draftId);
    try {
      const outcome = await runRestoreDraft(info, {
        generation: lifecycleGenerationRef.current,
        pathPlatform: PATH_PLATFORM,
        isCurrent,
        createTabId: nextId,
        readDraft: (draftId) => portRef.current.readDraft(draftId),
        adoptDraft: (id, draft) => {
          const before = stateRef.current;
          const state = dispatch({
            type: "documentRestored",
            id,
            draft,
            pathPlatform: PATH_PLATFORM,
          });
          // The exact snapshot appended by this dispatch, compared against the
          // tab list before it: a colliding createTabId must not masquerade as
          // a tab this adoption created.
          const added = state.tabs.find(
            (tab) =>
              tab.id === id && !before.tabs.some((existing) => existing.id === id),
          );
          return { state, added };
        },
        onOwnerReady: (owner, created) => {
          // The recovered text is in a tab; its draft entry needs no further
          // decision from the user. Both a fresh tab and a merge into an open
          // tab arrive here, before the owner draft is written.
          setRecoveryDrafts((current) =>
            current?.filter((entry) => entry.draftId !== info.draftId) ?? current,
          );
          // Only a fresh tab needs asset-scope/watch acquisition; a merged
          // owner already holds both under its existing consumer id.
          if (created) {
            acquireDocumentScope(owner);
            if (owner.path !== null) {
              watchConsumer(owner.id, owner.path, "document");
            }
          }
        },
        markPersisted: (tabId) => getDraftScheduler().markPersisted(tabId),
        unmarkPersisted: (tabId) => getDraftScheduler().unmarkPersisted(tabId),
        // Deliberately the raw port call: it must reject so the transaction
        // keeps the leftover draft as the only disk copy and reports
        // draftWriteFailed instead of dropping the recovered text's backup.
        writeDraft: (draft) => portRef.current.writeDraft(draft),
        discardDraft: (draftId) => portRef.current.discardDraft(draftId),
      });

      switch (outcome.kind) {
        case "restored":
          if (outcome.draftWriteFailed) {
            setError(RESTORE_DRAFT_WRITE_FAILED_MESSAGE);
          }
          return;
        case "refused":
          // The text landed nowhere: the leftover and its dialog entry stay so
          // the only copy of the crashed work is still visible and recoverable.
          setError(RESTORE_REFUSED_MESSAGE);
          return;
        case "missing":
          // Gone from disk (another window restored or discarded it, or the
          // store was cleaned up). A dead entry must not stay in the dialog
          // erroring on every click; drop it without a banner.
          setRecoveryDrafts((current) =>
            current?.filter((entry) => entry.draftId !== info.draftId) ?? current,
          );
          return;
        case "error":
          setError(errorMessage(outcome.error));
          return;
        case "stale":
          // The tab state was replaced (unmount/reload); never surface it.
          return;
      }
    } finally {
      restoringDraftIds.current.delete(info.draftId);
    }
  }, [
    acquireDocumentScope,
    dispatch,
    getDraftScheduler,
    isCurrent,
    nextId,
    watchConsumer,
  ]);

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
            (entry) => normalizePathKey(entry.path, PATH_PLATFORM) !== normalizePathKey(item.path, PATH_PLATFORM),
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
    dismissError,
    saveError,
    workspace,
    recent,
    theme,
    editorPreferences,
    setTheme,
    setEditorPreferences,
    sidebarPreferences,
    setSidebarPreferences,
    outlinePreferences,
    setOutlinePreferences,
    translationSettings,
    setTranslationSettings,
    translations,
    translationOf,
    setTranslationViewportProvider,
    toggleTranslation,
    viewModes,
    viewModeOf,
    setViewMode,
    toggleReading,
    presentationTabs,
    presentationOpenOf,
    openPresentation,
    closePresentation,
    recoveryDrafts,
    newDocument,
    openFiles,
    openPath,
    openWorkspace,
    openWorkspacePath,
    closeWorkspace,
    activate: (id: string) => dispatch({ type: "activate", id }),
    changeText,
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
    renameDocument,
  };
}
