import {
  DocumentPortError,
  type DocumentPort,
  type SavedFile,
} from "./DocumentPort";
import type { DocumentSnapshot, OpenedFile } from "./types";

export interface MemoryDocumentPortOptions {
  saveAsPath?: string | null;
  chosenPaths?: string[];
}

const cloneOpenedFile = (file: OpenedFile): OpenedFile => ({ ...file });
const cloneSnapshot = (document: DocumentSnapshot): DocumentSnapshot => ({
  ...document,
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

  get writes(): DocumentSnapshot[] {
    return this.#writes.map(cloneSnapshot);
  }

  async chooseAndOpenFiles(): Promise<OpenedFile[]> {
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

  async save(document: DocumentSnapshot): Promise<SavedFile> {
    if (document.path === null) {
      throw new DocumentPortError("io", "Cannot save a document without a path");
    }
    return this.#write(document, document.path);
  }

  async saveAs(document: DocumentSnapshot): Promise<SavedFile | null> {
    const path = this.#options.saveAsPath;
    if (path == null) return null;
    return this.#write(document, path);
  }

  #write(document: DocumentSnapshot, path: string): SavedFile {
    const input = cloneSnapshot(document);
    this.#writes.push(input);

    const existing = this.#files.get(path);
    const modifiedUnixMs = (existing?.modifiedUnixMs ?? 0) + 1;
    const version = `memory-version-${this.#nextRevision}`;
    this.#nextRevision += 1;
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
