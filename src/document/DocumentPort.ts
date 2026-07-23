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

export interface ClipboardImageInput {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly documentPath: string | null;
}

export interface WorkspaceRoot {
  readonly path: string;
  readonly title: string;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
}

export interface DocumentPort {
  chooseAndOpenFiles(): Promise<ReadonlyArray<OpenedFile>>;
  openPath(path: string): Promise<OpenedFile>;
  chooseSavePath(suggestedName: string): Promise<SaveTarget | null>;
  write(request: PendingWriteRequest): Promise<SavedFile>;
  saveClipboardImage(input: ClipboardImageInput): Promise<string | null>;
  acquireDocumentScope(consumerId: string, path: string): Promise<void>;
  acquireWorkspaceScope(consumerId: string, root: string): Promise<void>;
  releaseAssetScope(consumerId: string): Promise<void>;
  chooseWorkspace(): Promise<WorkspaceRoot | null>;
  openWorkspacePath(path: string): Promise<WorkspaceRoot>;
  listDirectory(root: string, relative: string): Promise<ReadonlyArray<DirectoryEntry>>;
  createMarkdownFile(root: string, relative: string): Promise<DirectoryEntry>;
  renameEntry(root: string, from: string, toName: string): Promise<DirectoryEntry>;
  trashEntry(root: string, relative: string): Promise<void>;
}
