import {
  DocumentPortError,
  type DocumentPort,
  type SavedFile,
} from "./DocumentPort";
import { normalizePathKey } from "./documentReducer";
import type {
  OpenedFile,
  PathPlatform,
  PendingWriteRequest,
  SaveTarget,
} from "./types";

export interface MemoryDocumentPortOptions {
  readonly savePath?: string | null;
  readonly chosenPaths?: ReadonlyArray<string>;
  readonly pathPlatform?: PathPlatform;
}

const cloneOpenedFile = (file: OpenedFile): OpenedFile => ({ ...file });
const cloneRequest = (request: PendingWriteRequest): PendingWriteRequest =>
  Object.freeze({ ...request });

export class MemoryDocumentPort implements DocumentPort {
  readonly #files: Map<string, OpenedFile>;
  readonly #options: MemoryDocumentPortOptions;
  readonly #pathPlatform: PathPlatform;
  readonly #writes: PendingWriteRequest[] = [];
  #nextRevision = 1;

  constructor(
    files: Map<string, OpenedFile>,
    options: MemoryDocumentPortOptions = {},
  ) {
    this.#pathPlatform = options.pathPlatform ?? "macos";
    this.#files = new Map(
      [...files].map(([, file]) => [
        normalizePathKey(file.path, this.#pathPlatform),
        cloneOpenedFile(file),
      ]),
    );
    this.#options = {
      ...options,
      chosenPaths: options.chosenPaths ? [...options.chosenPaths] : undefined,
    };
  }

  get writes(): ReadonlyArray<PendingWriteRequest> {
    return this.#writes.map(cloneRequest);
  }

  async chooseAndOpenFiles(): Promise<ReadonlyArray<OpenedFile>> {
    const paths =
      this.#options.chosenPaths ??
      [...this.#files.values()].map((file) => file.path);
    return Promise.all(paths.map((path) => this.openPath(path)));
  }

  async openPath(path: string): Promise<OpenedFile> {
    const file = this.#files.get(normalizePathKey(path, this.#pathPlatform));
    if (!file) {
      throw new DocumentPortError("not_found", `Document not found: ${path}`);
    }
    return cloneOpenedFile(file);
  }

  async chooseSavePath(_suggestedName: string): Promise<SaveTarget | null> {
    const path = this.#options.savePath;
    if (path == null) return null;
    const existing = this.#files.get(
      normalizePathKey(path, this.#pathPlatform),
    );
    return Object.freeze({
      path,
      expectedVersion: existing?.version ?? null,
    });
  }

  async write(request: PendingWriteRequest): Promise<SavedFile> {
    const key = normalizePathKey(request.targetPath, this.#pathPlatform);
    const existing = this.#files.get(key);
    if ((existing?.version ?? null) !== request.expectedVersion) {
      throw new DocumentPortError(
        "conflict",
        `Document version changed before save: ${request.targetPath}`,
      );
    }

    const input = cloneRequest(request);
    this.#writes.push(input);
    const modifiedUnixMs = (existing?.modifiedUnixMs ?? 0) + 1;
    let version: string;
    do {
      version = `memory-version-${this.#nextRevision}`;
      this.#nextRevision += 1;
    } while ([...this.#files.values()].some((file) => file.version === version));
    const displayPath = existing?.path ?? request.targetPath;
    this.#files.set(key, {
      path: displayPath,
      text: input.text,
      hasUtf8Bom: input.hasUtf8Bom,
      newline: input.newline,
      modifiedUnixMs,
      version,
    });
    return { path: displayPath, modifiedUnixMs, version };
  }
}
