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
