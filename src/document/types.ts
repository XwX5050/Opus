export type Newline = "lf" | "cr_lf";

export interface DocumentSnapshot {
  id: string;
  path: string | null;
  title: string;
  text: string;
  savedText: string;
  hasUtf8Bom: boolean;
  newline: Newline;
  modifiedUnixMs: number | null;
  version: string | null;
  status: "clean" | "dirty" | "conflict" | "missing";
}

export interface ClosedTab {
  document: DocumentSnapshot;
  closedIndex: number;
}

export interface DocumentState {
  tabs: DocumentSnapshot[];
  activeId: string | null;
  recentlyClosed: ClosedTab[];
}

export interface OpenedFile {
  path: string;
  text: string;
  hasUtf8Bom: boolean;
  newline: Newline;
  modifiedUnixMs: number;
  version: string;
}
