import { describe, expect, it } from "vitest";
import { TRANSLATION_PRESETS } from "./presets";
import {
  CUSTOM_KEY_SLOT,
  DEFAULT_TRANSLATION_SETTINGS,
  isValidTranslationKeySlot,
  normalizeTranslationSettings,
  translationKeySlot,
  translationSettingsSignature,
  type TranslationSettings,
} from "./types";

describe("normalizeTranslationSettings", () => {
  it("keeps valid stored values and reports no pending key", () => {
    expect(
      normalizeTranslationSettings({
        endpoint: "https://example.com/v1",
        model: "gpt-test",
        targetLanguage: "English",
        concurrency: 6,
      }),
    ).toEqual({
      settings: {
        endpoint: "https://example.com/v1",
        model: "gpt-test",
        targetLanguage: "English",
        concurrency: 6,
      },
      pendingKeys: {},
    });
  });

  it("returns defaults for garbage input", () => {
    for (const value of [undefined, null, "openai", 42]) {
      expect(normalizeTranslationSettings(value)).toEqual({
        settings: DEFAULT_TRANSLATION_SETTINGS,
        pendingKeys: {},
      });
    }
  });

  it("falls back per field when a stored value has the wrong type", () => {
    expect(
      normalizeTranslationSettings({
        endpoint: 12,
        model: ["gpt-4o-mini"],
        targetLanguage: 1,
      }),
    ).toEqual({ settings: DEFAULT_TRANSLATION_SETTINGS, pendingKeys: {} });
  });

  it("rejects blank or absurdly long field values", () => {
    const { settings } = normalizeTranslationSettings({
      endpoint: "   ",
      model: "x".repeat(2000),
      targetLanguage: "\n",
    });
    expect(settings.endpoint).toBe(DEFAULT_TRANSLATION_SETTINGS.endpoint);
    expect(settings.model).toBe(DEFAULT_TRANSLATION_SETTINGS.model);
    expect(settings.targetLanguage).toBe(
      DEFAULT_TRANSLATION_SETTINGS.targetLanguage,
    );
  });

  it("trims surrounding whitespace", () => {
    expect(
      normalizeTranslationSettings({
        endpoint: "  https://example.com/v1  ",
        model: " gpt-test ",
        targetLanguage: " 中文 ",
      }).settings,
    ).toEqual({
      endpoint: "https://example.com/v1",
      model: "gpt-test",
      targetLanguage: "中文",
      concurrency: 10,
    });
  });

  it("never returns the shared default object", () => {
    const { settings } = normalizeTranslationSettings(null);
    expect(settings).not.toBe(DEFAULT_TRANSLATION_SETTINGS);
  });
});

describe("concurrency field", () => {
  it("defaults to 10", () => {
    expect(DEFAULT_TRANSLATION_SETTINGS.concurrency).toBe(10);
  });

  it("falls back to the default for non-finite values", () => {
    for (const value of [undefined, null, "5", NaN, Infinity, {}]) {
      expect(
        normalizeTranslationSettings({ concurrency: value }).settings
          .concurrency,
      ).toBe(DEFAULT_TRANSLATION_SETTINGS.concurrency);
    }
  });

  it("rounds fractional values", () => {
    expect(
      normalizeTranslationSettings({ concurrency: 5.6 }).settings.concurrency,
    ).toBe(6);
    expect(
      normalizeTranslationSettings({ concurrency: 3.4 }).settings.concurrency,
    ).toBe(3);
  });

  it("clamps to the 1-32 range", () => {
    expect(
      normalizeTranslationSettings({ concurrency: 0 }).settings.concurrency,
    ).toBe(1);
    expect(
      normalizeTranslationSettings({ concurrency: -3 }).settings.concurrency,
    ).toBe(1);
    expect(
      normalizeTranslationSettings({ concurrency: 100 }).settings.concurrency,
    ).toBe(32);
  });
});

describe("translationKeySlot", () => {
  it("is the matched preset's id", () => {
    const preset = TRANSLATION_PRESETS[0];
    expect(
      translationKeySlot({ endpoint: preset.endpoint, model: preset.model }),
    ).toBe(preset.id);
    // A trailing slash is the same endpoint (see matchPreset).
    expect(
      translationKeySlot({
        endpoint: `${preset.endpoint}/`,
        model: preset.model,
      }),
    ).toBe(preset.id);
  });

  it("is custom while the endpoint and model match no preset", () => {
    expect(
      translationKeySlot({
        endpoint: "https://example.com/v1",
        model: "gpt-4o-mini",
      }),
    ).toBe(CUSTOM_KEY_SLOT);
    // A preset's endpoint with another model is a custom provider too.
    expect(
      translationKeySlot({
        endpoint: TRANSLATION_PRESETS[0].endpoint,
        model: "other-model",
      }),
    ).toBe(CUSTOM_KEY_SLOT);
  });
});

describe("isValidTranslationKeySlot", () => {
  it("accepts custom and preset-shaped ids", () => {
    for (const slot of ["custom", "glm", "hunyuan", "deepseek", "a-1"]) {
      expect(isValidTranslationKeySlot(slot)).toBe(true);
    }
  });

  it("rejects anything the backend would refuse", () => {
    for (const slot of ["", "GLM", "a_b", "a b", "a".repeat(65), "中文"]) {
      expect(isValidTranslationKeySlot(slot)).toBe(false);
    }
    // The contract is the backend's shape check, nothing stricter: a lone
    // hyphen is a shape match even though no preset ever uses it.
    expect(isValidTranslationKeySlot("-")).toBe(true);
  });
});

describe("pending translation keys of a pre-slot session", () => {
  const legacy = (
    value: Record<string, unknown>,
    endpoint = "https://example.com/v1",
    model = "gpt-4o-mini",
  ) => normalizeTranslationSettings({ endpoint, model, ...value });

  it("reports the active key under the slot its endpoint+model address", () => {
    expect(legacy({ apiKey: "sk-active" }).pendingKeys).toEqual({
      custom: "sk-active",
    });
    const preset = TRANSLATION_PRESETS[0];
    expect(
      legacy({ apiKey: "sk-active" }, preset.endpoint, preset.model).pendingKeys,
    ).toEqual({ [preset.id]: "sk-active" });
  });

  it("reports every remembered preset key, slot by slot", () => {
    expect(
      legacy({
        apiKey: "sk-custom",
        presetApiKeys: { glm: "sk-glm", deepseek: "sk-deepseek" },
      }).pendingKeys,
    ).toEqual({
      glm: "sk-glm",
      deepseek: "sk-deepseek",
      custom: "sk-custom",
    });
  });

  it("lets the active key win over a remembered one for the same slot", () => {
    expect(
      legacy({
        apiKey: "sk-active",
        presetApiKeys: { custom: "sk-stale" },
      }).pendingKeys,
    ).toEqual({ custom: "sk-active" });
  });

  it("ignores empty, malformed and unaddressable entries", () => {
    expect(
      legacy({
        apiKey: "   ",
        presetApiKeys: {
          glm: "",
          deepseek: 42,
          "Bad_Slot": "sk-bad",
          "": "sk-blank",
          valid: "  sk-valid  ",
        },
      }).pendingKeys,
    ).toEqual({ valid: "sk-valid" });
  });

  it("is empty for a session already in the slot shape", () => {
    expect(
      normalizeTranslationSettings({ ...DEFAULT_TRANSLATION_SETTINGS })
        .pendingKeys,
    ).toEqual({});
  });

  it("caps a corrupt preset map at 8 entries", () => {
    const manyKeys = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`slot-${index}`, `sk-${index}`]),
    );
    expect(
      legacy({ presetApiKeys: manyKeys }).pendingKeys,
    ).toEqual(
      Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [`slot-${index}`, `sk-${index}`]),
      ),
    );
  });
});

describe("translationSettingsSignature", () => {
  it("is equal for settings objects with the same output-affecting values", () => {
    expect(
      translationSettingsSignature({ ...DEFAULT_TRANSLATION_SETTINGS }),
    ).toBe(translationSettingsSignature(DEFAULT_TRANSLATION_SETTINGS));
  });

  it("changes when the endpoint, model, target language or concurrency change", () => {
    const base = DEFAULT_TRANSLATION_SETTINGS;
    const signature = translationSettingsSignature(base);
    expect(
      translationSettingsSignature({ ...base, endpoint: "https://other.example/v1" }),
    ).not.toBe(signature);
    expect(
      translationSettingsSignature({ ...base, model: "gpt-5" }),
    ).not.toBe(signature);
    expect(
      translationSettingsSignature({ ...base, targetLanguage: "English" }),
    ).not.toBe(signature);
    expect(translationSettingsSignature({ ...base, concurrency: 3 })).not.toBe(
      signature,
    );
  });

  it("ignores key-shaped fields a session under migration may still carry", () => {
    // The signature must not see a key at all: an unmigrated session's
    // plaintext fields are not settings, and rotating a key never
    // invalidates an in-memory translation.
    const withLegacyFields = {
      ...DEFAULT_TRANSLATION_SETTINGS,
      apiKey: "sk-rotated",
      presetApiKeys: { custom: "sk-rotated" },
    } as unknown as TranslationSettings;
    expect(translationSettingsSignature(withLegacyFields)).toBe(
      translationSettingsSignature(DEFAULT_TRANSLATION_SETTINGS),
    );
  });
});
