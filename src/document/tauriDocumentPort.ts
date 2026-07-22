import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DocumentPort, DocumentPortErrorCode, SavedFile } from "./DocumentPort";
import { DocumentPortError } from "./DocumentPort";
import type { OpenedFile, PendingWriteRequest, SaveTarget } from "./types";

type OpenDto = { path: string; text: string; has_utf8_bom: boolean; newline: OpenedFile["newline"]; modified_unix_ms: number; version: string };
type SaveDto = { path: string; modified_unix_ms: number; version: string };
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

export function createTauriDocumentPort(): DocumentPort {
  const openPath = async (path: string) => {
    try { return opened(await invoke<OpenDto>("open_document", { path })); } catch (error) { throw failure(error); }
  };
  return {
    openPath,
    async chooseAndOpenFiles() {
      const selection = await open({ directory: false, multiple: true, filters: [{ name: "Markdown", extensions: ["md", "markdown"] }] });
      if (selection === null) return [];
      return Promise.all((Array.isArray(selection) ? selection : [selection]).map(openPath));
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
  };
}

export interface OpenPathSubscriptions {
  ready(): Promise<void>;
  dispose(): void;
}

export async function subscribeToOpenPaths(port: DocumentPort, onFiles: (files: ReadonlyArray<OpenedFile>) => void, onDirectory: (path: string) => void = () => {}): Promise<OpenPathSubscriptions> {
  let isReady = false;
  let disposed = false;
  const queued: string[][] = [];
  const consume = async (paths: string[]) => {
    if (disposed) return;
    if (!isReady) { queued.push(paths); return; }
    const markdown = paths.filter(path => /\.(?:md|markdown)$/i.test(path));
    paths.filter(path => !/\.(?:md|markdown)$/i.test(path)).forEach(onDirectory);
    if (markdown.length) onFiles(await Promise.all(markdown.map(path => port.openPath(path))));
  };
  const unlisten: UnlistenFn[] = [];
  unlisten.push(await listen<string[]>("open-paths", event => { void consume(event.payload); }));
  unlisten.push(await getCurrentWindow().onDragDropEvent(event => {
    if (event.payload.type === "drop") void consume(event.payload.paths);
  }));
  return {
    async ready() { isReady = true; for (const paths of queued.splice(0)) await consume(paths); },
    dispose() { disposed = true; queued.length = 0; unlisten.splice(0).forEach(fn => fn()); },
  };
}
