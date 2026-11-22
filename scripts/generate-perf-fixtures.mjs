#!/usr/bin/env node
/**
 * Generates deterministic, seeded UTF-8 Markdown fixtures for the perf
 * harness into tests/perf/generated/ (gitignored — never commit these):
 *
 *   regular-1mb.md    ~1 MiB, well under both light-mode thresholds
 *   light-2mb.md      just over 2 MiB, trips the byte threshold
 *   pressure-10mb.md  ~10 MiB and >= 100,000 lines, the pressure scenario
 *
 * Re-running always produces byte-identical files (fixed seed). Every file
 * is written to a sibling temp file, fsynced, size-verified and renamed into
 * place, so a killed generator can never leave a truncated fixture that the
 * next measurement would silently load.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// fileURLToPath (not URL.pathname) so paths with spaces or escaped
// characters resolve to the real directory.
export const PERF_FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tests/perf/generated",
);
const MIB = 1024 * 1024;

export const PERF_FIXTURES = [
  { name: "regular-1mb.md", seed: 42, minBytes: MIB },
  { name: "light-2mb.md", seed: 1337, minBytes: 2 * MIB },
  { name: "pressure-10mb.md", seed: 2024, minBytes: 10 * MIB, minLines: 100_000 },
];

/** mulberry32: small, deterministic PRNG. */
const prng = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const WORDS_EN =
  "the quick brown fox jumps over a lazy dog while markdown renders headings lists links and code".split(
    " ",
  );
const WORDS_CJK = "轻量 编辑器 渲染 性能 文档 预览 阈值 内存 帧率 输入".split(" ");

const sentence = (rand, words) => {
  const count = 6 + Math.floor(rand() * 10);
  const picked = [];
  for (let i = 0; i < count; i += 1) {
    picked.push(words[Math.floor(rand() * words.length)]);
  }
  return picked.join(words === WORDS_CJK ? "" : " ");
};

/** Builds one pseudo-random Markdown block (a few lines). */
const block = (rand, index) => {
  const kind = index % 6;
  switch (kind) {
    case 0:
      return `## Section ${index} ${sentence(rand, WORDS_EN)}\n`;
    case 1:
      return `${sentence(rand, WORDS_EN)} with **bold** and *emphasis* and a [link](https://example.com/${index}).\n\n${sentence(rand, WORDS_CJK)}。\n`;
    case 2:
      return `- ${sentence(rand, WORDS_EN)}\n- ${sentence(rand, WORDS_EN)}\n- \`${sentence(rand, WORDS_EN)}\`\n`;
    case 3:
      return `\`\`\`js\nconst value${index} = ${Math.floor(rand() * 1000)};\nconsole.log(value${index});\n\`\`\`\n`;
    case 4:
      return `> ${sentence(rand, WORDS_EN)}\n> ${sentence(rand, WORDS_CJK)}\n`;
    default:
      return `${sentence(rand, WORDS_EN)}.\n\n${sentence(rand, WORDS_EN)} — ${sentence(rand, WORDS_CJK)}。\n`;
  }
};

/**
 * Grows seeded Markdown until it exceeds `minBytes` UTF-8 bytes and
 * `minLines` lines, then trims/pads the tail to land just past the target.
 */
export const generateFixtureText = ({ seed, minBytes, minLines = 1 }) => {
  const rand = prng(seed);
  const chunks = ["# Performance fixture\n\n"];
  let bytes = Buffer.byteLength(chunks[0], "utf8");
  let lines = 2;
  let index = 0;
  while (bytes <= minBytes || lines < minLines) {
    const next = block(rand, index);
    chunks.push(next);
    bytes += Buffer.byteLength(next, "utf8");
    lines += next.split("\n").length - 1;
    index += 1;
  }
  return { text: chunks.join(""), bytes, lines };
};

/**
 * Writes one file through a sibling temp file. The temp file is fsynced and
 * its byte count verified before the atomic rename, so readers see either
 * the previous complete file or the new complete file — never a truncation.
 */
export const writeFileAtomically = async (outputPath, text) => {
  const directory = path.dirname(outputPath);
  await mkdir(directory, { recursive: true });
  const expectedBytes = Buffer.byteLength(text, "utf8");
  const tempPath = path.join(
    directory,
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle = null;
  try {
    handle = await open(tempPath, "w");
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    const written = await stat(tempPath);
    if (written.size !== expectedBytes) {
      throw new Error(
        `short write for ${outputPath}: ${written.size}/${expectedBytes} bytes`,
      );
    }
    await rename(tempPath, outputPath);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The original error is more useful.
      }
    }
    await rm(tempPath, { force: true });
    throw error;
  }
};

export const generatePerfFixtures = async (outDir = PERF_FIXTURE_DIR) => {
  const summaries = [];
  for (const fixture of PERF_FIXTURES) {
    const { text, bytes, lines } = generateFixtureText(fixture);
    const outputPath = path.join(outDir, fixture.name);
    await writeFileAtomically(outputPath, text);
    summaries.push({ name: fixture.name, path: outputPath, bytes, lines });
  }
  return summaries;
};

/**
 * Resolves a basename-only fixture request without allowing a symlink (or
 * any other path trick) to escape the generated directory. Returns null for
 * invalid names, missing files and real paths outside `root`.
 */
export const resolveGeneratedFixturePath = async (root, name) => {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    !name.endsWith(".md")
  ) {
    return null;
  }
  try {
    const realRoot = await realpath(root);
    const realFile = await realpath(path.join(realRoot, name));
    const relative = path.relative(realRoot, realFile);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return null;
    }
    return (await stat(realFile)).isFile() ? realFile : null;
  } catch {
    return null;
  }
};

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const summaries = await generatePerfFixtures();
    for (const summary of summaries) {
      console.log(
        `${summary.name}: ${(summary.bytes / MIB).toFixed(2)} MiB, ${summary.lines.toLocaleString("en-US")} lines`,
      );
    }
    console.log(`fixtures written to ${PERF_FIXTURE_DIR}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
