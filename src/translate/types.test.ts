import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSLATION_SETTINGS,
  normalizeTranslationSettings,
  stashApiKey,
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
        presetApiKeys: { glm: "sk-glm", custom: "sk-custom" },
      }),
    ).toEqual({
      endpoint: "https://example.com/v1",
      apiKey: "sk-test",
      model: "gpt-test",
      targetLanguage: "English",
      concurrency: 6,
      presetApiKeys: { glm: "sk-glm", custom: "sk-custom" },
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
      presetApiKeys: {},
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

describe("presetApiKeys field", () => {
  it("is always present and empty for old sessions without it", () => {
    expect(DEFAULT_TRANSLATION_SETTINGS.presetApiKeys).toEqual({});
    expect(normalizeTranslationSettings(undefined).presetApiKeys).toEqual({});
    expect(normalizeTranslationSettings(null).presetApiKeys).toEqual({});
    expect(normalizeTranslationSettings({}).presetApiKeys).toEqual({});
    expect(
      normalizeTranslationSettings({
        endpoint: "https://example.com/v1",
        apiKey: "sk-test",
        model: "gpt-test",
        targetLanguage: "中文",
        concurrency: 4,
      }).presetApiKeys,
    ).toEqual({});
  });

  it("keeps stored preset keys and survives a round trip", () => {
    const settings = normalizeTranslationSettings({
      ...DEFAULT_TRANSLATION_SETTINGS,
      presetApiKeys: {
        custom: "sk-custom",
        glm: "sk-glm",
        hunyuan: "sk-hunyuan",
        deepseek: "sk-deepseek",
      },
    });
    expect(settings.presetApiKeys).toEqual({
      custom: "sk-custom",
      glm: "sk-glm",
      hunyuan: "sk-hunyuan",
      deepseek: "sk-deepseek",
    });
    // Normalizing the normalized output changes nothing.
    expect(normalizeTranslationSettings(settings)).toEqual(settings);
  });

  it("drops invalid presetApiKeys entries", () => {
    const keys = {
      valid: "sk-ok",
      numeric: 42,
      nulled: null,
      nested: { value: "sk-nested" },
      longValue: "x".repeat(1025),
      ["k".repeat(1025)]: "sk-long-key",
      "": "sk-blank-key",
    } as unknown as Record<string, string>;
    expect(
      normalizeTranslationSettings({ ...DEFAULT_TRANSLATION_SETTINGS, presetApiKeys: keys })
        .presetApiKeys,
    ).toEqual({ valid: "sk-ok" });
  });

  it("rejects a non-object presetApiKeys map", () => {
    for (const value of ["sk-key", 42, true]) {
      expect(
        normalizeTranslationSettings({
          ...DEFAULT_TRANSLATION_SETTINGS,
          presetApiKeys: value as never,
        }).presetApiKeys,
      ).toEqual({});
    }
  });

  it("caps the stored map at 8 entries", () => {
    const manyKeys = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`slot-${index}`, `sk-${index}`]),
    );
    const normalized = normalizeTranslationSettings({
      ...DEFAULT_TRANSLATION_SETTINGS,
      presetApiKeys: manyKeys,
    });
    expect(Object.keys(normalized.presetApiKeys)).toEqual([
      "slot-0",
      "slot-1",
      "slot-2",
      "slot-3",
      "slot-4",
      "slot-5",
      "slot-6",
      "slot-7",
    ]);
  });
});

describe("stashApiKey", () => {
  it("remembers the key under the slot and makes it the active key", () => {
    expect(stashApiKey(DEFAULT_TRANSLATION_SETTINGS, "custom", "sk-a")).toEqual({
      ...DEFAULT_TRANSLATION_SETTINGS,
      apiKey: "sk-a",
      presetApiKeys: { custom: "sk-a" },
    });
  });

  it("preserves other slots' keys and overwrites the same slot", () => {
    const first = stashApiKey(DEFAULT_TRANSLATION_SETTINGS, "custom", "sk-a");
    const second = stashApiKey(first, "glm", "sk-b");
    expect(second.presetApiKeys).toEqual({ custom: "sk-a", glm: "sk-b" });
    expect(second.apiKey).toBe("sk-b");
    const third = stashApiKey(second, "custom", "sk-a2");
    expect(third.presetApiKeys).toEqual({ custom: "sk-a2", glm: "sk-b" });
    expect(third.apiKey).toBe("sk-a2");
  });
});
