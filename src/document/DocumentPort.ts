import type { DocumentSnapshot, OpenedFile } from "./types";

export type DocumentPortErrorCode =
  | "invalid_utf8"
  | "permission_denied"
  | "not_found"
  | "io";

export class DocumentPortError extends Error {
  readonly code: DocumentPortErrorCode;

  constructor(code: DocumentPortErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DocumentPortError";
    this.code = code;
  }
}

export interface SavedFile {
  path: string;
  modifiedUnixMs: number;
  version: string;
}

export interface DocumentPort {
  chooseAndOpenFiles(): Promise<OpenedFile[]>;
  openPath(path: string): Promise<OpenedFile>;
  save(document: DocumentSnapshot): Promise<SavedFile>;
  saveAs(document: DocumentSnapshot): Promise<SavedFile | null>;
}
