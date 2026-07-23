import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ClipboardImageInput, DirectoryEntry, DocumentPort, DocumentPortErrorCode, SavedFile, WorkspaceRoot } from "./DocumentPort";
import { DocumentPortError } from "./DocumentPort";
import type { DiskEvent, OpenedFile, PendingWriteRequest, RecoveryDraft, RecoveryDraftInfo, SaveTarget } from "./types";

type OpenDto = { path: string; text: string; has_utf8_bom: boolean; newline: OpenedFile["newline"]; modified_unix_ms: number; version: string };
type SaveDto = { path: string; modified_unix_ms: number; version: string };
type WorkspaceRootDto = { path: string; title: string };
type DirectoryEntryDto = { name: string; path: string; is_directory: boolean };
type DiskEventDto =
  | { kind: "changed"; path: string; modified_unix_ms: number; version: string }
  | { kind: "missing"; path: string }
  | { kind: "moved"; from: string; to: string };
type DraftInfoDto = { draft_id: string; original_path: string | null; title: string; saved_text_hash: string; saved_version: string | null; updated_unix_ms: number };
type DraftDto = { draft_id: string; original_path: string | null; title: string; text: string; has_utf8_bom: boolean; newline: RecoveryDraft["newline"]; saved_text_hash: string; saved_version: string | null };
const codes = new Set<DocumentPortErrorCode>(["invalid_utf8", "permission_denied", "not_found", "conflict", "io"]);

function failure(error: unknown): DocumentPortError {
  if (typeof error === "object" && error && "code" in error && "message" in error) {
    const { code, message } = error as { code: string; message: string };
    if (codes.has(code as DocumentPortErrorCode)) return new DocumentPortError(code as DocumentPortErrorCode, message, { cause: error });
  }
  return new DocumentPortError("io", error instanceof Error ? error.message : String(error), { cause: error });
}

const opened = (dto: OpenDto): OpenedFile => ({ path: dto.path, text: dto.text, hasUtf8Bom: dto.has_utf8_bom, newline: dto.newline, modifiedUnixMs: dto.modified_unix_ms, version: dto.version });
const saved = (dto: SaveDto): SavedFile => ({ path: dto.path, modifiedUnixMs: dto.modified_unix_ms, version: dto.version });
const workspaceRoot = (dto: WorkspaceRootDto): WorkspaceRoot => ({ path: dto.path, title: dto.title });
const directoryEntry = (dto: DirectoryEntryDto): DirectoryEntry => ({ name: dto.name, path: dto.path, isDirectory: dto.is_directory });
const diskEvent = (dto: DiskEventDto): DiskEvent =>
  dto.kind === "changed"
    ? { kind: "changed", path: dto.path, modifiedUnixMs: dto.modified_unix_ms, version: dto.version }
    : dto.kind === "moved"
      ? { kind: "moved", from: dto.from, to: dto.to }
      : { kind: "missing", path: dto.path };
const draftInfo = (dto: DraftInfoDto): RecoveryDraftInfo => ({ draftId: dto.draft_id, originalPath: dto.original_path, title: dto.title, savedTextHash: dto.saved_text_hash, savedVersion: dto.saved_version, updatedUnixMs: dto.updated_unix_ms });
const draft = (dto: DraftDto): RecoveryDraft => ({ draftId: dto.draft_id, originalPath: dto.original_path, title: dto.title, text: dto.text, hasUtf8Bom: dto.has_utf8_bom, newline: dto.newline, savedTextHash: dto.saved_text_hash, savedVersion: dto.saved_version });

// The asset-protocol URL builder lives here so that the rest of the app never
// imports @tauri-apps/api/core directly.
export const tauriImagePreviewUrl = (path: string): string => convertFileSrc(path);

const parentDirectoryOf = (path: string): string | null => {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return index === 0 ? "/" : null;
  return normalized.slice(0, index);
};

const timestampedImageName = (mimeType: ClipboardImageInput["mimeType"], now: Date): string => {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `image-${stamp}.${mimeType === "image/png" ? "png" : "jpg"}`;
};

export interface DocumentPortErrorContext {
  readonly path: string;
  readonly source: "dialog" | "event";
}
export type DocumentPortErrorHandler = (error: DocumentPortError, context: DocumentPortErrorContext) => void;

function report(handler: DocumentPortErrorHandler, error: unknown, context: DocumentPortErrorContext): void {
  try { handler(error instanceof DocumentPortError ? error : failure(error), context); } catch { /* error observers must not break document delivery */ }
}

export function createTauriDocumentPort(onError: DocumentPortErrorHandler = () => {}): DocumentPort {
  const openPath = async (path: string) => {
    try { return opened(await invoke<OpenDto>("open_document", { path })); } catch (error) { throw failure(error); }
  };
  return {
    openPath,
    async chooseAndOpenFiles() {
      const selection = await open({ directory: false, multiple: true, filters: [{ name: "Markdown", extensions: ["md", "markdown"] }] });
      if (selection === null) return [];
      const files: OpenedFile[] = [];
      for (const path of Array.isArray(selection) ? selection : [selection]) {
        try { files.push(await openPath(path)); } catch (error) { report(onError, error, { path, source: "dialog" }); }
      }
      return files;
    },
    async chooseSavePath(suggestedName: string): Promise<SaveTarget | null> {
      const path = await save({ defaultPath: suggestedName, filters: [{ name: "Markdown", extensions: ["md", "markdown"] }] });
      if (path === null) return null;
      try { return { path, expectedVersion: (await openPath(path)).version }; }
      catch (error) { if (error instanceof DocumentPortError && error.code === "not_found") return { path, expectedVersion: null }; throw error; }
    },
    async write(request: PendingWriteRequest) {
      if (!Object.isFrozen(request)) throw new TypeError("PendingWriteRequest must be frozen");
      try {
        return saved(await invoke<SaveDto>("save_document", { request: { request_id: request.requestId, document_id: request.documentId, target_path: request.targetPath, text: request.text, has_utf8_bom: request.hasUtf8Bom, newline: request.newline, expected_version: request.expectedVersion, path_platform: request.pathPlatform } }));
      } catch (error) { throw failure(error); }
    },
    async saveClipboardImage(input: ClipboardImageInput): Promise<string | null> {
      const name = timestampedImageName(input.mimeType, new Date());
      const directory = input.documentPath === null ? null : parentDirectoryOf(input.documentPath);
      const path = await save({
        defaultPath: directory ? `${directory}/${name}` : name,
        filters: [{ name: "Image", extensions: [input.mimeType === "image/png" ? "png" : "jpg"] }],
      });
      if (path === null) return null;
      try {
        await invoke("save_clipboard_image", { path, bytes: Array.from(input.bytes), mime_type: input.mimeType });
      } catch (error) { throw failure(error); }
      if (directory && path.startsWith(`${directory}/`)) return path.slice(directory.length + 1);
      return path;
    },
    async acquireDocumentScope(consumerId: string, path: string): Promise<void> {
      try { await invoke("acquire_document_scope", { consumer_id: consumerId, path }); } catch (error) { throw failure(error); }
    },
    async acquireWorkspaceScope(consumerId: string, root: string): Promise<void> {
      try { await invoke("acquire_workspace_scope", { consumer_id: consumerId, root }); } catch (error) { throw failure(error); }
    },
    async releaseAssetScope(consumerId: string): Promise<void> {
      try { await invoke("release_asset_scope", { consumer_id: consumerId }); } catch (error) { throw failure(error); }
    },
    async chooseWorkspace(): Promise<WorkspaceRoot | null> {
      try {
        const dto = await invoke<WorkspaceRootDto | null>("choose_workspace");
        return dto === null ? null : workspaceRoot(dto);
      } catch (error) { throw failure(error); }
    },
    async openWorkspacePath(path: string): Promise<WorkspaceRoot> {
      try { return workspaceRoot(await invoke<WorkspaceRootDto>("open_workspace", { root: path })); } catch (error) { throw failure(error); }
    },
    async listDirectory(root: string, relative: string): Promise<ReadonlyArray<DirectoryEntry>> {
      try { return (await invoke<DirectoryEntryDto[]>("list_directory", { root, relative })).map(directoryEntry); } catch (error) { throw failure(error); }
    },
    async createMarkdownFile(root: string, relative: string): Promise<DirectoryEntry> {
      try { return directoryEntry(await invoke<DirectoryEntryDto>("create_markdown_file", { root, relative })); } catch (error) { throw failure(error); }
    },
    async renameEntry(root: string, from: string, toName: string): Promise<DirectoryEntry> {
      try { return directoryEntry(await invoke<DirectoryEntryDto>("rename_entry", { root, from, to_name: toName })); } catch (error) { throw failure(error); }
    },
    async trashEntry(root: string, relative: string): Promise<void> {
      try { await invoke("trash_entry", { root, relative }); } catch (error) { throw failure(error); }
    },
    async watchDocument(consumerId: string, path: string): Promise<void> {
      try { await invoke("watch_document", { consumer_id: consumerId, path }); } catch (error) { throw failure(error); }
    },
    async watchWorkspace(consumerId: string, root: string): Promise<void> {
      try { await invoke("watch_workspace", { consumer_id: consumerId, root }); } catch (error) { throw failure(error); }
    },
    async unwatch(consumerId: string): Promise<void> {
      try { await invoke("unwatch", { consumer_id: consumerId }); } catch (error) { throw failure(error); }
    },
    subscribeToDiskEvents(handler: (event: DiskEvent) => void): Promise<() => void> {
      return listen<DiskEventDto>("document-disk-event", (event) => handler(diskEvent(event.payload)));
    },
    async listDrafts(): Promise<ReadonlyArray<RecoveryDraftInfo>> {
      try { return (await invoke<DraftInfoDto[]>("list_recovery_drafts")).map(draftInfo); } catch (error) { throw failure(error); }
    },
    async readDraft(draftId: string): Promise<RecoveryDraft> {
      try { return draft(await invoke<DraftDto>("read_recovery_draft", { draft_id: draftId })); } catch (error) { throw failure(error); }
    },
    async writeDraft(record: RecoveryDraft): Promise<RecoveryDraftInfo> {
      try {
        return draftInfo(await invoke<DraftInfoDto>("write_recovery_draft", {
          request: {
            draft_id: record.draftId,
            original_path: record.originalPath,
            title: record.title,
            text: record.text,
            has_utf8_bom: record.hasUtf8Bom,
            newline: record.newline,
            saved_text_hash: record.savedTextHash,
            saved_version: record.savedVersion,
          },
        }));
      } catch (error) { throw failure(error); }
    },
    async discardDraft(draftId: string): Promise<void> {
      try { await invoke("discard_recovery_draft", { draft_id: draftId }); } catch (error) { throw failure(error); }
    },
  };
}

export interface OpenPathSubscriptions {
  ready(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ImageDrop {
  readonly paths: ReadonlyArray<string>;
  readonly x: number;
  readonly y: number;
}

/**
 * Subscribes to natively dropped image files. Tauri 2 with the default
 * `dragDropEnabled: true` delivers drops only through the native window
 * event (see src-tauri/src/lib.rs); the webview never receives HTML5 drops
 * with real file paths, so image insertion is driven by this event.
 */
export async function subscribeToImageDrops(
  onImages: (drop: ImageDrop) => void,
  signal?: AbortSignal,
): Promise<UnlistenFn> {
  const unlisten = await listen<{ paths: string[]; x: number; y: number }>(
    "image-files-dropped",
    (event) => {
      // Native coordinates are physical pixels; the editor works in CSS pixels.
      const scale = window.devicePixelRatio || 1;
      onImages({
        paths: [...event.payload.paths],
        x: event.payload.x / scale,
        y: event.payload.y / scale,
      });
    },
  );
  if (signal?.aborted) {
    unlisten();
    return () => {};
  }
  return unlisten;
}

export async function subscribeToOpenPaths(port: DocumentPort, onFiles: (files: ReadonlyArray<OpenedFile>) => void, onDirectory: (path: string) => void = () => {}, onError: DocumentPortErrorHandler = () => {}, signal?: AbortSignal): Promise<OpenPathSubscriptions> {
  let isReady = false;
  let disposed = false;
  let generation = 0;
  type Payload = { files: string[]; directories: string[] };
  const queued: Payload[] = [];
  const inFlight = new Set<Promise<void>>();
  const active = (token: number) => !disposed && token === generation;
  const consumeReady = async (payload: Payload, token: number) => {
    const files: OpenedFile[] = [];
    for (const path of payload.directories) {
      if (!active(token)) return;
      try { onDirectory(path); } catch (error) { if (active(token)) report(onError, error, { path, source: "event" }); }
    }
    for (const path of payload.files) {
      if (!active(token)) return;
      try {
        const file = await port.openPath(path);
        if (!active(token)) return;
        files.push(file);
      } catch (error) {
        if (!active(token)) return;
        report(onError, error, { path, source: "event" });
      }
    }
    if (files.length && active(token)) {
      try { onFiles(files); } catch (error) { if (active(token)) report(onError, error, { path: files[0].path, source: "event" }); }
    }
  };
  const track = (operation: Promise<void>) => {
    inFlight.add(operation);
    void operation.then(() => inFlight.delete(operation), () => inFlight.delete(operation));
    return operation;
  };
  let pumpPromise: Promise<void> | null = null;
  const pump = (): Promise<void> => {
    if (pumpPromise) return pumpPromise;
    const token = generation;
    const operation = (async () => {
      while (active(token) && queued.length) {
        const payload = queued[0];
        await consumeReady(payload, token);
        if (active(token) && queued[0] === payload) queued.shift();
      }
    })();
    pumpPromise = track(operation);
    void operation.then(() => {
      if (pumpPromise === operation) pumpPromise = null;
      if (active(token) && queued.length) void pump();
    }, () => { if (pumpPromise === operation) pumpPromise = null; });
    return operation;
  };
  const receive = (payload: Payload) => {
    if (disposed) return;
    queued.push(payload);
    if (isReady) void pump();
  };
  const unlisten: UnlistenFn = await listen<Payload>("open-paths", event => receive(event.payload));
  if (signal?.aborted) {
    disposed = true;
    generation += 1;
    queued.length = 0;
    unlisten();
    return { async ready() {}, async dispose() {} };
  }
  try { await emit("frontend-ready"); } catch (error) { unlisten(); throw error; }
  let disposePromise: Promise<void> | null = null;
  return {
    async ready() {
      if (disposed) return;
      if (isReady) { await pump(); return; }
      isReady = true;
      await pump();
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true; generation += 1; queued.length = 0; unlisten();
      disposePromise = Promise.allSettled([...inFlight]).then(() => undefined);
      return disposePromise;
    },
  };
}
