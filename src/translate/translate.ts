/**
 * Document translation pipeline: segments the Markdown, protects inline
 * code/math spans with placeholders, subdivides over-long paragraphs into
 * provider-friendly chunks, drops chunks already written in the target
 * language, and packs the remainder into static batches — at most
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
import type { DocumentPort, TranslateSegmentsOptions } from "../document/DocumentPort";
import { hasTranslatableLetters, isLikelyTargetLanguage } from "./languageGuess";
import {
  PLACEHOLDER_OPEN,
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

/** Longer escalating cooldowns for HTTP 429 rate-limit responses. */
const RATE_LIMIT_BACKOFFS_MS = [1500, 3000, 6000, 10000] as const;

/** How many times a failed batch request is retried, one per backoff entry. */
const REQUEST_RETRY_COUNT = REQUEST_RETRY_BACKOFFS_MS.length;

let runSequence = 0;

const abortError = (): DOMException =>
  new DOMException("Aborted", "AbortError");

const isAbortError = (caught: unknown): boolean =>
  caught instanceof DOMException
    ? caught.name === "AbortError"
    : caught instanceof Error && caught.name === "AbortError";

const errorText = (caught: unknown): string =>
  caught instanceof Error ? caught.message : String(caught);

const isNonRetryableError = (caught: unknown): boolean => {
  if (isAbortError(caught)) return true;
  const lower = errorText(caught).toLowerCase();
  if (
    lower.startsWith("cancelled:") ||
    lower.includes("missing-key:") ||
    lower.includes("invalid-slot:") ||
    lower.includes("invalid-key:") ||
    lower.includes("not allowed") ||
    lower.includes("invalid url")
  ) {
    return true;
  }
  return /\bhttp\s+(400|401|403|404|422)\b/.test(lower);
};

const isRateLimitError = (caught: unknown): boolean => {
  const lower = errorText(caught).toLowerCase();
  return (
    /\bhttp\s+429\b/.test(lower) ||
    lower.includes("too many requests") ||
    lower.includes("rate limit")
  );
};

const isSplittableBatchError = (caught: unknown): boolean => {
  const lower = errorText(caught).toLowerCase();
  return (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("truncated") ||
    lower.includes("repetition loop") ||
    lower.includes("exceeded maximum output limit") ||
    lower.includes("error decoding response body")
  );
};

const delay = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(abortError());
  }
  void promise.catch(() => {});
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort !== null) signal.removeEventListener("abort", onAbort);
  });
};

const spansForChunk = (
  chunk: string,
  spans: readonly InlineSpan[],
): readonly InlineSpan[] => {
  if (spans.length === 0 || !chunk.includes(PLACEHOLDER_OPEN)) return [];
  const present = new Set<number>();
  for (const match of chunk.matchAll(/⟪(\d+)⟫/g)) {
    present.add(Number(match[1]));
  }
  return present.size === 0
    ? []
    : spans.filter((span) => present.has(span.index));
};

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
 * A static run of translation units sent to the provider as one request.
 * Workers mark a batch in-flight when they pick it so no two workers ever
 * send the same units.
 */
interface TranslationBatch {
  readonly units: TranslationUnit[];
  /**
   * Each unit's index in the full unit list, aligned with `units`. Batch
   * construction skips units already written in the target language, so the
   * indices are not necessarily consecutive — results must map back by
   * identity, never by `first + offset`.
   */
  readonly unitIndices: number[];
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
  port: Pick<DocumentPort, "translateSegments" | "cancelTranslation">,
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

  const supportsCancel = typeof port.cancelTranslation === "function";
  const runId = supportsCancel
    ? `translate-${++runSequence}-${Date.now()}`
    : undefined;
  const runController = new AbortController();
  let backendCancelled = false;
  const abortRun = (): void => {
    if (!runController.signal.aborted) {
      runController.abort();
    }
    if (supportsCancel && runId !== undefined && !backendCancelled) {
      backendCancelled = true;
      void port.cancelTranslation!(runId).catch(() => {});
    }
  };
  const onExternalAbort = (): void => abortRun();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
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
    const unitSegmentIndex: number[] = [];
    for (let index = 0; index < translatable.length; index++) {
      unitStartBySegment.push(units.length);
      const spans = protectedSegments[index].spans;
      for (const chunk of chunksBySegment[index]) {
        const chunkSpans = spansForChunk(chunk, spans);
        units.push({
          text: chunk,
          originalText: replaceInlineSpans(chunk, chunkSpans),
          spans: chunkSpans,
        });
        unitSegmentIndex.push(index);
      }
    }

    // Per-unit results; holes mean that unit is still in flight.
    const unitResults: (string | undefined)[] = new Array(units.length);
    // Incremental segment texts so each unit completion only re-joins its own segment.
    const segmentTexts: string[] = translatable.map((segment) => segment.text);
    const totalBatches = units.length;
    let completedBatches = 0;
    // Once a worker fails (abort or port error), the run aborts siblings and rejects.
    let failed = false;
    let firstError: unknown;

    const joinSegmentText = (segmentIndex: number): string => {
      const start = unitStartBySegment[segmentIndex];
      const count = chunksBySegment[segmentIndex].length;
      let result = "";
      for (let offset = 0; offset < count; offset++) {
        result +=
          unitResults[start + offset] ?? units[start + offset].originalText;
      }
      return result;
    };

    const setUnitResult = (unitIndex: number, value: string): void => {
      unitResults[unitIndex] = value;
      const segIdx = unitSegmentIndex[unitIndex];
      segmentTexts[segIdx] = joinSegmentText(segIdx);
    };

    const emitPartial = (): void => {
      if (!onPartial) return;
      onPartial({
        text: reassembleTranslation(segments, segmentTexts),
        completedBatches,
        totalBatches,
      });
    };

    /** Marks a unit done and surfaces the new partial immediately. */
    const completeUnit = (): void => {
      completedBatches += 1;
      emitPartial();
    };

    /** Packs the untranslated units into static batches in document order. */
    const batches: TranslationBatch[] = [];
    let openBatch: TranslationBatch | null = null;
    let openBatchChars = 0;
    for (let index = 0; index < units.length; index++) {
      const unit = units[index];
      if (
        !hasTranslatableLetters(unit.text) ||
        isLikelyTargetLanguage(unit.originalText, settings.targetLanguage)
      ) {
        // Already in the target language or contains no translatable letters
        // (e.g. horizontal rules, pure numbers, standalone code spans): keep
        // verbatim and never send to the provider.
        setUnitResult(index, unit.originalText);
        completeUnit();
        continue;
      }
      const unitChars = unit.text.length;
      if (
        openBatch === null ||
        openBatch.units.length >= TRANSLATION_BATCH_MAX_UNITS ||
        openBatchChars + unitChars > TRANSLATION_BATCH_MAX_CHARS
      ) {
        openBatch = { units: [], unitIndices: [], status: "pending" };
        batches.push(openBatch);
        openBatchChars = 0;
      }
      openBatch.units.push(unit);
      openBatch.unitIndices.push(index);
      openBatchChars += unitChars;
    }

    /**
     * Each unit's current [start, end) character offset in the displayed text.
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
      for (let index = 0; index < units.length; index++) {
        if (starts[index] >= from) return { lo: index, hi: index };
      }
      return { lo: units.length - 1, hi: units.length - 1 };
    };

    const pickBatch = (): TranslationBatch | undefined => {
      const visible = visibleUnitInterval();
      let best: TranslationBatch | undefined;
      let bestDistance = Infinity;
      for (const batch of batches) {
        if (batch.status !== "pending") continue;
        const firstUnitIndex = batch.unitIndices[0];
        const lastUnitIndex = batch.unitIndices[batch.unitIndices.length - 1];
        const distance =
          visible === null
            ? firstUnitIndex
            : lastUnitIndex < visible.lo
              ? visible.lo - lastUnitIndex
              : firstUnitIndex > visible.hi
                ? firstUnitIndex - visible.hi
                : 0;
        if (
          best === undefined ||
          distance < bestDistance ||
          (distance === bestDistance && firstUnitIndex < best.unitIndices[0])
        ) {
          best = batch;
          bestDistance = distance;
        }
      }
      return best;
    };

    // Adaptive rate-limit governor (AIMD): shared across workers so a 429
    // halves effective concurrency and pauses all workers cleanly rather than
    // hammering the provider.
    let effectiveConcurrency = concurrency;
    let consecutiveSuccesses = 0;
    let cooldownUntil = 0;
    let activeRequests = 0;
    const slotWaiters: (() => void)[] = [];

    const wakeWaiters = (): void => {
      while (slotWaiters.length > 0 && activeRequests < effectiveConcurrency) {
        const next = slotWaiters.shift();
        next?.();
      }
    };

    const acquireRequestSlot = async (): Promise<void> => {
      while (true) {
        if (runController.signal.aborted) throw abortError();
        const now = Date.now();
        if (now < cooldownUntil) {
          await delay(cooldownUntil - now, runController.signal);
          continue;
        }
        if (activeRequests < effectiveConcurrency) {
          activeRequests += 1;
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            const idx = slotWaiters.indexOf(wake);
            if (idx !== -1) slotWaiters.splice(idx, 1);
            reject(abortError());
          };
          const wake = () => {
            runController.signal.removeEventListener("abort", onAbort);
            resolve();
          };
          slotWaiters.push(wake);
          runController.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    };

    const releaseRequestSlot = (): void => {
      activeRequests = Math.max(0, activeRequests - 1);
      wakeWaiters();
    };

    const callPort = (texts: string[]): Promise<string[]> => {
      if (supportsCancel) {
        const opts: TranslateSegmentsOptions = {
          signal: runController.signal,
          runId,
        };
        return port.translateSegments(settings, texts, opts);
      }
      return port.translateSegments(settings, texts);
    };

    /**
     * Sends one request, retrying transient failures and HTTP 429s with
     * adaptive concurrency control. Aborts and 4xx auth/config errors fail
     * immediately without retrying.
     */
    const translateWithRetry = async (
      texts: string[],
    ): Promise<readonly (string | undefined)[]> => {
      let transientAttempt = 0;
      let rateLimitAttempt = 0;
      while (true) {
        if (runController.signal.aborted) throw abortError();
        let acquired = false;
        try {
          if (
            Date.now() >= cooldownUntil &&
            activeRequests < effectiveConcurrency
          ) {
            activeRequests += 1;
          } else {
            await acquireRequestSlot();
          }
          acquired = true;
          const result = await callPort(texts);
          consecutiveSuccesses += 1;
          if (consecutiveSuccesses >= 4 && effectiveConcurrency < concurrency) {
            effectiveConcurrency += 1;
            consecutiveSuccesses = 0;
          }
          return result;
        } catch (caught) {
          if (signal?.aborted || runController.signal.aborted) {
            throw abortError();
          }
          if (isAbortError(caught) || isNonRetryableError(caught)) {
            throw caught;
          }
          if (texts.length > 1 && isSplittableBatchError(caught)) {
            throw caught;
          }
          if (isRateLimitError(caught)) {
            effectiveConcurrency = Math.max(
              1,
              Math.floor(effectiveConcurrency / 2),
            );
            consecutiveSuccesses = 0;
            if (rateLimitAttempt < RATE_LIMIT_BACKOFFS_MS.length) {
              const waitMs = RATE_LIMIT_BACKOFFS_MS[rateLimitAttempt];
              cooldownUntil = Math.max(cooldownUntil, Date.now() + waitMs);
              rateLimitAttempt += 1;
              releaseRequestSlot();
              acquired = false;
              await delay(waitMs, runController.signal);
              continue;
            }
            throw caught;
          }
          if (transientAttempt < REQUEST_RETRY_COUNT) {
            const waitMs = REQUEST_RETRY_BACKOFFS_MS[transientAttempt];
            transientAttempt += 1;
            releaseRequestSlot();
            acquired = false;
            await delay(waitMs, runController.signal);
            continue;
          }
          throw caught;
        } finally {
          if (acquired) {
            releaseRequestSlot();
          }
        }
      }
    };

    /**
     * Sends a batch with automatic bisection on splittable failures (timeout,
     * truncation, repetition loop, or decode error) so one oversized batch
     * splits cleanly instead of failing the document.
     */
    const translateBatchWithBisect = async (
      texts: string[],
    ): Promise<readonly (string | undefined)[]> => {
      try {
        return await translateWithRetry(texts);
      } catch (caught) {
        if (
          texts.length > 1 &&
          !runController.signal.aborted &&
          isSplittableBatchError(caught)
        ) {
          const mid = Math.ceil(texts.length / 2);
          const [left, right] = await Promise.all([
            translateBatchWithBisect(texts.slice(0, mid)),
            translateBatchWithBisect(texts.slice(mid)),
          ]);
          return [...left, ...right];
        }
        throw caught;
      }
    };

    /** One-unit request, used for the un-protected fallback retry. */
    const translateSingle = async (text: string): Promise<string | undefined> => {
      const results = await translateWithRetry([text]);
      return results[0];
    };

    const applyBatchResults = async (
      batch: TranslationBatch,
      results: readonly (string | undefined)[],
    ): Promise<void> => {
      const fallbackUnits: { unit: TranslationUnit; unitIndex: number }[] = [];
      for (let offset = 0; offset < batch.units.length; offset++) {
        if (failed || runController.signal.aborted) return;
        const unit = batch.units[offset];
        const unitIndex = batch.unitIndices[offset];
        const translated = results[offset];
        if (unit.spans.length === 0) {
          const result =
            translated === undefined
              ? unit.originalText
              : normalizeTranslatedBlock(unit.text, translated);
          setUnitResult(unitIndex, result);
          completeUnit();
        } else if (translated === undefined) {
          setUnitResult(unitIndex, unit.originalText);
          completeUnit();
        } else {
          const restored = restoreInlineSpans(unit.text, translated, unit.spans);
          if (restored !== null) {
            setUnitResult(
              unitIndex,
              normalizeTranslatedBlock(unit.text, restored),
            );
            completeUnit();
          } else {
            fallbackUnits.push({ unit, unitIndex });
          }
        }
      }
      if (fallbackUnits.length > 0) {
        await Promise.all(
          fallbackUnits.map(async ({ unit, unitIndex }) => {
            if (failed || runController.signal.aborted) return;
            const plain = await translateSingle(unit.originalText);
            if (failed || runController.signal.aborted) return;
            const result =
              plain === undefined
                ? unit.originalText
                : normalizeTranslatedBlock(unit.originalText, plain);
            setUnitResult(unitIndex, result);
            completeUnit();
          }),
        );
      }
    };

    const work = async (): Promise<void> => {
      try {
        while (true) {
          if (failed) return;
          if (signal?.aborted || runController.signal.aborted) throw abortError();
          const batch = pickBatch();
          if (batch === undefined) return;
          batch.status = "in-flight";
          const results = await translateBatchWithBisect(
            batch.units.map((unit) => unit.text),
          );
          if (failed) return;
          if (signal?.aborted || runController.signal.aborted) throw abortError();
          await applyBatchResults(batch, results);
          batch.status = "done";
        }
      } catch (caught) {
        if (!failed) {
          failed = true;
          firstError = signal?.aborted ? abortError() : caught;
          abortRun();
        }
        throw caught;
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, batches.length) },
      work,
    );
    await raceAbort(Promise.allSettled(workers), runController.signal).catch(
      (caught) => {
        if (!failed) {
          failed = true;
          firstError = caught;
        }
      },
    );
    if (failed) throw firstError;
    if (signal?.aborted) throw abortError();
    return reassembleTranslation(segments, segmentTexts);
  } finally {
    signal?.removeEventListener("abort", onExternalAbort);
  }
}