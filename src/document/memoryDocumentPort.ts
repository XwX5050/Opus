import {
  DocumentPortError,
  type DocumentPort,
  type SavedFile,
} from "./DocumentPort";
import type { DocumentSnapshot, OpenedFile } from "./types";

export interface MemoryDocumentPortOptions {
  readonly savePath?: string | null;
  readonly chosenPaths?: ReadonlyArray<string>;
}

const cloneOpenedFile = (file: OpenedFile): OpenedFile => ({ ...file });
const cloneSnapshot = (document: DocumentSnapshot): DocumentSnapshot => ({
  ...document,
  pendingSave: document.pendingSave ? { ...document.pendingSave } : undefined,
});

export class MemoryDocumentPort implements DocumentPort {
  readonly #files: Map<string, OpenedFile>;
  readonly #options: MemoryDocumentPortOptions;
  readonly #writes: DocumentSnapshot[] = [];
  #nextRevision = 1;

  constructor(
    files: Map<string, OpenedFile>,
    options: MemoryDocumentPortOptions = {},
  ) {
    this.#files = new Map(
      [...files].map(([path, file]) => [path, cloneOpenedFile(file)]),
    );
    this.#options = {
      ...options,
      chosenPaths: options.chosenPaths ? [...options.chosenPaths] : undefined,
    };
  }

  get writes(): ReadonlyArray<DocumentSnapshot> {
    return this.#writes.map(cloneSnapshot);
  }

  async chooseAndOpenFiles(): Promise<ReadonlyArray<OpenedFile>> {
    const paths = this.#options.chosenPaths ?? [...this.#files.keys()];
    return Promise.all(paths.map((path) => this.openPath(path)));
  }

  async openPath(path: string): Promise<OpenedFile> {
    const file = this.#files.get(path);
    if (!file) {
      throw new DocumentPortError("not_found", `Document not found: ${path}`);
    }
    return cloneOpenedFile(file);
  }

  async chooseSavePath(_suggestedName: string): Promise<string | null> {
    return this.#options.savePath ?? null;
  }

  async save(document: DocumentSnapshot): Promise<SavedFile> {
    if (document.path === null) {
      throw new DocumentPortError("io", "Cannot save a document without a path");
    }
    return this.#write(document.path, document, document.version);
  }

  async saveToPath(
    path: string,
    document: DocumentSnapshot,
    expectedVersion: string | null,
  ): Promise<SavedFile> {
    return this.#write(path, document, expectedVersion);
  }

  #write(
    path: string,
    document: DocumentSnapshot,
    expectedVersion: string | null,
  ): SavedFile {
    const existing = this.#files.get(path);
    if ((existing?.version ?? null) !== expectedVersion) {
      throw new DocumentPortError(
        "conflict",
        `Document version changed before save: ${path}`,
      );
    }

    const input = cloneSnapshot({ ...document, path });
    this.#writes.push(input);
    const modifiedUnixMs = (existing?.modifiedUnixMs ?? 0) + 1;
    let version: string;
    do {
      version = `memory-version-${this.#nextRevision}`;
      this.#nextRevision += 1;
    } while ([...this.#files.values()].some((file) => file.version === version));
    this.#files.set(path, {
      path,
      text: input.text,
      hasUtf8Bom: input.hasUtf8Bom,
      newline: input.newline,
      modifiedUnixMs,
      version,
    });
    return { path, modifiedUnixMs, version };
  }
}
