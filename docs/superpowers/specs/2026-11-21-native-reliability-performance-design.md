# Native Reliability and Production Performance Design

Date: 2026-11-21
Status: Approved scope; implementation assumptions recorded below

Implementation status (2026-11-21): the three changes plus the
extreme-document core grammar exist in the working tree. Locally completed:
the full Vitest suite (59 files / 1564 tests), the Node script tests, the
`native-e2e` Rust unit tests, both the normal and perf builds,
`cargo fmt --check`, default `cargo check`, clippy with and without the
`native-e2e` feature, and the latest recorded macOS native all-scenario run
(`run-2026-11-20T22-38-07-511Z`). Browser E2E is not green: 31 passed, 1
failed in `tests/e2e/tableClipboard.spec.ts` (reading-mode selection copy),
left unfixed as unrelated. The complete production `npm run perf` run has
since refreshed `tests/perf/report.json` and the baseline table; the
Linux/Windows native runs and the final full gate are still pending. None of
those is represented as passing in the docs. See the companion plan for the
exact checked/unchecked state.

## Context

Opus already has lossless document I/O, reducer-level concurrency protection,
recovery drafts, browser-shell E2E, and performance budgets. The remaining
reliability gaps are at the seams: browser E2E uses an in-memory port, the
save/recovery orchestration is concentrated in a large React hook, and browser
performance numbers come from a development build.

This design covers three coordinated changes:

1. Exercise the real Tauri backend in a real native webview process.
2. Extract save, external-change, draft-scheduling, and draft-restoration
   contracts into independently testable modules.
3. Measure browser metrics from a production React bundle while preserving
   packaged-app startup measurements.

## Decisions and alternatives

### Native automation

Use an application-in-process scenario runner plus an external Node orchestrator.
The runner drives the real controller and CodeMirror view through the real
`TauriDocumentPort`; the orchestrator launches and restarts the native process,
modifies fixture files, and independently verifies on-disk bytes and reports.

A Cargo feature and a separate Vite mode compile the runner only into a dedicated
test build. A separate Tauri identifier isolates session and recovery data from
the user's installation. The Rust test commands accept no arbitrary output paths
from the webview: marker/report paths come from the orchestrator's environment.

Do not introduce WebDriver/WebdriverIO in this iteration. It adds driver and
framework dependencies and has uneven macOS support. Do not extend the existing
MemoryDocumentPort E2E mode: that would not exercise the native seam. Native file
panels, OS file associations, IME, and signed-installer acceptance remain manual.

### Save and recovery boundaries

Extract four modules with no React dependency:

- `src/document/saveFlow.ts`: per-tab save mutual exclusion, target selection,
  reducer-owned frozen write requests, completion classification, and failure
  routing for save/save-as/close-save intents.
- `src/document/externalChanges.ts`: disk-event decisions and guarded disk reads.
- `src/recovery/draftScheduler.ts`: per-tab debounce/max-pending scheduling,
  reference-based signatures, flush, and persisted-draft bookkeeping.
- `src/recovery/restoreDraft.ts`: read/adopt/write-owner/discard-leftover ordering.

`useAppController` remains the React adapter and retains lifecycle generations,
scope/watch sequencing, close-dialog state, user-visible state, and its complete
public API. Reducer invariants remain in `documentReducer`; they are not duplicated
in the new modules.

Do not create a single large persistence manager, and do not rewrite the close
dialog or reducer. Those approaches either move the same coupling elsewhere or
expand the regression surface without improving the core contracts.

### Production browser performance

Build a separate `perf.html` entry with a dedicated Vite config into `dist-perf/`.
The entry shares demo-fixture construction with the development demo but directly
injects a MemoryDocumentPort through `createApp`. The normal `index.html` entry,
normal production build, and `App.tsx` runtime port selection remain unchanged.

Serve the production bundle through localhost-only `vite preview`; a narrowly
scoped middleware serves only basename-addressed generated Markdown fixtures.
The editor-ready performance mark is enabled in DEV and the dedicated `perf`
mode only. The normal production build does not include the perf entry or mark.

Keep the existing metric names and budgets for this protocol change. Add explicit
browser/packaged-app provenance and fixture/asset hashes. Browser setup failures
must fail without overwriting the last committed report. Development-browser
measurements remain available as an opt-in diagnostic channel and write a separate
report.

Do not enable `?demo=1` in production, reuse the E2E fixture global, or measure
production through DOM observers. Those alternatives either widen test backdoors
or change the metric definition.

#### Extreme-document core grammar

Light mode still starts at 2 MiB of UTF-8 text or 50,000 lines. Inside light
mode, an extreme document switches the **syntax grammar** to a core profile:

- Enter at **8 MiB of UTF-16 code units** of the original text; leave only at
  **7.5 MiB or below**. The 0.5 MiB hysteresis prevents parser reconfiguration
  while typing at the boundary.
- Normal mode, documents that only cross the 2 MiB/50,000-line light threshold,
  and **继续完整渲染** (force-full) always keep the full grammar.
- Core retains frontmatter and the base Markdown grammar needed by the outline
  (headings, lists, quotes, indented/fenced code, emphasis, links). It removes
  the GFM, highlight, and math syntax extensions and does not load nested
  fenced-code language grammars; fenced blocks still parse as code without
  language-specific highlighting.
- The grammar lives in a CodeMirror `Compartment`. Switching uses
  `reconfigure`, never a new `EditorView`: selection, undo history, and the
  mounted DOM survive. A switch requested during IME composition is frozen
  until `compositionend` (with a polling fallback); the outline publisher
  re-extracts headings on `transaction.reconfigured`.
- Table widgets depend on GFM's `Table` node. Their independent light-mode
  rule (1,000 rendered cells) applies while the full grammar is active; core
  removes GFM and therefore produces no table widgets. The implementation must
  not promise table rendering or the cell budget for a document in core.
- The light-mode banner states that an extreme document uses 精简 Markdown
  syntax; the text content is never changed.

This targets the synchronous language-state catch-up that the temporary
production diagnostics show dominating document-end input latency on the
pressure fixture. The fixture (8,764,408 UTF-16 code units) genuinely enters
core; the 1 MiB and 2 MiB fixtures stay full.

## Native scenarios and data flow

The initial native suite covers:

1. Launch with a fixture path through the real argv/open-path handshake.
2. Edit through CodeMirror and save through the controller and Rust command.
3. Verify UTF-8 BOM and CRLF preservation from external disk reads.
4. Modify a file externally and verify watcher/event/controller behavior,
   including clean reload and dirty conflict handling.
5. Wait until a recovery draft is actually persisted, terminate the process,
   relaunch with the isolated identifier, restore the draft, and verify the dirty
   document and its text.

The orchestrator owns timeouts, process cleanup, temporary fixtures, report
collection, and failure diagnostics. It must never delete data unless the resolved
test identifier has the dedicated test suffix. Normal builds do not register
native-test commands or import the frontend runner.

## State invariants

The following are compatibility requirements, not optional implementation details:

- A tab can have only one active save flow; the lock is acquired before the first
  await and released in `finally`.
- The exact frozen `PendingWriteRequest` object produced by the reducer is passed
  to `DocumentPort.write` without copying.
- Every asynchronous completion checks lifecycle currency before committing.
- Guarded external reads require matching normalized path and expected version.
- Save/save-as/close-save preserve their current translation guards and distinct
  error-dialog/banner behavior.
- Scope/watch redirection remains serialized in the controller.
- Draft signatures retain `{status, text}` reference comparisons plus scalar
  metadata (path, title, BOM, newline, version) and never copy document-sized
  strings.
- Draft discard remains fire-and-forget where command FIFO ordering is required.
- Recovery writes the owner's fresh copy before discarding the leftover draft;
  identical owner/leftover IDs are never discarded, and owner-write failure keeps
  the leftover.
- React StrictMode cleanup cancels timers without permanently disabling a
  scheduler that is used again.

## Performance protocol

`npm run perf` builds the dedicated production bundle on every run, starts a
strict-port preview server, measures open/input/save/sidebar metrics in headless
Chromium, stops the server, and then retains the existing packaged-app startup
measurement behavior. Chromium results remain labeled as browser-engine results,
not WKWebView results.

The committed `tests/perf/report.json` is refreshed only from a real successful
run, and the baseline table is copied from it. Cold start and signed Gatekeeper
samples remain explicitly skipped until genuinely collected; no values are
invented.

## Testing and verification

Each new state module receives focused unit tests before controller integration.
Existing controller, AppShell, reducer, and recovery tests must pass unchanged
unless a test explicitly targets the new module boundary.

The core grammar receives focused editor tests: threshold and hysteresis
boundaries, a 2 MiB light document staying full, core-vs-full syntax trees,
one view/selection/undo across a switch, the composition freeze until
`compositionend`, and outline re-extraction on reconfigure. The full Vitest
suite and the latest recorded native all-scenario run
(`run-2026-11-20T22-38-07-511Z`) and the complete `npm run perf` report
are evidence for those layers; browser E2E and the complete final gate
remain separate checks.

Native runner helpers receive unit tests where practical, but acceptance requires
running the actual native process and externally checking its disk effects.
Production performance acceptance requires both a real perf build and a complete
measurement run, plus a normal production build proving the perf entry is absent.

Final gates:

```sh
npm test
npm run test:node
npm run build
npm run perf:build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml --features native-e2e -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --features native-e2e --lib native_e2e
npm run test:e2e
npm run test:native -- --build
npm run perf
```

At the time of writing, the full Vitest suite (1564 tests), Node script tests,
`native-e2e` Rust unit tests, both builds, `cargo fmt --check`, default
`cargo check`, and clippy (both feature sets) pass locally, and the latest
recorded macOS native all-scenario run
(`run-2026-11-20T22-38-07-511Z`) passed. Browser E2E is not green: 31 passed,
1 failed in `tests/e2e/tableClipboard.spec.ts`. The complete `npm run perf`
run has refreshed the report and baseline; the final full gate has not been
executed end to end. Any platform-specific gate that cannot run in the
current environment is reported as unverified rather than represented as
passing.

## Assumptions

- The user-approved scope authorizes implementation without adding cloud,
  collaboration, export, or unrelated product features.
- A dedicated unsigned test build is acceptable for native automation; it does
  not replace final signed/notarized release acceptance.
- Existing performance budget numbers remain unchanged during this protocol
  migration and the core-grammar work; the official baseline is refreshed only
  by a complete successful `npm run perf` run.
- Test and performance artifacts use established ignored output directories;
  generated reports needed as baselines remain committed files.
- No git commit is created unless the user explicitly requests one.
