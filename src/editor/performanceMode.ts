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
 * `string.length`. Line breaks follow CodeMirror (`/\r\n?|\n/`): a CRLF
 * pair is one separator, a lone CR counts too.
 */
export const measureText = (text: string): DocumentSize => {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10) {
      lines += 1;
    } else if (code === 13) {
      lines += 1;
      if (text.charCodeAt(index + 1) === 10) index += 1; // CRLF = one break
    }
  }
  return { bytes: utf8Encoder.encode(text).length, lines };
};

/**
 * Classifies documents whose mode is decidable from UTF-16 length alone,
 * in O(1):
 *
 * - `length > FULL_MODE_MAX_BYTES` → light, because UTF-8 bytes are never
 *   fewer than UTF-16 code units;
 * - `length < FULL_MODE_MAX_LINES` → full, because lines ≤ length + 1 ≤
 *   50,000, and bytes ≤ 3·length < 150 KB ≪ 2 MiB.
 *
 * Everything between (50,000–2 MiB code units) is "in band" and returns
 * null: only the real encode/line scan can decide.
 */
export const cheapModeForLength = (length: number): PerformanceMode | null => {
  if (length > FULL_MODE_MAX_BYTES) return "light";
  if (length < FULL_MODE_MAX_LINES) return "full";
  return null;
};

/**
 * Picks the automatic mode directly from raw text. O(1) for out-of-band
 * lengths (see {@link cheapModeForLength}); in-band documents pay the full
 * O(n) encode/line scan, so callers that evaluate on every keystroke must
 * bound how often they call this — useAutomaticPerformanceMode debounces
 * exactly that case (tab switches still scan synchronously, once per open).
 */
export const modeForText = (text: string): PerformanceMode =>
  cheapModeForLength(text.length) ?? modeFor(measureText(text));
