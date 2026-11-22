import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertBuiltAssets,
  assertFixturesComplete,
  buildEnvironment,
  collectAssetProvenance,
  createCleanupStack,
  documentEndShortcut,
  normalizeLatencySamples,
  resolveBrowserChannel,
  saveShortcut,
  serverReady,
  snapshotGitState,
  writeReportAtomically,
} from "./measure-editor.mjs";

test("CLI channel parsing defaults to production and rejects unknown values", () => {
  assert.equal(resolveBrowserChannel([]), "production");
  assert.equal(resolveBrowserChannel(["--browser", "dev"]), "dev");
  assert.equal(resolveBrowserChannel(["--browser=production"]), "production");
  assert.throws(() => resolveBrowserChannel(["--browser", "staging"]), /must be one of/);
  assert.throws(() => resolveBrowserChannel(["--bogus"]), /unknown argument/);
});

test("platform shortcuts match CodeMirror and save conventions", () => {
  assert.equal(documentEndShortcut("darwin"), "Meta+End");
  assert.equal(documentEndShortcut("linux"), "Control+End");
  assert.equal(documentEndShortcut("win32"), "Control+End");
  assert.equal(saveShortcut("darwin"), "Meta+s");
  assert.equal(saveShortcut("linux"), "Control+s");
  assert.equal(saveShortcut("win32"), "Control+s");
});

test("input samples require exactly KEYSTROKES finite values and clamp negatives", () => {
  assert.deepEqual(normalizeLatencySamples([5, -2, 0.5], 3), [5, 0, 0.5]);
  assert.throws(() => normalizeLatencySamples([1, 2], 3), /exactly 3/);
  assert.throws(() => normalizeLatencySamples([1, Number.NaN, 3], 3), /finite/);
  assert.throws(() => normalizeLatencySamples("nope", 3), /not an array/);
});

test("git state is a snapshot with hash, dirty flag and capture time", () => {
  const state = snapshotGitState();
  assert.ok(state.buildSha === null || typeof state.buildSha === "string");
  assert.equal(typeof state.buildShaDirty, "boolean");
  assert.equal(typeof state.dirtyFileCount, "number");
  assert.ok(!Number.isNaN(Date.parse(state.capturedAt)));
});

test("environment uses the supplied git snapshot, not live status", () => {
  const snapshot = {
    buildSha: "deadbeef",
    buildShaDirty: false,
    dirtyFileCount: 0,
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
  const environment = buildEnvironment("dev", snapshot);
  assert.equal(environment.buildSha, "deadbeef");
  assert.equal(environment.buildShaDirty, false);
  assert.equal(environment.gitStateCapturedAt, snapshot.capturedAt);
  assert.equal(environment.browserChannel, "dev");
});

test("cleanup stack runs in reverse order, is idempotent and can remove entries", async () => {
  const calls = [];
  const stack = createCleanupStack();
  stack.add("first", () => calls.push("first"));
  stack.add("second", () => calls.push("second"));
  await stack.run({ perCleanupMs: 100, totalMs: 500 });
  assert.deepEqual(calls, ["second", "first"]);
  await stack.run({ perCleanupMs: 100, totalMs: 500 });
  assert.deepEqual(calls, ["second", "first"]);

  const removedCalls = [];
  const removable = createCleanupStack();
  const release = removable.add("removed", () => removedCalls.push("removed"));
  removable.add("kept", () => removedCalls.push("kept"));
  release();
  await removable.run({ perCleanupMs: 100, totalMs: 500 });
  assert.deepEqual(removedCalls, ["kept"]);
});

test("cleanup stack bounds a hanging cleanup and continues", async () => {
  const calls = [];
  const stack = createCleanupStack();
  stack.add("hang", () => new Promise(() => {}));
  stack.add("after", () => calls.push("after"));
  const started = Date.now();
  await stack.run({ perCleanupMs: 25, totalMs: 500 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `cleanup took ${elapsed} ms`);
  assert.deepEqual(calls, ["after"]);
});

test("cleanup stack honors a per-entry timeout", async () => {
  const stack = createCleanupStack();
  stack.add("hang", () => new Promise(() => {}), 20);
  stack.add("fast", () => undefined);
  const started = Date.now();
  await stack.run({ perCleanupMs: 500, totalMs: 1_000 });
  assert.ok(Date.now() - started < 500);
});

test("serverReady gives up on a hanging server with a short timeout", async () => {
  const server = createServer(() => {
    // Intentionally never respond.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const started = Date.now();
  const ready = await serverReady(
    `http://127.0.0.1:${address.port}/perf.html`,
    100,
  );
  const elapsed = Date.now() - started;
  assert.equal(ready, false);
  assert.ok(elapsed < 1_000, `serverReady took ${elapsed} ms`);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test("asset provenance records bytes and SHA-256 and rejects empty builds", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opus-assets-"));
  try {
    await mkdir(path.join(directory, "assets"));
    await writeFile(path.join(directory, "perf.html"), "<div id=root></div>");
    await writeFile(path.join(directory, "assets", "perf.js"), "console.log(1)");
    const assets = collectAssetProvenance(directory, directory);
    assert.equal(assets.length, 2);
    const html = assets.find((asset) => asset.path === "perf.html");
    assert.ok(html);
    assert.equal(html.bytes, Buffer.byteLength("<div id=root></div>"));
    assert.equal(
      html.sha256,
      createHash("sha256").update("<div id=root></div>").digest("hex"),
    );
    assert.doesNotThrow(() => assertBuiltAssets(assets));
    assert.throws(() => assertBuiltAssets([]), /no assets/);
    assert.throws(
      () => assertBuiltAssets([{ path: "perf.html", bytes: 1, sha256: "x" }]),
      /JavaScript/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixture completeness rejects truncated generated files", () => {
  assert.doesNotThrow(() =>
    assertFixturesComplete([
      { name: "regular-1mb.md", bytes: 1024 * 1024 + 1 },
    ]),
  );
  assert.throws(
    () => assertFixturesComplete([{ name: "regular-1mb.md", bytes: 10 }]),
    /truncated/,
  );
});

test("report writes atomically and leaves no temp file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opus-report-"));
  const reportPath = path.join(directory, "report.json");
  try {
    const report = { schema: 1, metrics: { hot_start_ms: { median: 1 } } };
    await writeReportAtomically(report, reportPath);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), report);
    assert.deepEqual(await readdir(directory), ["report.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("report serialization failure leaves no temp file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opus-report-fail-"));
  try {
    const circular = {};
    circular.self = circular;
    assert.throws(() =>
      writeReportAtomically(circular, path.join(directory, "report.json")),
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
