# Performance

Budgets, measurement protocol, and the current baseline for large-document
performance. The release benchmark is `npm run perf`; it writes
`tests/perf/report.json` and exits non-zero when a measured budget fails.

## Light mode (automatic degradation)

Documents larger than **2 MiB of UTF-8 text** or **50,000 lines** open in
light mode (`src/editor/performanceMode.ts`):

- stays on: Markdown parsing, selection, search, visible-range text styling
  (live preview);
- paused: offscreen image creation and nonessential block widgets (math
  rendering, image widgets), via the live-preview CodeMirror compartment;
- the document text is never changed by light mode;
- a dismissible banner offers **继续完整渲染**, which forces full rendering
  for that tab only; closing and reopening the tab returns to automatic
  mode.

Evaluation is bounded so typing never pays an O(document) scan
(`src/app/usePerformanceMode.ts`): opening or switching to a tab
classifies synchronously (once per open, so a light document never mounts
full widgets even for one frame); documents decidable from length alone
(over 2 MiB of UTF-16 units, or under 50,000) classify in O(1) on every
render; in-band edits re-evaluate only after typing pauses (200 ms
debounce). The mode toggles widget rendering only, so this delay is
imperceptible — full rendering is the safe direction.

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
npm run perf:fixtures   # deterministic seeded fixtures → tests/perf/generated/ (gitignored)
npm run perf            # measure + tests/perf/report.json + pass/fail summary
```

`npm run perf` reuses a dev server on port 1420 if one is running, otherwise
starts its own (detached process group) and shuts the whole group down
afterwards — no orphaned Vite. Fixtures are byte-identical
across runs (fixed seed): ~1 MiB regular, just over 2 MiB threshold,
~10 MiB / ≥100,000-line pressure documents.

**Report artifacts are committed baselines.** `tests/perf/report.json` and
`tests/perf/startup-samples.json` are small, human-auditable evidence of
the latest real run and are refreshed (and re-committed) whenever the
benchmark is re-run. Only the large fixture files under
`tests/perf/generated/` are gitignored.

## What is measured

**Browser-shell metrics (run now, real numbers):** the harness drives the
dev-only demo hook (`?demo=1&fixture=…`) in headless Chromium.

- *Open-to-editor*: navigation start → the
  `markdown-edit:editor-editable` `performance.mark`, emitted in DEV builds
  on the first frame after the editor mounts. One warm-up load (Vite
  transform cost) is discarded before the five samples.
- *Input latency*: keydown `event.timeStamp` → the next
  `requestAnimationFrame` timestamp (the frame that paints the change),
  over 40 keystrokes at the document end. Chromium's Event Timing
  `duration` was evaluated and rejected: headless presentation scheduling
  floors it at ~32 ms even for no-op keyups, so it measures the
  environment, not the app. The rAF timestamp is the paint proxy.
- *Pressure save*: Cmd+S → the dirty indicator clears. The demo port writes
  to memory, so this measures the UI save path, not disk I/O.
- *Sidebar interactive*: click → the demo folder's `aria-expanded` flips.

**Process-level metrics (packaged app):** `scripts/measure-startup.mjs`
times process spawn → editor-editable on the real bundle. The readiness
signal is instrumentation, not a proxy: when the app is launched with the
`MARKDOWN_EDIT_PERF_MARK` environment variable set to a file path, the
frontend reports the first frame after the editor mounts and the backend
(`src-tauri/src/perf_mark.rs`) appends a UNIX-millisecond timestamp to that
file; the harness diffs it against its own pre-spawn timestamp. Without the
variable the command is a no-op, so production behavior is untouched.
Without a bundle — or with a stale bundle lacking the instrumentation —
`npm run perf` reports these metrics as skipped, with instructions.

```sh
npm run tauri build            # produce the .app (unsigned local build)
npm run perf                   # includes 5 real hot-start launch → quit cycles
node scripts/measure-startup.mjs               # hot-start cycles only
node scripts/measure-startup.mjs --cold        # one cold sample (run per reboot)
node scripts/measure-startup.mjs --gatekeeper  # Gatekeeper first launch
```

Each launch opens `tests/perf/generated/regular-1mb.md` (passed as argv,
so the editor always mounts), then the app is quit via AppleScript and the
harness confirms no process remains. The app's persisted session
(`session.json` in the app-support directory) is backed up to a temp file
before every launch and restored afterwards — even if the harness itself
is killed, the next run restores the stale backup first. Samples persist
in `tests/perf/startup-samples.json` with their provenance — an ad-hoc
local build is labeled "unsigned dev bundle", since hot/cold budgets
officially apply to the signed/notarized release build.

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

See `tests/perf/report.json` for the authoritative record (hardware, macOS,
build SHA, five samples per metric, medians, p95, pass/fail). Latest run on
this machine (Apple M5 / 36 GB / macOS 26.5.2, headless Chromium against the
Vite dev server):

| Metric | Median | p95 | Budget | Result |
| --- | ---: | ---: | ---: | --- |
| Hot start (unsigned dev bundle) | 310 ms | 314 ms | 1000 ms | PASS |
| Cold start | — (0/5 samples) | — | 2000 ms | skipped (needs reboot cycles) |
| Open regular (1 MiB) | 117.2 ms | 125.6 ms | 1000 ms | PASS |
| Open pressure (10 MiB) | 156 ms | 161.2 ms | 3000 ms | PASS |
| Input latency, regular | 5.5 ms | 10.5 ms | 32 ms p95 | PASS |
| Input latency, pressure | 30.0 ms | 33.2 ms | 50 ms p95 | PASS |
| Pressure save | 2 ms | 3 ms | 1000 ms | PASS |
| Sidebar interactive | 15 ms | 17.8 ms | — | info |
| Gatekeeper first launch | — | — | — | skipped (needs signed build) |

Hot start is a real process-spawn → editor-editable measurement of the
locally built (ad-hoc, unnotarized) bundle; the budget officially applies
to the signed/notarized release build on the M1/8 GB baseline.

Reaching the input budgets required removing two per-keystroke
O(document-size) string copies: the controlled-value sync in
`MarkdownEditor` now compares by string identity, and recovery-draft
signatures in `useAppController` hold `{status, text}` references instead of
a concatenated copy.
