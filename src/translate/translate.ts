/**
 * Document translation pipeline: segments the Markdown, batches the
 * translatable blocks within a character budget, calls the port once per
 * batch, and reassembles the translated result.
 */
import type { DocumentPort } from "../document/DocumentPort";
import { reassembleTranslation, splitMarkdownSegments } from "./segments";
import type { TranslationSettings } from "./types";

/** Approximate character budget per translateSegments call. */
const BATCH_CHAR_BUDGET = 3000;

/** Splits translatable segments into batches within the budget. */
const buildBatches = (
  translatable: readonly { readonly text: string }[],
): string[][] => {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const segment of translatable) {
    const chars = segment.text.length;
    if (current.length > 0 && currentChars + chars > BATCH_CHAR_BUDGET) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    // A single segment longer than the budget travels alone.
    current.push(segment.text);
    currentChars += chars;
  }
  if (current.length > 0) batches.push(current);
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
  signal?: AbortSignal,
): Promise<string> {
  const segments = splitMarkdownSegments(text);
  const translatable = segments.filter(
    (segment) => segment.kind === "translatable",
  );
  if (translatable.length === 0) return text;

  const translated: string[] = [];
  let translatableIndex = 0;
  for (const batch of buildBatches(translatable)) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const results = await port.translateSegments(settings, batch);
    for (const result of results) {
      translated.push(
        normalizeTranslatedBlock(translatable[translatableIndex].text, result),
      );
      translatableIndex += 1;
    }
  }
  return reassembleTranslation(segments, translated);
}
