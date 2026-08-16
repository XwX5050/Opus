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
      }),
    ).toEqual({
      endpoint: "https://example.com/v1",
      apiKey: "sk-test",
      model: "gpt-test",
      targetLanguage: "English",
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
    });
  });

  it("never returns the shared default object", () => {
    const normalized = normalizeTranslationSettings(null);
    expect(normalized).not.toBe(DEFAULT_TRANSLATION_SETTINGS);
  });
});
