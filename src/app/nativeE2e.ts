import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import type { DocumentPort } from "../document/DocumentPort";
import { normalizePathKey } from "../document/documentReducer";
import { detectPathPlatform } from "../document/platform";
import type {
  DocumentSnapshot,
  PathPlatform,
  RecoveryDraftInfo,
} from "../document/types";
import type { useAppController } from "./useAppController";

/**
 * Native end-to-end scenario runner.
 *
 * This module is compiled only into the dedicated native test build
 * (`vite build --mode native-e2e`) and is imported dynamically by AppShell
 * behind `import.meta.env.MODE === "native-e2e"`. It drives the real
 * controller and the real CodeMirror view over the real
 * TauriDocumentPort; an external Node orchestrator
 * (`scripts/native-e2e.mjs`) launches the process, mutates fixtures, reads
 * the marker/report files, and verifies on-disk bytes independently.
 *
 * Nothing here may be imported by normal application modules. The backend
 * only accepts a phase for markers and a report body: scenario, marker path,
 * and report path come from the orchestrator's process environment.
 */

export type NativeE2eScenario =
  | "smoke"
  | "edit-save"
  | "external-change"
  | "recovery";

export const NATIVE_E2E_SCENARIOS: ReadonlyArray<NativeE2eScenario> = [
  "smoke",
  "edit-save",
  "external-change",
  "recovery",
];

const SCENARIO_SET: ReadonlySet<string> = new Set(NATIVE_E2E_SCENARIOS);

export const isNativeE2eScenario = (
  value: unknown,
): value is NativeE2eScenario =>
  typeof value === "string" && SCENARIO_SET.has(value);

export const NATIVE_E2E_IDENTIFIER_SUFFIX = ".native-e2e";
export const NATIVE_E2E_PRODUCTION_IDENTIFIER = "com.xiongweini.markdown-edit";

/**
 * A native test run must never touch the production bundle's session or
 * recovery data. The backend validates this too; the frontend check fails
 * fast before any scenario side effect.
 */
export const assertNativeE2eIdentifier = (identifier: string): void => {
  if (
    identifier === NATIVE_E2E_PRODUCTION_IDENTIFIER ||
    identifier.length <= NATIVE_E2E_IDENTIFIER_SUFFIX.length ||
    !identifier.endsWith(NATIVE_E2E_IDENTIFIER_SUFFIX)
  ) {
    throw new Error(
      `native E2E refuses identifier ${JSON.stringify(identifier)}: ` +
        `it must end with ${NATIVE_E2E_IDENTIFIER_SUFFIX} and differ from production`,
    );
  }
};

/** True only in the dedicated native test build (`--mode native-e2e`). */
export const nativeE2eEnabled = (env: {
  readonly MODE?: unknown;
}): boolean => env.MODE === "native-e2e";

/**
 * Polls `read` until it returns a value other than `null`/`undefined`/
 * `false`. Timing only gates failures; every wait resolves on observed state
 * (a tab, a draft, a marker), never on a fixed sleep.
 */
export const waitFor = async <T>(
  read: () => T | null | undefined | false,
  timeoutMs = 30_000,
  pollMs = 50,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined && value !== false) return value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
};

const waitForAsync = async <T>(
  read: () => Promise<T | null | undefined>,
  timeoutMs: number,
  pollMs = 100,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
};

/** Canonical-path tab lookup, matching the controller's own tab matching. */
export const findTabByPath = (
  tabs: ReadonlyArray<DocumentSnapshot>,
  path: string,
  platform: PathPlatform,
): DocumentSnapshot | undefined => {
  const key = normalizePathKey(path, platform);
  return tabs.find(
    (tab) => tab.path !== null && normalizePathKey(tab.path, platform) === key,
  );
};

export interface NativeE2eContext {
  readonly scenario: string;
  readonly identifier: string;
}

/**
 * The only backend surface the runner uses. Implemented over Tauri commands
 * in the real app; tests can substitute a recorder.
 */
export interface NativeE2eTransport {
  context(): Promise<NativeE2eContext>;
  marker(phase: string): Promise<void>;
  report(report: Record<string, unknown>): Promise<void>;
}

/**
 * Real transport. Command names exist only when the `native-e2e` Cargo
 * feature is compiled in; the build flag and the feature are enabled
 * together by `scripts/native-e2e.mjs`.
 */
export const createTauriNativeE2eTransport = (): NativeE2eTransport => ({
  context: () => invoke<NativeE2eContext>("native_e2e_context"),
  marker: async (phase) => {
    await invoke("native_e2e_marker", { phase });
  },
  report: async (report) => {
    await invoke("native_e2e_report", { report });
  },
});

export interface NativeE2eHost {
  readonly port: DocumentPort;
  readonly controller: () => ReturnType<typeof useAppController>;
  readonly editorView: () => EditorView | null;
}

type Controller = ReturnType<typeof useAppController>;

const PATH_PLATFORM = detectPathPlatform();
// The scenario runner's own observation deadline. The orchestrator
// (`scripts/native-e2e.mjs`) waits `RUNNER_TIMEOUT_MS` plus a margin, so a
// runner timeout writes its precise failure report and "failed" marker before
// the orchestrator's generic phase timeout can fire.
const TIMEOUT_MS = 90_000;

/** Text appended through CodeMirror; the report carries the exact value so
 * the orchestrator never hardcodes it. */
export const NATIVE_E2E_EDIT_TOKEN = "\n\nnative-e2e-native-edit\n";

const findTabById = (
  host: NativeE2eHost,
  id: string,
): DocumentSnapshot | undefined =>
  host.controller().state.tabs.find((tab) => tab.id === id);

const requirePath = (tab: DocumentSnapshot): string => {
  if (tab.path === null) throw new Error(`native E2E tab ${tab.id} has no path`);
  return tab.path;
};

const openedDocument = (host: NativeE2eHost): {
  readonly tab: DocumentSnapshot;
  readonly view: EditorView;
} | null => {
  const tab = host.controller().state.tabs.find(
    (candidate) => candidate.path !== null,
  );
  const view = host.editorView();
  return tab && view ? { tab, view } : null;
};

const waitForOpenedDocument = (
  host: NativeE2eHost,
): Promise<{ readonly tab: DocumentSnapshot; readonly view: EditorView }> =>
  waitFor(() => openedDocument(host), TIMEOUT_MS);

/**
 * Appends text through the real CodeMirror view, so the editor's own update
 * listener (not a controller shortcut) produces the change the app saves.
 * The command is a user edit: it preserves every existing line ending and
 * the document's BOM flag, which the save path then writes back.
 */
const appendThroughEditor = (view: EditorView, token: string): void => {
  view.dispatch({ changes: { from: view.state.doc.length, insert: token } });
};

/**
 * CodeMirror represents every line break as `\n` internally, while the port
 * hands the controller the file's original text (`\r\n` for CRLF files).
 * The first editor transaction therefore produces a normalized buffer, which
 * the save path converts back to the document's stored newline style.
 */
export const normalizeNewlines = (text: string): string =>
  text.replace(/\r\n?/g, "\n");

const waitForTabText = (
  host: NativeE2eHost,
  id: string,
  predicate: (tab: DocumentSnapshot) => boolean,
): Promise<DocumentSnapshot> =>
  waitFor(() => {
    const tab = findTabById(host, id);
    return tab && predicate(tab) ? tab : null;
  }, TIMEOUT_MS);

const mark = (
  transport: NativeE2eTransport,
  phase: string,
): Promise<void> => transport.marker(phase);

const passedReport = async (
  transport: NativeE2eTransport,
  report: Record<string, unknown>,
): Promise<void> => {
  await transport.report({ status: "passed", ...report });
  // The marker is written after the report so a polling orchestrator that
  // observes `done` can immediately read a complete report.
  await mark(transport, "done");
};

const runSmoke = async (
  host: NativeE2eHost,
  transport: NativeE2eTransport,
): Promise<void> => {
  const opened = await waitForOpenedDocument(host);
  const path = requirePath(opened.tab);
  await mark(transport, "opened");
  // Report the controller's own tab state. Re-reading the file through the
  // port would only prove the disk still holds the fixture, not that the argv
  // handshake opened it into that tab. Waiting for non-empty text rejects a
  // placeholder tab before it can masquerade as a successful open.
  const tab = await waitForTabText(
    host,
    opened.tab.id,
    (current) => current.text.length > 0,
  );
  await passedReport(transport, {
    path,
    text: tab.text,
    hasUtf8Bom: tab.hasUtf8Bom,
    newline: tab.newline,
  });
};

const runEditSave = async (
  host: NativeE2eHost,
  transport: NativeE2eTransport,
): Promise<void> => {
  const { tab, view } = await waitForOpenedDocument(host);
  const path = requirePath(tab);
  const bom = tab.hasUtf8Bom;
  const newline = tab.newline;
  await mark(transport, "opened");

  const expectedText = normalizeNewlines(tab.text) + NATIVE_E2E_EDIT_TOKEN;
  appendThroughEditor(view, NATIVE_E2E_EDIT_TOKEN);
  await waitForTabText(
    host,
    tab.id,
    (current) => current.text === expectedText && current.status !== "clean",
  );

  const saved = await host.controller().save(tab.id);
  if (!saved) throw new Error("controller.save returned false");
  await waitForTabText(
    host,
    tab.id,
    (current) =>
      current.status === "clean" &&
      current.savedText === expectedText &&
      current.text === expectedText,
  );

  const disk = await host.port.openPath(path);
  const expectedDiskText =
    newline === "cr_lf"
      ? expectedText.replaceAll("\n", "\r\n")
      : expectedText;
  if (disk.text !== expectedDiskText) {
    throw new Error("saved file text does not match the edited buffer");
  }
  if (disk.hasUtf8Bom !== bom || disk.newline !== newline) {
    throw new Error(
      `save did not preserve BOM/newline (bom ${bom}->${disk.hasUtf8Bom}, ` +
        `newline ${newline}->${disk.newline})`,
    );
  }

  await passedReport(transport, {
    path,
    text: disk.text,
    editToken: NATIVE_E2E_EDIT_TOKEN,
    hasUtf8Bom: disk.hasUtf8Bom,
    newline: disk.newline,
  });
};

/**
 * The conflict dialog is rendered by AppShell only while the active tab is in
 * `conflict`; waiting for this exact dialog proves the visible UI (not just
 * reducer state) reached the user. The load-disk action is then clicked on
 * the rendered button, exercising its real React handler.
 */
const waitForConflictDialog = (): Promise<HTMLElement> =>
  waitFor(
    () =>
      document.querySelector<HTMLElement>(
        '[role="dialog"][aria-labelledby="conflict-dialog-title"]',
      ),
    TIMEOUT_MS,
  );

const clickLoadDiskVersion = (dialog: HTMLElement): void => {
  const button = [...dialog.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "载入磁盘版本",
  );
  if (!button) throw new Error("conflict dialog has no load-disk button");
  button.click();
};

/**
 * Marker-driven external-change scenario:
 *
 *   clean-ready    -> orchestrator rewrites the file
 *   clean-reloaded -> the watcher reloaded the clean tab from disk
 *   dirty-ready    -> orchestrator rewrites the file again
 *   conflict-visible -> the dirty tab surfaced the conflict dialog
 *   done           -> the dialog's "load disk version" action was applied
 *
 * The runner never sleeps: every phase transition is observed in controller
 * state, and the orchestrator drives each external write from the marker.
 */
const runExternalChange = async (
  host: NativeE2eHost,
  transport: NativeE2eTransport,
): Promise<void> => {
  const { tab, view } = await waitForOpenedDocument(host);
  const path = requirePath(tab);
  const initialText = tab.text;
  const initialVersion = tab.version;
  await mark(transport, "opened");
  await mark(transport, "clean-ready");

  const clean = await waitForTabText(
    host,
    tab.id,
    (current) =>
      current.status === "clean" &&
      current.text !== initialText &&
      current.version !== initialVersion,
  );
  await mark(transport, "clean-reloaded");

  const dirtyText = normalizeNewlines(clean.text) + NATIVE_E2E_EDIT_TOKEN;
  const syncedView = await waitFor(() => {
    const candidate = host.editorView();
    return candidate &&
      candidate.state.doc.toString() === normalizeNewlines(clean.text)
      ? candidate
      : null;
  }, TIMEOUT_MS);
  appendThroughEditor(syncedView, NATIVE_E2E_EDIT_TOKEN);
  await waitForTabText(
    host,
    tab.id,
    (current) => current.text === dirtyText && current.status === "dirty",
  );
  await mark(transport, "dirty-ready");

  const conflict = await waitForTabText(
    host,
    tab.id,
    (current) => current.status === "conflict",
  );
  if (conflict.text !== dirtyText) {
    throw new Error("conflict handling dropped the dirty buffer");
  }
  const conflictDialog = await waitForConflictDialog();
  await mark(transport, "conflict-visible");

  // Exercise the visible conflict dialog's "load disk version" action
  // through its rendered button and real React handler.
  const disk = await host.port.openPath(path);
  clickLoadDiskVersion(conflictDialog);
  const resolved = await waitForTabText(
    host,
    tab.id,
    (current) => current.status === "clean" && current.text === disk.text,
  );

  const onDisk = await host.port.openPath(path);
  await passedReport(transport, {
    path,
    cleanText: clean.text,
    dirtyText: conflict.text,
    resolvedText: resolved.text,
    diskText: onDisk.text,
    editToken: NATIVE_E2E_EDIT_TOKEN,
    conflictObserved: true,
    conflictDialogVisible: true,
  });
};

const persistedEditDraft = async (
  host: NativeE2eHost,
): Promise<{ info: RecoveryDraftInfo; text: string } | null> => {
  let drafts: ReadonlyArray<RecoveryDraftInfo>;
  try {
    drafts = await host.port.listDrafts();
  } catch {
    return null;
  }
  return findEditDraft(drafts, (draftId) => host.port.readDraft(draftId), NATIVE_E2E_EDIT_TOKEN);
};

/**
 * Finds the draft that carries this scenario's edit, using the id the
 * recovery store actually listed. Draft ids are namespaced per launch
 * (`draft-<uuid>-<tab id>`, see `src/recovery/drafts.ts`), so a relaunch can
 * never address the previous launch's draft by a derived or fixed id — only
 * by the id returned from `listDrafts()`. Unreadable or unrelated drafts are
 * skipped rather than failing the whole search.
 */
export const findEditDraft = async (
  drafts: ReadonlyArray<RecoveryDraftInfo>,
  read: (draftId: string) => Promise<{ readonly text: string }>,
  token: string,
): Promise<{ info: RecoveryDraftInfo; text: string } | null> => {
  for (const info of drafts) {
    try {
      const draft = await read(info.draftId);
      if (draft.text.includes(token)) {
        return { info, text: draft.text };
      }
    } catch {
      // A corrupt or already-discarded draft is simply not the one we wrote.
    }
  }
  return null;
};

/**
 * Recovery scenario, split across two launches of the same test build:
 *
 * First launch — no persisted draft: open the fixture through argv, edit
 * through CodeMirror, then poll the real recovery store until the draft
 * contains the edit and is readable. Write `draft-ready` and stay alive; the
 * orchestrator SIGKILLs the process once the marker appears.
 *
 * Relaunch — a draft with the edit token exists: wait for the controller's
 * launch recovery listing, restore through `controller.restoreDraft` (the
 * dialog's action), and verify the recovered tab is dirty and carries the
 * edited text.
 */
const runRecovery = async (
  host: NativeE2eHost,
  transport: NativeE2eTransport,
): Promise<void> => {
  const existing = await persistedEditDraft(host);
  if (existing === null) {
    const { tab, view } = await waitForOpenedDocument(host);
    requirePath(tab);
    await mark(transport, "opened");

    const expectedText = normalizeNewlines(tab.text) + NATIVE_E2E_EDIT_TOKEN;
    appendThroughEditor(view, NATIVE_E2E_EDIT_TOKEN);
    await waitForTabText(
      host,
      tab.id,
      (current) => current.text === expectedText && current.status === "dirty",
    );

    const persisted = await waitForAsync(
      () => persistedEditDraft(host),
      TIMEOUT_MS,
    );
    if (persisted.text !== expectedText) {
      throw new Error("persisted recovery draft does not match the edited text");
    }
    // The marker contract is fixed (scenario/phase/identifier), so the real
    // draft id travels in the report. The orchestrator uses it to locate the
    // store's `<draft_id>.json` file; deriving the id from the tab would name
    // a different launch namespace after the relaunch.
    await transport.report({
      status: "draft-ready",
      draftId: persisted.info.draftId,
      draftCharacters: persisted.text.length,
    });
    await mark(transport, "draft-ready");
    // The orchestrator owns termination here: it kills the process after
    // observing draft-ready, which is what makes the relaunch a real crash
    // recovery rather than a graceful close.
    await new Promise<never>(() => {});
    return;
  }

  const listed = await waitFor(
    () => host.controller().recoveryDrafts,
    TIMEOUT_MS,
  );
  const info =
    listed.find((candidate) => candidate.draftId === existing.info.draftId) ??
    listed.find(
      (candidate) =>
        candidate.originalPath !== null &&
        existing.info.originalPath !== null &&
        normalizePathKey(candidate.originalPath, PATH_PLATFORM) ===
          normalizePathKey(existing.info.originalPath, PATH_PLATFORM),
    );
  if (!info) throw new Error("controller did not list the persisted draft");

  await mark(transport, "draft-listed");
  await host.controller().restoreDraft(info);

  const restored = await waitFor(() => {
    const tabs = host.controller().state.tabs;
    const owner =
      info.originalPath === null
        ? tabs.find((tab) => tab.path !== null)
        : findTabByPath(tabs, info.originalPath, PATH_PLATFORM);
    return owner && owner.text.includes(NATIVE_E2E_EDIT_TOKEN) ? owner : null;
  }, TIMEOUT_MS);
  const restoredDirty = restored.status !== "clean";
  if (!restoredDirty) {
    throw new Error("restored draft landed as a clean document");
  }
  await mark(transport, "restored");
  await passedReport(transport, {
    path: restored.path,
    text: restored.text,
    editToken: NATIVE_E2E_EDIT_TOKEN,
    // Report the real reducer status; the orchestrator requires "dirty" and
    // must not trust a constant. `documentStatus` avoids colliding with the
    // report envelope's own "passed"/"failed" status.
    dirty: restoredDirty,
    documentStatus: restored.status,
    draftId: info.draftId,
  });
};

let started = false;

/**
 * Starts the scenario selected by the backend context. Idempotent within a
 * document: React StrictMode's development double-effect must not run two
 * scenarios.
 */
export const runNativeE2e = async (
  host: NativeE2eHost,
  transport: NativeE2eTransport = createTauriNativeE2eTransport(),
): Promise<void> => {
  if (started) return;
  started = true;
  try {
    const context = await transport.context();
    assertNativeE2eIdentifier(context.identifier);
    if (!isNativeE2eScenario(context.scenario)) {
      throw new Error(
        `unsupported native E2E scenario ${JSON.stringify(context.scenario)}`,
      );
    }
    switch (context.scenario) {
      case "smoke":
        return await runSmoke(host, transport);
      case "edit-save":
        return await runEditSave(host, transport);
      case "external-change":
        return await runExternalChange(host, transport);
      case "recovery":
        return await runRecovery(host, transport);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await transport.report({ status: "failed", error: message });
      await mark(transport, "failed");
    } catch {
      // Diagnostics are best-effort; the orchestrator also captures stderr.
    }
    throw error;
  }
};
