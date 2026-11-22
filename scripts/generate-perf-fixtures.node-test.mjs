import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PERF_FIXTURES,
  generateFixtureText,
  resolveGeneratedFixturePath,
  writeFileAtomically,
} from "./generate-perf-fixtures.mjs";

test("fixture generation is deterministic and byte-counted", () => {
  const first = generateFixtureText({ seed: 7, minBytes: 4_096 });
  const second = generateFixtureText({ seed: 7, minBytes: 4_096 });
  assert.equal(first.text, second.text);
  assert.equal(first.bytes, Buffer.byteLength(first.text, "utf8"));
  assert.ok(first.bytes > 4_096);
  assert.deepEqual(
    PERF_FIXTURES.map((fixture) => fixture.name),
    ["regular-1mb.md", "light-2mb.md", "pressure-10mb.md"],
  );
});

test("atomic fixture write replaces a truncated file with a complete one", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opus-fixture-"));
  try {
    const target = path.join(directory, "regular-1mb.md");
    await writeFile(target, "truncated");
    const expected = "# complete fixture\n";
    await writeFileAtomically(target, expected);
    assert.equal(await readFile(target, "utf8"), expected);
    assert.deepEqual(await readdir(directory), ["regular-1mb.md"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic fixture write removes its temp file when rename fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opus-fixture-fail-"));
  try {
    const target = path.join(directory, "regular-1mb.md");
    await mkdir(target);
    await assert.rejects(writeFileAtomically(target, "data"));
    assert.deepEqual(await readdir(directory), ["regular-1mb.md"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated fixture paths stay inside the generated directory", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opus-fixtures-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "opus-fixtures-outside-"));
  try {
    const inside = path.join(directory, "regular-1mb.md");
    const outsideFile = path.join(outside, "secret.md");
    await writeFile(inside, "# inside\n");
    await writeFile(outsideFile, "# outside\n");
    assert.equal(
      await resolveGeneratedFixturePath(directory, "regular-1mb.md"),
      await realpath(inside),
    );
    assert.equal(await resolveGeneratedFixturePath(directory, "../secret.md"), null);
    assert.equal(await resolveGeneratedFixturePath(directory, "notes.txt"), null);
    assert.equal(await resolveGeneratedFixturePath(directory, ".."), null);
    if (process.platform !== "win32") {
      const escape = path.join(directory, "escape.md");
      await symlink(outsideFile, escape);
      assert.equal(await resolveGeneratedFixturePath(directory, "escape.md"), null);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
