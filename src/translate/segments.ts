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

export interface Segment {
  readonly kind: "translatable" | "protected";
  readonly text: string;
}

type ScanState = "normal" | "frontmatter" | "fence" | "math" | "comment";

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
const MATH_OPEN_RE = /^[ \t]*\$\$/;

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

/** A one-line `$$...$$` block carries no content to protect separately. */
const isSelfContainedMathLine = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.length > 2 && trimmed.startsWith("$$") && trimmed.endsWith("$$");
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
        // Any `$$`-prefixed line closes the block; the opening line was
        // already consumed, so an unmatched block runs to EOF.
        if (MATH_OPEN_RE.test(line)) {
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
        if (MATH_OPEN_RE.test(line)) {
          startProtectedBlock(line);
          state = isSelfContainedMathLine(line) ? "normal" : "math";
          break;
        }
        if (line.includes("<!--")) {
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
