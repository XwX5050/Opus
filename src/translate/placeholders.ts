/**
 * Inline code/math placeholder protection for translatable chunks.
 *
 * Inline spans — backtick-delimited code (`` `code` ``, including
 * multi-backtick spans like ```` `` `x` `` ````) and single-dollar math
 * (`$x^2$`) — are swapped for opaque ⟪n⟫ tokens before a chunk goes to the
 * model, then restored from the translated reply. The model cannot
 * sensibly translate an opaque token, so code identifiers and math stay
 * byte-identical in the output instead of being mangled by translation.
 *
 * Guarantees:
 * - `protectInlineSpans` never nests: the scanner walks the text left to
 *   right in a single pass, so `` `$x$` `` becomes one code span rather than
 *   a code span containing a math placeholder.
 * - `replaceInlineSpans` inverts `protectInlineSpans` exactly on the
 *   protected text (byte-for-byte), so subdivision can work on the protected
 *   text and the chunks map back to the original paragraph.
 * - Generated tokens are numbered past any literal ⟪n⟫ token already in the
 *   source, so a placeholder can never collide with (and later replace) a
 *   user-written bracket token.
 *
 * Restoration is validated, not trusted: the model may drop, duplicate, or
 * renumber tokens, or invent new ones. On any mismatch `restoreInlineSpans`
 * returns null and the caller falls back to an un-protected translation,
 * because leaking a placeholder into the user's document is worse than
 * protecting nothing. One documented heuristic: source text that itself
 * contains ⟪ or ⟫ characters is treated as opaque token material during
 * translation and typically forces that chunk onto the un-protected
 * fallback path — a vanishingly rare case that always degrades safely.
 */

export interface InlineSpan {
  /** Stable numeric id; `placeholder` renders from it. */
  readonly index: number;
  /** Unique replacement token, e.g. "⟪1⟫". */
  readonly placeholder: string;
  /** The exact span text replaced, delimiters included — `` `code` ``, `$x$`. */
  readonly original: string;
}

export interface ProtectedText {
  /** Text with every inline span replaced by its placeholder. */
  readonly text: string;
  /** Spans in scan order; `spans[n]` matches the token it produced. */
  readonly spans: readonly InlineSpan[];
}

export const PLACEHOLDER_OPEN = "\u27ea"; // ⟪
export const PLACEHOLDER_CLOSE = "\u27eb"; // ⟫

const PLACEHOLDER_TOKEN_RE = /⟪(\d+)⟫/g;

const placeholderFor = (index: number): string =>
  `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;

/**
 * Index of the next backtick run whose length is exactly `length`, or -1.
 * CommonMark closes a code span only on a backtick string of equal length, so
 * a longer run is content: in `` `a```b` `` the three-backtick run never
 * closes the one-backtick opener, and the span ends at the final backtick.
 */
const findCodeSpanCloser = (
  text: string,
  from: number,
  length: number,
): number => {
  let cursor = from;
  while (cursor < text.length) {
    if (text[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let end = cursor + 1;
    while (text[end] === "`") end += 1;
    if (end - cursor === length) return cursor;
    cursor = end;
  }
  return -1;
};

/**
 * Index of the next lone `$` at or after `from`, or -1. Dollars inside a `$$`
 * run are display-math material, never an inline-math closer, so the scan
 * steps over the whole run: `$a$$b$` closes at the final dollar instead of
 * splitting into the two spans `$a$` and `$b$`.
 */
const findInlineMathCloser = (text: string, from: number): number => {
  let cursor = from;
  while (cursor < text.length) {
    if (text[cursor] !== "$") {
      cursor += 1;
      continue;
    }
    if (text[cursor + 1] === "$") {
      while (text[cursor] === "$") cursor += 1;
      continue;
    }
    return cursor;
  }
  return -1;
};

/**
 * Scans a translatable segment and swaps every well-formed inline code or
 * math span for an opaque ⟪n⟫ token. Unmatched backticks or dollars pass
 * through as literal text — protection only ever applies to complete pairs,
 * so stray punctuation is never swallowed.
 */
export function protectInlineSpans(text: string): ProtectedText {
  const spans: InlineSpan[] = [];
  // Number generated placeholders past any literal ⟪n⟫ tokens already in the
  // input, keeping the generated and pre-existing token spaces disjoint.
  let nextIndex = 1;
  for (const match of text.matchAll(PLACEHOLDER_TOKEN_RE)) {
    nextIndex = Math.max(nextIndex, Number(match[1]) + 1);
  }
  let result = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "`") {
      // A run of N backticks opens a code span closed by the next run of
      // exactly N backticks; code spans never contain a line break.
      let run = index;
      while (run + 1 < text.length && text[run + 1] === "`") run += 1;
      const openerLength = run - index + 1;
      const closer = findCodeSpanCloser(text, run + 1, openerLength);
      const content = closer === -1 ? "" : text.slice(run + 1, closer);
      if (closer !== -1 && !content.includes("\n")) {
        spans.push({
          index: nextIndex,
          placeholder: placeholderFor(nextIndex),
          original: text.slice(index, closer + openerLength),
        });
        nextIndex += 1;
        result += spans[spans.length - 1].placeholder;
        index = closer + openerLength;
        continue;
      }
      // No well-formed close: emit the run literally so stray backticks are
      // never turned into placeholders.
      result += "`".repeat(openerLength);
      index = run + 1;
      continue;
    }
    if (char === "$") {
      if (text[index + 1] === "$") {
        // A `$$` run is display-math material and stays literal. Emitting
        // both dollars together stops the pair's second dollar from being
        // read as an inline-math opener that would swallow the text between
        // it and a later unrelated dollar.
        result += "$$";
        index += 2;
        continue;
      }
      // A single dollar opens an inline-math pair closed by the next lone
      // dollar; a `$$` run in between is display-math material, never a
      // close.
      const closer = findInlineMathCloser(text, index + 1);
      const content = closer === -1 ? "" : text.slice(index + 1, closer);
      if (closer !== -1 && !content.includes("\n")) {
        spans.push({
          index: nextIndex,
          placeholder: placeholderFor(nextIndex),
          original: text.slice(index, closer + 1),
        });
        nextIndex += 1;
        result += spans[spans.length - 1].placeholder;
        index = closer + 1;
        continue;
      }
    }
    result += char;
    index += 1;
  }
  return { text: result, spans };
}

/**
 * Restores placeholders in a translated chunk, validating that every
 * placeholder the chunk contained survives exactly once and that the reply
 * introduces no new ⟪n⟫ tokens. Returns null on any mismatch so callers can
 * fall back to an un-protected translation instead of risking a placeholder
 * in the final document.
 */
export function restoreInlineSpans(
  protectedChunk: string,
  translated: string,
  spans: readonly InlineSpan[],
): string | null {
  const generated = new Set(spans.map((span) => span.index));
  if (generated.size === 0) return null;
  // The chunk's own generated tokens: these are what the model must keep.
  const expected = new Set<number>();
  for (const match of protectedChunk.matchAll(PLACEHOLDER_TOKEN_RE)) {
    const index = Number(match[1]);
    if (generated.has(index)) expected.add(index);
  }
  const seen = new Map<number, number>();
  for (const match of translated.matchAll(PLACEHOLDER_TOKEN_RE)) {
    const index = Number(match[1]);
    seen.set(index, (seen.get(index) ?? 0) + 1);
  }
  for (const [index, count] of seen) {
    if (generated.has(index)) {
      // A generated token must survive exactly once, no more, no less.
      if (count !== 1 || !expected.has(index)) return null;
    } else {
      // A token the reply invented (or a renumbered one) would leak into the
      // document; treat it like a dropped placeholder.
      return null;
    }
  }
  for (const index of expected) {
    if ((seen.get(index) ?? 0) !== 1) return null;
  }
  const replaced = replaceInlineSpans(translated, spans);
  // Catch malformed fragments such as ⟪x⟫ that the token regex never
  // matched; a lone bracket surviving into the document fails the restore.
  if (
    replaced.includes(PLACEHOLDER_OPEN) ||
    replaced.includes(PLACEHOLDER_CLOSE)
  ) {
    return null;
  }
  return replaced;
}

/**
 * Inverts protection for one chunk of protected text: replaces every
 * generated token with its original span. Because generated indices never
 * collide with pre-existing user tokens, this is an exact inverse of
 * `protectInlineSpans` on the protected text; unknown tokens are kept as-is.
 */
export function replaceInlineSpans(
  protectedText: string,
  spans: readonly InlineSpan[],
): string {
  return protectedText.replace(
    PLACEHOLDER_TOKEN_RE,
    (token, number: string) => {
      const span = spans.find(
        (candidate) => candidate.index === Number(number),
      );
      return span ? span.original : token;
    },
  );
}