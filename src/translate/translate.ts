/**
 * Document translation pipeline: segments the Markdown, protects inline
 * code/math spans with placeholders, subdivides over-long paragraphs into
 * provider-friendly chunks, translates every chunk through a bounded pool of
 * concurrent port calls — one request per chunk, each carrying a
 * single-element array so the backend issues exactly one provider request per
 * chunk — and reassembles the translated result. Failed requests are retried
 * with a short backoff. Every completed chunk is surfaced through `onPartial`
 * so callers can render the translation as it builds instead of waiting for
 * the whole document.
 */
import type { DocumentPort } from "../document/DocumentPort";
import {
  protectInlineSpans,
  replaceInlineSpans,
  restoreInlineSpans,
  type InlineSpan,
} from "./placeholders";
import {
  reassembleTranslation,
  splitMarkdownSegments,
  subdivideSegment,
} from "./segments";
import type { TranslationSettings } from "./types";

/** Maximum concurrent translateSegments calls for one document. */
const DEFAULT_CONCURRENCY = 10;

/**
 * Backoff delay before each retry attempt, in ms — short, escalating pauses
 * that absorb transient network hiccups without stalling the pool for long.
 */
const REQUEST_RETRY_BACKOFFS_MS = [300, 900] as const;

/** How many times a failed chunk request is retried, one per backoff entry. */
const REQUEST_RETRY_COUNT = REQUEST_RETRY_BACKOFFS_MS.length;

const abortError = (): DOMException =>
  new DOMException("Aborted", "AbortError");

const isAbortError = (caught: unknown): boolean =>
  caught instanceof DOMException
    ? caught.name === "AbortError"
    : caught instanceof Error && caught.name === "AbortError";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A completed portion of the translation: `text` is the document with the
 * finished chunks translated and everything still in flight left as the
 * original text, so it is always the best current approximation of the final
 * result.
 */
export interface TranslationPartial {
  readonly text: string;
  /** Chunks whose translations are already included in `text`. */
  readonly completedBatches: number;
  /** Total chunks this document was subdivided into. */
  readonly totalBatches: number;
}

export interface TranslateDocumentOptions {
  readonly signal?: AbortSignal;
  /** Called after each chunk completes with the partial translation. */
  readonly onPartial?: (partial: TranslationPartial) => void;
  /** Maximum concurrent translateSegments calls; defaults to 10. */
  readonly concurrency?: number;
}

/** One translation unit: a chunk of a translatable segment. */
interface TranslationUnit {
  /**
   * Chunk text as sent to the provider; inline code/math spans inside it are
   * replaced with ⟪n⟫ placeholders. A segment's chunks stay contiguous in the
   * unit list and concatenate back to the segment's protected text exactly.
   */
  readonly text: string;
  /**
   * Unprotected chunk text; the fallback used while the chunk is in flight
   * and when the provider yields nothing. Concatenates back to the original
   * segment text byte-for-byte.
   */
  readonly originalText: string;
  /** The segment's inline spans, restored from the provider's reply. */
  readonly spans: readonly InlineSpan[];
}

const trailingLineBreak = (text: string): string => {
  const match = /[\r\n]+$/.exec(text);
  return match ? match[0] : "";
};

/**
 * Models often drop or add line breaks around their output. Normalize the
 * translated block so it keeps exactly the original block's trailing line
 * break; otherwise paragraph separation collapses when a translation omits
 * the trailing newline.
 */
const normalizeTranslatedBlock = (
  original: string,
  translated: string,
): string => {
  const body = translated.replace(/^[\r\n]+/, "").replace(/[\r\n]+$/, "");
  // An empty (or line-break-only / whitespace-only) model response would
  // silently drop the paragraph; fall back to the original block instead.
  if (body.trim().length === 0) return original;
  return body + trailingLineBreak(original);
};

export async function translateDocument(
  port: Pick<DocumentPort, "translateSegments">,
  settings: TranslationSettings,
  text: string,
  options: TranslateDocumentOptions = {},
): Promise<string> {
  const { signal, onPartial } = options;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const segments = splitMarkdownSegments(text);
  const translatable = segments.filter(
    (segment) => segment.kind === "translatable",
  );
  if (translatable.length === 0) return text;

  // Protect inline code/math spans with placeholders *before* subdividing so
  // a chunk boundary can never land inside a span. Each chunk then becomes
  // its own translation unit; a segment's chunks are contiguous in `units`,
  // so their translations join back in order.
  const protectedSegments = translatable.map((segment) =>
    protectInlineSpans(segment.text),
  );
  const chunksBySegment = protectedSegments.map((protectedSegment) =>
    subdivideSegment(protectedSegment.text),
  );
  const units: TranslationUnit[] = [];
  const unitStartBySegment: number[] = [];
  for (let index = 0; index < translatable.length; index++) {
    unitStartBySegment.push(units.length);
    const spans = protectedSegments[index].spans;
    for (const chunk of chunksBySegment[index]) {
      units.push({
        text: chunk,
        originalText: replaceInlineSpans(chunk, spans),
        spans,
      });
    }
  }

  // Per-unit results; holes mean that chunk is still in flight.
  const unitResults: (string | undefined)[] = new Array(units.length);
  const totalBatches = units.length;
  let completedBatches = 0;
  let nextUnitIndex = 0;
  // Once a worker fails (abort or port error), the run rejects: remaining
  // workers stop and stop reporting partials.
  let failed = false;

  const emitPartial = (): void => {
    if (!onPartial) return;
    const partialTexts = translatable.map((_, index) => joinSegmentText(index));
    onPartial({
      text: reassembleTranslation(segments, partialTexts),
      completedBatches,
      totalBatches,
    });
  };

  const joinSegmentText = (segmentIndex: number): string => {
    const start = unitStartBySegment[segmentIndex];
    const count = chunksBySegment[segmentIndex].length;
    let result = "";
    for (let offset = 0; offset < count; offset++) {
      // Holes (still-in-flight chunks) read as undefined at runtime and fall
      // back to the original chunk text, mirroring reassembleTranslation's
      // missing-slot fallback at a finer granularity.
      result += unitResults[start + offset] ?? units[start + offset].originalText;
    }
    return result;
  };

  /** Marks a chunk done and surfaces the new partial immediately. */
  const completeUnit = (): void => {
    completedBatches += 1;
    emitPartial();
  };

  /**
   * Translates one chunk, retrying transient failures with a short backoff.
   * Aborts — an external signal or an AbortError from the port — never retry.
   */
  const translateChunk = async (chunk: string): Promise<string | undefined> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= REQUEST_RETRY_COUNT; attempt++) {
      try {
        const results = await port.translateSegments(settings, [chunk]);
        return results[0];
      } catch (caught) {
        if (signal?.aborted) throw abortError();
        if (isAbortError(caught)) throw caught;
        lastError = caught;
        if (attempt < REQUEST_RETRY_COUNT) {
          await delay(REQUEST_RETRY_BACKOFFS_MS[attempt]);
          if (signal?.aborted) throw abortError();
        }
      }
    }
    throw lastError;
  };

  /**
   * Translates one unit. Chunks holding protected inline spans restore them
   * from the reply; if the model mangled or dropped a placeholder, the chunk
   * is re-translated without protection so a placeholder can never leak into
   * the document. Empty replies fall back to the original chunk text.
   */
  const translateUnit = async (unit: TranslationUnit): Promise<string> => {
    if (unit.spans.length === 0) {
      const translated = await translateChunk(unit.text);
      return translated === undefined
        ? unit.originalText
        : normalizeTranslatedBlock(unit.text, translated);
    }
    const translated = await translateChunk(unit.text);
    if (translated === undefined) return unit.originalText;
    const restored = restoreInlineSpans(unit.text, translated, unit.spans);
    if (restored !== null) return normalizeTranslatedBlock(unit.text, restored);
    // The provider rewrote or dropped placeholders: retry the plain chunk.
    // Its span text goes to the model as ordinary characters — the same
    // un-protected path a no-span chunk takes.
    const plain = await translateChunk(unit.originalText);
    return plain === undefined
      ? unit.originalText
      : normalizeTranslatedBlock(unit.originalText, plain);
  };

  const work = async (): Promise<void> => {
    try {
      while (true) {
        if (failed) return;
        if (signal?.aborted) throw abortError();
        const unitIndex = nextUnitIndex;
        nextUnitIndex += 1;
        if (unitIndex >= units.length) return;
        const unit = units[unitIndex];
        const result = await translateUnit(unit);
        if (failed) return;
        if (signal?.aborted) throw abortError();
        unitResults[unitIndex] = result;
        completeUnit();
      }
    } catch (caught) {
      failed = true;
      throw caught;
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, units.length) },
    work,
  );
  const settled = await Promise.allSettled(workers);
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
  return reassembleTranslation(
    segments,
    translatable.map((_, index) => joinSegmentText(index)),
  );
}