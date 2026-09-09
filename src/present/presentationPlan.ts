/**
 * Slide planning for presentation mode.
 *
 * Markdown documents paginate two ways:
 * - `splitManualSlides` honors explicit `---` slide separators. It returns
 *   `null` when the document contains no valid separator so callers can fall
 *   back to auto-pagination.
 * - `splitNaturalBlocks` splits the document into natural blocks — paragraph
 *   runs and whole protected blocks — which `packBlocksByHeight` then packs
 *   greedily into slides that fit a screen.
 *
 * The line scanning mirrors `src/translate/segments.ts`: a deliberately
 * lexical state machine that tracks YAML frontmatter, fenced code blocks,
 * whole-block display math, and HTML comments without parsing Markdown.
 * Fences open with three or more backticks or tildes — optionally under
 * CommonMark blockquote markers — and close with the same character at
 * equal or greater length, followed only by spaces/tabs; math blocks open
 * and close on independent `$$` delimiter lines; anything left unclosed
 * runs to EOF.
 */

type ProtectedState = "fence" | "math" | "comment";

/**
 * An opening Markdown code fence: optional indentation, an optional run of
 * CommonMark blockquote markers (`>` each followed by optional whitespace —
 * nested `> > ` quoted fences included), then three or more backticks or
 * tildes; the rest of the line is the info string, as in CommonMark. Only
 * the line's classification is consumed — the original line stays part of
 * the slide/block text, so quoting never loses bytes.
 */
const FENCE_RE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})/;

/**
 * Blockquote marker depth of a fence line — how many `>` markers precede the
 * fence run (`> ```` is depth 1, `> > ```` depth 2, a plain fence depth 0).
 * CommonMark strips one marker per open quote level, so a quoted fence only
 * closes on a run at its own depth.
 */
const fenceMarkerDepth = (line: string): number => {
  const prefix = /^[ \t]*(?:>[ \t]*)*/.exec(line)?.[0] ?? "";
  return (prefix.match(/>/g) ?? []).length;
};

/**
 * Closing line of a fence that was opened without a blockquote prefix: the
 * fence run must follow only indentation — a `>`-prefixed line is code
 * inside a top-level fence, never its close — and be followed only by
 * spaces/tabs plus the line's own trailing line break. Closing fences carry
 * no info string, so `~~~not-a-closing-fence` never closes a fence.
 * Character and length matching against the opening run are the caller's
 * job.
 */
const FENCE_CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?\n?$/;

/**
 * Closing-line candidate of a fence that was opened inside a blockquote: at
 * least one `>` marker, then the same trailing rules as `FENCE_CLOSE_RE`.
 * The caller additionally requires the candidate's marker depth to equal the
 * opening fence's — a run at shallower or deeper nesting is code content,
 * not the close.
 */
const FENCE_QUOTED_CLOSE_RE =
  /^[ \t]*(?:>[ \t]*)+(`{3,}|~{3,})[ \t]*\r?\n?$/;

const COMMENT_OPEN_RE = /^[ \t]*<!--/;

/**
 * Independent `$$` delimiter line, mirroring the editor's math extension
 * (mathExtension.ts matches `^\$\$[\t ]*\r?$` on the line's content). Nothing
 * but optional whitespace may follow the `$$`, so prose such as `$$ 500 元/人`
 * is not a delimiter. The `\r?\n?` absorbs the newline that `splitLines`
 * keeps attached to the line.
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

/**
 * Index of the frontmatter closing line, or -1 when the document has no
 * frontmatter. Frontmatter is only recognized when a closing line exists; an
 * unclosed opening `---` is ordinary content handled by the caller (and may
 * itself be a slide separator).
 */
const findFrontmatterEnd = (lines: readonly string[]): number => {
  if (lines.length === 0 || !isFrontmatterOpening(lines[0])) return -1;
  for (let index = 1; index < lines.length; index++) {
    if (isFrontmatterClosing(lines[index])) return index;
  }
  return -1;
};

/**
 * A slide-separator line: its trimmed content, with internal spaces and tabs
 * removed, is three or more dashes (`---`, `----`, `- - -`). `***` and `___`
 * are not separators.
 */
const isSeparatorCandidate = (line: string): boolean =>
  /^-{3,}$/.test(line.trim().replace(/[ \t]/g, ""));

/**
 * Kind of the previous line in the document, deciding whether a `---` line is
 * a slide separator or a CommonMark setext H2 underline (`Title\n---`).
 */
type PrevLineKind =
  | "start" // beginning of the document
  | "blank" // blank line
  | "content" // ordinary paragraph line
  | "block-end" // closing line of a protected block
  | "separator"; // another slide separator

/**
 * Splits the document into slides at explicit `---` separators, or returns
 * `null` when no valid separator exists.
 *
 * A separator is a `---`-style line (see `isSeparatorCandidate`) seen in
 * normal scanner state — never inside a fenced code block, display-math
 * block, HTML comment block, or YAML frontmatter — that is not directly
 * preceded by a content line. Separators are consumed as delimiters rather
 * than emitted, so a separator run after a blank line or another separator
 * still splits; the empty slides that fall between adjacent separators are
 * dropped. Slides are trimmed; the frontmatter text, when present, becomes
 * the leading content of the first slide.
 */
export function splitManualSlides(markdown: string): string[] | null {
  if (markdown.length === 0) return null;
  const lines = splitLines(markdown);
  const frontmatterEnd = findFrontmatterEnd(lines);

  const slides: string[] = [];
  let pending: string[] = [];
  let state: "normal" | ProtectedState = "normal";
  let fenceChar = "";
  let fenceLength = 0;
  // Marker depth of the open fence's line (0 for a plain fence); a quoted
  // fence only closes on a line carrying the same depth.
  let fenceDepth = 0;
  let prevLine: PrevLineKind = "start";
  let separatorCount = 0;

  const flushSlide = (): void => {
    const slide = pending.join("").trim();
    if (slide.length > 0) slides.push(slide);
    pending = [];
  };

  let index = 0;
  if (frontmatterEnd >= 0) {
    pending.push(...lines.slice(0, frontmatterEnd + 1));
    index = frontmatterEnd + 1;
    prevLine = "block-end";
  }

  for (; index < lines.length; index++) {
    const line = lines[index];
    switch (state) {
      case "fence": {
        pending.push(line);
        const closing = (fenceDepth > 0 ? FENCE_QUOTED_CLOSE_RE : FENCE_CLOSE_RE).exec(
          line,
        );
        if (
          closing &&
          fenceMarkerDepth(line) === fenceDepth &&
          closing[1][0] === fenceChar &&
          closing[1].length >= fenceLength
        ) {
          state = "normal";
          prevLine = "block-end";
        }
        break;
      }
      case "math":
        pending.push(line);
        // Any independent `$$` delimiter line closes the block; the opening
        // line was already consumed, so an unmatched block runs to EOF.
        if (MATH_DELIMITER_RE.test(line)) {
          state = "normal";
          prevLine = "block-end";
        }
        break;
      case "comment":
        pending.push(line);
        if (line.includes("-->")) {
          state = "normal";
          prevLine = "block-end";
        }
        break;
      case "normal": {
        if (isBlankLine(line)) {
          pending.push(line);
          prevLine = "blank";
          break;
        }
        if (isSeparatorCandidate(line)) {
          // Directly after a content line the dashes are a setext H2
          // underline and stay content; after a blank line, the document
          // start, a protected-block end, or another separator they split.
          if (prevLine === "content") {
            pending.push(line);
            prevLine = "content";
          } else {
            flushSlide();
            separatorCount += 1;
            prevLine = "separator";
          }
          break;
        }
        const fence = FENCE_RE.exec(line);
        if (fence) {
          pending.push(line);
          fenceChar = fence[1][0];
          fenceLength = fence[1].length;
          fenceDepth = fenceMarkerDepth(line);
          state = "fence";
          break;
        }
        if (MATH_DELIMITER_RE.test(line)) {
          pending.push(line);
          state = "math";
          break;
        }
        if (COMMENT_OPEN_RE.test(line)) {
          pending.push(line);
          if (!line.includes("-->")) {
            state = "comment";
          } else {
            // A single-line comment is a complete protected block; a `---`
            // right after it splits.
            prevLine = "block-end";
          }
          break;
        }
        pending.push(line);
        prevLine = "content";
        break;
      }
    }
  }
  flushSlide();
  return separatorCount > 0 ? slides : null;
}

/**
 * Splits the document into natural blocks: maximal runs of non-blank lines,
 * with protected blocks — YAML frontmatter at the document start, fenced code
 * blocks, whole-block display math, and HTML comments — kept whole even when
 * they contain blank lines. Unclosed fences, math blocks, and comments run to
 * EOF. Blocks are trimmed; blank runs and empty blocks are dropped.
 */
export function splitNaturalBlocks(markdown: string): string[] {
  if (markdown.length === 0) return [];
  const lines = splitLines(markdown);
  const frontmatterEnd = findFrontmatterEnd(lines);

  const blocks: string[] = [];
  let pending: string[] = [];
  // True while pending holds a closed protected block that must not merge
  // with the following paragraph run (mirrors segments.ts pendingKind).
  let pendingProtected = false;
  let state: "normal" | ProtectedState = "normal";
  let fenceChar = "";
  let fenceLength = 0;
  // Marker depth of the open fence's line (0 for a plain fence); a quoted
  // fence only closes on a line carrying the same depth.
  let fenceDepth = 0;

  const flush = (): void => {
    const block = pending.join("").trim();
    if (block.length > 0) blocks.push(block);
    pending = [];
    pendingProtected = false;
  };

  let index = 0;
  if (frontmatterEnd >= 0) {
    pending.push(...lines.slice(0, frontmatterEnd + 1));
    flush();
    index = frontmatterEnd + 1;
  }

  for (; index < lines.length; index++) {
    const line = lines[index];
    switch (state) {
      case "fence": {
        pending.push(line);
        const closing = (fenceDepth > 0 ? FENCE_QUOTED_CLOSE_RE : FENCE_CLOSE_RE).exec(
          line,
        );
        if (
          closing &&
          fenceMarkerDepth(line) === fenceDepth &&
          closing[1][0] === fenceChar &&
          closing[1].length >= fenceLength
        ) {
          state = "normal";
          pendingProtected = true;
        }
        break;
      }
      case "math":
        pending.push(line);
        if (MATH_DELIMITER_RE.test(line)) {
          state = "normal";
          pendingProtected = true;
        }
        break;
      case "comment":
        pending.push(line);
        if (line.includes("-->")) {
          state = "normal";
          pendingProtected = true;
        }
        break;
      case "normal": {
        if (isBlankLine(line)) {
          flush();
          break;
        }
        const fence = FENCE_RE.exec(line);
        if (fence) {
          flush();
          pending.push(line);
          fenceChar = fence[1][0];
          fenceLength = fence[1].length;
          fenceDepth = fenceMarkerDepth(line);
          state = "fence";
          break;
        }
        if (MATH_DELIMITER_RE.test(line)) {
          flush();
          pending.push(line);
          state = "math";
          break;
        }
        if (COMMENT_OPEN_RE.test(line)) {
          flush();
          pending.push(line);
          pendingProtected = true;
          if (!line.includes("-->")) state = "comment";
          break;
        }
        if (pendingProtected) flush();
        pending.push(line);
        break;
      }
    }
  }
  flush();
  return blocks;
}

/** An ATX heading: one to six `#` followed by a space. */
const isAtxHeading = (item: unknown): boolean =>
  typeof item === "string" && /^#{1,6} /.test(item);

/**
 * Packs items into groups (slides) by greedy height accumulation: items join
 * the current group while the cumulative height stays within `maxHeight`, and
 * an item whose own height exceeds `maxHeight` forms a singleton group. Zero
 * and negative heights count as 0. Groups are never empty and preserve order.
 *
 * After packing, a single non-cascading pass prevents orphaned headings: when
 * a non-final group holds more than one item and its last item's text starts
 * with an ATX heading (`#{1,6}` + space), that heading moves to the start of
 * the next group — a heading must not be the last block of a slide it could
 * lead. The recipient is not repacked: the pass runs once, in order.
 */
export function packBlocksByHeight<T>(
  items: readonly T[],
  heightOf: (item: T) => number,
  maxHeight: number,
): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let used = 0;

  for (const item of items) {
    const height = Math.max(0, heightOf(item));
    if (current.length > 0 && used + height > maxHeight) {
      groups.push(current);
      current = [];
      used = 0;
    }
    if (height > maxHeight) {
      groups.push([item]);
    } else {
      current.push(item);
      used += height;
    }
  }
  if (current.length > 0) groups.push(current);

  for (let groupIndex = 0; groupIndex < groups.length - 1; groupIndex++) {
    const group = groups[groupIndex];
    if (group.length > 1 && isAtxHeading(group[group.length - 1])) {
      const [heading] = group.splice(group.length - 1, 1);
      groups[groupIndex + 1].unshift(heading);
    }
  }
  return groups;
}