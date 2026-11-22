#!/usr/bin/env node
/**
 * Native end-to-end orchestrator (docs: src/app/nativeE2e.ts).
 *
 * Builds the feature-gated test application and drives the real native
 * process through scenario phases:
 *
 *   smoke            argv open → editor mounted → report
 *   edit-save        edit through CodeMirror → controller save → byte check
 *   external-change  clean reload → dirty edit → external rewrite →
 *                    conflict dialog → load-disk action
 *   recovery         edit → durable draft → SIGKILL → relaunch → restore
 *
 * Synchronization is exclusively marker-file based: the runner writes a
 * phase only after observing the corresponding state, and this process only
 * performs an external write after reading the phase that requests it.
 * There are no fixed sleeps.
 *
 * Safety:
 * - The dedicated build uses identifier
 *   `com.xiongweini.markdown-edit.native-e2e`; every marker/report is checked
 *   against it before this process trusts or cleans anything.
 * - On macOS and Linux the child runs with an isolated HOME/XDG data root, so
 *   session and recovery data stay inside the scenario directory. Windows is
 *   different: Rust resolves app data through the known shell folder
 *   (`FOLDERID_RoamingAppData`), not the child's APPDATA variable, so HOME or
 *   APPDATA overrides do NOT relocate real data. There the dedicated
 *   identifier alone isolates the test data (the real per-user app-data root
 *   plus the `.native-e2e` identifier); cleanup revalidates that directory
 *   name and refuses to touch the production identifier. Because that path is
 *   fixed by the identifier, Windows native runs must not execute
 *   concurrently.
 * - Fixtures live in an OS temp directory owned by this process and are
 *   removed in `finally`; diagnostics (including the recovered draft body
 *   and hash) stay under test-results/native-e2e/.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The dedicated identifier configured in
// src-tauri/tauri.native-e2e.conf.json. Data cleanup is allowed only when a
// marker/report proves this identifier is running.
const APP_IDENTIFIER = "com.xiongweini.markdown-edit.native-e2e";
const PRODUCTION_IDENTIFIER = "com.xiongweini.markdown-edit";
const IDENTIFIER_SUFFIX = ".native-e2e";
const TEST_CONFIG = "src-tauri/tauri.native-e2e.conf.json";
const RESULTS_ROOT = path.join(ROOT, "test-results", "native-e2e");
const TAURI_CLI_JS = path.join(
  ROOT,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);
const BINARY_NAME = process.platform === "win32" ? "app.exe" : "app";
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SCENARIOS = ["smoke", "edit-save", "external-change", "recovery"];
const DEFAULT_SCENARIO = "smoke";
// The runner's own deadline for observing a scenario state
// (`TIMEOUT_MS` in src/app/nativeE2e.ts). The orchestrator must outlive it by
// enough margin to cover native window/webview startup before the runner's
// clock starts: when the runner gives up it writes a precise failure report
// and a "failed" marker, and only then does the orchestrator report the phase
// timeout. A shorter orchestrator timeout would hide that diagnosis behind a
// generic "timed out waiting for marker".
export const RUNNER_TIMEOUT_MS = 90_000;
const RUNNER_STARTUP_GRACE_MS = 30_000;
export const PHASE_TIMEOUT_MS = RUNNER_TIMEOUT_MS + RUNNER_STARTUP_GRACE_MS;
const STARTUP_TIMEOUT_MS = PHASE_TIMEOUT_MS;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const KILL_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 10_000;

class OrchestratorError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OrchestratorError";
    this.details = details;
  }
}

const usage = () => `usage: node scripts/native-e2e.mjs [options]

Options:
  --build              Build the feature-gated test app before running
  --release            Build in release mode (implies --build)
  --scenario <name>    ${SCENARIOS.join(" | ")} | all   (default: ${DEFAULT_SCENARIO})
  --app <path>         Run an existing native test binary (skips --build)
  --keep-data          Keep the isolated app-data directory for debugging
  --verbose            Stream build/app output and log every marker
  --help, -h           Show this help

The dedicated build is produced with:
  tauri build --no-bundle --features native-e2e --config ${TEST_CONFIG}
and writes its frontend to test-results/native-e2e/dist (gitignored).

Test data lives in an isolated HOME on macOS/Linux. On Windows native dirs
use the shell known folder, so the dedicated .native-e2e identifier isolates
data instead; cleanup verifies that identifier before removing anything.
Every scenario starts from a clean test-data directory; --keep-data only
keeps what that scenario wrote.`;

const fail = (message) => {
  throw new OrchestratorError(message);
};

const parseArgs = (argv) => {
  const options = {
    build: false,
    release: false,
    scenario: DEFAULT_SCENARIO,
    app: null,
    keepData: false,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--build":
        options.build = true;
        break;
      case "--release":
        options.release = true;
        options.build = true;
        break;
      case "--scenario": {
        const value = argv[index + 1];
        index += 1;
        if (value === undefined) fail("--scenario requires a value");
        options.scenario = value;
        break;
      }
      case "--app": {
        const value = argv[index + 1];
        index += 1;
        if (value === undefined) fail("--app requires a path");
        options.app = path.resolve(value);
        break;
      }
      case "--keep-data":
        options.keepData = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  if (options.scenario !== "all" && !SCENARIOS.includes(options.scenario)) {
    fail(
      `--scenario must be one of ${SCENARIOS.join("|")}|all, got ${options.scenario}`,
    );
  }
  if (options.app !== null && !existsSync(options.app)) {
    fail(`--app binary does not exist: ${options.app}`);
  }
  // An explicit --app always wins: it names the exact executable to run.
  if (options.app !== null) options.build = false;
  return options;
};

const selectedScenarios = (scenario) =>
  scenario === "all" ? [...SCENARIOS] : [scenario];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const relative = (file) => path.relative(ROOT, file).split(path.sep).join("/");

/**
 * Diagnostics may point outside the repository (Windows app data lives in the
 * user profile), where a relative path is noise. Keep in-repo paths relative
 * and everything else absolute.
 */
export const displayPath = (file, root = ROOT) => {
  const inside =
    file === root || file.startsWith(`${root}${path.sep}`);
  return inside ? relative(file) : file;
};

const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const readJson = async (file) => {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    // Atomic rename means a visible file is complete. A parse failure is a
    // real diagnostic, not a transient state; surface it with the path.
    fail(`invalid JSON at ${relative(file)}: ${text.slice(0, 200)}`);
  }
};

const fileDigest = (file) => {
  const bytes = readFileSync(file);
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
};

const normalizeNewlines = (text) => text.replace(/\r\n?/g, "\n");

/**
 * Compares filesystem paths across Windows spellings. Windows reports the
 * same file as `C:\x`, `\\?\C:\x`, `\\.\C:\x`, or `\\?\UNC\server\share\x`;
 * Node's realpath may use the extended form while Tauri/Rust returns the
 * ordinary one. Strip the namespace prefix, normalize separators/dots, and
 * fold case before comparing. macOS/Linux keep their native path semantics.
 */
export const stripWindowsExtendedPrefix = (value) => {
  let result = value;
  if (result.startsWith("\\\\?\\")) {
    result = result.slice(4);
    if (result.toLowerCase().startsWith("unc\\")) {
      result = `\\\\${result.slice(4)}`;
    }
  } else if (result.startsWith("\\\\.\\")) {
    result = result.slice(4);
  }
  return result;
};

export const normalizePathForComparison = (
  value,
  platform = process.platform,
) => {
  if (platform === "win32") {
    return path.win32
      .normalize(stripWindowsExtendedPrefix(value))
      .toLocaleLowerCase("en-US");
  }
  return path.normalize(value);
};

export const samePath = (left, right, platform = process.platform) =>
  typeof left === "string" &&
  typeof right === "string" &&
  normalizePathForComparison(left, platform) ===
    normalizePathForComparison(right, platform);

const decodeFixture = (bytes) => {
  if (!bytes.subarray(0, BOM.length).equals(BOM)) {
    fail("expected the fixture/saved file to keep its UTF-8 BOM");
  }
  const text = bytes.subarray(BOM.length).toString("utf8");
  const withoutBom = bytes.subarray(BOM.length);
  for (let index = 0; index < withoutBom.length; index += 1) {
    if (withoutBom[index] === 0x0a && (index === 0 || withoutBom[index - 1] !== 0x0d)) {
      fail("found a bare LF byte; the document's CRLF style was not preserved");
    }
  }
  return text;
};

const countOccurrences = (text, needle) => {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
};

// ---------- commands ----------

const runCommand = async (command, args, options) => {
  const {
    cwd = ROOT,
    env = {},
    logPath,
    timeoutMs = BUILD_TIMEOUT_MS,
    verbose = false,
    label = path.basename(command),
  } = options;
  if (verbose) console.log(`$ ${command} ${args.join(" ")}`);
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`$ ${command} ${args.join(" ")}\n`);
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  const collect = (chunk, into) =>
    into.length < 2_000_000 ? into + chunk.toString() : into;
  child.stdout.on("data", (chunk) => {
    stdout = collect(chunk, stdout);
    log.write(chunk);
    if (verbose) process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = collect(chunk, stderr);
    log.write(chunk);
    if (verbose) process.stderr.write(chunk);
  });
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      killProcessTree(child, true);
      resolve();
    }, timeoutMs);
  });
  const exitPromise = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    // `spawn` failures (missing binary, EACCES) surface here instead of
    // leaving the exit wait pending until its timeout.
    child.once("error", reject);
  });
  try {
    // Normal builds may run for many minutes; wait for exit or the command
    // timeout, whichever happens first. The bounded SIGKILL wait only starts
    // after the timeout has actually fired.
    const outcome = await Promise.race([
      exitPromise.then((result) => ({ timedOut: false, result })),
      timeoutPromise.then(() => ({ timedOut: true })),
    ]);
    if (!outcome.timedOut) {
      log.end();
      return { ...outcome.result, stdout, stderr };
    }
    // The timer already sent SIGKILL; bound the wait for its actual exit so
    // an unkillable child cannot hang the orchestrator forever.
    await waitForProcessExit(child, exitPromise, label);
    log.end();
    fail(`${label} timed out after ${timeoutMs} ms; see ${relative(logPath)}`);
  } catch (error) {
    log.end();
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const killProcessTree = (child, force) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
};

const stopApplication = async (application) => {
  if (!application) return;
  const { child, exit } = application;
  if (application.launchError || child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    await exit;
    return;
  }
  killProcessTree(child, false);
  const graceful = await Promise.race([
    exit.then(() => true),
    sleep(KILL_TIMEOUT_MS).then(() => false),
  ]);
  if (graceful) return;
  killProcessTree(child, true);
  const forced = await Promise.race([
    exit.then(() => true),
    sleep(KILL_TIMEOUT_MS).then(() => false),
  ]);
  if (!forced) fail(`could not stop native process ${child.pid}`);
};

/**
 * Waits for a process to exit, twice escalating with SIGKILL. Both waits are
 * bounded: an unresponsive child fails the run instead of hanging it.
 * `exitPromise` resolves with `{code, signal}` and may reject on spawn error.
 */
const waitForProcessExit = async (
  child,
  exitPromise,
  label,
  timeoutMs = EXIT_TIMEOUT_MS,
) => {
  const waitOnce = () =>
    Promise.race([
      exitPromise.then((result) => ({ exited: true, result })),
      sleep(timeoutMs).then(() => ({ exited: false })),
    ]);
  const first = await waitOnce();
  if (first.exited) return first.result;
  killProcessTree(child, true);
  const second = await waitOnce();
  if (second.exited) return second.result;
  fail(
    `${label}: process ${child.pid ?? "unknown"} did not exit after SIGKILL`,
  );
};

/**
 * Waits for a killed process to actually exit. A SIGKILL that is ignored
 * (or a wedged child) must fail the run instead of hanging the orchestrator;
 * the caller keeps `application` set so the outer finally can still clean up.
 */
const waitForApplicationExit = async (application, label) => {
  await waitForProcessExit(application.child, application.exit, label);
  application.log.end();
};

// ---------- build / launch ----------

const buildTestApp = async (options, runDir) => {
  if (!existsSync(TAURI_CLI_JS)) {
    fail(
      `local Tauri CLI JS entry not found at ${relative(TAURI_CLI_JS)} (run npm ci)`,
    );
  }
  const args = [
    // Run the CLI entry through the Node binary that executes this script.
    // This works on Windows without a `.cmd` shell shim (spawning a .cmd
    // without a shell is unreliable) and never routes generated arguments
    // through a shell.
    TAURI_CLI_JS,
    "build",
    "--no-bundle",
    "--features",
    "native-e2e",
    "--config",
    TEST_CONFIG,
  ];
  if (!options.release) args.splice(2, 0, "--debug");
  const logPath = path.join(runDir, "build.log");
  console.log(
    `Building native E2E ${options.release ? "release" : "debug"} app ` +
      `(frontend mode native-e2e)…`,
  );
  const result = await runCommand(process.execPath, args, {
    cwd: ROOT,
    logPath,
    timeoutMs: BUILD_TIMEOUT_MS,
    verbose: options.verbose,
    label: "tauri build",
  });
  if (result.code !== 0) {
    fail(
      `tauri build failed (exit ${result.code}); see ${relative(logPath)}\n` +
        tail(result.stderr || result.stdout),
    );
  }
  const binary = path.join(
    ROOT,
    "src-tauri",
    "target",
    options.release ? "release" : "debug",
    BINARY_NAME,
  );
  if (!existsSync(binary)) {
    fail(`build succeeded but the binary is missing: ${relative(binary)}`);
  }
  return {
    binary,
    command: [process.execPath, ...args],
    logPath,
  };
};

const tail = (text, lines = 20) => {
  const all = text.trim().split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join("\n");
};

/**
 * Windows app data root as the native side resolves it. Rust's `dirs`
 * dependency asks the shell for `FOLDERID_RoamingAppData`; it does not read
 * the child's `APPDATA`, so an environment override is not an isolation
 * mechanism. The orchestrator intentionally leaves the child's APPDATA
 * untouched and derives the directory from its own system value; an outer
 * environment that rewrites APPDATA would need the path returned by the
 * backend instead.
 */
const windowsDataRoot = () => {
  const appData = process.env.APPDATA;
  if (typeof appData === "string" && appData.length > 0) return appData;
  return path.join(
    process.env.USERPROFILE || os.homedir(),
    "AppData",
    "Roaming",
  );
};

const applicationDataDirectory = (home) => {
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_IDENTIFIER);
  }
  if (process.platform === "win32") {
    return path.join(windowsDataRoot(), APP_IDENTIFIER);
  }
  return path.join(home, ".local", "share", APP_IDENTIFIER);
};

const isolatedEnvironment = (home) => {
  const env = {
    HOME: home,
    TMPDIR: path.join(home, "tmp"),
    OPUS_NATIVE_E2E_SCENARIO: "", // filled per launch
  };
  if (process.platform === "win32") {
    // HOME/APPDATA do not relocate the known shell folder. Only temp
    // locations are redirected; the test identifier carries the isolation.
    env.TEMP = path.join(home, "tmp");
    env.TMP = env.TEMP;
  } else {
    env.XDG_DATA_HOME = path.join(home, ".local", "share");
    env.XDG_CONFIG_HOME = path.join(home, ".config");
    env.XDG_CACHE_HOME = path.join(home, ".cache");
  }
  return env;
};

/**
 * True only when `directory` is the per-user data directory of the dedicated
 * test identifier. Cleanup uses this as its last line of defence: a path that
 * is the production identifier, a bare suffix, or an arbitrary directory is
 * never removed.
 */
export const isDedicatedTestDataDirectory = (
  directory,
  platform = process.platform,
  identifier = APP_IDENTIFIER,
) => {
  if (
    identifier === PRODUCTION_IDENTIFIER ||
    !identifier.endsWith(IDENTIFIER_SUFFIX) ||
    identifier.length <= IDENTIFIER_SUFFIX.length
  ) {
    return false;
  }
  if (typeof directory !== "string" || directory.length === 0) return false;
  const normalized =
    platform === "win32"
      ? path.win32.normalize(directory)
      : path.normalize(directory);
  const absolute =
    platform === "win32"
      ? path.win32.isAbsolute(normalized)
      : path.isAbsolute(normalized);
  if (!absolute) return false;
  const base =
    platform === "win32"
      ? path.win32.basename(normalized)
      : path.basename(normalized);
  return platform === "win32"
    ? base.toLowerCase() === identifier.toLowerCase()
    : base === identifier;
};

/**
 * Removes only data this run created. macOS/Linux app data sits inside the
 * per-scenario HOME, so removing that HOME removes the test data. Windows app
 * data lives in the real user profile under the dedicated identifier;
 * removing it is allowed only after {@link isDedicatedTestDataDirectory}
 * confirms the name. Failures are reported, never thrown, because cleanup
 * runs from `finally` and must not mask the scenario outcome.
 */
const cleanupScenarioData = async ({ home, keepData }) => {
  const dataDir = applicationDataDirectory(home);
  const summary = {
    kept: keepData,
    home: displayPath(home),
    appData: displayPath(dataDir),
    removed: [],
    skipped: [],
    errors: [],
  };
  if (keepData) {
    summary.skipped.push({ path: summary.home, reason: "--keep-data" });
    summary.skipped.push({ path: summary.appData, reason: "--keep-data" });
    return summary;
  }
  const remove = async (directory, label) => {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      summary.removed.push(displayPath(directory));
    } catch (error) {
      summary.errors.push(
        `${label} (${displayPath(directory)}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  // The scenario HOME belongs to this process; its app data is inside it on
  // macOS/Linux.
  await remove(home, "scenario home");
  if (process.platform === "win32") {
    if (isDedicatedTestDataDirectory(dataDir)) {
      await remove(dataDir, "test app data");
    } else {
      summary.skipped.push({
        path: summary.appData,
        reason: "not the dedicated .native-e2e data directory",
      });
    }
  }
  return summary;
};

const launchApplication = async ({
  binary,
  fixturePath,
  scenario,
  markerPath,
  reportPath,
  home,
  logPath,
  verbose,
}) => {
  const env = {
    ...isolatedEnvironment(home),
    OPUS_NATIVE_E2E_SCENARIO: scenario,
    OPUS_NATIVE_E2E_MARKER: markerPath,
    OPUS_NATIVE_E2E_REPORT: reportPath,
    RUST_BACKTRACE: "1",
  };
  for (const directory of [
    env.TMPDIR,
    applicationDataDirectory(home),
    path.dirname(markerPath),
    path.dirname(reportPath),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  const log = createWriteStream(logPath, { flags: "a" });
  const child = spawn(binary, [fixturePath], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  if (verbose) {
    child.stdout.on("data", (chunk) => process.stdout.write(`[app] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[app] ${chunk}`));
  }
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let launchError = null;
  child.once("error", (error) => {
    launchError = error;
  });
  return {
    child,
    exit,
    log,
    logPath,
    get launchError() {
      return launchError;
    },
  };
};

// ---------- marker / report ----------

const validateMarker = (marker, scenario) => {
  if (marker === null || typeof marker !== "object") {
    fail("marker is not a JSON object");
  }
  const keys = Object.keys(marker).sort().join(",");
  if (keys !== "identifier,phase,scenario") {
    fail(`marker has unexpected shape: ${keys}`);
  }
  if (marker.identifier !== APP_IDENTIFIER) {
    fail(
      `marker reports identifier ${JSON.stringify(marker.identifier)}; ` +
        `refusing to continue with anything but ${APP_IDENTIFIER}`,
    );
  }
  if (marker.scenario !== scenario) {
    fail(
      `marker scenario ${JSON.stringify(marker.scenario)} does not match ${scenario}`,
    );
  }
  if (typeof marker.phase !== "string" || marker.phase.length === 0) {
    fail("marker phase is missing");
  }
};

const PHASE_ORDER = {
  smoke: ["opened", "done"],
  "edit-save": ["opened", "done"],
  "external-change": [
    "opened",
    "clean-ready",
    "clean-reloaded",
    "dirty-ready",
    "conflict-visible",
    "done",
  ],
  // Recovery is split across two launches; both sequences share one file.
  recovery: ["opened", "draft-ready", "draft-listed", "restored", "done"],
};

const waitForMarker = async ({
  markerPath,
  reportPath,
  phase,
  scenario,
  application,
  timeoutMs = PHASE_TIMEOUT_MS,
}) => {
  const order = PHASE_ORDER[scenario];
  const targetIndex = order.indexOf(phase);
  if (targetIndex === -1) fail(`unknown marker phase ${phase} for ${scenario}`);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const marker = await readJson(markerPath);
      if (marker !== null) {
        validateMarker(marker, scenario);
        if (marker.phase === "failed") {
          const report = await readJson(reportPath);
          throw new OrchestratorError(
            `native runner reported failure: ${report?.error ?? "no report"}`,
            { marker, report },
          );
        }
        // A fast scenario can write several phases within one poll interval
        // (smoke goes straight from opened to done). Accept a later phase in
        // the same scenario's order; only phases before the target mean the
        // condition has not happened yet.
        const observedIndex = order.indexOf(marker.phase);
        if (observedIndex === -1) {
          fail(`unexpected marker phase ${JSON.stringify(marker.phase)}`);
        }
        if (observedIndex >= targetIndex) return marker;
      }
      lastError = null;
    } catch (error) {
      if (error instanceof OrchestratorError) throw error;
      lastError = error;
    }
    if (application) {
      if (application.launchError) {
        fail(
          `failed to launch the native process: ${application.launchError.message}`,
        );
      }
      const { child } = application;
      if (child.exitCode !== null || child.signalCode !== null) {
        fail(
          `native process exited (code ${child.exitCode}, signal ${child.signalCode}) ` +
            `before marker ${phase}; see ${relative(application.logPath)}`,
        );
      }
    }
    if (Date.now() >= deadline) {
      fail(
        `timed out after ${timeoutMs} ms waiting for marker "${phase}"` +
          (lastError ? ` (${lastError.message})` : ""),
      );
    }
    await sleep(50);
  }
};

const waitForReport = async (reportPath, scenario) => {
  const report = await readJson(reportPath);
  if (report === null) fail(`report file is missing: ${relative(reportPath)}`);
  if (report.identifier !== APP_IDENTIFIER) {
    fail(
      `report identifier ${JSON.stringify(report.identifier)} is not ${APP_IDENTIFIER}`,
    );
  }
  if (report.scenario !== scenario) {
    fail(`report scenario ${JSON.stringify(report.scenario)} is not ${scenario}`);
  }
  if (report.status !== "passed") {
    fail(`report status is ${JSON.stringify(report.status)}: ${report.error ?? ""}`);
  }
  return report;
};

// ---------- fixtures and assertions ----------

const fixtureBytes = (text) => Buffer.concat([BOM, Buffer.from(text, "utf8")]);

const writeFixture = async (file, text) => {
  await fs.writeFile(file, fixtureBytes(text));
};

let externalWriteSequence = 0;

/**
 * External rewrites are atomic: write a sibling temporary file, fsync it,
 * then rename over the document. The watcher therefore only ever observes a
 * complete file, matching how an external editor saves.
 */
export const writeExternal = async (file, text) => {
  const directory = path.dirname(file);
  externalWriteSequence += 1;
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${externalWriteSequence}.tmp`,
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(fixtureBytes(text));
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
};

const fixtureText = (label) =>
  `# Native E2E ${label}\r\n\r\n- first line\r\n- second line\r\n`;

const assertEditSave = async ({ report, fixturePath, initialText }) => {
  const bytes = await fs.readFile(fixturePath);
  const diskText = decodeFixture(bytes);
  if (!samePath(report.path, await fs.realpath(fixturePath))) {
    fail(`report path ${report.path} is not the canonical fixture path`);
  }
  if (report.text !== diskText) {
    fail("report text does not match the saved bytes");
  }
  if (report.hasUtf8Bom !== true || report.newline !== "cr_lf") {
    fail("report did not record the preserved BOM/CRLF style");
  }
  const normalized = normalizeNewlines(diskText);
  const token = report.editToken;
  if (typeof token !== "string" || token.length === 0) {
    fail("report did not include the edit token");
  }
  if (countOccurrences(normalized, token) !== 1) {
    fail("edit token does not occur exactly once in the saved text");
  }
  if (normalized !== normalizeNewlines(initialText) + token) {
    fail("saved text is not the original fixture plus exactly one edit");
  }
  return { diskText, bytes: bytes.byteLength, sha256: sha256(bytes) };
};

const assertExternalChange = async ({
  report,
  fixturePath,
  cleanText,
  conflictText,
}) => {
  if (!samePath(report.path, await fs.realpath(fixturePath))) {
    fail(`report path ${report.path} is not the canonical fixture path`);
  }
  if (report.conflictObserved !== true || report.conflictDialogVisible !== true) {
    fail("report did not observe the visible conflict dialog");
  }
  if (report.cleanText === report.dirtyText) {
    fail("clean reload did not replace the original text");
  }
  if (normalizeNewlines(report.cleanText) !== normalizeNewlines(cleanText)) {
    fail("clean reload did not surface the externally written text");
  }
  const token = report.editToken;
  if (typeof token !== "string" || token.length === 0) {
    fail("report did not include the edit token");
  }
  if (!normalizeNewlines(report.dirtyText).includes(token)) {
    fail("dirty buffer lost the editor edit");
  }
  if (report.resolvedText !== report.diskText) {
    fail("resolved text does not match the final disk read");
  }
  if (normalizeNewlines(report.resolvedText) !== normalizeNewlines(conflictText)) {
    fail("load-disk action did not adopt the external conflict text");
  }
  const bytes = await fs.readFile(fixturePath);
  const diskText = decodeFixture(bytes);
  if (diskText !== report.resolvedText) {
    fail("disk bytes do not match the resolved report text");
  }
  return { diskText, bytes: bytes.byteLength, sha256: sha256(bytes) };
};

const assertSmoke = async ({ report, fixturePath, initialText }) => {
  if (!samePath(report.path, await fs.realpath(fixturePath))) {
    fail(`report path ${report.path} is not the canonical fixture path`);
  }
  if (report.text !== initialText) {
    fail("argv-opened document text does not match the fixture");
  }
  if (report.hasUtf8Bom !== true || report.newline !== "cr_lf") {
    fail("argv-opened document did not preserve BOM/CRLF metadata");
  }
  const bytes = await fs.readFile(fixturePath);
  if (!bytes.equals(fixtureBytes(initialText))) {
    fail("smoke scenario must not modify the fixture");
  }
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
};

const recoveryDraftDirectory = (home) =>
  path.join(applicationDataDirectory(home), "recovery");

const DRAFT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Resolves the draft file the Rust recovery store wrote for a real draft id.
 * The id always comes from the runner's `listDrafts()` result (reported
 * before the crash marker), never from a guessed tab id: `drafts.ts`
 * namespaces ids per launch (`draft-<uuid>-document-N`), so `draft-document-N`
 * names no persisted file after a relaunch. Ids become file names in the
 * backend, so an id outside its alphabet is rejected instead of used as a
 * path.
 */
export const draftFilePath = (directory, draftId) => {
  if (typeof draftId !== "string" || !DRAFT_ID_PATTERN.test(draftId)) {
    throw new OrchestratorError(
      `recovery draft id ${JSON.stringify(draftId)} is not a safe draft file name`,
    );
  }
  return path.join(directory, `${draftId}.json`);
};

/**
 * Reads and validates the stored draft record. The file name and the
 * `draft_id` inside must agree, so a stale or spoofed file cannot stand in
 * for the draft the runner listed.
 */
export const readDraftRecord = (file, expectedId) => {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    fail(
      `cannot read recovery draft ${displayPath(file)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    fail(`invalid JSON in recovery draft ${displayPath(file)}`);
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    fail(`recovery draft ${displayPath(file)} is not a JSON object`);
  }
  if (record.draft_id !== expectedId) {
    fail(
      `recovery draft ${displayPath(file)} reports id ` +
        `${JSON.stringify(record.draft_id)}, expected ${JSON.stringify(expectedId)}`,
    );
  }
  if (typeof record.text !== "string" || record.text.length === 0) {
    fail(`recovery draft ${displayPath(file)} has no text`);
  }
  return record;
};

/**
 * The first launch reports the real draft id it listed (with status
 * `draft-ready`) before writing the marker. The report is the only channel
 * that can carry data beyond the fixed marker contract.
 */
const waitForDraftReport = async (
  reportPath,
  scenario,
  timeoutMs = 30_000,
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const report = await readJson(reportPath);
    if (report !== null) {
      if (report.identifier !== APP_IDENTIFIER) {
        fail(
          `draft report identifier ${JSON.stringify(report.identifier)} is not ${APP_IDENTIFIER}`,
        );
      }
      if (report.scenario !== scenario) {
        fail(`draft report scenario ${JSON.stringify(report.scenario)} is not ${scenario}`);
      }
      if (report.status === "failed") {
        fail(`native runner reported failure: ${report.error ?? "no report error"}`);
      }
      if (report.status === "draft-ready") {
        if (typeof report.draftId !== "string" || report.draftId.length === 0) {
          fail("draft-ready report does not carry a draft id");
        }
        return report;
      }
    }
    if (Date.now() >= deadline) {
      fail(`timed out after ${timeoutMs} ms waiting for the draft-ready report`);
    }
    await sleep(50);
  }
};

/**
 * Copies the persisted draft into the diagnostics directory and keeps its
 * text and hash in the summary. The scenario HOME (and on Windows the test
 * app-data directory) is deleted during cleanup, so a path alone would point
 * at a file that no longer exists by the time anyone reads the report.
 */
const archivePersistedDraft = async ({
  scenarioDir,
  home,
  draftId,
}) => {
  const source = draftFilePath(recoveryDraftDirectory(home), draftId);
  const record = readDraftRecord(source, draftId);
  const archived = path.join(scenarioDir, "draft-launch-1.json");
  await fs.copyFile(source, archived);
  const textSha256 = sha256(Buffer.from(record.text, "utf8"));
  return {
    id: draftId,
    text: record.text,
    textSha256,
    bytes: Buffer.byteLength(record.text, "utf8"),
    originalPath: record.original_path ?? null,
    file: relative(archived),
    sourceFile: displayPath(source),
  };
};

const assertRecovery = async ({ report, fixturePath, persistedDraft }) => {
  if (report.documentStatus !== "dirty") {
    fail(
      `recovered document status is ${JSON.stringify(report.documentStatus)}, expected "dirty"`,
    );
  }
  if (report.dirty !== (report.documentStatus !== "clean")) {
    fail("recovered document dirty flag does not match its reported status");
  }
  if (!samePath(report.path, await fs.realpath(fixturePath))) {
    fail("recovered document path does not match the fixture");
  }
  if (report.draftId !== persistedDraft.id) {
    fail(
      `restored draft id ${JSON.stringify(report.draftId)} is not the persisted ` +
        `id ${JSON.stringify(persistedDraft.id)}`,
    );
  }
  if (report.text !== persistedDraft.text) {
    fail("restored text does not match the durable draft written before SIGKILL");
  }
  if (sha256(Buffer.from(report.text, "utf8")) !== persistedDraft.textSha256) {
    fail("restored text hash does not match the archived draft");
  }
  if (typeof report.editToken !== "string") {
    fail("report did not include the edit token");
  }
  if (countOccurrences(normalizeNewlines(report.text), report.editToken) !== 1) {
    fail("recovered text does not contain exactly one edit token");
  }
  return {
    draftId: report.draftId,
    bytes: Buffer.byteLength(report.text, "utf8"),
    textSha256: persistedDraft.textSha256,
    archivedDraft: persistedDraft.file,
  };
};

// ---------- scenario driver ----------

const resetOutputs = async (markerPath, reportPath) => {
  await fs.rm(markerPath, { force: true });
  await fs.rm(reportPath, { force: true });
};

const runScenario = async ({ name, binary, options, workRoot, runDir }) => {
  const scenarioDir = path.join(runDir, name);
  await fs.mkdir(scenarioDir, { recursive: true });
  const fixturePath = path.join(workRoot, `${name}.md`);
  const initialText = fixtureText(name);
  await writeFixture(fixturePath, initialText);
  const markerPath = path.join(scenarioDir, "marker.json");
  const reportPath = path.join(scenarioDir, "report.json");
  const home = path.join(scenarioDir, "home");
  await resetOutputs(markerPath, reportPath);
  // Start every scenario from a clean test-data directory. On Windows the
  // directory is the real per-user app-data root under the dedicated test
  // identifier, so an interrupted earlier run could otherwise leave drafts
  // that a recovery scenario would mistake for its own. The same validation
  // as end-of-run cleanup gates this removal.
  const preexistingCleanup = await cleanupScenarioData({
    home,
    keepData: false,
  });
  await fs.mkdir(home, { recursive: true });
  if (existsSync(applicationDataDirectory(home))) {
    fail(
      `test app data still exists after cleanup: ` +
        `${displayPath(applicationDataDirectory(home))} — another native E2E ` +
        `run may still be using the dedicated identifier`,
    );
  }

  const result = {
    status: "running",
    markers: [],
    fixture: {
      path: relative(fixturePath),
      sha256: sha256(readFileSync(fixturePath)),
      bytes: statSync(fixturePath).size,
    },
    data: {
      home: displayPath(home),
      appData: displayPath(applicationDataDirectory(home)),
      // Only macOS/Linux honor the HOME/XDG overrides. Windows resolves app
      // data through the shell known folder, so the dedicated identifier is
      // the isolation boundary there.
      isolated: process.platform !== "win32",
      cleanedBeforeStart: preexistingCleanup,
    },
    launches: [],
  };
  let application = null;
  let persistedDraft = null;
  try {
    const launch = async (index, launchScenario) => {
      const logPath = path.join(scenarioDir, `app-launch-${index}.log`);
      const launched = await launchApplication({
        binary,
        fixturePath,
        scenario: launchScenario,
        markerPath,
        reportPath,
        home,
        logPath,
        verbose: options.verbose,
      });
      application = launched;
      result.launches.push({ index, log: relative(logPath) });
      return launched;
    };
    const expect = async (phase, timeoutMs) => {
      const marker = await waitForMarker({
        markerPath,
        reportPath,
        phase,
        scenario: name,
        application,
        timeoutMs,
      });
      // Record what was actually observed. A fast scenario may advance past
      // the requested phase between polls; pretending the requested phase
      // was seen would make diagnostics lie about the sequence.
      result.markers.push({
        phase: marker.phase,
        expected: phase,
        at: new Date().toISOString(),
      });
      if (options.verbose) {
        const suffix =
          marker.phase === phase ? "" : ` (advanced past ${phase})`;
        console.log(`[${name}] marker: ${marker.phase}${suffix}`);
      }
      return marker;
    };
    const finish = async (assertion) => {
      await expect("done");
      const report = await waitForReport(reportPath, name);
      const detail = await assertion({ report });
      result.status = "passed";
      result.report = report;
      result.assertion = detail;
    };

    if (name === "smoke") {
      await launch(1, "smoke");
      await expect("opened", STARTUP_TIMEOUT_MS);
      await finish(({ report }) =>
        assertSmoke({ report, fixturePath, initialText }),
      );
    } else if (name === "edit-save") {
      await launch(1, "edit-save");
      await expect("opened", STARTUP_TIMEOUT_MS);
      await finish(({ report }) =>
        assertEditSave({ report, fixturePath, initialText }),
      );
    } else if (name === "external-change") {
      await launch(1, "external-change");
      await expect("opened", STARTUP_TIMEOUT_MS);
      await expect("clean-ready");
      const cleanText = fixtureText("external clean reload");
      await writeExternal(fixturePath, cleanText);
      await expect("clean-reloaded");
      await expect("dirty-ready");
      const conflictText = fixtureText("external conflict");
      await writeExternal(fixturePath, conflictText);
      await expect("conflict-visible");
      await finish(({ report }) =>
        assertExternalChange({ report, fixturePath, cleanText, conflictText }),
      );
    } else if (name === "recovery") {
      await launch(1, "recovery");
      await expect("opened", STARTUP_TIMEOUT_MS);
      await expect("draft-ready", PHASE_TIMEOUT_MS);
      // The runner reports the real draft id it listed from the recovery
      // store. Its launch-scoped namespace differs on every relaunch, so a
      // hardcoded `draft-document-N` (or a scan keyed on the tab id) would
      // look at a file that does not exist.
      const draftReport = await waitForDraftReport(reportPath, name);
      persistedDraft = await archivePersistedDraft({
        scenarioDir,
        home,
        draftId: draftReport.draftId,
      });
      result.draft = persistedDraft;
      // A crash, not a clean close: no close-requested flush, no draft
      // discard. The relaunch must find the draft written before this kill.
      // `waitForApplicationExit` bounds the wait; if it fails, `application`
      // stays set so the outer finally still attempts cleanup.
      killProcessTree(application.child, true);
      await waitForApplicationExit(application, "recovery launch 1");
      application = null;
      // The draft must have survived the kill unchanged, not merely existed
      // before it.
      const survived = readDraftRecord(
        draftFilePath(recoveryDraftDirectory(home), persistedDraft.id),
        persistedDraft.id,
      );
      if (sha256(Buffer.from(survived.text, "utf8")) !== persistedDraft.textSha256) {
        fail("recovery draft content changed across the crash");
      }
      // Archive the first launch's sync files, then reset for the relaunch.
      await fs.copyFile(markerPath, path.join(scenarioDir, "marker-launch-1.json"));
      await fs.copyFile(reportPath, path.join(scenarioDir, "report-launch-1.json"));
      await resetOutputs(markerPath, reportPath);

      await launch(2, "recovery");
      await expect("draft-listed", STARTUP_TIMEOUT_MS);
      await expect("restored");
      await finish(({ report }) =>
        assertRecovery({ report, fixturePath, persistedDraft }),
      );
    } else {
      fail(`unimplemented scenario ${name}`);
    }
    await stopApplication(application);
    application = null;
  } catch (error) {
    result.status = "failed";
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    // Cleanup is diagnostic-preserving: a failure to stop the child must not
    // skip the summary or the safe removal of data this run created.
    try {
      await stopApplication(application);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.stopError = message;
      if (result.status === "passed") result.status = "failed";
      result.error = result.error ? `${result.error}; ${message}` : message;
    }
    application = null;
    try {
      result.finalMarker = await readJson(markerPath);
    } catch (error) {
      result.markerError = error instanceof Error ? error.message : String(error);
    }
    try {
      result.finalReport = await readJson(reportPath);
    } catch (error) {
      result.reportError = error instanceof Error ? error.message : String(error);
    }
    try {
      result.cleanup = await cleanupScenarioData({
        home,
        keepData: options.keepData,
      });
    } catch (error) {
      // `cleanupScenarioData` reports its own failures; this only guards
      // against an unexpected bug so the summary is still written.
      result.cleanup = {
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
    if (result.status === "running") {
      result.status = "failed";
      result.error ??= "scenario ended without a result";
    }
    const summaryFile = path.join(scenarioDir, "summary.json");
    try {
      writeFileSync(summaryFile, `${JSON.stringify(result, null, 2)}\n`);
      result.summary = relative(summaryFile);
    } catch (error) {
      result.summaryError = error instanceof Error ? error.message : String(error);
      console.error(
        `cannot write scenario summary ${relative(summaryFile)}: ${result.summaryError}`,
      );
    }
  }
  return result;
};

const assertSafeIdentifier = () => {
  if (
    APP_IDENTIFIER === PRODUCTION_IDENTIFIER ||
    APP_IDENTIFIER.length <= IDENTIFIER_SUFFIX.length ||
    !APP_IDENTIFIER.endsWith(IDENTIFIER_SUFFIX)
  ) {
    fail("native E2E identifier is not isolated from production");
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  assertSafeIdentifier();
  mkdirSync(RESULTS_ROOT, { recursive: true });
  const runDir = path.join(RESULTS_ROOT, `run-${timestamp()}`);
  await fs.mkdir(runDir, { recursive: true });
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opus-native-e2e-"));
  const summary = {
    status: "running",
    identifier: APP_IDENTIFIER,
    startedAt: new Date().toISOString(),
    release: options.release,
    keepData: options.keepData,
    app: null,
    build: null,
    scenarios: {},
    failure: null,
  };
  let pass = false;
  try {
    let binary;
    if (options.build) {
      const built = await buildTestApp(options, runDir);
      binary = built.binary;
      summary.build = {
        command: built.command.map((part, index) =>
          index === 0
            ? path.basename(part)
            : path.isAbsolute(part)
              ? relative(part)
              : part,
        ),
        log: relative(built.logPath),
      };
    } else if (options.app !== null) {
      binary = options.app;
    } else {
      // Without --build or --app, run the debug binary left by a previous
      // --build; fail early with a clear instruction when it is absent.
      binary = path.join(ROOT, "src-tauri", "target", "debug", BINARY_NAME);
      if (!existsSync(binary)) {
        fail(
          "no test binary available: pass --build (or --app <path>) — " +
            "a normal build does not register the native E2E commands",
        );
      }
    }
    summary.app = {
      path: relative(binary),
      ...fileDigest(binary),
    };
    console.log(`Native E2E identifier: ${APP_IDENTIFIER}`);
    console.log(`Application: ${relative(binary)}`);

    const names = selectedScenarios(options.scenario);
    let failed = false;
    for (const name of names) {
      console.log(`\n▶ ${name}`);
      let result;
      try {
        result = await runScenario({
          name,
          binary,
          options,
          workRoot,
          runDir,
        });
      } catch (error) {
        // runScenario records its own failures; this path only covers errors
        // before it could (for example an unreadable fixture). Record the
        // scenario in the top-level summary before propagating.
        result = {
          status: "failed",
          markers: [],
          launches: [],
          error: error instanceof Error ? error.message : String(error),
        };
        summary.scenarios[name] = result;
        summary.failure = `${name}: ${result.error}`;
        throw error;
      }
      summary.scenarios[name] = result;
      if (result.status !== "passed") {
        failed = true;
        summary.failure = `${name}: ${result.error ?? "scenario failed"}`;
        console.error(`\n✗ ${summary.failure}`);
        break;
      }
      console.log(`✓ ${name}`);
    }
    if (!failed) {
      pass = true;
      console.log(`\nNative E2E passed: ${names.join(", ")}`);
    }
  } catch (error) {
    summary.failure = error instanceof Error ? error.message : String(error);
    console.error(`\n✗ Native E2E failed: ${summary.failure}`);
    if (error instanceof OrchestratorError && error.details) {
      console.error(JSON.stringify(error.details, null, 2));
    }
  } finally {
    summary.status = pass ? "passed" : "failed";
    summary.finishedAt = new Date().toISOString();
    rmSync(workRoot, { recursive: true, force: true });
    const summaryPath = path.join(runDir, "summary.json");
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`Diagnostics: ${relative(runDir)}`);
    if (!pass) process.exitCode = 1;
  }
};

const isEntryPoint =
  process.argv[1] !== undefined &&
  samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url));

if (isEntryPoint) {
  await main().catch((error) => {
    // Argument/usage errors happen before a run directory exists; runtime
    // failures are already reported and given exit code 1 inside main().
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 2;
  });
}