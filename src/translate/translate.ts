/**
 * Document translation pipeline: segments the Markdown, batches the
 * translatable blocks within a character budget, translates batches through a
 * bounded pool of concurrent port calls, and reassembles the translated
 * result. Every completed batch is surfaced through `onPartial` so callers
 * can render the translation as it builds instead of waiting for the whole
 * document.
 */
import type { DocumentPort } from "../document/DocumentPort";
import { reassembleTranslation, splitMarkdownSegments } from "./segments";
import type { TranslationSettings } from "./types";

/** Approximate character budget per translateSegments call. */
const BATCH_CHAR_BUDGET = 1500;

/** Maximum concurrent translateSegments calls for one document. */
const DEFAULT_CONCURRENCY = 4;

/**
 * A completed portion of the translation: `text` is the document with the
 * finished batches translated and everything still in flight left as the
 * original text, so it is always the best current approximation of the final
 * result.
 */
export interface TranslationPartial {
  readonly text: string;
  /** Batches whose translations are already included in `text`. */
  readonly completedBatches: number;
  /** Total batches this document was split into. */
  readonly totalBatches: number;
}

export interface TranslateDocumentOptions {
  readonly signal?: AbortSignal;
  /** Called after each batch completes with the partial translation. */
  readonly onPartial?: (partial: TranslationPartial) => void;
  /** Maximum concurrent translateSegments calls; defaults to 4. */
  readonly concurrency?: number;
}

interface Batch {
  /** Index of the first translatable segment in this batch. */
  readonly startIndex: number;
  readonly texts: string[];
}

/** Splits translatable segments into batches within the budget. */
const buildBatches = (
  translatable: readonly { readonly text: string }[],
): Batch[] => {
  const batches: Batch[] = [];
  let current: string[] = [];
  let currentChars = 0;
  let startIndex = 0;
  for (let index = 0; index < translatable.length; index++) {
    const segment = translatable[index];
    const chars = segment.text.length;
    if (current.length > 0 && currentChars + chars > BATCH_CHAR_BUDGET) {
      batches.push({ startIndex, texts: current });
      current = [];
      currentChars = 0;
      startIndex = index;
    }
    // A single segment longer than the budget travels alone.
    current.push(segment.text);
    currentChars += chars;
  }
  if (current.length > 0) batches.push({ startIndex, texts: current });
  return batches;
};

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
): string =>
  translated.replace(/^[\r\n]+/, "").replace(/[\r\n]+$/, "") +
  trailingLineBreak(original);

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

  const batches = buildBatches(translatable);
  // Positional slots, one per translatable segment: filled as batches land,
  // holes stay undefined so reassembly falls back to the original text.
  const translated: (string | undefined)[] = new Array(translatable.length);
  const totalBatches = batches.length;
  let completedBatches = 0;
  let nextBatchIndex = 0;
  // Once a worker fails (abort or port error), the run rejects: remaining
  // workers stop and stop reporting partials.
  let failed = false;
  const abortError = (): DOMException =>
    new DOMException("Aborted", "AbortError");

  const emitPartial = (): void => {
    if (!onPartial) return;
    onPartial({
      // Holes (still-in-flight segments) read as undefined at runtime and
      // fall back to the original text inside reassembleTranslation.
      text: reassembleTranslation(segments, translated as readonly string[]),
      completedBatches,
      totalBatches,
    });
  };

  const work = async (): Promise<void> => {
    try {
      while (true) {
        if (failed) return;
        if (signal?.aborted) throw abortError();
        const batchIndex = nextBatchIndex;
        nextBatchIndex += 1;
        if (batchIndex >= batches.length) return;
        const batch = batches[batchIndex];
        const results = await port.translateSegments(settings, batch.texts);
        if (failed) return;
        if (signal?.aborted) throw abortError();
        for (let offset = 0; offset < results.length; offset++) {
          const segmentIndex = batch.startIndex + offset;
          translated[segmentIndex] = normalizeTranslatedBlock(
            translatable[segmentIndex].text,
            results[offset],
          );
        }
        completedBatches += 1;
        emitPartial();
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
  return reassembleTranslation(segments, translated as readonly string[]);
}