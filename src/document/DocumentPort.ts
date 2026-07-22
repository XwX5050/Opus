import type {
  OpenedFile,
  PendingWriteRequest,
  SaveTarget,
} from "./types";

export type DocumentPortErrorCode =
  | "invalid_utf8"
  | "permission_denied"
  | "not_found"
  | "conflict"
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
  readonly path: string;
  readonly modifiedUnixMs: number;
  readonly version: string;
}

export interface DocumentPort {
  chooseAndOpenFiles(): Promise<ReadonlyArray<OpenedFile>>;
  openPath(path: string): Promise<OpenedFile>;
  chooseSavePath(suggestedName: string): Promise<SaveTarget | null>;
  write(request: PendingWriteRequest): Promise<SavedFile>;
}
