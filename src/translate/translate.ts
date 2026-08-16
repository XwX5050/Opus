/**
 * Document translation pipeline: segments the Markdown, translates every
 * translatable block through a bounded pool of concurrent port calls — one
 * request per segment, each carrying a single-element array so the backend
 * issues exactly one provider request per segment — and reassembles the
 * translated result. Every completed segment is surfaced through `onPartial`
 * so callers can render the translation as it builds instead of waiting for
 * the whole document.
 */
import type { DocumentPort } from "../document/DocumentPort";
import { reassembleTranslation, splitMarkdownSegments } from "./segments";
import type { TranslationSettings } from "./types";

/** Maximum concurrent translateSegments calls for one document. */
const DEFAULT_CONCURRENCY = 10;

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

  // Positional slots, one per translatable segment: filled as segments land,
  // holes stay undefined so reassembly falls back to the original text.
  const translated: (string | undefined)[] = new Array(translatable.length);
  const totalSegments = translatable.length;
  let completedSegments = 0;
  let nextSegmentIndex = 0;
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
      completedBatches: completedSegments,
      totalBatches: totalSegments,
    });
  };

  const work = async (): Promise<void> => {
    try {
      while (true) {
        if (failed) return;
        if (signal?.aborted) throw abortError();
        const segmentIndex = nextSegmentIndex;
        nextSegmentIndex += 1;
        if (segmentIndex >= translatable.length) return;
        const segment = translatable[segmentIndex];
        const results = await port.translateSegments(settings, [segment.text]);
        if (failed) return;
        if (signal?.aborted) throw abortError();
        const result = results[0];
        translated[segmentIndex] =
          result === undefined
            ? segment.text
            : normalizeTranslatedBlock(segment.text, result);
        completedSegments += 1;
        emitPartial();
      }
    } catch (caught) {
      failed = true;
      throw caught;
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, translatable.length) },
    work,
  );
  const settled = await Promise.allSettled(workers);
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
  return reassembleTranslation(segments, translated as readonly string[]);
}