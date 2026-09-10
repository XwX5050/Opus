/**
 * Translation settings and view state for the document translation feature.
 *
 * Settings are edited in the settings dialog and persisted with the session;
 * `normalizeTranslationSettings` repairs data read back from the store the
 * same way `normalizeEditorPreferences` does, so a corrupt store behaves like
 * a fresh install.
 *
 * Provider API keys are deliberately NOT part of these settings: the frontend
 * addresses a key by slot (`translationKeySlot`) and the backend owns the
 * secret in the OS credential store, so no key ever lives in the session file
 * or in frontend memory.
 */

import { matchPreset } from "./presets";

export interface TranslationSettings {
  readonly endpoint: string;
  readonly model: string;
  readonly targetLanguage: string;
  /** Maximum concurrent chunk requests for one document translation. */
  readonly concurrency: number;
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  endpoint: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  targetLanguage: "中文",
  concurrency: 10,
};

/** Slot holding the key of a provider that matches no preset. */
export const CUSTOM_KEY_SLOT = "custom";

/** Valid slots: "custom" or a preset-shaped id, mirroring the backend check. */
const SLOT_PATTERN = /^[a-z0-9-]{1,64}$/;

export const isValidTranslationKeySlot = (slot: string): boolean =>
  slot === CUSTOM_KEY_SLOT || SLOT_PATTERN.test(slot);

/**
 * The slot the configured provider addresses its API key by: the matched
 * preset's id, or "custom" while the endpoint and model identify no preset.
 * Computed from the settings — never stored, so it can never go stale.
 */
export const translationKeySlot = (settings: {
  readonly endpoint: string;
  readonly model: string;
}): string => matchPreset(settings)?.id ?? CUSTOM_KEY_SLOT;

/**
 * How the backend protects stored translation keys: "system" when the OS
 * credential store is available, "file" when it falls back to a
 * weakly-protected local file.
 */
export type TranslationKeyProtection = "system" | "file";

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

/** A stored key as it can still exist in a pre-slot session: any non-empty
 * trimmed string within the field cap. */
const storedKey = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_FIELD_LENGTH
    ? trimmed
    : "";
};

/** Cap on remembered legacy preset keys: three presets plus "custom" exist,
 * so anything beyond a handful is corrupt data. */
const MAX_PRESET_API_KEYS = 8;

/** The `presetApiKeys` record of a pre-slot session, entry-validated. */
const storedPresetKeys = (value: unknown): Record<string, string> => {
  if (typeof value !== "object" || value === null) return {};
  const keys: Record<string, string> = {};
  for (const [slot, apiKey] of Object.entries(value)) {
    if (Object.keys(keys).length >= MAX_PRESET_API_KEYS) break;
    const key = storedKey(apiKey);
    if (key.length === 0) continue;
    keys[slot] = key;
  }
  return keys;
};

/**
 * Plaintext keys still sitting in a session written before slot addressing,
 * keyed by the slot each belongs to. The backend writes every entry into the
 * OS credential store and only then drops the plaintext fields, so no key is
 * silently lost on upgrade.
 */
export type PendingTranslationKeys = Readonly<Record<string, string>>;

export interface NormalizedTranslationSettings {
  /** The repaired, slot-addressed settings. Never carries a key. */
  readonly settings: TranslationSettings;
  /** Empty unless a pre-slot session still carries plaintext keys. */
  readonly pendingKeys: PendingTranslationKeys;
}

/** Keys of a pre-slot `translationSettings` record, mapped to their slots. */
const pendingKeysOf = (
  record: Record<string, unknown>,
  settings: TranslationSettings,
): PendingTranslationKeys => {
  const keys: Record<string, string> = {};
  for (const [slot, key] of Object.entries(
    storedPresetKeys(record.presetApiKeys),
  )) {
    // A stale slot id (a preset that no longer exists) is still migrated —
    // the key is the user's, not ours to drop — but only well-formed slots
    // can be addressed, so anything else is left alone rather than sent to
    // a backend that would reject it.
    if (isValidTranslationKeySlot(slot)) keys[slot] = key;
  }
  const active = storedKey(record.apiKey);
  if (active.length > 0) keys[translationKeySlot(settings)] = active;
  return keys;
};

/**
 * Repair data read from the persisted session; invalid fields get defaults.
 * Keys of a pre-slot session are reported as pending (never as settings) so
 * the caller can migrate them instead of dropping them.
 */
export const normalizeTranslationSettings = (
  value: unknown,
): NormalizedTranslationSettings => {
  if (typeof value !== "object" || value === null) {
    return { settings: { ...DEFAULT_TRANSLATION_SETTINGS }, pendingKeys: {} };
  }
  const record = value as Record<string, unknown>;
  const settings: TranslationSettings = {
    endpoint: normalizeField(record.endpoint, DEFAULT_TRANSLATION_SETTINGS.endpoint),
    model: normalizeField(record.model, DEFAULT_TRANSLATION_SETTINGS.model),
    targetLanguage: normalizeField(
      record.targetLanguage,
      DEFAULT_TRANSLATION_SETTINGS.targetLanguage,
    ),
    concurrency: normalizeConcurrency(record.concurrency),
  };
  return { settings, pendingKeys: pendingKeysOf(record, settings) };
};

/**
 * Opaque signature of the settings fields that change what a translation
 * looks like: endpoint, model, target language and concurrency. API keys
 * authenticate the same output and live outside the settings, so they are
 * deliberately excluded. In-memory per-tab translation results are bound to
 * this signature, so changing any listed field drops (or marks stale) every
 * cached result and the next show re-translates under the new settings.
 */
export const translationSettingsSignature = (
  settings: TranslationSettings,
): string =>
  JSON.stringify([
    settings.endpoint,
    settings.model,
    settings.targetLanguage,
    settings.concurrency,
  ]);

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
