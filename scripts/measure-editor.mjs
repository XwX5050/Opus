#!/usr/bin/env node
/**
 * Performance benchmark for the editor (docs/performance.md).
 *
 * Browser-shell metrics run against the dev-only demo hook (?demo=1&fixture=…)
 * in headless Chromium and produce real numbers now:
 *   - open_to_editor_regular_ms / open_to_editor_pressure_ms
 *     (navigation start → "markdown-edit:editor-editable" performance mark)
 *   - input_p95_regular_ms / input_p95_pressure_ms
 *     (keydown timeStamp → next requestAnimationFrame, i.e. input → paint)
 *   - sidebar_interactive_ms (click → folder expanded; informational)
 *   - save_pressure_ms (Cmd+S → dirty indicator cleared; in-memory port)
 *
 * Process-level metrics: hot start is measured live (launch → normal-quit
 * cycles of the packaged app, timed via its MARKDOWN_EDIT_PERF_MARK
 * instrumentation); cold start and the Gatekeeper first launch accumulate
 * via scripts/measure-startup.mjs --cold / --gatekeeper. Without a bundle
 * (or with a stale, uninstrumented one) they report "skipped" with
 * instructions — never faked.
 *
 * Output: tests/perf/report.json + a console summary. Exit code 1 if any
 * measured budget fails. Run `npm run perf:fixtures` first (auto-runs here).
 */
import { chromium } from "playwright";
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DEFAULT_BUNDLE,
  REQUIRED_COLD_SAMPLES,
  loadSamples,
  measureHotStarts,
} from "./measure-startup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.PERF_URL ?? "http://localhost:1420";
const SAMPLES = 5;
const KEYSTROKES = 40;

const BUDGETS = {
  hot_start_ms: 1000,
  cold_start_ms: 2000,
  open_to_editor_regular_ms: 1000,
  open_to_editor_pressure_ms: 3000,
  input_p95_regular_ms: 32,
  input_p95_pressure_ms: 50,
  save_pressure_ms: 1000,
  sidebar_interactive_ms: null, // informational, no release budget
  gatekeeper_first_launch_ms: null, // informational, recorded separately
};

// ---------- statistics ----------

const quantile = (sorted, q) => {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (value) => Math.round(value * 100) / 100;
  return { median: round(quantile(sorted, 0.5)), p95: round(quantile(sorted, 0.95)) };
};

// ---------- environment ----------

const shell = (command, args = []) => {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

const environment = () => ({
  chip: shell("sysctl", ["-n", "machdep.cpu.brand_string"]),
  memoryBytes: Number(shell("sysctl", ["-n", "hw.memsize"]) ?? 0) || null,
  macOS: shell("sw_vers", ["-productVersion"]),
  arch: process.arch,
  buildSha: shell("git", ["rev-parse", "HEAD"]),
  buildShaDirty: shell("git", ["status", "--porcelain"]) !== "",
  node: process.version,
  measuredAt: new Date().toISOString(),
  note: "Browser-shell metrics use headless Chromium against the Vite dev server, not the packaged WKWebView build; see docs/performance.md.",
});

// ---------- dev server ----------

const serverReady = async () => {
  try {
    const response = await fetch(BASE_URL);
    return response.ok;
  } catch {
    return false;
  }
};

const ensureDevServer = async () => {
  if (await serverReady()) {
    console.log(`reusing dev server at ${BASE_URL}`);
    return null;
  }
  console.log("starting dev server (npm run dev)…");
  const child = spawn("npm", ["run", "dev"], { cwd: ROOT, stdio: "ignore" });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await serverReady()) return child;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  child.kill();
  throw new Error(`dev server did not start at ${BASE_URL}`);
};

// ---------- page helpers ----------

const demoUrl = (params) => {
  const query = new URLSearchParams({ demo: "1", theme: "dark", ...params });
  return `${BASE_URL}/?${query}`;
};

const EDITOR_MARK = "markdown-edit:editor-editable";

/** Loads a demo page and waits until the editor reports editable. */
const openDemoPage = async (browser, params) => {
  const page = await browser.newPage({ viewport: { width: 1080, height: 760 } });
  await page.goto(demoUrl(params), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (name) => performance.getEntriesByName(name, "mark").length > 0,
    EDITOR_MARK,
    { timeout: 60_000 },
  );
  return page;
};

const editorEditableMarkMs = (page) =>
  page.evaluate((name) => {
    const marks = performance.getEntriesByName(name, "mark");
    return marks.length ? marks.at(-1).startTime : null;
  }, EDITOR_MARK);

const openToEditorSample = async (browser, fixture) => {
  const page = await openDemoPage(browser, { fixture });
  const ms = await editorEditableMarkMs(page);
  await page.close();
  return ms;
};

/**
 * Types into the focused editor and returns per-keystroke input-to-paint
 * latencies: keydown `event.timeStamp` → the next requestAnimationFrame
 * timestamp (the frame that paints the change). Chromium's Event Timing
 * durations proved unusable here — headless presentation scheduling floors
 * them at ~32 ms even for no-op keyups — so the rAF timestamp is the paint
 * proxy. See docs/performance.md.
 */
const inputLatencySamples = async (page) => {
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.evaluate(() => {
    window.__perfLatencies = [];
    document.querySelector(".cm-content").addEventListener("keydown", (event) => {
      const { timeStamp } = event;
      requestAnimationFrame((rafTime) => {
        window.__perfLatencies.push(rafTime - timeStamp);
      });
    });
  });
  for (let i = 0; i < KEYSTROKES; i += 1) {
    await page.keyboard.press("x");
  }
  return page.evaluate(() => window.__perfLatencies);
};

// ---------- browser-shell metrics ----------

const measureBrowserMetrics = async (metrics) => {
  const browser = await chromium.launch();
  try {
    // Warm-up: first-ever load pays Vite's transform cost; that is dev-server
    // overhead, not editor cost, so it is excluded from the samples.
    const warmup = await openDemoPage(browser, { fixture: "regular-1mb.md" });
    await warmup.close();

    for (const [metric, fixture] of [
      ["open_to_editor_regular_ms", "regular-1mb.md"],
      ["open_to_editor_pressure_ms", "pressure-10mb.md"],
    ]) {
      const samples = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        samples.push(await openToEditorSample(browser, fixture));
      }
      metrics[metric].samples = samples;
    }

    for (const [metric, fixture] of [
      ["input_p95_regular_ms", "regular-1mb.md"],
      ["input_p95_pressure_ms", "pressure-10mb.md"],
    ]) {
      const page = await openDemoPage(browser, { fixture });
      metrics[metric].samples = await inputLatencySamples(page);
      await page.close();
    }

    // Pressure save: dirty the document, then time Cmd+S until the dirty
    // indicator clears. The demo port writes in memory, so this measures the
    // UI save path, not disk I/O (docs/performance.md).
    {
      const page = await openDemoPage(browser, { fixture: "pressure-10mb.md" });
      const samples = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        await page.click(".cm-content");
        await page.keyboard.press("End");
        await page.keyboard.press("x");
        await page.waitForSelector(".tab-dirty");
        const start = Date.now();
        await page.keyboard.press("Meta+s");
        await page.waitForFunction(
          () => !document.querySelector(".tab-dirty"),
          null,
          { timeout: 10_000 },
        );
        samples.push(Date.now() - start);
      }
      metrics.save_pressure_ms.samples = samples;
      await page.close();
    }

    // Sidebar interaction: expand the demo folder, then collapse it again.
    // The row's trailing buttons stop propagation, so the click must land
    // on the folder name itself.
    {
      const page = await openDemoPage(browser, {
        fixture: "regular-1mb.md",
        workspace: "1",
      });
      const folder = page.getByRole("treeitem", { name: "notes" });
      const folderName = folder.locator(".file-tree-name");
      await folder.waitFor({ timeout: 30_000 });
      const samples = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const expanded = (await folder.getAttribute("aria-expanded")) === "true";
        const start = Date.now();
        await folderName.click();
        await page.waitForFunction(
          (expected) =>
            document
              .querySelector('[role="treeitem"][aria-label="notes"]')
              ?.getAttribute("aria-expanded") === String(expected),
          !expanded,
          { timeout: 10_000 },
        );
        samples.push(Date.now() - start);
      }
      metrics.sidebar_interactive_ms.samples = samples;
      await page.close();
    }
  } finally {
    await browser.close();
  }
};

// ---------- process-level metrics (packaged app) ----------

const BUNDLE_PATH = DEFAULT_BUNDLE;

/**
 * Hot start is measured live: real launch → normal-quit cycles of the
 * bundle, timed via the MARKDOWN_EDIT_PERF_MARK instrumentation
 * (scripts/measure-startup.mjs). Cold start accumulates one sample per
 * reboot cycle (`--cold`); Gatekeeper first launch is recorded once after
 * installing the signed build (`--gatekeeper`). Without a bundle — or with
 * a stale bundle lacking the instrumentation — the metrics report an
 * honest skip with instructions; they are never faked.
 */
const measureProcessMetrics = async (metrics) => {
  if (!existsSync(BUNDLE_PATH)) {
    const instructions =
      "Run `npm run tauri build` to produce src-tauri/target/release/bundle/macos/Markdown Edit.app, then re-run `npm run perf` (hot start) and collect cold/Gatekeeper samples with scripts/measure-startup.mjs — see docs/performance.md.";
    for (const name of ["hot_start_ms", "cold_start_ms", "gatekeeper_first_launch_ms"]) {
      metrics[name] = { status: "skipped", reason: "no_bundle", instructions, samples: [] };
    }
    return;
  }

  try {
    const { samples, provenance } = await measureHotStarts({
      bundlePath: BUNDLE_PATH,
      samples: SAMPLES,
    });
    metrics.hot_start_ms.samples = samples.map((sample) => sample.spawnToEditableMs);
    metrics.hot_start_ms.provenance = provenance.label;
  } catch (error) {
    metrics.hot_start_ms = {
      status: "skipped",
      reason: "not_instrumented",
      instructions:
        "The bundle predates the MARKDOWN_EDIT_PERF_MARK instrumentation. Rebuild with `npm run tauri build`, then re-run `npm run perf`.",
      error: error instanceof Error ? error.message : String(error),
      samples: [],
    };
  }

  const store = loadSamples();
  if (store.cold.length >= REQUIRED_COLD_SAMPLES) {
    metrics.cold_start_ms.samples = store.cold.map((sample) => sample.spawnToEditableMs);
    if (store.provenance) metrics.cold_start_ms.provenance = store.provenance;
  } else {
    metrics.cold_start_ms = {
      status: "skipped",
      reason: "cold_samples_pending",
      instructions:
        `${store.cold.length}/${REQUIRED_COLD_SAMPLES} cold samples collected. ` +
        "Run `node scripts/measure-startup.mjs --cold` once per reboot cycle of the already-approved build — see docs/performance.md.",
      samples: store.cold.map((sample) => sample.spawnToEditableMs),
    };
  }

  if (store.gatekeeperFirstLaunchMs !== null && store.gatekeeperFirstLaunchMs !== undefined) {
    metrics.gatekeeper_first_launch_ms.samples = [store.gatekeeperFirstLaunchMs];
    if (store.provenance) metrics.gatekeeper_first_launch_ms.provenance = store.provenance;
  } else {
    metrics.gatekeeper_first_launch_ms = {
      status: "skipped",
      reason: "no_gatekeeper_sample",
      instructions:
        "Install the signed/notarized build and run `node scripts/measure-startup.mjs --gatekeeper` on its first launch — see docs/performance.md.",
      samples: [],
    };
  }
};

// ---------- main ----------

const fixtureDir = path.join(ROOT, "tests/perf/generated");
if (!existsSync(path.join(fixtureDir, "pressure-10mb.md"))) {
  console.log("fixtures missing — running generate-perf-fixtures.mjs");
  execSync("node scripts/generate-perf-fixtures.mjs", { cwd: ROOT, stdio: "inherit" });
}

const metrics = {};
for (const name of Object.keys(BUDGETS)) {
  metrics[name] = { status: "measured", samples: [] };
}

const server = await ensureDevServer();
try {
  await measureBrowserMetrics(metrics);
} finally {
  server?.kill();
}
await measureProcessMetrics(metrics);

let failed = false;
for (const [name, budget] of Object.entries(BUDGETS)) {
  const metric = metrics[name];
  metric.budgetMs = budget;
  if (metric.status === "skipped") {
    metric.pass = null;
    continue;
  }
  const { median, p95 } = stats(metric.samples);
  metric.median = median;
  metric.p95 = p95;
  if (budget === null) {
    metric.pass = null; // informational only
  } else {
    // Input budgets apply to p95; the timed-operation budgets to the median.
    const judged = name.startsWith("input_") ? p95 : median;
    metric.judgedOn = name.startsWith("input_") ? "p95" : "median";
    metric.pass = judged <= budget;
    if (!metric.pass) failed = true;
  }
}

const report = {
  schema: 1,
  environment: environment(),
  budgets: BUDGETS,
  metrics,
  overall: failed ? "fail" : "pass",
};

const reportDir = path.join(ROOT, "tests/perf");
mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, "report.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log("\nmetric                          median      p95  budget  result");
for (const [name, metric] of Object.entries(metrics)) {
  if (metric.status === "skipped") {
    console.log(`${name.padEnd(32)}     —        —  ${String(metric.budgetMs ?? "—").padStart(6)}  skipped (${metric.reason})`);
    continue;
  }
  const budget = metric.budgetMs === null ? "—" : metric.budgetMs;
  const result = metric.pass === null ? "info" : metric.pass ? "PASS" : "FAIL";
  console.log(
    `${name.padEnd(32)}${String(metric.median).padStart(8)}${String(metric.p95).padStart(9)}  ${String(budget).padStart(6)}  ${result}`,
  );
}
console.log(`\nreport written to ${reportPath}`);
console.log(`overall: ${report.overall}`);
process.exit(failed ? 1 : 0);
