import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR_PREFERENCES,
  DEFAULT_THEME_PREFERENCE,
  EDITOR_PREFERENCE_LIMITS,
  clampEditorPreferences,
  fontFamilyStack,
  normalizeEditorPreferences,
  normalizeThemePreference,
  resolveTheme,
} from "./preferences";

describe("normalizeThemePreference", () => {
  it("accepts system, light and dark", () => {
    expect(normalizeThemePreference("system")).toBe("system");
    expect(normalizeThemePreference("light")).toBe("light");
    expect(normalizeThemePreference("dark")).toBe("dark");
  });

  it("falls back to dark for anything else", () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe("dark");
    expect(normalizeThemePreference(undefined)).toBe("dark");
    expect(normalizeThemePreference(null)).toBe("dark");
    expect(normalizeThemePreference("solarized")).toBe("dark");
    expect(normalizeThemePreference(42)).toBe("dark");
  });
});

describe("resolveTheme", () => {
  it("keeps explicit light and dark regardless of the system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the system preference when set to system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("normalizeEditorPreferences", () => {
  it("keeps valid stored values", () => {
    expect(
      normalizeEditorPreferences({
        bodySizePx: 18,
        lineHeight: 1.8,
        contentWidthPx: 900,
        fontFamily: "serif",
      }),
    ).toEqual({
      bodySizePx: 18,
      lineHeight: 1.8,
      contentWidthPx: 900,
      fontFamily: "serif",
    });
  });

  it("returns defaults for garbage input", () => {
    expect(normalizeEditorPreferences(undefined)).toEqual(
      DEFAULT_EDITOR_PREFERENCES,
    );
    expect(normalizeEditorPreferences(null)).toEqual(DEFAULT_EDITOR_PREFERENCES);
    expect(normalizeEditorPreferences("dark")).toEqual(
      DEFAULT_EDITOR_PREFERENCES,
    );
    expect(normalizeEditorPreferences(12)).toEqual(DEFAULT_EDITOR_PREFERENCES);
  });

  it("falls back per field when a stored value is out of range", () => {
    const normalized = normalizeEditorPreferences({
      bodySizePx: 48,
      lineHeight: 0.5,
      contentWidthPx: 200,
      fontFamily: "monospace",
    });
    expect(normalized.bodySizePx).toBe(DEFAULT_EDITOR_PREFERENCES.bodySizePx);
    expect(normalized.lineHeight).toBe(DEFAULT_EDITOR_PREFERENCES.lineHeight);
    expect(normalized.contentWidthPx).toBe(
      DEFAULT_EDITOR_PREFERENCES.contentWidthPx,
    );
    expect(normalized.fontFamily).toBe("monospace");
  });

  it("falls back per field when a stored value has the wrong type", () => {
    const normalized = normalizeEditorPreferences({
      bodySizePx: "16",
      lineHeight: Number.NaN,
      contentWidthPx: null,
      fontFamily: 12,
    });
    expect(normalized).toEqual(DEFAULT_EDITOR_PREFERENCES);
  });

  it("accepts boundary values", () => {
    const normalized = normalizeEditorPreferences({
      bodySizePx: EDITOR_PREFERENCE_LIMITS.bodySizePx.min,
      lineHeight: EDITOR_PREFERENCE_LIMITS.lineHeight.max,
      contentWidthPx: EDITOR_PREFERENCE_LIMITS.contentWidthPx.max,
      fontFamily: "system",
    });
    expect(normalized.bodySizePx).toBe(EDITOR_PREFERENCE_LIMITS.bodySizePx.min);
    expect(normalized.lineHeight).toBe(EDITOR_PREFERENCE_LIMITS.lineHeight.max);
    expect(normalized.contentWidthPx).toBe(
      EDITOR_PREFERENCE_LIMITS.contentWidthPx.max,
    );
  });

  it("accepts preset and custom installed font names", () => {
    for (const preset of ["system", "serif", "monospace"]) {
      expect(
        normalizeEditorPreferences({ fontFamily: preset }).fontFamily,
      ).toBe(preset);
    }
    expect(
      normalizeEditorPreferences({ fontFamily: "LXGW WenKai" }).fontFamily,
    ).toBe("LXGW WenKai");
  });

  it("rejects blank or absurdly long font names", () => {
    expect(normalizeEditorPreferences({ fontFamily: "   " }).fontFamily).toBe(
      DEFAULT_EDITOR_PREFERENCES.fontFamily,
    );
    expect(
      normalizeEditorPreferences({ fontFamily: "x".repeat(200) }).fontFamily,
    ).toBe(DEFAULT_EDITOR_PREFERENCES.fontFamily);
  });

  it("never returns the shared default object", () => {
    const normalized = normalizeEditorPreferences(null);
    expect(normalized).not.toBe(DEFAULT_EDITOR_PREFERENCES);
  });
});

describe("clampEditorPreferences", () => {
  it("clamps live UI values into the valid ranges instead of resetting them", () => {
    expect(
      clampEditorPreferences({
        bodySizePx: 99,
        lineHeight: 0.1,
        contentWidthPx: 100,
        fontFamily: "serif",
      }),
    ).toEqual({
      bodySizePx: EDITOR_PREFERENCE_LIMITS.bodySizePx.max,
      lineHeight: EDITOR_PREFERENCE_LIMITS.lineHeight.min,
      contentWidthPx: EDITOR_PREFERENCE_LIMITS.contentWidthPx.min,
      fontFamily: "serif",
    });
  });

  it("repairs non-finite numbers and blank fonts", () => {
    const clamped = clampEditorPreferences({
      bodySizePx: Number.NaN,
      lineHeight: Number.POSITIVE_INFINITY,
      contentWidthPx: 700,
      fontFamily: "  ",
    });
    expect(clamped.bodySizePx).toBe(DEFAULT_EDITOR_PREFERENCES.bodySizePx);
    expect(clamped.lineHeight).toBe(DEFAULT_EDITOR_PREFERENCES.lineHeight);
    expect(clamped.contentWidthPx).toBe(700);
    expect(clamped.fontFamily).toBe(DEFAULT_EDITOR_PREFERENCES.fontFamily);
  });
});

describe("fontFamilyStack", () => {
  it("maps presets to concrete stacks", () => {
    expect(fontFamilyStack("system")).toContain("-apple-system");
    expect(fontFamilyStack("serif")).toContain("serif");
    expect(fontFamilyStack("monospace")).toContain("monospace");
    expect(fontFamilyStack("system")).not.toBe(fontFamilyStack("serif"));
  });

  it("quotes custom font names and appends a fallback", () => {
    const stack = fontFamilyStack("LXGW WenKai");
    expect(stack).toContain('"LXGW WenKai"');
    expect(stack).toContain("sans-serif");
  });

  it("strips quote characters from custom names", () => {
    expect(fontFamilyStack('Evil"Font')).not.toContain('Evil"Font');
    expect(fontFamilyStack('Evil"Font')).toContain('"EvilFont"');
  });

  it("strips control characters that would invalidate the font declaration", () => {
    expect(fontFamilyStack("Evil\nFont")).toBe(
      '"EvilFont", -apple-system, "PingFang SC", sans-serif',
    );
    expect(fontFamilyStack("Line\rBreak")).toContain('"LineBreak"');
    expect(fontFamilyStack("Tab\tFont")).not.toContain("\t");
    expect(fontFamilyStack("A\u0000B")).toContain('"AB"');
    expect(fontFamilyStack("A\u001FB")).toContain('"AB"');
  });
});
