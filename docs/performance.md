# Performance

Budgets, measurement protocol, and the current baseline for large-document
performance. The release benchmark is `npm run perf`; it builds the dedicated
production perf bundle, measures it through a local preview server, writes
`tests/perf/report.json`, and exits non-zero when a measured budget fails.
Budgets are unchanged by the protocol and core-grammar work: only the
provenance of the browser numbers changed (development build → production
bundle) and the extreme-document grammar was reduced.

## Light mode and core Markdown grammar

Documents larger than **2 MiB of UTF-8 text** or **50,000 lines** open in
light mode (`modeFor` in `src/editor/performanceMode.ts`). Light mode still
parses Markdown, keeps selection, search, and visible-range text styling, and
pauses offscreen image creation and nonessential block widgets (math
rendering, image widgets) through the live-preview CodeMirror compartment.
It never changes document text.

Within light mode, an **extreme document** additionally switches from the
full Markdown grammar to the **core** grammar once its original text reaches
**8 MiB of UTF-16 code units** (`REDUCED_SYNTAX_MIN_LENGTH`; the light-mode
and banner decision uses the tab's original text, while the editor applies
the grammar to the text it is rendering). It returns to
full only when the text drops to **7.5 MiB or less**
(`REDUCED_SYNTAX_EXIT_LENGTH`) — a 0.5 MiB hysteresis that keeps an edit
hovering at the boundary from reconfiguring the parser repeatedly.
`markdownSyntaxFor` always returns `full` when the mode is `full`, so normal
documents, documents that only cross the 2 MiB / 50,000-line light threshold,
and **继续完整渲染** (force-full) keep the full grammar.

Core keeps frontmatter plus the base Markdown grammar behind the outline —
headings, lists, quotes, indented/fenced code, emphasis, and links — and the
outline is re-extracted whenever the grammar is reconfigured. It drops the
GFM, highlight (`==`), and math syntax extensions, and it does not load
nested fenced-code language grammars (`codeLanguages`): a fenced block still
parses as code, without language-specific highlighting inside. Frontmatter
stays because without it the closing delimiter can be read as a pseudo Setext
heading and pollute the outline.

The switch uses `Compartment.reconfigure`, never a new `EditorView`: the
mounted DOM, selection, and undo history survive. A reconfigure requested
while the IME is composing is frozen until `compositionend` (with a polling
fallback for a missed event), because dispatching it mid-composition can pin
WebKitGTK's preedit caret.

Table widgets are independent of the grammar switch but depend on GFM's
`Table` syntax node. The 1,000-cell light-mode budget
(`LIGHT_MODE_TABLE_CELL_LIMIT`) therefore applies when the full grammar is
active — including 2 MiB/50,000-line light documents and **继续完整渲染** —
and tables over it stay raw editable Markdown. Core removes GFM, so it
produces no table widgets at all; do not promise table rendering or the
cell budget for a document that is in core.

Evaluation is bounded so typing never pays an O(document) scan
(`src/app/usePerformanceMode.ts`): opening or switching to a tab
classifies synchronously (once per open, so a light document never mounts
full widgets even for one frame); documents decidable from length alone
(over 2 MiB of UTF-16 units, or under 50,000) classify in O(1) on every
render; in-band edits re-evaluate only after typing pauses (200 ms
debounce). The debounce can delay pausing widgets when an in-band document
crosses the 2 MiB / 50,000-line light threshold; the core grammar decision
follows the rendered text length directly (only IME composition defers it).
Neither changes text or correctness, and the hysteresis prevents thrash at
the 8 MiB edge. The banner adds
**使用精简 Markdown 语法** when the original text is at or above the 8 MiB
enter threshold; below that it shows the shorter light-mode text while core
finishes exiting by 7.5 MiB.

## Budgets (M1 / 8 GB baseline)

| Metric | Budget | Judged on |
| --- | --- | --- |
| Hot start (process → editable) | 1 s | median of 5 |
| Cold start (process → editable) | 2 s | median of 5 |
| Regular open (1 MiB → editor) | 1 s | median of 5 |
| Pressure open (10 MiB → editor) | 3 s | median of 5 |
| Input latency, regular doc | 32 ms | p95 |
| Input latency, pressure doc | 50 ms | p95 |
| Pressure save | 1 s | median of 5 |
| Sidebar interactive | — | informational |
| Gatekeeper first launch | — | informational (recorded separately) |

## Running the benchmark

```sh
npm run perf:fixtures   # deterministic fixtures → tests/perf/generated/ (gitignored; optional)
npm run perf            # regenerate + build + strict preview + measure + report.json
npm run perf:build      # build the production perf bundle only (dist-perf/)
npm run perf:serve      # serve an existing dist-perf/ on 127.0.0.1:1422
npm run perf:startup    # packaged-app hot-start cycles only
node scripts/measure-editor.mjs --browser dev   # diagnostic dev bundle → report.dev.json
```

`npm run perf` never measures a development server. Each run:

1. regenerates the three fixtures atomically (sibling temp file, `fsync`,
   byte-count check, rename) so a killed generator cannot leave a truncated
   document for the next run;
2. builds the dedicated production entry with
   `vite build --config vite.perf.config.ts` → `dist-perf/` (React production
   runtime; the normal `index.html`/`dist/` build never contains it);
3. starts `vite preview` on `127.0.0.1:1422` with `strictPort` — a stale
   preview on that port fails the run instead of silently measuring it;
4. measures the browser metrics in headless Chromium against
   `/perf.html?theme=dark&fixture=…`, then the packaged-app hot start;
5. writes `tests/perf/report.json` atomically.

The preview server exposes generated fixtures through a narrowly scoped
middleware (`vite.perf.config.ts`): only a basename-addressed
`/tests/perf/generated/<name>.md` is served (no traversal, no other suffix),
always with `Cache-Control: no-store`. The browser, the server process group,
and any packaged app spawned by the harness are released in `finally`;
SIGINT/SIGTERM close the browser and server, quit a half-started app through
the normal path (so recovery drafts flush), restore its session store, and
exit without writing a report.

`--browser dev` is an explicit diagnostic channel: it measures the same
browser metrics through the Vite dev server (`?demo=1`, React development
runtime) and writes `tests/perf/report.dev.json`, which is gitignored. It
never launches the packaged app, never rewrites
`tests/perf/startup-samples.json`, and its numbers never replace the release
report.

Fixtures are byte-identical across runs (fixed seed): ~1 MiB regular, just
over 2 MiB threshold, ~10 MiB / ≥100,000-line pressure documents.

**Report artifacts are committed baselines.** `tests/perf/report.json` and
`tests/perf/startup-samples.json` are small, human-auditable evidence of the
latest real run and are refreshed (and re-committed) whenever the benchmark is
re-run. `report.json` is written only by a complete successful production run;
a build, preview, or readiness failure exits non-zero before writing, leaving
the previous report untouched. Only the large fixture files under
`tests/perf/generated/`, the diagnostic `report.dev.json`, and the harness's
`tests/perf/*.tmp` files are gitignored.

## What is measured

**Browser-shell metrics (production bundle):** the harness drives the
dedicated `perf.html` entry (`src/perf/main.tsx`) in headless Chromium. That
entry injects the same fixture-seeded `MemoryDocumentPort` as the dev demo
(`src/app/demoPort.ts`) through `createApp(..., { browserShell: true })`, but
under React's production runtime. Every metric records its `source`
(`browser-production`, `browser-dev`, or `packaged-app`); the report's
browser provenance records the channel, React environment, app entry, server,
viewport, built-asset bytes/SHA-256, and fixture bytes/SHA-256. The Git
SHA/dirty snapshot is taken before any build or measurement, so writing the
report cannot pollute the provenance it describes.

- *Open-to-editor*: navigation start → the
  `markdown-edit:editor-editable` `performance.mark`, emitted on the first
  frame after the editor mounts when `import.meta.env.DEV` or
  `import.meta.env.MODE === "perf"` holds (normal production builds have
  neither). One warm-up load is discarded before the five samples.
- *Input latency*: keydown `event.timeStamp` → the next
  `requestAnimationFrame` timestamp (the frame that paints the change).
  Before sampling, the harness presses the platform document-end shortcut and
  verifies through the perf-only `window.__OPUS_PERF_EDITOR_VIEW__` hook that
  the selection head is at `doc.length`; it then types exactly 40 keystrokes
  (`KEYSTROKES = 40`) and rejects a run that did not produce exactly 40 finite
  samples. Chromium's Event Timing `duration` was evaluated and rejected:
  headless presentation scheduling floors it at ~32 ms even for no-op keyups,
  so it measures the environment, not the app. The rAF timestamp is the paint
  proxy. The 10 MiB pressure fixture (8,764,408 UTF-16 code units) runs this
  sample under the core grammar; the 1 MiB and 2 MiB fixtures stay full.
- *Pressure save*: Cmd+S → the dirty indicator clears. The demo port writes
  to memory, so this measures the UI save path, not disk I/O.
- *Sidebar interactive*: click → the demo folder's `aria-expanded` flips.
- *Packaged-app startup*: `hot_start_ms` keeps its original measurement and
  its `source` is `packaged-app`; it is never attributed to the browser.

**Process-level metrics (packaged app):** `scripts/measure-startup.mjs`
times process spawn → editor-editable on the real bundle. The readiness
signal is instrumentation, not a proxy: when the app is launched with the
`MARKDOWN_EDIT_PERF_MARK` environment variable set to a file path, the
frontend reports the first frame after the editor mounts and the backend
(`src-tauri/src/perf_mark.rs`) appends a UNIX-millisecond timestamp to that
file; the harness diffs it against its own pre-spawn timestamp. Without the
variable the command is a no-op, so production behavior is untouched.
Without a bundle — or with a stale bundle lacking the instrumentation —
`npm run perf` reports these metrics as skipped, with instructions. The
current report's hot-start reason is `not_instrumented`: the bundle exists,
but no editable mark was observed. The cause was not confirmed; do not treat
a locked display or any other single explanation as established fact. Rebuild
and rerun in an interactive session to collect the samples.

```sh
npm run tauri build            # produce the .app (unsigned local build)
npm run perf                   # attempts 5 hot-start cycles (skipped if no mark)
node scripts/measure-startup.mjs               # hot-start cycles only
node scripts/measure-startup.mjs --cold        # one cold sample (run per reboot)
node scripts/measure-startup.mjs --gatekeeper  # Gatekeeper first launch
```

Each launch opens `tests/perf/generated/regular-1mb.md` (passed as argv,
so the editor always mounts), then the app is quit via AppleScript and the
harness confirms no process remains. The app's persisted session
(`session.json` in the app-support directory) is backed up to a temp file
before every launch and restored afterwards — even if the harness itself
is killed, the next run restores the stale backup first. Each sample records
the executable's SHA-256, bundle path, and signing provenance; the report
accepts a hot/cold/Gatekeeper sample only when all of them still match the
local bundle. An ad-hoc local build is labeled "unsigned dev bundle", since
hot/cold budgets officially apply to the signed/notarized release build.

**Warning: quit the app before measuring.** The harness refuses to run
while an instance of the bundle is already running — a forced kill would
skip the recovery-draft flush and could lose unsaved work. Either quit the
app yourself, or pass `--force` (CLI) / `PERF_FORCE=1` (`npm run perf`) to
close it via a normal graceful quit; signal kills remain only a
last-resort fallback after the graceful quit times out.

## Gatekeeper handling and start-up timing protocol

Install the same signed/notarized build and launch it once to complete
quarantine/Gatekeeper verification; record that first launch separately as
informational `gatekeeper_first_launch_ms`; quit and confirm no process
remains. In practice: right after installing, run
`node scripts/measure-startup.mjs --gatekeeper` — it performs that single
first launch, stores the sample in `tests/perf/startup-samples.json`, and
verifies the process is gone afterwards.

- A **cold-start sample** is the first launch after reboot of that
  already-approved build (five cold samples = five reboot cycles). After
  each reboot, run `node scripts/measure-startup.mjs --cold` once; the
  harness appends the sample and `npm run perf` computes median/p95 and
  pass/fail once five samples exist.
- A **hot-start sample** begins immediately after a normal quit of the
  already-approved build. `npm run perf` (or
  `node scripts/measure-startup.mjs`) collects five of them in one go.
- The 2-second cold budget **excludes only the separately recorded
  first-verification launch**, not ordinary process or WebView startup.

## Current baseline

`tests/perf/report.json` is the authoritative record for the run below
(hardware, macOS, build SHA/dirty state, per-metric samples, medians, p95,
pass/fail, provenance). This is the latest complete successful
`npm run perf` run.

Environment: **Apple M5 / 36 GB / macOS 27.3 / Node 26.12.1**, git SHA
`11b26c2`, working tree **dirty** (85 dirty files at measurement time).
Browser metrics are a **Chromium production-frontend baseline**: `perf.html`
built with `vite.perf.config.ts` (`mode: perf`, React production) and served
by `vite preview` on `127.0.0.1:1422`; the URL is
`/perf.html?theme=dark&fixture=…` (production does not use `demo=1`). These
are **not WKWebView** numbers and **not the M1 / 8 GB signed-release
baseline**.

| Metric | Median | p95 | Budget | Result |
| --- | ---: | ---: | ---: | --- |
| Hot start (packaged app) | 857 ms | 963.6 ms | 1000 ms | PASS |
| Cold start | — | — | 2000 ms | skipped (`cold_samples_pending`) |
| Open regular (1 MiB) | 107 ms | 110.38 ms | 1000 ms | PASS |
| Open pressure (10 MiB) | 135.3 ms | 136.76 ms | 3000 ms | PASS |
| Input latency, regular | 3.4 ms | 7.61 ms | 32 ms p95 | PASS |
| Input latency, pressure | 14.86 ms | 30.75 ms | 50 ms p95 | PASS |
| Pressure save | 2 ms | 2.8 ms | 1000 ms | PASS |
| Sidebar interactive | 21 ms | 331.6 ms | — | info |
| Gatekeeper first launch | — | — | — | skipped (`no_gatekeeper_sample`) |

The 10 MiB pressure fixture is 10,485,772 UTF-8 bytes / **8,764,408 UTF-16
code units**, so this run measures it under the core grammar;
`regular-1mb.md` (875,158 units) and `light-2mb.md` (1,748,953) stay full. Its
input p95 of 30.75 ms is inside the unchanged 50 ms p95 budget.

**Hot start and skipped metrics.** Five real launches of the current local
unsigned/ad-hoc `Opus.app` produced editor-ready marks with a median of 857 ms
(p95 963.6 ms), inside the 1-second budget. Cold start remains pending until
one sample is collected per reboot cycle, and Gatekeeper first launch until a
signed/notarized build is installed and measured; neither is faked.
