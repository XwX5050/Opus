import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  };
}

export interface OpenPathSubscriptions {
  ready(): Promise<void>;
  dispose(): Promise<void>;
}

export async function subscribeToOpenPaths(port: DocumentPort, onFiles: (files: ReadonlyArray<OpenedFile>) => void, onDirectory: (path: string) => void = () => {}, onError: DocumentPortErrorHandler = () => {}): Promise<OpenPathSubscriptions> {
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
