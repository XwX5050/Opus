#!/usr/bin/env node
/**
 * Process-level startup timing harness (docs/performance.md).
 *
 * Usage:
 *   node scripts/measure-startup.mjs [--samples N] [--bundle PATH] [--fixture PATH]
 *       Hot start: N (default 5) launch → normal-quit cycles of the packaged
 *       app, timing process spawn → editor editable. The readiness signal is
 *       the MARKDOWN_EDIT_PERF_MARK instrumentation: the app appends a
 *       UNIX-ms timestamp to that file the moment the editor first becomes
 *       editable (src-tauri/src/perf_mark.rs).
 *   node scripts/measure-startup.mjs --cold
 *       Cold start: a single launch, appended to the samples file. Run once
 *       per reboot cycle (the first launch after reboot of the already
 *       Gatekeeper-approved build); pass/fail is computed once 5 samples
 *       exist.
 *   node scripts/measure-startup.mjs --gatekeeper
 *       Gatekeeper first launch: a single launch right after installing a
 *       freshly downloaded signed/notarized build, recorded separately as
 *       informational gatekeeper_first_launch_ms.
 *
 * Samples and provenance persist in tests/perf/startup-samples.json;
 * scripts/measure-editor.mjs folds them into the release report.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BUNDLE = path.join(
  ROOT,
  "src-tauri/target/release/bundle/macos/Markdown Edit.app",
);
export const SAMPLES_FILE = path.join(ROOT, "tests/perf/startup-samples.json");
const DEFAULT_FIXTURE = path.join(ROOT, "tests/perf/generated/regular-1mb.md");
const LAUNCH_TIMEOUT_MS = 30_000;

export const HOT_BUDGET_MS = 1000;
export const COLD_BUDGET_MS = 2000;
export const REQUIRED_COLD_SAMPLES = 5;

// ---------- shell helpers ----------

const tryExec = async (command, args) => {
  try {
    const { stdout } = await execFileAsync(command, args);
    return stdout.trim();
  } catch {
    return null;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pidsForBinary = async (binaryPath) => {
  const out = await tryExec("pgrep", ["-f", binaryPath]);
  return out ? out.split("\n").map(Number).filter(Boolean) : [];
};

// ---------- bundle inspection ----------

const bundleBinary = (bundlePath) => {
  const dir = path.join(bundlePath, "Contents/MacOS");
  const entries = readdirSync(dir).filter((entry) => !entry.startsWith("."));
  if (entries.length !== 1) {
    throw new Error(`expected exactly one binary in ${dir}, found ${entries.length}`);
  }
  return path.join(dir, entries[0]);
};

const bundleIdentifier = (bundlePath) =>
  execFileSync("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    path.join(bundlePath, "Contents/Info.plist"),
  ], { encoding: "utf8" }).trim();

/** Honest provenance: ad-hoc local builds are NOT signed/notarized. */
export const bundleProvenance = async (bundlePath) => {
  // codesign -dv prints its report to stderr; merge the streams.
  const merged = await tryExec("bash", [
    "-c",
    `codesign -dv ${JSON.stringify(bundlePath)} 2>&1 || true`,
  ]);
  if (!merged) return { kind: "unknown", label: "signature unknown" };
  if (/Signature=adhoc/.test(merged)) {
    return { kind: "adhoc", label: "unsigned dev bundle (ad-hoc signature, not notarized)" };
  }
  const authority = merged.match(/^Authority=(.+)$/m)?.[1];
  if (authority) return { kind: "signed", label: `signed (${authority})` };
  return { kind: "unsigned", label: "unsigned bundle" };
};

// ---------- session store backup/restore ----------

/**
 * Launching the app persists its session (open tabs, window geometry) into
 * the store. Back it up before measuring and restore it afterwards so a
 * benchmark run never disturbs the real session of this app identifier.
 */
const sessionStoreBackup = (bundleId) => {
  const file = path.join(
    homedir(),
    "Library/Application Support",
    bundleId,
    "session.json",
  );
  const existed = existsSync(file);
  const content = existed ? readFileSync(file) : null;
  return {
    restore() {
      if (existed && content) writeFileSync(file, content);
      else if (existsSync(file)) rmSync(file);
    },
  };
};

// ---------- launch / quit ----------

/** Quits any running instance of the bundle binary; throws if one survives. */
export const ensureNotRunning = async (binaryPath, bundleId) => {
  let pids = await pidsForBinary(binaryPath);
  if (pids.length === 0) return;
  await tryExec("osascript", [
    "-e",
    `tell application id "${bundleId}" to quit`,
  ]);
  for (let i = 0; i < 50 && (await pidsForBinary(binaryPath)).length > 0; i += 1) {
    await sleep(100);
  }
  pids = await pidsForBinary(binaryPath);
  for (const pid of pids) await tryExec("kill", [String(pid)]);
  for (let i = 0; i < 30 && (await pidsForBinary(binaryPath)).length > 0; i += 1) {
    await sleep(100);
  }
  pids = await pidsForBinary(binaryPath);
  for (const pid of pids) await tryExec("kill", ["-9", String(pid)]);
  await sleep(200);
  pids = await pidsForBinary(binaryPath);
  if (pids.length > 0) {
    throw new Error(`could not stop running instance (pids: ${pids.join(", ")})`);
  }
};

const quitGracefully = async (child, binaryPath, bundleId) => {
  await tryExec("osascript", [
    "-e",
    `tell application id "${bundleId}" to quit`,
  ]);
  const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
  const graceful = await Promise.race([exited, sleep(8000).then(() => false)]);
  if (!graceful) {
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(3000).then(() => false)]);
  }
  await ensureNotRunning(binaryPath, bundleId);
};

/**
 * Launches the bundle once with MARKDOWN_EDIT_PERF_MARK set and times
 * spawn → editor-editable. The sample's primary number compares the app's
 * own timestamp (written by the instrumented build) against the harness's
 * pre-spawn timestamp; wallMs (file appearance latency) is a sanity cross
 * check. Throws when no mark arrives — i.e. the bundle lacks the
 * instrumentation or the editor never mounted.
 */
export const launchOnce = async ({
  bundlePath = DEFAULT_BUNDLE,
  fixturePath = DEFAULT_FIXTURE,
  timeoutMs = LAUNCH_TIMEOUT_MS,
}) => {
  const binary = bundleBinary(bundlePath);
  const bundleId = bundleIdentifier(bundlePath);
  await ensureNotRunning(binary, bundleId);
  const markFile = path.join(
    tmpdir(),
    `markdown-edit-perf-mark-${process.pid}-${Date.now()}.txt`,
  );
  const spawnedAt = Date.now();
  const child = spawn(binary, [fixturePath], {
    env: { ...process.env, MARKDOWN_EDIT_PERF_MARK: markFile },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + timeoutMs;
    let editableUnixMs = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`app exited early (code ${child.exitCode}) before becoming editable`);
      }
      if (existsSync(markFile)) {
        const firstLine = readFileSync(markFile, "utf8").split("\n")[0].trim();
        if (firstLine) {
          editableUnixMs = Number(firstLine);
          break;
        }
      }
      await sleep(15);
    }
    if (editableUnixMs === null || Number.isNaN(editableUnixMs)) {
      throw new Error(
        "no editable mark within timeout — the bundle lacks MARKDOWN_EDIT_PERF_MARK instrumentation (rebuild with `npm run tauri build`)",
      );
    }
    const wallMs = Date.now() - spawnedAt;
    return {
      spawnToEditableMs: editableUnixMs - spawnedAt,
      wallMs,
      startedAt: new Date(spawnedAt).toISOString(),
    };
  } finally {
    await quitGracefully(child, binary, bundleId);
    rmSync(markFile, { force: true });
  }
};

// ---------- samples file ----------

export const loadSamples = () => {
  if (!existsSync(SAMPLES_FILE)) {
    return { bundle: null, provenance: null, hot: [], cold: [], gatekeeperFirstLaunchMs: null };
  }
  return JSON.parse(readFileSync(SAMPLES_FILE, "utf8"));
};

const saveSamples = (samples) => {
  mkdirSync(path.dirname(SAMPLES_FILE), { recursive: true });
  writeFileSync(SAMPLES_FILE, `${JSON.stringify(samples, null, 2)}\n`);
};

// ---------- measurement modes ----------

const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p) => {
    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return lower === upper
      ? sorted[lower]
      : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  };
  const round = (value) => Math.round(value * 100) / 100;
  return { median: round(q(0.5)), p95: round(q(0.95)) };
};

/** Hot start: `samples` launch → normal-quit cycles of the bundle. */
export const measureHotStarts = async ({
  bundlePath = DEFAULT_BUNDLE,
  fixturePath = DEFAULT_FIXTURE,
  samples = 5,
} = {}) => {
  const bundleId = bundleIdentifier(bundlePath);
  const backup = sessionStoreBackup(bundleId);
  const provenance = await bundleProvenance(bundlePath);
  const run = [];
  try {
    for (let i = 0; i < samples; i += 1) {
      run.push(await launchOnce({ bundlePath, fixturePath }));
    }
  } finally {
    backup.restore();
  }
  const store = loadSamples();
  store.bundle = path.relative(ROOT, bundlePath);
  store.provenance = provenance.label;
  store.hot = run;
  saveSamples(store);
  return { samples: run, provenance };
};

const report = (label, values, budgetMs) => {
  const { median, p95 } = stats(values);
  const pass = budgetMs === null ? null : median <= budgetMs;
  console.log(
    `${label}: n=${values.length} median=${median} ms p95=${p95} ms` +
      (budgetMs === null ? " (informational)" : ` budget=${budgetMs} ms → ${pass ? "PASS" : "FAIL"}`),
  );
  values.forEach((value, index) => console.log(`  sample ${index + 1}: ${value} ms`));
  return pass;
};

// ---------- CLI ----------

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
  };
  const bundlePath = path.resolve(option("--bundle", DEFAULT_BUNDLE));
  const fixturePath = path.resolve(option("--fixture", DEFAULT_FIXTURE));
  const cold = args.includes("--cold");
  const gatekeeper = args.includes("--gatekeeper");

  if (!existsSync(bundlePath)) {
    console.error(`bundle not found: ${bundlePath}`);
    console.error("build it first: npm run tauri build");
    process.exit(2);
  }
  if (!existsSync(fixturePath)) {
    console.error(`fixture not found: ${fixturePath} (run npm run perf:fixtures)`);
    process.exit(2);
  }

  let failed = false;
  if (cold) {
    const sample = await launchOnce({ bundlePath, fixturePath });
    const store = loadSamples();
    store.cold.push(sample);
    saveSamples(store);
    console.log(`cold sample recorded (${store.cold.length}/${REQUIRED_COLD_SAMPLES})`);
    if (store.cold.length >= REQUIRED_COLD_SAMPLES) {
      const pass = report(
        "cold start",
        store.cold.map((entry) => entry.spawnToEditableMs),
        COLD_BUDGET_MS,
      );
      failed = failed || pass === false;
    } else {
      console.log("pass/fail is computed once 5 cold samples exist — run again after the next reboot");
    }
  } else if (gatekeeper) {
    const sample = await launchOnce({ bundlePath, fixturePath });
    const store = loadSamples();
    store.gatekeeperFirstLaunchMs = sample.spawnToEditableMs;
    saveSamples(store);
    report("gatekeeper first launch", [sample.spawnToEditableMs], null);
  } else {
    const samples = Number(option("--samples", "5"));
    const { samples: run, provenance } = await measureHotStarts({
      bundlePath,
      fixturePath,
      samples,
    });
    console.log(`provenance: ${provenance.label}`);
    const pass = report(
      "hot start",
      run.map((entry) => entry.spawnToEditableMs),
      HOT_BUDGET_MS,
    );
    failed = failed || pass === false;
  }
  process.exit(failed ? 1 : 0);
}
