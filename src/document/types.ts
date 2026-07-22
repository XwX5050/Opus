export type Newline = "lf" | "cr_lf";

export interface PendingSave {
  readonly requestId: string;
  readonly targetPath: string;
  readonly writtenText: string;
  readonly previousVersion: string | null;
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
  readonly pendingSave?: PendingSave;
}

export interface ClosedTab {
  readonly document: DocumentSnapshot;
  readonly closedIndex: number;
}

export interface DocumentState {
  readonly tabs: ReadonlyArray<DocumentSnapshot>;
  readonly activeId: string | null;
  readonly recentlyClosed: ReadonlyArray<ClosedTab>;
}

export interface OpenedFile {
  readonly path: string;
  readonly text: string;
  readonly hasUtf8Bom: boolean;
  readonly newline: Newline;
  readonly modifiedUnixMs: number;
  readonly version: string;
}
