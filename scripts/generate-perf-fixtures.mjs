#!/usr/bin/env node
/**
 * Generates deterministic, seeded UTF-8 Markdown fixtures for the perf
 * harness into tests/perf/generated/ (gitignored — never commit these):
 *
 *   regular-1mb.md    ~1 MiB, well under both light-mode thresholds
 *   light-2mb.md      just over 2 MiB, trips the byte threshold
 *   pressure-10mb.md  ~10 MiB and >= 100,000 lines, the pressure scenario
 *
 * Re-running always produces byte-identical files (fixed seed).
 */
import { mkdir, writeFile } from "node:fs/promises";

const OUT_DIR = new URL("../tests/perf/generated/", import.meta.url).pathname;
const MIB = 1024 * 1024;

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
const generate = ({ seed, minBytes, minLines = 1 }) => {
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

const fixtures = [
  { name: "regular-1mb.md", seed: 42, minBytes: MIB },
  { name: "light-2mb.md", seed: 1337, minBytes: 2 * MIB },
  { name: "pressure-10mb.md", seed: 2024, minBytes: 10 * MIB, minLines: 100_000 },
];

await mkdir(OUT_DIR, { recursive: true });
for (const fixture of fixtures) {
  const { text, bytes, lines } = generate(fixture);
  const path = `${OUT_DIR}${fixture.name}`;
  await writeFile(path, text, "utf8");
  console.log(
    `${fixture.name}: ${(bytes / MIB).toFixed(2)} MiB, ${lines.toLocaleString("en-US")} lines`,
  );
}
console.log(`fixtures written to ${OUT_DIR}`);
