import type {
  DiskEvent,
  OpenedFile,
  PendingWriteRequest,
  PersistedSession,
  RecoveryDraft,
  RecoveryDraftInfo,
  SaveTarget,
} from "./types";
import type { TranslationSettings } from "../translate/types";

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
  /** Clears the backend workspace anchor; best-effort, no-op outside Tauri. */
  closeWorkspace(): Promise<void>;
  listDirectory(root: string, relative: string): Promise<ReadonlyArray<DirectoryEntry>>;
  createMarkdownFile(root: string, relative: string): Promise<DirectoryEntry>;
  renameEntry(root: string, from: string, toName: string): Promise<DirectoryEntry>;
  trashEntry(root: string, relative: string): Promise<void>;
  /**
   * Watches one open document (the file does not need to exist). Watches are
   * reference-counted per consumer id; the underlying platform watch stops
   * when the last consumer unwatches.
   */
  watchDocument(consumerId: string, path: string): Promise<void>;
  /** Watches a workspace root recursively, same consumer refcounting. */
  watchWorkspace(consumerId: string, root: string): Promise<void>;
  /** Releases every watch held by the consumer. */
  unwatch(consumerId: string): Promise<void>;
  /**
   * Translates a batch of paragraphs with the configured OpenAI-compatible
   * API. The result has the same length as `segments`; each entry is the
   * translation of the segment at the same index. Rejects with a
   * DocumentPortError (or a plain Error) when the request fails.
   */
  translateSegments(
    settings: TranslationSettings,
    segments: string[],
  ): Promise<string[]>;
  /**
   * Lists the model ids an OpenAI-compatible endpoint advertises (GET
   * {endpoint}/models with the API key), sorted by id. The settings dialog
   * uses this to populate the model picker and to test the connection.
   * Rejects with a DocumentPortError (or a plain Error) when the request
   * fails.
   */
  listTranslationModels(endpoint: string, apiKey: string): Promise<string[]>;
  /**
   * Subscribes to the normalized disk-event stream. Resolves to an
   * unsubscribe function. Events arrive for any path covered by an active
   * watch; consumers filter by the paths they care about.
   */
  subscribeToDiskEvents(handler: (event: DiskEvent) => void): Promise<() => void>;
  listDrafts(): Promise<ReadonlyArray<RecoveryDraftInfo>>;
  readDraft(draftId: string): Promise<RecoveryDraft>;
  writeDraft(draft: RecoveryDraft): Promise<RecoveryDraftInfo>;
  discardDraft(draftId: string): Promise<void>;
  /**
   * Loads the persisted session (recent paths, tab order, active tab,
   * workspace). Returns null when no session was ever saved.
   */
  loadSession(): Promise<PersistedSession | null>;
  saveSession(session: PersistedSession): Promise<void>;
  /**
   * Persists any pending debounced session save immediately, bypassing the
   * trailing-edge timer — e.g. before an in-app update restarts the process,
   * where the window close event is never emitted. Resolves once the store
   * write settles (or immediately when nothing is pending). Best-effort: a
   * failed write never rejects.
   */
  flushSession(): Promise<void>;
  /**
   * Registers a handler run when the window is asked to close. The handler
   * may be async (e.g. flushing recovery drafts); the window closes after it
   * settles. Resolves to an unsubscribe function.
   */
  onCloseRequested(handler: () => void | Promise<void>): Promise<() => void>;
}
