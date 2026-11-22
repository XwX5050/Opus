# Native Reliability and Production Performance Implementation Plan

> **Status (2026-11-21):** implementation is present in the working tree.
> Checked items are backed by files and locally completed checks: the full
> Vitest suite (59 files / 1564 tests, including the core-grammar editor
> tests), the Node script tests (33), the `native-e2e` Rust unit tests (11),
> both the normal and perf builds, `cargo fmt --check`, default `cargo check`,
> clippy with and without the `native-e2e` feature, and the latest recorded
> macOS native all-scenario run
> (`test-results/native-e2e/run-2026-11-20T22-38-07-511Z`: smoke, edit-save,
> external-change, recovery all passed). Browser E2E is not green: 31 passed,
> 1 failed in `tests/e2e/tableClipboard.spec.ts` (reading-mode selection copy),
> left unfixed as unrelated. A complete production `npm run perf` has since
> succeeded and refreshed `tests/perf/report.json`; the baseline table now
> copies it. Unchecked items are the two TDD-red checkpoints (historical, not
> re-verified) and the final end-to-end gate. None of those is claimed as
> passing; no Linux or Windows native run is claimed here.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real native workflow automation, extract save/recovery orchestration into tested modules, and measure browser performance from a production frontend bundle.

**Architecture:** A feature-gated native test runner drives the real Tauri port while an external Node process verifies disk effects. Four pure TypeScript modules own save/external-change/draft/restore contracts while the controller remains the React adapter. A separate production-only perf entry and Vite config produce an isolated browser benchmark bundle.

**Tech Stack:** React 19, strict TypeScript, CodeMirror 6, Vitest, Playwright, Node.js 22, Tauri 2, Rust, Vite 8.

---

## File map and ownership

### Native automation

- Create `src-tauri/src/native_e2e.rs`: feature-gated config/marker/report commands.
- Create `src-tauri/tauri.native-e2e.conf.json`: isolated test identifier and build settings.
- Create `src/app/nativeE2e.ts`: native scenario runner and pure waiting helpers. The dedicated test build uses `vite build --mode native-e2e`; no `.env` file is created or committed.
- Create `src/app/nativeE2e.ts`: native scenario runner and pure waiting helpers.
- Create `src/app/nativeE2e.test.ts`: helper tests.
- Create `scripts/native-e2e.mjs`: process orchestration and external assertions.
- Modify `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src/app/AppShell.tsx`, `src/app/updates.ts`.

### Save and recovery

- Create `src/document/saveFlow.ts` and `src/document/saveFlow.test.ts`.
- Create `src/document/externalChanges.ts` and `src/document/externalChanges.test.ts`.
- Create `src/recovery/draftScheduler.ts` and `src/recovery/draftScheduler.test.ts`.
- Create `src/recovery/restoreDraft.ts` and `src/recovery/restoreDraft.test.ts`.
- Modify `src/app/useAppController.ts` only after all four modules pass their standalone tests.

### Production performance

- Create `perf.html`, `vite.perf.config.ts`, `src/perf/main.tsx`.
- Create `src/app/demoPort.ts` and `src/app/demoPort.test.ts`.
- Modify `src/app/App.tsx`, `src/editor/MarkdownEditor.tsx`, `scripts/measure-editor.mjs`.
- Refresh `tests/perf/report.json` only through a successful real run.

### Integration

- Modify `package.json`, `.gitignore`, `.github/workflows/ci.yml`.
- Update `docs/testing.md`, `docs/performance.md`, `docs/releasing.md`, `AGENTS.md`.
- Do not edit unrelated product modules or create a git commit.

### Task 1: Feature-gated native command support

**Files:** native command/config files listed above; no frontend runner yet.

- [x] Write Rust tests for environment-only configuration, non-production identifier validation, and atomic marker/report writes.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml native_e2e` and confirm the new tests fail because the module does not exist.
- [x] Implement `native_e2e.rs` with `NativeE2eConfig { scenario, report_path, marker_path, identifier }`; read paths only from process environment and serialize reports through sibling-temp-file-plus-rename writes.
- [x] Add the `native-e2e` Cargo feature and conditionally register commands in `lib.rs` with `#[cfg(feature = "native-e2e")]`.
- [x] Add a Tauri override whose identifier is `com.xiongweini.markdown-edit.native-e2e` and whose product name is visibly non-production. The frontend build uses `vite build --mode native-e2e`; the runner gates on `import.meta.env.MODE === "native-e2e"`, so no `.env` file is needed or committed.
- [x] Run Rust fmt, the focused tests, and a normal `cargo check --manifest-path src-tauri/Cargo.toml`; normal builds must compile without the feature.

Required marker contract:

```json
{
  "scenario": "edit-save",
  "phase": "draft-ready",
  "identifier": "com.xiongweini.markdown-edit.native-e2e"
}
```

The command must reject a missing/invalid test environment and must never accept a webview-supplied arbitrary output path.

### Task 2: Native scenario runner

**Files:** `src/app/nativeE2e.ts`, its tests, `AppShell.tsx`, `updates.ts`.

- [x] Write failing Vitest cases for timeout polling, canonical-path tab matching, and scenario-name validation.
- [x] Implement small pure helpers and the runner interface below.

```ts
export interface NativeE2eHost {
  port: DocumentPort;
  controller: () => ReturnType<typeof useAppController>;
  editorView: () => EditorView | null;
}

export const waitFor = async <T>(
  read: () => T | null | undefined | false,
  timeoutMs = 30_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
```

The runner must not be exported from normal application modules.

- [x] Implement `edit-save`: wait for the argv-opened tab, dispatch a CodeMirror transaction, call `controller.save(id)`, and report the canonical path and saved text.
- [x] Implement `external-change`: verify clean reload; then create a dirty tab, perform an external write requested through the marker/report handshake, and exercise the visible conflict dialog.
- [x] Implement `recovery`: edit, poll `port.listDrafts()` until the expected text is durable, emit `draft-ready`, then on relaunch restore through the actual recovery UI/controller and report the restored dirty text.
- [x] Start the runner through a dynamic import guarded by `import.meta.env.MODE === "native-e2e"`; normal production builds must tree-shake it.
- [x] Disable update checks in this test mode and run `npm test -- src/app/nativeE2e.test.ts src/app/App.test.tsx` plus `npm run build`.

### Task 3: External native orchestrator

**Files:** `scripts/native-e2e.mjs`, package/CI integration deferred to Task 10.

- [x] Implement CLI parsing for `--build`, `--release`, `--scenario smoke|all|edit-save|external-change|recovery`, `--app <path>`, `--keep-data`, and `--verbose`.
- [x] Build with `tauri build --debug --no-bundle --features native-e2e --config src-tauri/tauri.native-e2e.conf.json`; select the platform binary explicitly.
- [x] Create fixtures under the OS temp directory, launch the real binary with a fixture argv and isolated environment, and always clean up child processes in `finally`.
- [x] Verify saved bytes externally: UTF-8 BOM remains `EF BB BF`, every newline remains CRLF, and the inserted text occurs exactly once.
- [x] Drive external writes and process termination/relaunch from Node; use marker files for synchronization rather than fixed sleeps.
- [x] Write diagnostics to `test-results/native-e2e/` and exit nonzero on timeout, assertion failure, unexpected identifier, or invalid report.
- [x] Run `node scripts/native-e2e.mjs --build --scenario smoke` on macOS and confirm real native success; record any platform limitation explicitly instead of substituting a browser test. Superseded by the all-scenario run recorded in `test-results/native-e2e/run-2026-11-20T22-38-07-511Z` (smoke, edit-save, external-change, recovery all passed).

### Task 4: Save flow extraction

**Files:** `src/document/saveFlow.ts`, `src/document/saveFlow.test.ts`; controller integration occurs in Task 8.

- [x] Write failing tests using the real reducer and deferred port promises for: frozen-request identity, same-tab reentrancy, concurrent different-tab saves, chooser cancellation, target collision, write-result conflict, close/standalone failure routing, stale completion, and retarget notification.
- [ ] Run `npm test -- src/document/saveFlow.test.ts` and confirm import failure before implementation.
- [x] Implement these public types and the flow without React imports.

```ts
export type SaveIntent = "save" | "save-as" | "close";
export type SaveOutcome =
  | { kind: "saved"; tabId: string; retargeted: boolean }
  | { kind: "skipped" | "cancelled" | "blocked" | "stale" | "target-conflict" | "write-conflict" }
  | { kind: "failed"; error: DocumentPortError };

export interface SaveFlow {
  save(id: string | undefined, intent: SaveIntent): Promise<SaveOutcome>;
  isSaving(id: string): boolean;
}
```

The host interface must expose reducer application, current state, lifecycle checks, target selection, write, translation visibility, error/banner reporting, and new-path notification. The flow passes the reducer's `pendingSave` object to `write` with reference identity unchanged.

- [x] Run the focused tests and existing reducer tests until green.

### Task 5: External-change policy extraction

**Files:** `src/document/externalChanges.ts`, `src/document/externalChanges.test.ts`.

- [x] Write failing tests for changed/missing/moved decisions, self-save echo suppression, pending-save suppression, unknown paths, normalized path/version guards, not-found classification, and stale reads after Save As/rename.
- [x] Implement pure `findTabByPath`, `parentPathKey`, `isReadCommitCurrent`, `decideDiskEvent`, and async `readCurrentDiskVersion` using existing document types and `normalizePathKey`.
- [x] Keep scope/watch and dispatch side effects outside the module.
- [x] Run `npm test -- src/document/externalChanges.test.ts src/document/documentReducer.test.ts`.

### Task 6: Draft scheduler extraction

**Files:** `src/recovery/draftScheduler.ts`, `src/recovery/draftScheduler.test.ts`.

- [x] Write fake-timer tests for 2-second debounce, 5-second maximum pending, independent tabs, latest-text reads, unchanged `{status,text}` references plus scalar metadata (path, title, BOM, newline, version), failure re-arming, clean/closed discard, flush, and StrictMode-style timer cancellation/reuse.
- [x] Implement the scheduler with this contract.

```ts
export interface DraftScheduler {
  sync(tabs: ReadonlyArray<DocumentSnapshot>): void;
  flush(): Promise<void>;
  markPersisted(tabId: string): void;
  unmarkPersisted(tabId: string): void;
  cancelTimers(): void;
}
```

The host supplies `getTabs`, `writeDraft`, and `discardDraft`. Timer callbacks re-read current tabs. `flush` awaits all current writes but does not reject for one failed write. No document-text concatenation or copying is allowed.

- [x] Run `npm test -- src/recovery/draftScheduler.test.ts src/recovery/drafts.test.ts`.

### Task 7: Draft restoration transaction extraction

**Files:** `src/recovery/restoreDraft.ts`, `src/recovery/restoreDraft.test.ts`.

- [x] Write call-order tests for owner-ready → owner-write → leftover-discard, identical IDs, owner-write failure, clean owner, refused restore, missing/read errors, stale after read, normalized-path merge, and ignored discard failure.
- [x] Implement a never-rejecting restore function returning `restored | refused | missing | error | stale` outcomes.
- [x] Reuse `draftFromSnapshot`, `draftIdForTab`, `needsRecoveryDraft`, and `normalizePathKey`; do not duplicate draft ID or dirty-state rules.
- [x] Run `npm test -- src/recovery/restoreDraft.test.ts src/recovery/drafts.test.ts`.

### Task 8: Controller integration

**Files:** `src/app/useAppController.ts`; existing controller/AppShell tests are compatibility gates.

- [x] Add characterization coverage only where current behavior is not already tested: same-tab chooser reentrancy, save/save-as translation asymmetry, close-save failure, unchanged-path scope behavior, and stale restore after unmount.
- [x] Replace save orchestration with `SaveFlow`, retaining close-dialog latches and public `save`, `saveAs`, `retrySave`, and `saveErrorSaveAs` signatures.
- [x] Replace disk-event decisions and guarded reads with `externalChanges`, leaving scope/watch callbacks in the controller.
- [x] Replace the draft refs/effect/flush implementation with one scheduler instance; wire restore marking through the same scheduler.
- [x] Replace restore transaction internals while keeping `restoreDraft(info): Promise<void>` and existing UI timing.
- [x] Run `npm test -- src/app/useAppController.test.tsx src/app/AppShell.test.tsx src/document/documentReducer.test.ts src/recovery/drafts.test.ts`; every listed compatibility suite must run and pass.
- [x] Run all frontend tests and the production build; no behavior change is intended.

### Task 9: Production performance entry and build

**Files:** `perf.html`, `vite.perf.config.ts`, `src/perf/main.tsx`, `src/app/demoPort.ts`, its test, `App.tsx`, `MarkdownEditor.tsx`.

- [x] Move demo fixture construction verbatim into `demoPort.ts`; write tests for basename-only fixture lookup, missing-fixture errors, and workspace session construction.
- [x] Add the separate perf HTML entry which constructs the shared demo port and calls `createApp(port, { browserShell: true })` under React production.
- [x] Configure `vite.perf.config.ts` with `mode: "perf"`, `build.outDir: "dist-perf"`, `build.rollupOptions.input: "perf.html"`, and an assertion that `config.isProduction` is true.
- [x] Add preview middleware which serves only `/tests/perf/generated/<basename>.md`, rejects traversal/other suffixes, and sets `Cache-Control: no-store`.
- [x] Change the editor-ready mark gate to `import.meta.env.DEV || import.meta.env.MODE === "perf"`.
- [x] Run unit tests and both builds; assert `dist/perf.html` does not exist and `dist-perf/perf.html` does exist.

### Task 10: Production performance measurement and reporting

**Files:** `scripts/measure-editor.mjs`, `package.json`, `.gitignore`, `tests/perf/report.json`.

- [x] Replace the default dev-server channel with build-plus-strict-preview on port 1422; retain `--browser dev` as an explicit diagnostic mode writing `report.dev.json`.
- [x] Ensure every spawned server/process group is stopped in `finally`, and build/preview/mark failures exit nonzero before writing the committed report.
- [x] Add `source` to every metric and top-level browser provenance containing mode, React environment, entry, server, viewport, build asset SHA-256, and fixture byte counts/SHA-256 values.

```json
{
  "source": "browser-production",
  "provenance": {
    "browser": {
      "source": "production-bundle",
      "reactEnvironment": "production",
      "appEntry": "perf.html",
      "server": "vite preview"
    }
  }
}
```

- [x] Keep metric names, budgets, judgment fields, and packaged-app hot/cold/Gatekeeper behavior unchanged; `hot_start_ms.source` is `packaged-app`.
- [x] Add package commands for perf build/serve/native tests and ignore `dist-perf/` plus diagnostic reports.
- [x] Run `npm run perf` and inspect actual results. Refresh `report.json` and the baseline table only from this run; do not tighten budgets in this task. The successful report records Chromium production-frontend numbers; hot/cold/Gatekeeper remain skipped.

### Task 10b: Extreme-document core Markdown grammar (follow-up)

**Files:** `src/editor/performanceMode.ts`, `src/editor/editorExtensions.ts`, `src/editor/MarkdownEditor.tsx`, `src/editor/outlineExtension.ts`, `src/app/AppShell.tsx`, their tests.

- [x] Add `markdownSyntaxFor` with an 8 MiB UTF-16 enter threshold and a 7.5 MiB exit threshold (hysteresis); keep the full grammar for normal mode, 2 MiB/50,000-line light documents, and force-full.
- [x] Add `markdownLanguageExtension("core")`: keep frontmatter and the base Markdown grammar used by the outline; remove GFM, highlight, math, and `codeLanguages` nested-language highlighting while keeping fenced code as code.
- [x] Switch grammars through a `Compartment.reconfigure` (never a new `EditorView`), preserving selection and undo history; freeze a requested switch during IME composition until `compositionend` with a polling fallback; re-extract the outline on `transaction.reconfigured`.
- [x] Keep table widgets' independent 1,000-cell rule (`LIGHT_MODE_TABLE_CELL_LIMIT`) for the full grammar; core removes GFM `Table` nodes, so core makes no table promise. Add 精简 Markdown 语法 to the banner at or above the 8 MiB enter threshold.
- [x] Add focused tests for thresholds/hysteresis, 2 MiB staying full, core-vs-full syntax trees, one view/selection/undo across a switch, the composition freeze, and outline re-extraction.
- [x] Full frontend suite passes: 59 files / 1564 tests; focused editor suites 68/68; latest recorded native all-scenario run `run-2026-11-20T22-38-07-511Z` passed all four scenarios.
- [x] Run a complete `npm run perf` and refresh `tests/perf/report.json` plus the baseline table only from that run. The report records the pressure fixture (8,764,408 UTF-16 units) under core; browser numbers are Chromium production-frontend, and hot/cold/Gatekeeper remain skipped.
- [ ] Final full gate (`npm test`, `npm run test:node`, `npm run test:e2e`, native all, `npm run perf`, fmt/clippy/tests) remains pending; do not mark it complete until every part passes.

### Task 11: CI, documentation, and final verification

**Files:** `.github/workflows/ci.yml`, testing/performance/release docs, `AGENTS.md`.

- [x] Add a Linux native-smoke CI job using the existing WebKitGTK dependencies plus `xvfb`; upload `test-results/native-e2e/` on failure. Add macOS/Windows jobs only after their real commands pass locally or in CI.
- [x] Add a perf-build CI gate so the production benchmark entry cannot rot; keep timing measurements on a controlled runner rather than noisy per-PR virtual machines.
- [x] Document exact commands, test identifier isolation, uncovered manual scenarios, production/dev provenance, and report policy.
- [x] Update `AGENTS.md` wherever module lists, commands, E2E limitations, or performance descriptions changed.
- [ ] Run `npm test`, `npm run build`, Rust fmt/clippy/tests, `npm run test:e2e`, native smoke, and `npm run perf`. The latest native all run and the complete perf run are recorded, but browser E2E has one unrelated failure, so the full gate stays unchecked.
- [x] Inspect `git status --short`; remove only artifacts created by this work that are not deliverables. Report every check actually run and every platform/scenario left unverified.

