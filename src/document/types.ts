export type Newline = "lf" | "cr_lf";
export type PathPlatform = "linux" | "macos" | "windows";

export interface SaveTarget {
  readonly path: string;
  readonly expectedVersion: string | null;
}

export interface PendingWriteRequest {
  readonly requestId: string;
  readonly documentId: string;
  readonly targetPath: string;
  readonly text: string;
  readonly hasUtf8Bom: boolean;
  readonly newline: Newline;
  readonly expectedVersion: string | null;
  readonly pathPlatform: PathPlatform;
}

export interface DocumentSnapshot {
  readonly id: string;
  readonly path: string | null;
  readonly title: string;
  readonly text: string;
  readonly savedText: string;
  readonly hasUtf8Bom: boolean;
  readonly newline: Newline;
  readonly modifiedUnixMs: number | null;
  readonly version: string | null;
  readonly status: "clean" | "dirty" | "conflict" | "missing";
  readonly pendingSave?: PendingWriteRequest;
}

export interface ClosedTab {
  readonly document: DocumentSnapshot;
  readonly closedIndex: number;
}

export interface DocumentState {
  readonly tabs: ReadonlyArray<DocumentSnapshot>;
  readonly activeId: string | null;
  readonly recentlyClosed: ReadonlyArray<ClosedTab>;
  readonly nextSaveSequence: number;
}

export interface OpenedFile {
  readonly path: string;
  readonly text: string;
  readonly hasUtf8Bom: boolean;
  readonly newline: Newline;
  readonly modifiedUnixMs: number;
  readonly version: string;
}

/**
 * Normalized disk-change event emitted by the Rust watcher service
 * (`document-disk-event`). `version` on a change is the opaque document
 * version recomputed from disk at flush time, so the controller can
 * suppress events produced by its own saves; `modifiedUnixMs` is display
 * metadata only.
 */
export type DiskEvent =
  | {
      readonly kind: "changed";
      readonly path: string;
      readonly modifiedUnixMs: number;
      readonly version: string;
    }
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "moved"; readonly from: string; readonly to: string };

/**
 * A dirty-document snapshot stored for crash recovery. `savedTextHash` and
 * `savedVersion` are opaque tokens derived from the last clean document
 * version; Rust stores and returns them without interpreting them.
 */
export interface RecoveryDraft {
  readonly draftId: string;
  readonly originalPath: string | null;
  readonly title: string;
  readonly text: string;
  readonly hasUtf8Bom: boolean;
  readonly newline: Newline;
  readonly savedTextHash: string;
  readonly savedVersion: string | null;
}

/** Draft metadata for restart listings; excludes the (potentially large) text. */
export interface RecoveryDraftInfo {
  readonly draftId: string;
  readonly originalPath: string | null;
  readonly title: string;
  readonly savedTextHash: string;
  readonly savedVersion: string | null;
  readonly updatedUnixMs: number;
}
