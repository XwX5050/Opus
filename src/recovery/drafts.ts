import type { DocumentSnapshot, RecoveryDraft } from "../document/types";

/**
 * Draft IDs are derived from the stable tab ID (`document-N`), so they are
 * always filesystem-safe ([A-Za-z0-9_-], well under the 128-character limit
 * the Rust recovery store enforces) and stable for the tab's lifetime.
 */
export const draftIdForTab = (tabId: string): string => `draft-${tabId}`;

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
