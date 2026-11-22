import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("importing measure-startup is side-effect free", async () => {
  const sigintListeners = process.listenerCount("SIGINT");
  const sigtermListeners = process.listenerCount("SIGTERM");
  const mod = await import("./measure-startup.mjs");
  assert.equal(process.listenerCount("SIGINT"), sigintListeners);
  assert.equal(process.listenerCount("SIGTERM"), sigtermListeners);
  assert.equal(typeof mod.cleanupActiveLaunches, "function");
  assert.equal(typeof mod.restoreStartupSession, "function");
  assert.equal(typeof mod.bundleIdentity, "function");
  await mod.cleanupActiveLaunches();
});

test("sample bundle binding requires hash, path, provenance and kind", async () => {
  const { sampleMatchesBundle } = await import("./measure-startup.mjs");
  const identity = {
    path: "src-tauri/target/release/bundle/macos/Opus.app",
    sha256: "abc123",
    provenance: "unsigned dev bundle (ad-hoc signature, not notarized)",
    provenanceKind: "adhoc",
  };
  const sample = {
    bundleSha256: identity.sha256,
    bundlePath: identity.path,
    bundleProvenance: identity.provenance,
    bundleProvenanceKind: identity.provenanceKind,
  };
  assert.equal(sampleMatchesBundle(sample, identity), true);
  assert.equal(
    sampleMatchesBundle({ ...sample, bundleSha256: "other" }, identity),
    false,
  );
  assert.equal(
    sampleMatchesBundle({ ...sample, bundlePath: "other.app" }, identity),
    false,
  );
  assert.equal(
    sampleMatchesBundle({ ...sample, bundleProvenance: "signed" }, identity),
    false,
  );
  assert.equal(
    sampleMatchesBundle({ ...sample, bundleProvenanceKind: "signed" }, identity),
    false,
  );
  assert.equal(sampleMatchesBundle({ spawnToEditableMs: 123 }, identity), false);
  assert.equal(sampleMatchesBundle(null, identity), false);

  const { coldSamplesMatchBundle, REQUIRED_COLD_SAMPLES } = await import(
    "./measure-startup.mjs"
  );
  const cold = Array.from({ length: REQUIRED_COLD_SAMPLES }, () => sample);
  assert.equal(coldSamplesMatchBundle(cold, identity), true);
  assert.equal(
    coldSamplesMatchBundle(
      cold.map((entry, index) =>
        index === 2 ? { ...entry, bundleSha256: "stale" } : entry,
      ),
      identity,
    ),
    false,
  );
  assert.equal(coldSamplesMatchBundle(cold.slice(1), identity), false);
});

test("fileSha256 hashes file bytes", async () => {
  const { fileSha256 } = await import("./measure-startup.mjs");
  const directory = await mkdtemp(path.join(tmpdir(), "opus-sha-"));
  try {
    const file = path.join(directory, "binary");
    await writeFile(file, "hello");
    assert.equal(
      fileSha256(file),
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundleIdentity binds executable hash to signing provenance", { skip: process.platform !== "darwin" }, async () => {
  const { bundleIdentity, fileSha256 } = await import("./measure-startup.mjs");
  const directory = await mkdtemp(path.join(tmpdir(), "opus-app-"));
  try {
    const app = path.join(directory, "Opus.app");
    const binary = path.join(app, "Contents/MacOS/Opus");
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "fake executable");
    await writeFile(
      path.join(app, "Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.opus.test</string></dict></plist>
`,
    );
    const identity = await bundleIdentity(app);
    assert.equal(identity.sha256, fileSha256(binary));
    assert.ok(identity.path.endsWith(path.join("Opus.app")));
    assert.equal(identity.provenanceKind, "unsigned");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restoreStartupSession is best-effort for a missing bundle", async () => {
  const { restoreStartupSession } = await import("./measure-startup.mjs");
  assert.equal(restoreStartupSession("/definitely/not/here/Opus.app"), false);
});
