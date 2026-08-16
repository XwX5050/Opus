/**
 * Document translation pipeline: segments the Markdown, subdivides over-long
 * paragraphs into provider-friendly chunks, translates every chunk through a
 * bounded pool of concurrent port calls — one request per chunk, each
 * carrying a single-element array so the backend issues exactly one provider
 * request per chunk — and reassembles the translated result. Failed requests
 * are retried with a short backoff. Every completed segment is surfaced
 * through `onPartial` so callers can render the translation as it builds
 * instead of waiting for the whole document.
 */
import type { DocumentPort } from "../document/DocumentPort";
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
 * finished segments translated and everything still in flight left as the
 * original text, so it is always the best current approximation of the final
 * result.
 */
export interface TranslationPartial {
  readonly text: string;
  /** Segments whose translations are already included in `text`. */
  readonly completedBatches: number;
  /** Total translatable segments this document was split into. */
  readonly totalBatches: number;
}

export interface TranslateDocumentOptions {
  readonly signal?: AbortSignal;
  /** Called after each segment completes with the partial translation. */
  readonly onPartial?: (partial: TranslationPartial) => void;
  /** Maximum concurrent translateSegments calls; defaults to 10. */
  readonly concurrency?: number;
}

/** One translation unit: a chunk of a translatable segment. */
interface TranslationUnit {
  /** Index of the translatable segment the chunk belongs to. */
  readonly segmentIndex: number;
  /**
   * Chunk text; a segment's chunks stay contiguous in the unit list and
   * concatenate back to the segment's full text byte-for-byte.
   */
  readonly text: string;
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

  // Subdivide over-long paragraphs so no single request exceeds the provider
  // limit; each chunk becomes its own translation unit. A segment's chunks
  // are contiguous in `units`, so their translations join back in order.
  const chunksBySegment = translatable.map((segment) =>
    subdivideSegment(segment.text),
  );
  const units: TranslationUnit[] = [];
  const unitStartBySegment: number[] = [];
  for (let index = 0; index < translatable.length; index++) {
    unitStartBySegment.push(units.length);
    for (const chunk of chunksBySegment[index]) {
      units.push({ segmentIndex: index, text: chunk });
    }
  }

  // Positional slots, one per translatable segment: filled as segments land,
  // holes stay undefined so reassembly falls back to the original text.
  const translated: (string | undefined)[] = new Array(translatable.length);
  // Per-unit results; holes mean that chunk is still in flight.
  const unitResults: (string | undefined)[] = new Array(units.length);
  const doneUnitsBySegment = new Array<number>(translatable.length).fill(0);
  const totalSegments = translatable.length;
  let completedSegments = 0;
  let nextUnitIndex = 0;
  // Once a worker fails (abort or port error), the run rejects: remaining
  // workers stop and stop reporting partials.
  let failed = false;

  const emitPartial = (): void => {
    if (!onPartial) return;
    onPartial({
      // Holes (still-in-flight segments) read as undefined at runtime and
      // fall back to the original text inside reassembleTranslation.
      text: reassembleTranslation(segments, translated as readonly string[]),
      completedBatches: completedSegments,
      totalBatches: totalSegments,
    });
  };

  const joinSegmentTranslation = (segmentIndex: number): string => {
    const start = unitStartBySegment[segmentIndex];
    const count = chunksBySegment[segmentIndex].length;
    let result = "";
    for (let offset = 0; offset < count; offset++) {
      result += unitResults[start + offset] ?? units[start + offset].text;
    }
    return result;
  };

  /** Marks a chunk done; a segment lands (and reports) once all its chunks do. */
  const completeUnit = (unitIndex: number): void => {
    const segmentIndex = units[unitIndex].segmentIndex;
    doneUnitsBySegment[segmentIndex] += 1;
    if (doneUnitsBySegment[segmentIndex] < chunksBySegment[segmentIndex].length) {
      return;
    }
    translated[segmentIndex] = joinSegmentTranslation(segmentIndex);
    completedSegments += 1;
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

  const work = async (): Promise<void> => {
    try {
      while (true) {
        if (failed) return;
        if (signal?.aborted) throw abortError();
        const unitIndex = nextUnitIndex;
        nextUnitIndex += 1;
        if (unitIndex >= units.length) return;
        const unit = units[unitIndex];
        const result = await translateChunk(unit.text);
        if (failed) return;
        if (signal?.aborted) throw abortError();
        unitResults[unitIndex] =
          result === undefined
            ? unit.text
            : normalizeTranslatedBlock(unit.text, result);
        completeUnit(unitIndex);
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
  return reassembleTranslation(segments, translated as readonly string[]);
}