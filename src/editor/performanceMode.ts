/**
 * Large-document degradation ("light mode").
 *
 * Documents above 2 MiB of UTF-8 text or 50,000 lines open in light mode:
 * Markdown parsing, selection, search and visible-range text styling stay
 * active, while offscreen image creation and nonessential block widgets
 * (math, images) are paused. The user can temporarily force full rendering
 * per tab; closing and reopening the tab returns to automatic mode. Light
 * mode never changes document text.
 */
export type PerformanceMode = "full" | "light";

export interface DocumentSize {
  /** UTF-8 encoded byte length of the document text. */
  readonly bytes: number;
  /** Line count, matching CodeMirror semantics (newline separators + 1). */
  readonly lines: number;
}

/** Documents at or below both limits render fully (design spec §9). */
export const FULL_MODE_MAX_BYTES = 2 * 1024 * 1024;
export const FULL_MODE_MAX_LINES = 50_000;

export const modeFor = (size: DocumentSize): PerformanceMode =>
  size.bytes > FULL_MODE_MAX_BYTES || size.lines > FULL_MODE_MAX_LINES
    ? "light"
    : "full";

/**
 * Resolves the mode a tab should render with: a per-tab "继续完整渲染"
 * override wins, otherwise the thresholds decide. The override is tab-scoped
 * UI state, so reopening the document always returns here with
 * `forceFull === false` — i.e. automatic mode.
 */
export const effectiveMode = (
  size: DocumentSize,
  forceFull: boolean,
): PerformanceMode => (forceFull ? "full" : modeFor(size));

const utf8Encoder = new TextEncoder();

/**
 * Measures the size inputs of {@link modeFor} from raw text. Byte length is
 * the true UTF-8 length (CJK text is 3 bytes per character), not
 * `string.length`.
 */
export const measureText = (text: string): DocumentSize => {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return { bytes: utf8Encoder.encode(text).length, lines };
};

/**
 * Picks the automatic mode directly from raw text, with a cheap early out:
 * UTF-8 bytes are never fewer than UTF-16 code units, so once `text.length`
 * alone exceeds the byte threshold the document is certainly light and the
 * full encode/line scan can be skipped. This runs on every render while a
 * large document is being edited, so the fast path matters.
 */
export const modeForText = (text: string): PerformanceMode =>
  text.length > FULL_MODE_MAX_BYTES ? "light" : modeFor(measureText(text));
