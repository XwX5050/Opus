// Executable self-tests for the native E2E orchestrator's pure helpers.
//
// Run with: node --test scripts/native-e2e.node-test.mjs
//
// Deliberately not named `*.test.mjs`: Vitest's default include pattern would
// pick it up and run node:test assertions inside its own environment. Node's
// test runner accepts the explicit path regardless of the file name, so no
// package.json script is needed.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  draftFilePath,
  isDedicatedTestDataDirectory,
  normalizePathForComparison,
  PHASE_TIMEOUT_MS,
  readDraftRecord,
  RUNNER_TIMEOUT_MS,
  samePath,
  writeExternal,
} from "./native-e2e.mjs";

test("samePath folds Windows extended drive paths, separators and case", () => {
  assert.equal(
    samePath("\\\\?\\C:\\Docs\\Note.md", "c:/docs/note.md", "win32"),
    true,
  );
  assert.equal(
    samePath("\\\\?\\C:\\Docs\\..\\Docs\\Note.md", "C:\\DOCS\\note.md", "win32"),
    true,
  );
});

test("samePath folds Windows device namespace paths", () => {
  assert.equal(
    samePath("\\\\.\\C:\\Docs\\Note.md", "C:\\docs\\note.md", "win32"),
    true,
  );
});

test("samePath folds Windows extended UNC paths", () => {
  assert.equal(
    samePath(
      "\\\\?\\UNC\\Server\\Share\\Note.md",
      "\\\\server\\share\\note.md",
      "win32",
    ),
    true,
  );
  assert.equal(
    normalizePathForComparison(
      "\\\\?\\UNC\\Server\\Share\\Note.md",
      "win32",
    ),
    "\\\\server\\share\\note.md",
  );
});

test("samePath does not fold distinct Windows paths", () => {
  assert.equal(
    samePath("C:\\Docs\\One.md", "C:\\Docs\\Two.md", "win32"),
    false,
  );
});

test("samePath keeps POSIX semantics case-sensitive", () => {
  assert.equal(samePath("/tmp/A.md", "/tmp/a.md", "linux"), false);
  assert.equal(samePath("/tmp/A.md", "/tmp/./A.md", "linux"), true);
});

test("writeExternal replaces the document via a same-directory rename", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opus-native-e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "note.md");
  await writeFile(file, "old contents");
  const before = await stat(file);

  const text = "# Replaced\r\n\r\nbody\r\n";
  await writeExternal(file, text);

  const bytes = await readFile(file);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.subarray(3).toString("utf8"), text);
  // The sibling temp file was renamed over the target, not left behind; the
  // directory holds exactly the document again.
  assert.deepEqual(await readdir(directory), ["note.md"]);
  // A rename installs a new inode (skip on platforms where inode numbers are
  // not meaningful, e.g. some Windows filesystems).
  if (process.platform !== "win32") {
    const after = await stat(file);
    assert.notEqual(after.ino, before.ino);
  }
});

test("phase timeout outlives the runner deadline", () => {
  assert.ok(
    PHASE_TIMEOUT_MS > RUNNER_TIMEOUT_MS,
    `phase timeout ${PHASE_TIMEOUT_MS} must exceed runner timeout ${RUNNER_TIMEOUT_MS}`,
  );
  assert.ok(
    PHASE_TIMEOUT_MS - RUNNER_TIMEOUT_MS >= 30_000,
    "phase timeout must leave room for native startup before the runner clock",
  );
  assert.ok(RUNNER_TIMEOUT_MS >= 90_000);
});

test("draftFilePath resolves the real draft id to its store file", () => {
  const file = draftFilePath(
    path.join("data", "recovery"),
    "draft-11111111-1111-4111-8111-111111111111-document-1",
  );
  assert.equal(
    file,
    path.join(
      "data",
      "recovery",
      "draft-11111111-1111-4111-8111-111111111111-document-1.json",
    ),
  );
});

test("draftFilePath rejects ids that would escape the recovery store", () => {
  for (const draftId of [
    "",
    "draft-document-1/../../escape",
    "draft document 1",
    "draft-document-1.json",
    "x".repeat(129),
    null,
    42,
  ]) {
    assert.throws(
      () => draftFilePath("/tmp/recovery", draftId),
      /safe draft file name/,
      `id ${JSON.stringify(draftId)} must be rejected`,
    );
  }
});

test("readDraftRecord accepts the stored record and rejects mismatches", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opus-native-e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "draft-id.json");
  const draftId = "draft-11111111-1111-4111-8111-111111111111-document-1";
  await writeFile(
    file,
    JSON.stringify({
      draft_id: draftId,
      original_path: "/tmp/note.md",
      title: "note.md",
      text: "# Recovered\r\nbody",
      has_utf8_bom: true,
      newline: "cr_lf",
      saved_text_hash: "hash",
      saved_version: "v1",
    }),
  );

  const record = readDraftRecord(file, draftId);
  assert.equal(record.text, "# Recovered\r\nbody");

  assert.throws(
    () => readDraftRecord(file, "draft-other-document-1"),
    /reports id/,
  );

  await writeFile(file, "{not json");
  assert.throws(() => readDraftRecord(file, draftId), /invalid JSON/);

  await writeFile(file, JSON.stringify({ draft_id: draftId, text: "" }));
  assert.throws(() => readDraftRecord(file, draftId), /has no text/);
});

test("isDedicatedTestDataDirectory accepts only the test identifier directory", () => {
  const identifier = "com.xiongweini.markdown-edit.native-e2e";
  const linuxData = `/home/user/.local/share/${identifier}`;
  const windowsData = `C:\\Users\\User\\AppData\\Roaming\\${identifier}`;

  assert.equal(isDedicatedTestDataDirectory(linuxData), true);
  assert.equal(isDedicatedTestDataDirectory(`${linuxData}/`), true);
  assert.equal(
    isDedicatedTestDataDirectory(windowsData, "win32"),
    true,
  );
  assert.equal(
    isDedicatedTestDataDirectory(windowsData.toUpperCase(), "win32"),
    true,
  );

  assert.equal(isDedicatedTestDataDirectory("/tmp/native-e2e"), false);
  assert.equal(
    isDedicatedTestDataDirectory("/tmp/com.xiongweini.markdown-edit"),
    false,
  );
  assert.equal(
    isDedicatedTestDataDirectory(
      "/home/user/.local/share/com.xiongweini.markdown-edit",
      "linux",
      "com.xiongweini.markdown-edit",
    ),
    false,
  );
  assert.equal(
    isDedicatedTestDataDirectory("/tmp/.native-e2e", "linux", ".native-e2e"),
    false,
  );
  assert.equal(isDedicatedTestDataDirectory("relative/path"), false);
});
