import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSLATION_SETTINGS,
  normalizeTranslationSettings,
} from "./types";

describe("normalizeTranslationSettings", () => {
  it("keeps valid stored values", () => {
    expect(
      normalizeTranslationSettings({
        endpoint: "https://example.com/v1",
        apiKey: "sk-test",
        model: "gpt-test",
        targetLanguage: "English",
        concurrency: 6,
      }),
    ).toEqual({
      endpoint: "https://example.com/v1",
      apiKey: "sk-test",
      model: "gpt-test",
      targetLanguage: "English",
      concurrency: 6,
    });
  });

  it("returns defaults for garbage input", () => {
    expect(normalizeTranslationSettings(undefined)).toEqual(
      DEFAULT_TRANSLATION_SETTINGS,
    );
    expect(normalizeTranslationSettings(null)).toEqual(
      DEFAULT_TRANSLATION_SETTINGS,
    );
    expect(normalizeTranslationSettings("openai")).toEqual(
      DEFAULT_TRANSLATION_SETTINGS,
    );
    expect(normalizeTranslationSettings(42)).toEqual(
      DEFAULT_TRANSLATION_SETTINGS,
    );
  });

  it("falls back per field when a stored value has the wrong type", () => {
    expect(
      normalizeTranslationSettings({
        endpoint: 12,
        apiKey: null,
        model: ["gpt-4o-mini"],
        targetLanguage: 1,
      }),
    ).toEqual(DEFAULT_TRANSLATION_SETTINGS);
  });

  it("rejects blank or absurdly long field values", () => {
    const normalized = normalizeTranslationSettings({
      endpoint: "   ",
      apiKey: "",
      model: "x".repeat(2000),
      targetLanguage: "\n",
    });
    expect(normalized.endpoint).toBe(DEFAULT_TRANSLATION_SETTINGS.endpoint);
    expect(normalized.apiKey).toBe(DEFAULT_TRANSLATION_SETTINGS.apiKey);
    expect(normalized.model).toBe(DEFAULT_TRANSLATION_SETTINGS.model);
    expect(normalized.targetLanguage).toBe(
      DEFAULT_TRANSLATION_SETTINGS.targetLanguage,
    );
  });

  it("trims surrounding whitespace", () => {
    expect(
      normalizeTranslationSettings({
        endpoint: "  https://example.com/v1  ",
        apiKey: " sk-test ",
        model: " gpt-test ",
        targetLanguage: " 中文 ",
      }),
    ).toEqual({
      endpoint: "https://example.com/v1",
      apiKey: "sk-test",
      model: "gpt-test",
      targetLanguage: "中文",
      concurrency: 10,
    });
  });

  it("never returns the shared default object", () => {
    const normalized = normalizeTranslationSettings(null);
    expect(normalized).not.toBe(DEFAULT_TRANSLATION_SETTINGS);
  });
});

describe("concurrency field", () => {
  it("defaults to 10", () => {
    expect(DEFAULT_TRANSLATION_SETTINGS.concurrency).toBe(10);
  });

  it("falls back to the default for non-finite values", () => {
    for (const value of [undefined, null, "5", NaN, Infinity, {}]) {
      expect(
        normalizeTranslationSettings({ concurrency: value }).concurrency,
      ).toBe(DEFAULT_TRANSLATION_SETTINGS.concurrency);
    }
  });

  it("rounds fractional values", () => {
    expect(normalizeTranslationSettings({ concurrency: 5.6 }).concurrency).toBe(
      6,
    );
    expect(normalizeTranslationSettings({ concurrency: 3.4 }).concurrency).toBe(
      3,
    );
  });

  it("clamps to the 1-32 range", () => {
    expect(normalizeTranslationSettings({ concurrency: 0 }).concurrency).toBe(1);
    expect(normalizeTranslationSettings({ concurrency: -3 }).concurrency).toBe(
      1,
    );
    expect(normalizeTranslationSettings({ concurrency: 100 }).concurrency).toBe(
      32,
    );
  });
});
