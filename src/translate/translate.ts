/**
 * Document translation pipeline: segments the Markdown, protects inline
 * code/math spans with placeholders, subdivides over-long paragraphs into
 * provider-friendly chunks, drops chunks already written in the target
 * language, and packs the remainder into static contiguous batches — at most
 * TRANSLATION_BATCH_MAX_UNITS units or TRANSLATION_BATCH_MAX_CHARS characters
 * each — so one provider request covers several chunks. Batches run through a
 * bounded pool of port calls ordered by the caller's visible range when a
 * `TranslationPriority` is supplied: every pick re-reads the visible character
 * range of the currently displayed (partially translated) text and takes the
 * pending batch nearest the units it overlaps, so the visible screen
 * translates first, nearby chunks prefetch, and the rest drains in the
 * background. Failed requests are retried with a short backoff and aborts
 * never retry. Every completed unit is surfaced through `onPartial` so callers
 * can render the translation as it builds instead of waiting for the whole
 * document.
 */
import type { DocumentPort } from "../document/DocumentPort";
import { isLikelyTargetLanguage } from "./languageGuess";
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
 * Upper bounds for one batched provider request. Units are packed greedily in
 * document order; a batch never exceeds either cap, and a single over-limit
 * unit forms a batch of its own.
 */
export const TRANSLATION_BATCH_MAX_UNITS = 8;
export const TRANSLATION_BATCH_MAX_CHARS = 4000;

/**
 * Backoff delay before each retry attempt, in ms — short, escalating pauses
 * that absorb transient network hiccups without stalling the pool for long.
 */
const REQUEST_RETRY_BACKOFFS_MS = [300, 900] as const;

/** How many times a failed batch request is retried, one per backoff entry. */
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
 * finished units translated and everything still in flight left as the
 * original text, so it is always the best current approximation of the final
 * result.
 */
export interface TranslationPartial {
  readonly text: string;
  /** Units whose results are already included in `text`. */
  readonly completedBatches: number;
  /** Total units this document was subdivided into. */
  readonly totalBatches: number;
}

/** A half-open character range [from, to) of the displayed text. */
export interface TranslationTextRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Viewport priority for batch scheduling, expressed in character offsets of
 * the CURRENTLY DISPLAYED text — the latest partial translation as rendered;
 * before the first partial, the original document. The scheduler calls it
 * fresh every time it picks the next batch and ranks pending batches by
 * distance to the units the range overlaps, so scroll changes take effect
 * immediately. null = no preference → document order.
 */
export interface TranslationPriority {
  visibleRange(): TranslationTextRange | null;
}

export interface TranslateDocumentOptions {
  readonly signal?: AbortSignal;
  /** Called after each chunk completes with the partial translation. */
  readonly onPartial?: (partial: TranslationPartial) => void;
  /** Maximum concurrent translateSegments calls; defaults to 10. */
  readonly concurrency?: number;
  /**
   * Viewport-aware batch ordering; batches overlapping the visible range go
   * first.
   */
  readonly priority?: TranslationPriority;
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

/**
 * A static run of contiguous translation units sent to the provider as one
 * request. Workers mark a batch in-flight when they pick it so no two workers
 * ever send the same units.
 */
interface TranslationBatch {
  readonly units: TranslationUnit[];
  /** Index of the batch's first unit in the full unit list. */
  readonly firstUnitIndex: number;
  status: "pending" | "in-flight" | "done";
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
  if (signal?.aborted) throw abortError();

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

  // Per-unit results; holes mean that unit is still in flight.
  const unitResults: (string | undefined)[] = new Array(units.length);
  const totalBatches = units.length;
  let completedBatches = 0;
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

  /** Marks a unit done and surfaces the new partial immediately. */
  const completeUnit = (): void => {
    completedBatches += 1;
    emitPartial();
  };

  /** Packs the untranslated units into static contiguous batches. */
  const batches: TranslationBatch[] = [];
  let openBatch: TranslationBatch | null = null;
  let openBatchChars = 0;
  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    if (isLikelyTargetLanguage(unit.originalText, settings.targetLanguage)) {
      // Already in the target language: complete immediately with the
      // original text and never send it to the provider.
      unitResults[index] = unit.originalText;
      completeUnit();
      continue;
    }
    const unitChars = unit.text.length;
    if (
      openBatch === null ||
      openBatch.units.length >= TRANSLATION_BATCH_MAX_UNITS ||
      openBatchChars + unitChars > TRANSLATION_BATCH_MAX_CHARS
    ) {
      openBatch = { units: [], firstUnitIndex: index, status: "pending" };
      batches.push(openBatch);
      openBatchChars = 0;
    }
    openBatch.units.push(unit);
    openBatchChars += unitChars;
  }

  /**
   * Each unit's current [start, end) character offset in the displayed text —
   * the latest partial translation as rendered (`reassembleTranslation` of
   * the finished units, language-skipped units, and protected segments in
   * their original text). Rebuilt on every scheduler pick because each
   * completed translation changes the text length and shifts every later
   * unit.
   */
  const computeUnitOffsets = (): {
    starts: number[];
    ends: number[];
    total: number;
  } => {
    const starts: number[] = new Array(units.length);
    const ends: number[] = new Array(units.length);
    let cursor = 0;
    let segmentIndex = 0;
    for (const segment of segments) {
      if (segment.kind === "protected") {
        cursor += segment.text.length;
        continue;
      }
      const firstUnit = unitStartBySegment[segmentIndex];
      const count = chunksBySegment[segmentIndex].length;
      for (let offset = 0; offset < count; offset++) {
        const unitIndex = firstUnit + offset;
        starts[unitIndex] = cursor;
        cursor += (unitResults[unitIndex] ?? units[unitIndex].originalText)
          .length;
        ends[unitIndex] = cursor;
      }
      segmentIndex += 1;
    }
    return { starts, ends, total: cursor };
  };

  /**
   * The unit-index interval overlapping the caller's visible range, evaluated
   * fresh on every pick. Non-finite, negative, or inverted ranges behave like
   * null — no preference; the range is clamped to the displayed length. A
   * valid range that overlaps no unit (zero width, or covering only protected
   * text such as a code fence) snaps to the nearest unit in displayed order,
   * so a viewport full of code still prioritizes the prose right after it.
   */
  const visibleUnitInterval = (): { lo: number; hi: number } | null => {
    if (options.priority === undefined) return null;
    const range = options.priority.visibleRange();
    if (range === null) return null;
    let { from, to } = range;
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from < 0 ||
      to < 0 ||
      from > to
    ) {
      return null;
    }
    const { starts, ends, total } = computeUnitOffsets();
    from = Math.min(from, total);
    to = Math.min(to, total);
    let lo = -1;
    let hi = -1;
    for (let index = 0; index < units.length; index++) {
      if (starts[index] < to && ends[index] > from) {
        if (lo === -1) lo = index;
        hi = index;
      }
    }
    if (lo !== -1) return { lo, hi };
    // No unit overlaps: snap to the first unit at or after `from`, else to
    // the document's last unit when `from` sits past every unit (e.g. inside
    // trailing protected text).
    for (let index = 0; index < units.length; index++) {
      if (starts[index] >= from) return { lo: index, hi: index };
    }
    return { lo: units.length - 1, hi: units.length - 1 };
  };

  /**
   * The pending batch nearest the visible units. The range is re-evaluated on
   * every pick so scroll changes re-order work immediately; distance is the
   * unit-index gap between the batch and the visible interval (0 when they
   * intersect), ties go to the lower first-unit-index so content above the
   * viewport completes first, and a null range means plain document order.
   */
  const pickBatch = (): TranslationBatch | undefined => {
    const visible = visibleUnitInterval();
    let best: TranslationBatch | undefined;
    let bestDistance = Infinity;
    for (const batch of batches) {
      if (batch.status !== "pending") continue;
      const lastUnitIndex = batch.firstUnitIndex + batch.units.length - 1;
      const distance =
        visible === null
          ? batch.firstUnitIndex
          : lastUnitIndex < visible.lo
            ? visible.lo - lastUnitIndex
            : batch.firstUnitIndex > visible.hi
              ? batch.firstUnitIndex - visible.hi
              : 0;
      if (
        best === undefined ||
        distance < bestDistance ||
        (distance === bestDistance && batch.firstUnitIndex < best.firstUnitIndex)
      ) {
        best = batch;
        bestDistance = distance;
      }
    }
    return best;
  };

  /**
   * Sends one request, retrying transient failures with a short backoff.
   * Aborts — an external signal or an AbortError from the port — never retry.
   */
  const translateWithRetry = async (
    texts: string[],
  ): Promise<readonly (string | undefined)[]> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= REQUEST_RETRY_COUNT; attempt++) {
      try {
        return await port.translateSegments(settings, texts);
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

  /** One-unit request, used for the un-protected fallback retry. */
  const translateSingle = async (text: string): Promise<string | undefined> => {
    const results = await translateWithRetry([text]);
    return results[0];
  };

  /**
   * Applies a batch's results to its units. Units holding protected inline
   * spans restore them from the reply; if the model mangled or dropped a
   * placeholder, that unit alone is re-translated without protection so a
   * placeholder can never leak into the document. Empty replies fall back to
   * the original chunk text. Each completed unit emits its own partial.
   */
  const applyBatchResults = async (
    batch: TranslationBatch,
    results: readonly (string | undefined)[],
  ): Promise<void> => {
    for (let offset = 0; offset < batch.units.length; offset++) {
      if (failed) return;
      const unit = batch.units[offset];
      const unitIndex = batch.firstUnitIndex + offset;
      const translated = results[offset];
      let result: string;
      if (unit.spans.length === 0) {
        result =
          translated === undefined
            ? unit.originalText
            : normalizeTranslatedBlock(unit.text, translated);
      } else if (translated === undefined) {
        result = unit.originalText;
      } else {
        const restored = restoreInlineSpans(unit.text, translated, unit.spans);
        if (restored !== null) {
          result = normalizeTranslatedBlock(unit.text, restored);
        } else {
          // The provider rewrote or dropped placeholders: retry the plain
          // chunk. Its span text goes to the model as ordinary characters —
          // the same un-protected path a no-span chunk takes.
          const plain = await translateSingle(unit.originalText);
          result =
            plain === undefined
              ? unit.originalText
              : normalizeTranslatedBlock(unit.originalText, plain);
        }
      }
      unitResults[unitIndex] = result;
      completeUnit();
    }
  };

  const work = async (): Promise<void> => {
    try {
      while (true) {
        if (failed) return;
        if (signal?.aborted) throw abortError();
        const batch = pickBatch();
        if (batch === undefined) return;
        batch.status = "in-flight";
        const results = await translateWithRetry(batch.units.map((unit) => unit.text));
        if (failed) return;
        if (signal?.aborted) throw abortError();
        await applyBatchResults(batch, results);
        batch.status = "done";
      }
    } catch (caught) {
      failed = true;
      throw caught;
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, batches.length) },
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