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
  /** Maximum concurrent chunk requests for one document translation. */
  readonly concurrency: number;
  /** API keys remembered per preset id; "custom" is the key while no preset matches. */
  readonly presetApiKeys: Record<string, string>;
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  endpoint: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  targetLanguage: "中文",
  concurrency: 10,
  presetApiKeys: {},
};

const MAX_FIELD_LENGTH = 1024;

const normalizeField = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_FIELD_LENGTH
    ? trimmed
    : fallback;
};

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 32;

/** Non-finite values fall back to the default; otherwise round and clamp. */
const normalizeConcurrency = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TRANSLATION_SETTINGS.concurrency;
  }
  return Math.min(
    MAX_CONCURRENCY,
    Math.max(MIN_CONCURRENCY, Math.round(value)),
  );
};

/** Cap on remembered preset keys: three presets plus "custom" exist, so
 * anything beyond a handful is corrupt data. */
const MAX_PRESET_API_KEYS = 8;

const normalizePresetApiKeys = (value: unknown): Record<string, string> => {
  if (typeof value !== "object" || value === null) return {};
  const keys: Record<string, string> = {};
  for (const [key, apiKey] of Object.entries(value)) {
    if (Object.keys(keys).length >= MAX_PRESET_API_KEYS) break;
    if (key.length === 0 || key.length > MAX_FIELD_LENGTH) continue;
    if (typeof apiKey !== "string" || apiKey.length > MAX_FIELD_LENGTH) {
      continue;
    }
    keys[key] = apiKey;
  }
  return keys;
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
    concurrency: normalizeConcurrency(record.concurrency),
    presetApiKeys: normalizePresetApiKeys(record.presetApiKeys),
  };
};

/**
 * Returns a copy of `settings` with `apiKey` as the active key, remembered
 * under `slot` — a preset id, or "custom" for the key used while no preset
 * matches. Other slots' keys are preserved.
 */
export const stashApiKey = (
  settings: TranslationSettings,
  slot: string,
  apiKey: string,
): TranslationSettings => ({
  ...settings,
  apiKey,
  presetApiKeys: { ...settings.presetApiKeys, [slot]: apiKey },
});

export type TranslationViewState =
  | {
      readonly phase: "translating";
      /** Partial translation shown while chunks are still in flight. */
      readonly translatedText?: string;
      /** Chunks completed so far, for the banner's x/y progress display. */
      readonly completedBatches?: number;
      /** Total chunks this document was subdivided into. */
      readonly totalBatches?: number;
    }
  | { readonly phase: "ready"; readonly translatedText: string }
  | { readonly phase: "error"; readonly error: string };
