import type { DocumentSnapshot, RecoveryDraft } from "../document/types";

/**
 * RFC 4122 v4 UUID from the platform's secure random source, or null when the
 * runtime has no Web Crypto (very old WebViews).
 */
const randomUuid = (): string | null => {
  const cryptoApi: Crypto | undefined = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") return null;

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const createLaunchNamespace = (): string => {
  const uuid = randomUuid();
  if (uuid !== null) return uuid;

  // Last resort without Web Crypto: time plus two random base-36 segments is
  // not cryptographic, but keeps consecutive launches apart and every
  // character inside the Rust store's file-name alphabet.
  const randomSegment = (): string =>
    Math.random().toString(36).slice(2).padEnd(8, "0").slice(0, 8);
  return `${Date.now().toString(36)}-${randomSegment()}-${randomSegment()}`;
};

/**
 * One namespace per application launch. The tab id alone (`document-N`)
 * restarts at 1 on every launch, so without it a fresh session's first dirty
 * tab would overwrite another session's leftover draft of the same tab id.
 */
const LAUNCH_NAMESPACE = createLaunchNamespace();

/**
 * Draft IDs are `<prefix>-<launch namespace>-<tab id>`: stable for the tab's
 * lifetime, different across launches, and inside the Rust store's 128-char
 * `[A-Za-z0-9_-]` file-name alphabet. Legacy `draft-document-N` ids remain
 * listable/readable by the port; `restoreDraft` migrates one by writing the
 * owner copy under the current namespace before discarding the legacy id.
 */
export const draftIdForTab = (tabId: string): string =>
  `draft-${LAUNCH_NAMESPACE}-${tabId}`;

/** FNV-1a 32-bit over UTF-16 code units; the backend treats it as opaque. */
export const hashText = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/** A tab needs a recovery draft whenever closing it now would lose content. */
export const needsRecoveryDraft = (tab: DocumentSnapshot): boolean =>
  tab.status !== "clean" || tab.text !== tab.savedText;

export const draftFromSnapshot = (tab: DocumentSnapshot): RecoveryDraft => ({
  draftId: draftIdForTab(tab.id),
  originalPath: tab.path,
  title: tab.title,
  text: tab.text,
  hasUtf8Bom: tab.hasUtf8Bom,
  newline: tab.newline,
  savedTextHash: hashText(tab.savedText),
  savedVersion: tab.version,
});
