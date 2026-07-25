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
starts its own and shuts it down afterwards. Fixtures are byte-identical
across runs (fixed seed): ~1 MiB regular, just over 2 MiB threshold,
~10 MiB / ≥100,000-line pressure documents.

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

**Process-level metrics (require the packaged app):** hot start, cold start,
and Gatekeeper first launch measure process → editable and therefore need
the signed/notarized `.app`. Without a bundle the harness reports them as
`skipped: no_bundle` (with instructions) — they are never faked.

## Gatekeeper handling and start-up timing protocol

Install the same signed/notarized build and launch it once to complete
quarantine/Gatekeeper verification; record that first launch separately as
informational `gatekeeper_first_launch_ms`; quit and confirm no process
remains.

- A **cold-start sample** is the first launch after reboot of that
  already-approved build (five cold samples = five reboot cycles).
- A **hot-start sample** begins immediately after a normal quit of the
  already-approved build.
- The 2-second cold budget **excludes only the separately recorded
  first-verification launch**, not ordinary process or WebView startup.

To enable these measurements, build the bundle
(`npm run tauri build` →
`src-tauri/target/release/bundle/macos/Markdown Edit.app`) and time process
spawn → the editor's editable mark surfacing in the packaged WebView, using
the quit/reboot protocol above.

## Current baseline

See `tests/perf/report.json` for the authoritative record (hardware, macOS,
build SHA, five samples per metric, medians, p95, pass/fail). Latest run on
this machine (Apple M5 / 36 GB / macOS 26.5.2, headless Chromium against the
Vite dev server):

| Metric | Median | p95 | Budget | Result |
| --- | ---: | ---: | ---: | --- |
| Hot start | — | — | 1000 ms | skipped (not instrumented) |
| Cold start | — | — | 2000 ms | skipped (not instrumented) |
| Open regular (1 MiB) | 116.7 ms | 121.2 ms | 1000 ms | PASS |
| Open pressure (10 MiB) | 154.8 ms | 157.9 ms | 3000 ms | PASS |
| Input latency, regular | 5.4 ms | 8.9 ms | 32 ms p95 | PASS |
| Input latency, pressure | 29.9 ms | 32.7 ms | 50 ms p95 | PASS |
| Pressure save | 3 ms | 3.8 ms | 1000 ms | PASS |
| Sidebar interactive | 15 ms | 16 ms | — | info |
| Gatekeeper first launch | — | — | — | skipped (not instrumented) |

Reaching the input budgets required removing two per-keystroke
O(document-size) string copies: the controlled-value sync in
`MarkdownEditor` now compares by string identity, and recovery-draft
signatures in `useAppController` hold `{status, text}` references instead of
a concatenated copy.
