/**
 * Markdown segmentation for the document translation feature.
 *
 * `splitMarkdownSegments` walks the document line by line with a small state
 * machine — deliberately no real parser — and emits two kinds of segments:
 * - "translatable": paragraph blocks (runs of non-blank lines).
 * - "protected": structure that must pass through untranslated — YAML
 *   frontmatter at the document start, fenced code blocks (``` and ~~~,
 *   including fences left open to EOF), whole-block display math ($$...$$,
 *   including unclosed), HTML comment blocks, and blank-line separators.
 *
 * The concatenation of every segment's text reproduces the input exactly, so
 * `reassembleTranslation` can swap translations back in losslessly.
 */

import { PLACEHOLDER_CLOSE, PLACEHOLDER_OPEN } from "./placeholders";

export interface Segment {
  readonly kind: "translatable" | "protected";
  readonly text: string;
}

type ScanState = "normal" | "frontmatter" | "fence" | "math" | "comment";

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
const COMMENT_OPEN_RE = /^[ \t]*<!--/;

/**
 * Independent `$$` delimiter line, mirroring the editor's math extension
 * (mathExtension.ts matches `^\$\$[\t ]*\r?$` on the line's content; blocks
 * that never close fall back to a plain paragraph there). Nothing but
 * optional whitespace may follow the `$$`, so prose such as `$$ 500 元/人`
 * is not a delimiter and stays translatable. The `\r?\n?` absorbs the
 * newline that `splitLines` keeps attached to the line.
 */
const MATH_DELIMITER_RE = /^[ \t]*\$\$[\t ]*\r?\n?$/;

const isBlankLine = (line: string): boolean => line.trim().length === 0;

/** Keeps each trailing newline attached so blocks are lossless line runs. */
const splitLines = (text: string): string[] => text.split(/(?<=\n)/);

// Mirrors the editor's frontmatter extension: an opening `---` line at the
// very start of the document, closed by a `---` or `...` line.
const isFrontmatterOpening = (line: string): boolean => line.trim() === "---";
const isFrontmatterClosing = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed === "---" || trimmed === "...";
};

export function splitMarkdownSegments(text: string): Segment[] {
  if (text.length === 0) return [];

  const segments: Segment[] = [];
  let pending: string[] = [];
  let pendingKind: Segment["kind"] = "translatable";
  let state: ScanState = "normal";
  let fenceChar = "";
  let fenceLength = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    segments.push({ kind: pendingKind, text: pending.join("") });
    pending = [];
    pendingKind = "translatable";
  };

  const startProtectedBlock = (line: string): void => {
    flush();
    pendingKind = "protected";
    pending = [line];
  };

  const lines = splitLines(text);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    switch (state) {
      case "frontmatter":
        pending.push(line);
        if (isFrontmatterClosing(line)) {
          flush();
          state = "normal";
        }
        break;
      case "fence": {
        pending.push(line);
        const closing = FENCE_RE.exec(line);
        if (
          closing &&
          closing[1][0] === fenceChar &&
          closing[1].length >= fenceLength
        ) {
          flush();
          state = "normal";
        }
        break;
      }
      case "math":
        pending.push(line);
        // Any independent `$$` delimiter line closes the block; the opening
        // line was already consumed, so an unmatched block runs to EOF.
        if (MATH_DELIMITER_RE.test(line)) {
          flush();
          state = "normal";
        }
        break;
      case "comment":
        pending.push(line);
        if (line.includes("-->")) {
          flush();
          state = "normal";
        }
        break;
      case "normal": {
        if (isBlankLine(line)) {
          // A blank line ends the current block, unless the block is itself
          // a blank run (which just grows).
          if (pending.length > 0) {
            const isBlankRun =
              pendingKind === "protected" && isBlankLine(pending[0]);
            if (!isBlankRun) flush();
          }
          if (pending.length === 0) pendingKind = "protected";
          pending.push(line);
          break;
        }
        if (index === 0 && isFrontmatterOpening(line)) {
          startProtectedBlock(line);
          state = "frontmatter";
          break;
        }
        const fence = FENCE_RE.exec(line);
        if (fence) {
          startProtectedBlock(line);
          fenceChar = fence[1][0];
          fenceLength = fence[1].length;
          state = "fence";
          break;
        }
        if (MATH_DELIMITER_RE.test(line)) {
          startProtectedBlock(line);
          state = "math";
          break;
        }
        if (COMMENT_OPEN_RE.test(line)) {
          startProtectedBlock(line);
          state = line.includes("-->") ? "normal" : "comment";
          break;
        }
        // Ordinary paragraph line; a pending blank run belongs to this block.
        if (pendingKind === "protected") flush();
        pending.push(line);
        break;
      }
    }
  }
  flush();
  return segments;
}

/**
 * Target size, in characters, for a single translatable chunk sent to the
 * provider. `subdivideSegment` treats it as a hard upper bound — no chunk
 * exceeds it and most land close to it.
 *
 * 600 balances two opposing costs. Per-chunk LLM latency grows roughly with
 * the chunk's character count: a 1500-character chunk can take tens of
 * seconds to generate a full translation (and oversized requests have also
 * been observed to disconnect with `response JSON is invalid: error decoding
 * response body` on OpenAI-compatible providers), while a ~600-character
 * chunk typically completes in a few seconds. Smaller chunks therefore
 * shorten the tail latency each request imposes on the bounded concurrency
 * pool and keep the pool fed with more chunks for documents that subdivide
 * into few segments in the first place. Going much smaller (below ~500
 * characters) would start paying more per-request overhead — prompt framing,
 * hop latency, provider-side batching — than it saves on generation time.
 * Exported so tests and callers reason about the same limit.
 */
export const MAX_TRANSLATABLE_CHUNK_LENGTH = 600;

/**
 * Sentence- and phrase-ending punctuation, Chinese and English. Chunks split
 * *after* these characters (keeping them attached) so translated fragments
 * still end at natural boundaries. The regex matches one sentence — a run of
 * non-punctuation characters plus any trailing punctuation — or a bare
 * non-punctuation run, exhausting the input with no empty matches, so the
 * concatenation of the matches is always byte-identical to the input line.
 */
const SENTENCE_BOUNDARY_RE =
  /[^。！？；：，!?;:,]*[。！？；：，!?;:,]+|[^。！？；：，!?;:,]+/g;

/**
 * Hard-cut position for an over-long run: `maxLength` unless that would slice
 * a placeholder token (⟪n⟫) in half, in which case the cut backs up to just
 * before the token so placeholders always reach the provider intact.
 */
const safeHardCut = (text: string, maxLength: number): number => {
  const naive = Math.min(maxLength, text.length);
  // Walk back from the cut to the nearest ⟪ or ⟫; an opening ⟪ before the cut
  // with no ⟫ in between means the cut falls inside a placeholder token.
  for (let index = naive - 1; index >= 0; index--) {
    const char = text[index];
    if (char === PLACEHOLDER_CLOSE) break;
    if (char === PLACEHOLDER_OPEN) return Math.max(index, 1);
  }
  return naive;
};

/**
 * Splits a single over-long line into chunks at sentence boundaries, falling
 * back to exact character cuts for any sentence that still exceeds the
 * limit. The line's trailing line break stays attached to the final chunk so
 * paragraph structure survives translation losslessly.
 */
const subdivideLongLine = (line: string, maxLength: number): string[] => {
  const trailing = /[\r\n]+$/.exec(line)?.[0] ?? "";
  const body = trailing.length > 0 ? line.slice(0, -trailing.length) : line;
  const sentences = body.match(SENTENCE_BOUNDARY_RE) ?? [body];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current.length + sentence.length <= maxLength) {
      current += sentence;
    } else {
      if (current.length > 0) chunks.push(current);
      current = sentence;
      while (current.length > maxLength) {
        const cut = safeHardCut(current, maxLength);
        chunks.push(current.slice(0, cut));
        current = current.slice(cut);
      }
    }
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length === 0) chunks.push(body);
  if (trailing.length > 0) chunks[chunks.length - 1] += trailing;
  return chunks;
};

/**
 * Splits one translatable segment's text into chunks no longer than
 * `maxLength`, preferring line boundaries so a paragraph's lines stay
 * together when they fit, then sentence boundaries for any single over-long
 * line, with exact character cuts as the last resort. Chunks concatenate
 * back to `text` byte-for-byte, keeping the segment contract that
 * `reassembleTranslation` relies on; only the final chunk of a chunked line
 * may exceed the limit by its trailing line break (one or two characters).
 */
export function subdivideSegment(
  text: string,
  maxLength: number = MAX_TRANSLATABLE_CHUNK_LENGTH,
): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  for (const line of splitLines(text)) {
    if (line.length > maxLength) {
      chunks.push(...subdivideLongLine(line, maxLength));
    } else {
      const last = chunks[chunks.length - 1];
      if (last !== undefined && last.length + line.length <= maxLength) {
        chunks[chunks.length - 1] = last + line;
      } else {
        chunks.push(line);
      }
    }
  }
  return chunks;
}

/**
 * Fills translated text back into the translatable segments, keeping the
 * protected segments as-is. `translated[i]` corresponds to the i-th
 * translatable segment; missing entries fall back to the original text.
 */
export function reassembleTranslation(
  segments: readonly Segment[],
  translated: readonly string[],
): string {
  let translatedIndex = 0;
  let result = "";
  for (const segment of segments) {
    if (segment.kind === "translatable") {
      result += translated[translatedIndex] ?? segment.text;
      translatedIndex += 1;
    } else {
      result += segment.text;
    }
  }
  return result;
}
