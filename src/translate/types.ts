/**
 * Translation settings and view state for the document translation feature.
 *
 * Settings are edited in the settings dialog and persisted with the session;
 * `normalizeTranslationSettings` repairs data read back from the store the
 * same way `normalizeEditorPreferences` does, so a corrupt store behaves like
 * a fresh install.
 */

export interface TranslationSettings {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly targetLanguage: string;
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  endpoint: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  targetLanguage: "中文",
};

const MAX_FIELD_LENGTH = 1024;

const normalizeField = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_FIELD_LENGTH
    ? trimmed
    : fallback;
};

/** Repair data read from the persisted session; invalid fields get defaults. */
export const normalizeTranslationSettings = (
  value: unknown,
): TranslationSettings => {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_TRANSLATION_SETTINGS };
  }
  const record = value as Record<string, unknown>;
  return {
    endpoint: normalizeField(record.endpoint, DEFAULT_TRANSLATION_SETTINGS.endpoint),
    apiKey: normalizeField(record.apiKey, DEFAULT_TRANSLATION_SETTINGS.apiKey),
    model: normalizeField(record.model, DEFAULT_TRANSLATION_SETTINGS.model),
    targetLanguage: normalizeField(
      record.targetLanguage,
      DEFAULT_TRANSLATION_SETTINGS.targetLanguage,
    ),
  };
};

export type TranslationViewState =
  | {
      readonly phase: "translating";
      /** Partial translation shown while segments are still in flight. */
      readonly translatedText?: string;
      readonly completedBatches?: number;
      readonly totalBatches?: number;
    }
  | { readonly phase: "ready"; readonly translatedText: string }
  | { readonly phase: "error"; readonly error: string };
