/**
 * Theme and editor preferences: pure validation, resolution and CSS mapping.
 *
 * Two different repair strategies live here on purpose:
 * - `normalize*` is for data read back from the persisted session: an invalid
 *   stored value falls back to the default for that field, because a corrupt
 *   store should behave like a fresh install.
 * - `clamp*` is for live UI edits: a value typed past a limit is clamped to
 *   the nearest valid value, because silently resetting what the user just
 *   typed is hostile.
 */
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "dark";

export const FONT_PRESETS = ["system", "serif", "monospace"] as const;
export type FontPreset = (typeof FONT_PRESETS)[number];

/**
 * `fontFamily` is either one of {@link FONT_PRESETS} or a user-entered name of
 * an installed font; both are stored as the same plain string.
 */
export interface EditorPreferences {
  readonly bodySizePx: number;
  readonly lineHeight: number;
  readonly contentWidthPx: number;
  readonly fontFamily: string;
}

export const EDITOR_PREFERENCE_LIMITS = {
  bodySizePx: { min: 13, max: 24 },
  lineHeight: { min: 1.3, max: 2.2 },
  contentWidthPx: { min: 560, max: 1100 },
} as const;

const MAX_FONT_NAME_LENGTH = 100;

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  bodySizePx: 16,
  lineHeight: 1.6,
  contentWidthPx: 760,
  fontFamily: "system",
};

export const normalizeThemePreference = (value: unknown): ThemePreference =>
  value === "system" || value === "light" || value === "dark"
    ? value
    : DEFAULT_THEME_PREFERENCE;

export const resolveTheme = (
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme =>
  preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;

const within = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;

const normalizeFontFamily = (value: unknown): string => {
  if (typeof value !== "string") return DEFAULT_EDITOR_PREFERENCES.fontFamily;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_FONT_NAME_LENGTH
    ? trimmed
    : DEFAULT_EDITOR_PREFERENCES.fontFamily;
};

/** Repair data read from the persisted session; invalid fields get defaults. */
export const normalizeEditorPreferences = (
  value: unknown,
): EditorPreferences => {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_EDITOR_PREFERENCES };
  }
  const record = value as Record<string, unknown>;
  return {
    bodySizePx: within(
      record.bodySizePx,
      EDITOR_PREFERENCE_LIMITS.bodySizePx.min,
      EDITOR_PREFERENCE_LIMITS.bodySizePx.max,
    )
      ? Math.round(record.bodySizePx)
      : DEFAULT_EDITOR_PREFERENCES.bodySizePx,
    lineHeight: within(
      record.lineHeight,
      EDITOR_PREFERENCE_LIMITS.lineHeight.min,
      EDITOR_PREFERENCE_LIMITS.lineHeight.max,
    )
      ? record.lineHeight
      : DEFAULT_EDITOR_PREFERENCES.lineHeight,
    contentWidthPx: within(
      record.contentWidthPx,
      EDITOR_PREFERENCE_LIMITS.contentWidthPx.min,
      EDITOR_PREFERENCE_LIMITS.contentWidthPx.max,
    )
      ? Math.round(record.contentWidthPx)
      : DEFAULT_EDITOR_PREFERENCES.contentWidthPx,
    fontFamily: normalizeFontFamily(record.fontFamily),
  };
};

const clampNumber = (value: number, fallback: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** Repair live UI edits; out-of-range values clamp to the nearest limit. */
export const clampEditorPreferences = (
  preferences: EditorPreferences,
): EditorPreferences => ({
  bodySizePx: Math.round(
    clampNumber(
      preferences.bodySizePx,
      DEFAULT_EDITOR_PREFERENCES.bodySizePx,
      EDITOR_PREFERENCE_LIMITS.bodySizePx.min,
      EDITOR_PREFERENCE_LIMITS.bodySizePx.max,
    ),
  ),
  lineHeight: clampNumber(
    preferences.lineHeight,
    DEFAULT_EDITOR_PREFERENCES.lineHeight,
    EDITOR_PREFERENCE_LIMITS.lineHeight.min,
    EDITOR_PREFERENCE_LIMITS.lineHeight.max,
  ),
  contentWidthPx: Math.round(
    clampNumber(
      preferences.contentWidthPx,
      DEFAULT_EDITOR_PREFERENCES.contentWidthPx,
      EDITOR_PREFERENCE_LIMITS.contentWidthPx.min,
      EDITOR_PREFERENCE_LIMITS.contentWidthPx.max,
    ),
  ),
  fontFamily: normalizeFontFamily(preferences.fontFamily),
});

/** Map a font choice (preset or installed-font name) to a CSS font stack. */
export const fontFamilyStack = (choice: string): string => {
  switch (choice) {
    case "serif":
      return `"Source Han Serif SC", "Songti SC", Georgia, "Times New Roman", serif`;
    case "monospace":
      return `"SF Mono", ui-monospace, Menlo, Consolas, monospace`;
    case "system":
      return `-apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif`;
    default: {
      // A user-entered installed font name; quotes inside could break out of
      // the CSS string, so strip them — and control characters, which would
      // quietly invalidate the whole `font` declaration — before quoting.
      const safe = choice.replace(/["\\\x00-\x1F]/g, "");
      return `"${safe}", -apple-system, "PingFang SC", sans-serif`;
    }
  }
};
