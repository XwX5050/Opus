#!/usr/bin/env node
/**
 * Performance benchmark for the editor (docs/performance.md).
 *
 * Default channel (production):
 *   1. Regenerate fixtures atomically.
 *   2. Build the dedicated perf entry (`vite.perf.config.ts` → dist-perf/).
 *   3. Snapshot the built assets, then start `vite preview` on strict port
 *      1422 with the fixture-only middleware declared by that config.
 *   4. Measure open/input/save/sidebar metrics in headless Chromium against
 *      perf.html (React production runtime), then packaged-app hot start.
 *   5. Write tests/perf/report.json atomically.
 *
 * Diagnostic channel (`--browser dev`): measures the same browser metrics
 * through the Vite dev server (?demo=1) and writes tests/perf/report.dev.json.
 * It never launches the packaged app, so tests/perf/startup-samples.json is
 * never rewritten. Its numbers include dev-only React instrumentation and
 * Vite transform cost, so they never replace the release report.
 *
 * Every metric records its `source`; browser provenance carries the channel,
 * React environment, server, viewport, built-asset SHA-256/bytes, and
 * fixture SHA-256/bytes. Git SHA/dirty state is snapshotted before any build
 * or measurement, so writing startup samples or the report cannot pollute
 * the provenance it is meant to describe. A build/server/mark failure exits
 * non-zero before writing, leaving the previous report untouched. SIGINT/
 * SIGTERM close the browser and server, quit a native app spawned by the
 * harness, and restore its session store before exiting.
 */
import { chromium } from "playwright";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  PERF_FIXTURES,
  PERF_FIXTURE_DIR,
} from "./generate-perf-fixtures.mjs";
import {
  DEFAULT_BUNDLE,
  REQUIRED_COLD_SAMPLES,
  bundleIdentity,
  cleanupActiveLaunches,
  coldSamplesMatchBundle,
  loadSamples,
  measureHotStarts,
  restoreStartupSession,
  sampleMatchesBundle,
} from "./measure-startup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREVIEW_PORT = 1422;
const DEV_PORT = 1420;
const VITE_BIN = path.join(ROOT, "node_modules/vite/bin/vite.js");
const FIXTURE_GENERATOR = path.join(ROOT, "scripts/generate-perf-fixtures.mjs");
const FIXTURE_DIR = PERF_FIXTURE_DIR;
const DIST_PERF_DIR = path.join(ROOT, "dist-perf");
const REQUIRED_FIXTURES = PERF_FIXTURES.map((fixture) => fixture.name);
const MIN_FIXTURE_BYTES = new Map(
  PERF_FIXTURES.map((fixture) => [fixture.name, fixture.minBytes]),
);
const SAMPLES = 5;
const KEYSTROKES = 40;
const VIEWPORT = { width: 1080, height: 760 };
const BROWSER_CHANNELS = ["production", "dev"];
export const SERVER_READY_TIMEOUT_MS = 1_000;

const PROCESS_METRICS = new Set([
  "hot_start_ms",
  "cold_start_ms",
  "gatekeeper_first_launch_ms",
]);

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

// ---------- CLI helpers ----------

export const resolveBrowserChannel = (args = []) => {
  let channel = "production";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--browser") {
      channel = args[index + 1];
      index += 1;
      if (channel === undefined) {
        throw new Error("--browser requires production or dev");
      }
    } else if (arg.startsWith("--browser=")) {
      channel = arg.slice("--browser=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!BROWSER_CHANNELS.includes(channel)) {
    throw new Error(
      `--browser must be one of ${BROWSER_CHANNELS.join("|")}, got ${channel}`,
    );
  }
  return channel;
};

export const documentEndShortcut = (platform = process.platform) =>
  // CodeMirror binds document end as Mod-End: Cmd-End on macOS, Ctrl-End
  // elsewhere.
  platform === "darwin" ? "Meta+End" : "Control+End";

export const saveShortcut = (platform = process.platform) =>
  platform === "darwin" ? "Meta+s" : "Control+s";

export const normalizeLatencySamples = (samples, expected = KEYSTROKES) => {
  if (!Array.isArray(samples)) {
    throw new Error("input-latency samples are not an array");
  }
  if (samples.length !== expected) {
    throw new Error(
      `expected exactly ${expected} input-latency samples, got ${samples.length}`,
    );
  }
  return samples.map((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`input-latency sample ${index} is not a finite number`);
    }
    return Math.max(0, value);
  });
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

// ---------- environment and provenance ----------

const shell = (command, args = []) => {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

/**
 * Snapshot the repo state before any build, fixture regeneration or
 * measurement writes. The report must describe the source it measured, not
 * the dirty state its own startup-samples/report writes create.
 */
export const snapshotGitState = () => {
  const status = shell("git", ["status", "--porcelain"]);
  return {
    buildSha: shell("git", ["rev-parse", "HEAD"]),
    buildShaDirty: status === null ? true : status.length > 0,
    dirtyFileCount: status ? status.split("\n").length : 0,
    capturedAt: new Date().toISOString(),
  };
};

export const buildEnvironment = (channel, snapshot) => ({
  chip: shell("sysctl", ["-n", "machdep.cpu.brand_string"]),
  memoryBytes: Number(shell("sysctl", ["-n", "hw.memsize"]) ?? 0) || null,
  macOS: shell("sw_vers", ["-productVersion"]),
  arch: process.arch,
  buildSha: snapshot.buildSha,
  buildShaDirty: snapshot.buildShaDirty,
  buildShaDirtyFileCount: snapshot.dirtyFileCount,
  gitStateCapturedAt: snapshot.capturedAt,
  node: process.version,
  measuredAt: new Date().toISOString(),
  browserChannel: channel,
  note:
    channel === "production"
      ? "Browser-shell metrics use headless Chromium against the dedicated production perf bundle served by vite preview; they are Chromium-engine numbers, not packaged WKWebView numbers. See docs/performance.md."
      : "Diagnostic run: browser-shell metrics use headless Chromium against the Vite dev server (React development runtime); these numbers are not release evidence. This channel never launches the packaged app or rewrites startup-samples.json. See docs/performance.md.",
});

const relativePath = (file) =>
  path.relative(ROOT, file).split(path.sep).join("/");

const fileDigest = (file) => {
  const bytes = readFileSync(file);
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

const walkFiles = (directory) => {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
};

export const collectAssetProvenance = (directory, baseDir = ROOT) =>
  walkFiles(directory)
    .sort((a, b) => relativePath(a).localeCompare(relativePath(b)))
    .map((file) => ({
      path: path.relative(baseDir, file).split(path.sep).join("/"),
      ...fileDigest(file),
    }));

export const assertBuiltAssets = (assets) => {
  if (assets.length === 0) {
    throw new Error("perf build produced no assets");
  }
  const hasEntry = assets.some(
    (asset) => asset.path === "perf.html" || asset.path.endsWith("/perf.html"),
  );
  const hasJavaScript = assets.some((asset) => asset.path.endsWith(".js"));
  if (!hasEntry || !hasJavaScript) {
    throw new Error(
      "perf build is missing perf.html or JavaScript assets; refusing to measure an empty bundle",
    );
  }
};

const fixtureProvenance = () =>
  REQUIRED_FIXTURES.map((name) => {
    const file = path.join(FIXTURE_DIR, name);
    if (!existsSync(file)) {
      throw new Error(
        `fixture ${name} is missing; run node scripts/generate-perf-fixtures.mjs`,
      );
    }
    return { name, path: relativePath(file), ...fileDigest(file) };
  });

export const assertFixturesComplete = (fixtures) => {
  for (const fixture of fixtures) {
    const minimum = MIN_FIXTURE_BYTES.get(fixture.name);
    if (minimum === undefined) {
      throw new Error(`unknown perf fixture: ${fixture.name}`);
    }
    if (fixture.bytes < minimum) {
      throw new Error(
        `fixture ${fixture.name} is truncated (${fixture.bytes} < ${minimum} bytes)`,
      );
    }
  }
};

const browserSource = (channel) =>
  channel === "production" ? "browser-production" : "browser-dev";

const browserProvenance = ({
  channel,
  baseUrl,
  browserVersion,
  assets,
  fixtures,
}) => ({
  source: channel === "production" ? "production-bundle" : "vite-dev-server",
  channel,
  mode: channel === "production" ? "perf" : "development",
  reactEnvironment: channel === "production" ? "production" : "development",
  appEntry: channel === "production" ? "perf.html" : "index.html?demo=1",
  server: channel === "production" ? "vite preview" : "vite dev server",
  url: baseUrl,
  engine: `Chromium ${browserVersion}`,
  viewport: VIEWPORT,
  build:
    channel === "production"
      ? {
          command: "vite build",
          config: "vite.perf.config.ts",
          viteMode: "perf",
          outDir: "dist-perf",
        }
      : null,
  assets,
  fixtures,
});

// ---------- build, fixtures and servers ----------

const regenerateFixtures = () => {
  console.log("regenerating perf fixtures (atomic writes)…");
  execFileSync(process.execPath, [FIXTURE_GENERATOR], {
    cwd: ROOT,
    stdio: "inherit",
  });
};

const buildPerfBundle = () => {
  console.log("building production perf bundle (vite.perf.config.ts → dist-perf/)…");
  const result = spawnSync(
    process.execPath,
    [VITE_BIN, "build", "--config", "vite.perf.config.ts"],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `perf bundle build failed (exit ${result.status ?? result.signal})`,
    );
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const serverReady = async (
  url,
  timeoutMs = SERVER_READY_TIMEOUT_MS,
) => {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const waitForServer = async (child, readyUrl, label) => {
  let exit = null;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exit) {
      throw new Error(
        `${label} exited before becoming ready (code ${exit.code}, signal ${exit.signal})`,
      );
    }
    if (await serverReady(readyUrl)) return;
    await sleep(300);
  }
  throw new Error(`${label} did not start at ${readyUrl}`);
};

const stopServer = async (
  child,
  readyUrl,
  { killExitedGroup = false } = {},
) => {
  if (!child) return;
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  // A preview process that already exited (for example after losing the
  // strict-port race) has no process group worth signalling. The npm dev
  // wrapper is different: it can exit while its Vite child still serves, so
  // the caller asks for the group to be killed regardless.
  if (hasExited() && !killExitedGroup) return;
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  };
  killGroup("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (hasExited() && !(await serverReady(readyUrl))) return;
    await sleep(200);
  }
  killGroup("SIGKILL");
  const forceDeadline = Date.now() + 1_000;
  while (Date.now() < forceDeadline && !hasExited()) {
    await sleep(100);
  }
};

const startDevServer = async (baseUrl, cleanup) => {
  if (await serverReady(`${baseUrl}/`)) {
    console.log(`reusing dev server at ${baseUrl}`);
    return { child: null, release: () => {} };
  }
  console.log("starting dev server (npm run dev)…");
  // detached: the npm wrapper and its Vite child share one process group,
  // so the group kill below can never orphan Vite on port 1420.
  const child = spawn("npm", ["run", "dev"], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true,
  });
  const release = cleanup.add("dev-server", () =>
    stopServer(child, `${baseUrl}/`, { killExitedGroup: true }),
  );
  try {
    await waitForServer(child, `${baseUrl}/`, "dev server");
    return { child, release };
  } catch (error) {
    release();
    await stopServer(child, `${baseUrl}/`, { killExitedGroup: true });
    throw error;
  }
};

const startPreviewServer = async (baseUrl, cleanup) => {
  const previewUrl = `${baseUrl}/perf.html`;
  // Strict port: a stale preview must fail the run instead of silently
  // measuring a different bundle. Pre-check the URL as well: otherwise the
  // readiness poll could see an existing server and accept it while our own
  // child is exiting on EADDRINUSE.
  if (await serverReady(previewUrl)) {
    throw new Error(
      `port ${PREVIEW_PORT} is already in use; stop the existing preview server first (strict port)`,
    );
  }
  console.log(
    `starting production preview at ${baseUrl} (strict port ${PREVIEW_PORT})…`,
  );
  // The process group is killed in finally and by the signal cleanup stack.
  const child = spawn(
    process.execPath,
    [
      VITE_BIN,
      "preview",
      "--config",
      "vite.perf.config.ts",
      "--port",
      String(PREVIEW_PORT),
      "--strictPort",
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    },
  );
  const release = cleanup.add("preview-server", () =>
    stopServer(child, previewUrl),
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await waitForServer(child, previewUrl, "preview server");
    // The readiness poll can win a race against an EADDRINUSE exit; give the
    // child one tick and refuse to measure a server we do not own.
    await sleep(100);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("preview server exited immediately after becoming ready");
    }
    return { child, release };
  } catch (error) {
    release();
    await stopServer(child, previewUrl);
    const detail = stderr.trim();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ""}`,
    );
  }
};

// ---------- cleanup ----------

const raceWithTimeout = async (fn, timeoutMs) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export const createCleanupStack = () => {
  const entries = [];
  let running = null;
  const add = (label, cleanup, timeoutMs = null) => {
    const entry = { label, cleanup, timeoutMs };
    entries.push(entry);
    return () => {
      const index = entries.indexOf(entry);
      if (index !== -1) entries.splice(index, 1);
    };
  };
  const run = ({ perCleanupMs = 6_000, totalMs = 45_000 } = {}) => {
    if (running) return running;
    running = (async () => {
      const deadline = Date.now() + totalMs;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const { label, cleanup, timeoutMs } = entries[index];
        try {
          const outcome = await raceWithTimeout(
            cleanup,
            Math.min(timeoutMs ?? perCleanupMs, remaining),
          );
          if (outcome === "timeout") {
            console.warn(`cleanup timed out: ${label}`);
          }
        } catch (error) {
          console.warn(
            `cleanup failed for ${label}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      entries.length = 0;
    })();
    return running;
  };
  return { add, run };
};

const installSignalHandlers = (cleanup) => {
  let interrupted = false;
  const handle = (signal) => {
    if (interrupted) return;
    interrupted = true;
    console.error(`received ${signal}; cleaning up…`);
    void cleanup.run().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.once("SIGINT", () => handle("SIGINT"));
  process.once("SIGTERM", () => handle("SIGTERM"));
  return () => interrupted;
};

// ---------- page helpers ----------

const demoUrl = (baseUrl, channel, params) => {
  const query = new URLSearchParams({ theme: "dark", ...params });
  if (channel !== "production") query.set("demo", "1");
  const entry = channel === "production" ? "/perf.html" : "/";
  return `${baseUrl}${entry}?${query}`;
};

const EDITOR_MARK = "markdown-edit:editor-editable";

/** Loads a demo page and waits until the editor reports editable. */
const openDemoPage = async (browser, url) => {
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(url, { waitUntil: "domcontentloaded" });
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

const openToEditorSample = async (browser, url, fixture) => {
  const page = await openDemoPage(browser, url);
  const ms = await editorEditableMarkMs(page);
  await page.close();
  if (typeof ms !== "number") {
    throw new Error(`missing ${EDITOR_MARK} mark for ${fixture}`);
  }
  return ms;
};

/**
 * Types into the focused editor and returns per-keystroke input-to-paint
 * latencies: keydown `event.timeStamp` → the next requestAnimationFrame
 * timestamp (the frame that paints the change). Chromium's Event Timing
 * durations proved unusable here — headless presentation scheduling floors
 * them at ~32 ms even for no-op keyups — so the rAF timestamp is the paint
 * proxy. The platform document-end shortcut is verified through the
 * perf-only editor view hook before sampling. See docs/performance.md.
 */
const inputLatencySamples = async (page, endShortcut) => {
  await page.click(".cm-content");
  await page.keyboard.press(endShortcut);
  const atDocumentEnd = await page.evaluate(() => {
    const view = window.__OPUS_PERF_EDITOR_VIEW__;
    return Boolean(
      view && view.state.selection.main.head === view.state.doc.length,
    );
  });
  if (!atDocumentEnd) {
    throw new Error(
      `document-end shortcut ${endShortcut} did not reach the end of the document`,
    );
  }
  await page.evaluate(() => {
    window.__perfLatencies = [];
    document.querySelector(".cm-content").addEventListener("keydown", (event) => {
      const { timeStamp } = event;
      requestAnimationFrame((rafTime) => {
        // A rAF timestamp can precede a keydown timestamp by microseconds on
        // coarse clocks; a negative input latency is not meaningful.
        window.__perfLatencies.push(Math.max(0, rafTime - timeStamp));
      });
    });
  });
  for (let i = 0; i < KEYSTROKES; i += 1) {
    await page.keyboard.press("x");
  }
  // Wait until every keydown's rAF callback has run (plus one paint frame),
  // then require exactly KEYSTROKES samples.
  await page.waitForFunction(
    (expected) => (window.__perfLatencies?.length ?? 0) >= expected,
    KEYSTROKES,
    { timeout: 15_000 },
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(true))),
  );
  const samples = await page.evaluate(() => window.__perfLatencies);
  return normalizeLatencySamples(samples);
};

// ---------- browser-shell metrics ----------

const measureBrowserMetrics = async (metrics, { baseUrl, channel, cleanup }) => {
  const browser = await chromium.launch();
  const releaseBrowser = cleanup.add("browser", () => browser.close());
  const endShortcut = documentEndShortcut();
  const saveKey = saveShortcut();
  try {
    // Warm-up: the first-ever load pays one-time browser/module warm-up
    // (Vite's transform cost in dev mode); that is harness overhead, not
    // editor cost, so it is excluded from the samples.
    const warmupUrl = demoUrl(baseUrl, channel, { fixture: "regular-1mb.md" });
    const warmup = await openDemoPage(browser, warmupUrl);
    await warmup.close();

    for (const [metric, fixture] of [
      ["open_to_editor_regular_ms", "regular-1mb.md"],
      ["open_to_editor_pressure_ms", "pressure-10mb.md"],
    ]) {
      const samples = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const url = demoUrl(baseUrl, channel, { fixture });
        samples.push(await openToEditorSample(browser, url, fixture));
      }
      metrics[metric].samples = samples;
    }

    for (const [metric, fixture] of [
      ["input_p95_regular_ms", "regular-1mb.md"],
      ["input_p95_pressure_ms", "pressure-10mb.md"],
    ]) {
      const url = demoUrl(baseUrl, channel, { fixture });
      const page = await openDemoPage(browser, url);
      metrics[metric].samples = await inputLatencySamples(page, endShortcut);
      await page.close();
    }

    // Pressure save: dirty the document, then time the platform save
    // shortcut until the dirty indicator clears. The demo port writes in
    // memory, so this measures the UI save path, not disk I/O.
    {
      const url = demoUrl(baseUrl, channel, { fixture: "pressure-10mb.md" });
      const page = await openDemoPage(browser, url);
      const samples = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        await page.click(".cm-content");
        await page.keyboard.press("End");
        await page.keyboard.press("x");
        await page.waitForSelector(".tab-dirty");
        const start = Date.now();
        await page.keyboard.press(saveKey);
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
      const url = demoUrl(baseUrl, channel, {
        fixture: "regular-1mb.md",
        workspace: "1",
      });
      const page = await openDemoPage(browser, url);
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

    return { version: browser.version() };
  } finally {
    try {
      await browser.close();
    } catch {
      // A signal cleanup may already have closed it.
    }
    releaseBrowser();
  }
};

// ---------- process-level metrics (packaged app) ----------

const BUNDLE_PATH = DEFAULT_BUNDLE;

/**
 * Hot start is measured live: real launch → normal-quit cycles of the
 * bundle, timed via the MARKDOWN_EDIT_PERF_MARK instrumentation
 * (scripts/measure-startup.mjs). Cold start accumulates one sample per
 * reboot cycle (`--cold`); Gatekeeper first launch is recorded once after
 * installing the signed build (`--gatekeeper`). Cold/Gatekeeper samples
 * carry the bundle SHA-256 and signing provenance; samples from another
 * build are skipped rather than mixed into this report.
 *
 * The dev diagnostic channel never launches the app or touches
 * tests/perf/startup-samples.json.
 */
const measureProcessMetrics = async (metrics, { channel, cleanup }) => {
  if (channel === "production" && process.env.PERF_SKIP_PACKAGED === "1") {
    const instructions =
      "Packaged-app metrics were skipped by PERF_SKIP_PACKAGED=1 for an iterative browser-only run. Unset it for release evidence.";
    for (const name of [
      "hot_start_ms",
      "cold_start_ms",
      "gatekeeper_first_launch_ms",
    ]) {
      metrics[name] = {
        status: "skipped",
        reason: "disabled",
        instructions,
        samples: [],
      };
    }
    return { label: null, identity: null };
  }
  if (channel !== "production") {
    const instructions =
      "The --browser dev diagnostic channel never launches the packaged app and never rewrites tests/perf/startup-samples.json. Run `npm run perf` for packaged-app metrics.";
    for (const name of [
      "hot_start_ms",
      "cold_start_ms",
      "gatekeeper_first_launch_ms",
    ]) {
      metrics[name] = {
        status: "skipped",
        reason: "dev_channel",
        instructions,
        samples: [],
      };
    }
    return { label: null, identity: null };
  }

  if (!existsSync(BUNDLE_PATH)) {
    const instructions =
      "Run `npm run tauri build` to produce src-tauri/target/release/bundle/macos/Opus.app, then re-run `npm run perf` (hot start) and collect cold/Gatekeeper samples with scripts/measure-startup.mjs — see docs/performance.md.";
    for (const name of [
      "hot_start_ms",
      "cold_start_ms",
      "gatekeeper_first_launch_ms",
    ]) {
      metrics[name] = {
        status: "skipped",
        reason: "no_bundle",
        instructions,
        samples: [],
      };
    }
    return { label: null, identity: null };
  }

  let identity;
  try {
    identity = await bundleIdentity(BUNDLE_PATH);
  } catch (error) {
    const instructions =
      "The bundle exists but its executable/provenance could not be read. Rebuild with `npm run tauri build`, then re-run `npm run perf`.";
    for (const name of [
      "hot_start_ms",
      "cold_start_ms",
      "gatekeeper_first_launch_ms",
    ]) {
      metrics[name] = {
        status: "skipped",
        reason: "bundle_unreadable",
        instructions,
        error: error instanceof Error ? error.message : String(error),
        samples: [],
      };
    }
    return { label: null, identity: null };
  }

  // A native graceful quit (draft flush + quit fallbacks) can legitimately
  // take ~20 s; give it more room than browser/server cleanup.
  const releaseNative = cleanup.add(
    "packaged-app",
    async () => {
      await cleanupActiveLaunches();
      restoreStartupSession(BUNDLE_PATH);
    },
    30_000,
  );

  let hotStartLabel = null;
  try {
    const { samples, provenance } = await measureHotStarts({
      bundlePath: BUNDLE_PATH,
      samples: SAMPLES,
      force: process.env.PERF_FORCE === "1",
      identity,
    });
    metrics.hot_start_ms.samples = samples.map((sample) => sample.spawnToEditableMs);
    metrics.hot_start_ms.provenance = provenance.label;
    metrics.hot_start_ms.bundleSha256 = identity.sha256;
    hotStartLabel = provenance.label;
  } catch (error) {
    const instanceRunning =
      error instanceof Error && "code" in error && error.code === "INSTANCE_RUNNING";
    metrics.hot_start_ms = {
      status: "skipped",
      reason: instanceRunning ? "instance_running" : "not_instrumented",
      instructions: instanceRunning
        ? "Opus is already running — quit it first (the harness never force-kills a live instance), or re-run with PERF_FORCE=1 to close it via a normal graceful quit."
        : "The bundle did not emit the editor-ready mark: it may predate the MARKDOWN_EDIT_PERF_MARK instrumentation, or the editor never mounted (for example while the display is locked). Rebuild with `npm run tauri build` and re-run `npm run perf` in an interactive session.",
      error: error instanceof Error ? error.message : String(error),
      samples: [],
    };
  } finally {
    // Idempotent: signal cleanup may have already quit/restored.
    await cleanupActiveLaunches();
    restoreStartupSession(BUNDLE_PATH);
    releaseNative();
  }

  const store = loadSamples();
  const cold = Array.isArray(store.cold) ? store.cold : [];
  const coldMatches = coldSamplesMatchBundle(cold, identity);
  if (coldMatches) {
    metrics.cold_start_ms.samples = cold.map(
      (sample) => sample.spawnToEditableMs,
    );
    metrics.cold_start_ms.provenance = identity.provenance;
    metrics.cold_start_ms.bundleSha256 = identity.sha256;
  } else if (cold.length >= REQUIRED_COLD_SAMPLES) {
    metrics.cold_start_ms = {
      status: "skipped",
      reason: "bundle_mismatch",
      instructions:
        "The stored cold samples were collected from a different bundle (hash/path/provenance). Recollect them for this build: run `node scripts/measure-startup.mjs --cold` once per reboot cycle — see docs/performance.md.",
      storedSampleCount: cold.length,
      storedBundleSha256: cold[0]?.bundleSha256 ?? null,
      samples: [],
    };
  } else {
    metrics.cold_start_ms = {
      status: "skipped",
      reason: "cold_samples_pending",
      instructions:
        `${cold.length}/${REQUIRED_COLD_SAMPLES} cold samples collected. ` +
        "Run `node scripts/measure-startup.mjs --cold` once per reboot cycle of the already-approved build — see docs/performance.md.",
      samples: cold.map((sample) => sample.spawnToEditableMs),
    };
  }

  const gatekeeperSample = store.gatekeeperSample;
  const gatekeeperMatches =
    Boolean(gatekeeperSample) &&
    sampleMatchesBundle(gatekeeperSample, identity);
  if (gatekeeperMatches) {
    metrics.gatekeeper_first_launch_ms.samples = [
      gatekeeperSample.spawnToEditableMs,
    ];
    metrics.gatekeeper_first_launch_ms.provenance = identity.provenance;
    metrics.gatekeeper_first_launch_ms.bundleSha256 = identity.sha256;
  } else if (
    gatekeeperSample ||
    (store.gatekeeperFirstLaunchMs !== null &&
      store.gatekeeperFirstLaunchMs !== undefined)
  ) {
    metrics.gatekeeper_first_launch_ms = {
      status: "skipped",
      reason: "bundle_mismatch",
      instructions:
        "The recorded Gatekeeper sample is unbound or belongs to a different bundle (hash/path/provenance). Install this build and run `node scripts/measure-startup.mjs --gatekeeper` on its first launch — see docs/performance.md.",
      storedBundleSha256: gatekeeperSample?.bundleSha256 ?? null,
      samples: [],
    };
  } else {
    metrics.gatekeeper_first_launch_ms = {
      status: "skipped",
      reason: "no_gatekeeper_sample",
      instructions:
        "Install the signed/notarized build and run `node scripts/measure-startup.mjs --gatekeeper` on its first launch — see docs/performance.md.",
      samples: [],
    };
  }

  return { label: hotStartLabel, identity };
};

// ---------- report ----------

/**
 * Synchronous by design: the whole write/fsync/rename runs in one event-loop
 * turn, so a signal handler cannot exit between "temp file created" and
 * "rename complete" and leave a stray temp file. Serialization happens
 * before the temp file is created, keeping failures free of temp files too.
 */
export const writeReportAtomically = (report, reportPath) => {
  const data = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(path.dirname(reportPath), { recursive: true });
  const tempPath = `${reportPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tempPath, "w");
    try {
      writeFileSync(fd, data, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, reportPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
};

const summarize = (metrics, reportPath, overall) => {
  console.log("\nmetric                          median      p95  budget  result  source");
  for (const [name, metric] of Object.entries(metrics)) {
    if (metric.status === "skipped") {
      console.log(
        `${name.padEnd(32)}     —        —  ${String(metric.budgetMs ?? "—").padStart(6)}  skipped (${metric.reason})  ${metric.source}`,
      );
      continue;
    }
    const budget = metric.budgetMs === null ? "—" : metric.budgetMs;
    const result = metric.pass === null ? "info" : metric.pass ? "PASS" : "FAIL";
    console.log(
      `${name.padEnd(32)}${String(metric.median).padStart(8)}${String(metric.p95).padStart(9)}  ${String(budget).padStart(6)}  ${result.padEnd(6)}  ${metric.source}`,
    );
  }
  console.log(`\nreport written to ${reportPath}`);
  console.log(`overall: ${overall}`);
};

// ---------- main ----------

const run = async (channel, snapshot, cleanup, isInterrupted) => {
  const production = channel === "production";
  const baseUrl = production
    ? `http://127.0.0.1:${PREVIEW_PORT}`
    : // Vite's dev server listens on localhost, which may resolve to ::1 only.
      `http://localhost:${DEV_PORT}`;

  if (isInterrupted()) throw new Error("interrupted before measurement");

  regenerateFixtures();
  const fixtures = fixtureProvenance();
  assertFixturesComplete(fixtures);

  const metrics = {};
  for (const name of Object.keys(BUDGETS)) {
    metrics[name] = { status: "measured", samples: [] };
  }

  let assets = [];
  if (production) {
    buildPerfBundle();
    // Snapshot immediately after the build: later measurement must not see a
    // rebuilt or partially written bundle.
    assets = collectAssetProvenance(DIST_PERF_DIR);
    assertBuiltAssets(assets);
  }

  if (isInterrupted()) throw new Error("interrupted before server start");
  const server = production
    ? await startPreviewServer(baseUrl, cleanup)
    : await startDevServer(baseUrl, cleanup);
  const serverReadyUrl = production ? `${baseUrl}/perf.html` : `${baseUrl}/`;
  let browserInfo;
  try {
    browserInfo = await measureBrowserMetrics(metrics, {
      baseUrl,
      channel,
      cleanup,
    });
  } finally {
    await stopServer(server.child, serverReadyUrl, {
      killExitedGroup: !production,
    });
    server.release();
  }

  if (isInterrupted()) throw new Error("interrupted before packaged metrics");
  const processInfo = await measureProcessMetrics(metrics, { channel, cleanup });
  for (const name of Object.keys(BUDGETS)) {
    metrics[name].source = PROCESS_METRICS.has(name)
      ? "packaged-app"
      : browserSource(channel);
  }

  let failed = false;
  for (const [name, budget] of Object.entries(BUDGETS)) {
    const metric = metrics[name];
    metric.budgetMs = budget;
    if (metric.status === "skipped") {
      metric.pass = null;
      continue;
    }
    if (metric.samples.length === 0) {
      throw new Error(`metric ${name} produced no samples`);
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

  if (isInterrupted()) throw new Error("interrupted before report write");

  const report = {
    schema: 1,
    environment: buildEnvironment(channel, snapshot),
    provenance: {
      browser: browserProvenance({
        channel,
        baseUrl,
        browserVersion: browserInfo.version,
        assets,
        fixtures,
      }),
      packagedApp: {
        source: "packaged-app",
        bundlePath: relativePath(BUNDLE_PATH),
        bundleExists: existsSync(BUNDLE_PATH),
        bundleSha256: processInfo.identity?.sha256 ?? null,
        provenance: processInfo.identity?.provenance ?? null,
        provenanceKind: processInfo.identity?.provenanceKind ?? null,
        label: processInfo.label,
        reason: production
          ? process.env.PERF_SKIP_PACKAGED === "1"
            ? "disabled"
            : null
          : "dev_channel",
      },
    },
    budgets: BUDGETS,
    metrics,
    overall: failed ? "fail" : "pass",
  };

  const reportPath = process.env.PERF_REPORT
    ? path.resolve(ROOT, process.env.PERF_REPORT)
    : path.join(
        ROOT,
        "tests/perf",
        production ? "report.json" : "report.dev.json",
      );
  writeReportAtomically(report, reportPath);
  summarize(metrics, reportPath, report.overall);
  return failed;
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("usage: node scripts/measure-editor.mjs [--browser production|dev]");
    return;
  }
  let channel;
  try {
    channel = resolveBrowserChannel(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("usage: node scripts/measure-editor.mjs [--browser production|dev]");
    process.exitCode = 2;
    return;
  }

  const snapshot = snapshotGitState();
  const cleanup = createCleanupStack();
  const isInterrupted = installSignalHandlers(cleanup);
  try {
    const failed = await run(channel, snapshot, cleanup, isInterrupted);
    process.exit(failed ? 1 : 0);
  } catch (error) {
    if (isInterrupted()) return;
    console.error("\nperformance run failed before writing a report:");
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    await cleanup.run();
    process.exitCode = 1;
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
