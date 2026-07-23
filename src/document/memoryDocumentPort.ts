import {
  DocumentPortError,
  type ClipboardImageInput,
  type DirectoryEntry,
  type DocumentPort,
  type SavedFile,
  type WorkspaceRoot,
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
  readonly clipboardImagePath?: string | null;
  readonly workspace?: WorkspaceRoot | null;
  readonly directories?: ReadonlyArray<string>;
}

export type MemoryScopeCall =
  | { readonly kind: "document"; readonly consumerId: string; readonly path: string }
  | { readonly kind: "workspace"; readonly consumerId: string; readonly root: string }
  | { readonly kind: "release"; readonly consumerId: string };

export interface MemoryClipboardImageSave {
  readonly bytes: Uint8Array;
  readonly mimeType: ClipboardImageInput["mimeType"];
  readonly documentPath: string | null;
}

const cloneOpenedFile = (file: OpenedFile): OpenedFile => ({ ...file });
const cloneRequest = (request: PendingWriteRequest): PendingWriteRequest =>
  Object.freeze({ ...request });
const cloneImageSave = (save: MemoryClipboardImageSave): MemoryClipboardImageSave => ({
  bytes: new Uint8Array(save.bytes),
  mimeType: save.mimeType,
  documentPath: save.documentPath,
});

export class MemoryDocumentPort implements DocumentPort {
  readonly #files: Map<string, OpenedFile>;
  readonly #options: MemoryDocumentPortOptions;
  readonly #pathPlatform: PathPlatform;
  readonly #writes: PendingWriteRequest[] = [];
  readonly #clipboardImageSaves: MemoryClipboardImageSave[] = [];
  readonly #scopeCalls: MemoryScopeCall[] = [];
  readonly #directories = new Map<string, string>();
  readonly #listCalls: { root: string; relative: string }[] = [];
  #nextRevision = 1;

  /** When set, trashEntry rejects with this error instead of deleting. */
  trashFailure: DocumentPortError | null = null;
  /** When set, listDirectory rejects with this error instead of listing. */
  listFailure: DocumentPortError | null = null;

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
    for (const directory of options.directories ?? []) {
      this.#directories.set(this.#key(directory), directory);
      this.#registerAncestors(directory);
    }
    if (options.workspace) {
      this.#directories.set(
        this.#key(options.workspace.path),
        options.workspace.path,
      );
      this.#registerAncestors(options.workspace.path);
    }
    for (const file of this.#files.values()) {
      this.#registerAncestors(file.path);
    }
  }

  #key(path: string): string {
    return normalizePathKey(path, this.#pathPlatform);
  }

  #registerAncestors(path: string): void {
    let index = path.indexOf("/", 1);
    while (index !== -1) {
      const ancestor = path.slice(0, index);
      if (!this.#directories.has(this.#key(ancestor))) {
        this.#directories.set(this.#key(ancestor), ancestor);
      }
      index = path.indexOf("/", index + 1);
    }
  }

  get writes(): ReadonlyArray<PendingWriteRequest> {
    return this.#writes.map(cloneRequest);
  }

  get clipboardImageSaves(): ReadonlyArray<MemoryClipboardImageSave> {
    return this.#clipboardImageSaves.map(cloneImageSave);
  }

  get scopeCalls(): ReadonlyArray<MemoryScopeCall> {
    return this.#scopeCalls.map((call) => ({ ...call }));
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

  async saveClipboardImage(input: ClipboardImageInput): Promise<string | null> {
    this.#clipboardImageSaves.push(
      cloneImageSave({
        bytes: input.bytes,
        mimeType: input.mimeType,
        documentPath: input.documentPath,
      }),
    );
    return this.#options.clipboardImagePath ?? null;
  }

  async acquireDocumentScope(consumerId: string, path: string): Promise<void> {
    this.#scopeCalls.push({ kind: "document", consumerId, path });
  }

  async acquireWorkspaceScope(consumerId: string, root: string): Promise<void> {
    this.#scopeCalls.push({ kind: "workspace", consumerId, root });
  }

  async releaseAssetScope(consumerId: string): Promise<void> {
    this.#scopeCalls.push({ kind: "release", consumerId });
  }

  get listCalls(): ReadonlyArray<{ root: string; relative: string }> {
    return this.#listCalls.map((call) => ({ ...call }));
  }

  async chooseWorkspace(): Promise<WorkspaceRoot | null> {
    return this.#options.workspace ?? null;
  }

  async openWorkspacePath(path: string): Promise<WorkspaceRoot> {
    const directory = this.#directories.get(this.#key(path));
    if (!directory) {
      throw new DocumentPortError("not_found", `Workspace not found: ${path}`);
    }
    const name = directory.split("/").at(-1) ?? directory;
    return { path: directory, title: name };
  }

  #resolveDirectory(root: string, relative: string): string {
    if (!relative && !this.#directories.has(this.#key(root))) {
      throw new DocumentPortError("not_found", `Workspace not found: ${root}`);
    }
    const path = relative ? `${root}/${relative}` : root;
    const directory = this.#directories.get(this.#key(path));
    if (!directory) {
      throw new DocumentPortError("not_found", `Directory not found: ${path}`);
    }
    const rootKey = this.#key(root);
    const directoryKey = this.#key(directory);
    if (directoryKey !== rootKey && !directoryKey.startsWith(`${rootKey}/`)) {
      throw new DocumentPortError(
        "permission_denied",
        `Directory escapes the workspace root: ${path}`,
      );
    }
    return directory;
  }

  async listDirectory(
    root: string,
    relative: string,
  ): Promise<ReadonlyArray<DirectoryEntry>> {
    this.#listCalls.push({ root, relative });
    if (this.listFailure) throw this.listFailure;
    const directory = this.#resolveDirectory(root, relative);
    const prefix = `${this.#key(directory)}/`;
    const directories = new Map<string, string>();
    const files: DirectoryEntry[] = [];
    const visit = (path: string, isDirectory: boolean) => {
      const key = this.#key(path);
      if (key === this.#key(directory) || !key.startsWith(prefix)) return;
      const rest = path.slice(directory.length + 1);
      const segment = rest.split("/")[0];
      if (rest.includes("/")) {
        const childPath = `${directory}/${segment}`;
        if (!directories.has(this.#key(childPath))) {
          directories.set(this.#key(childPath), childPath);
        }
      } else if (isDirectory) {
        if (!directories.has(key)) directories.set(key, path);
      } else if (/\.(md|markdown)$/i.test(segment)) {
        files.push({ name: segment, path, isDirectory: false });
      }
    };
    for (const path of this.#directories.values()) visit(path, true);
    for (const file of this.#files.values()) visit(file.path, false);
    const byName = (a: { name: string }, b: { name: string }) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
      a.name.localeCompare(b.name);
    const directoryEntries = [...directories.values()]
      .map((path) => ({
        name: path.split("/").at(-1) ?? path,
        path,
        isDirectory: true,
      }))
      .sort(byName);
    return [...directoryEntries, ...files.sort(byName)];
  }

  async createMarkdownFile(
    root: string,
    relative: string,
  ): Promise<DirectoryEntry> {
    if (!/\.(md|markdown)$/i.test(relative)) {
      throw new DocumentPortError(
        "io",
        `New files must have a .md or .markdown extension: ${relative}`,
      );
    }
    const parentRelative = relative.includes("/")
      ? relative.slice(0, relative.lastIndexOf("/"))
      : "";
    const parent = this.#resolveDirectory(root, parentRelative);
    const name = relative.split("/").at(-1) ?? relative;
    const path = `${parent}/${name}`;
    if (this.#files.has(this.#key(path))) {
      throw new DocumentPortError("conflict", `Already exists: ${path}`);
    }
    this.#files.set(this.#key(path), {
      path,
      text: "",
      hasUtf8Bom: false,
      newline: "lf",
      modifiedUnixMs: 0,
      version: `memory-version-${this.#nextRevision++}`,
    });
    return { name, path, isDirectory: false };
  }

  async renameEntry(
    root: string,
    from: string,
    toName: string,
  ): Promise<DirectoryEntry> {
    if (!toName || toName.includes("/") || toName.startsWith(".")) {
      throw new DocumentPortError("io", `Invalid entry name: ${toName}`);
    }
    const fromPath = this.#resolvePathIn(root, from);
    const parent = fromPath.slice(0, fromPath.length - fromPath.split("/").at(-1)!.length);
    const toPath = `${parent}${toName}`;
    const file = this.#files.get(this.#key(fromPath));
    if (file) {
      if (this.#files.has(this.#key(toPath))) {
        throw new DocumentPortError("conflict", `Already exists: ${toPath}`);
      }
      this.#files.delete(this.#key(fromPath));
      this.#files.set(this.#key(toPath), { ...file, path: toPath });
      return { name: toName, path: toPath, isDirectory: false };
    }
    const directory = this.#directories.get(this.#key(fromPath));
    if (!directory) {
      throw new DocumentPortError("not_found", `Entry not found: ${fromPath}`);
    }
    if (
      this.#directories.has(this.#key(toPath)) ||
      this.#files.has(this.#key(toPath))
    ) {
      throw new DocumentPortError("conflict", `Already exists: ${toPath}`);
    }
    const oldPrefix = `${directory}/`;
    const moves: [string, string][] = [];
    for (const [key, path] of this.#directories) {
      if (path === directory || path.startsWith(oldPrefix)) {
        moves.push([key, toPath + path.slice(directory.length)]);
      }
    }
    for (const [key] of moves) this.#directories.delete(key);
    for (const [, path] of moves) this.#directories.set(this.#key(path), path);
    for (const [key, entry] of [...this.#files]) {
      if (entry.path.startsWith(oldPrefix)) {
        this.#files.delete(key);
        const moved = toPath + entry.path.slice(directory.length);
        this.#files.set(this.#key(moved), { ...entry, path: moved });
      }
    }
    return { name: toName, path: toPath, isDirectory: true };
  }

  async trashEntry(root: string, relative: string): Promise<void> {
    const path = this.#resolvePathIn(root, relative);
    if (this.trashFailure) throw this.trashFailure;
    const file = this.#files.get(this.#key(path));
    if (file) {
      this.#files.delete(this.#key(path));
      return;
    }
    const directory = this.#directories.get(this.#key(path));
    if (!directory || directory === root) {
      throw new DocumentPortError("not_found", `Entry not found: ${path}`);
    }
    const oldPrefix = `${directory}/`;
    for (const [key, candidate] of [...this.#directories]) {
      if (candidate === directory || candidate.startsWith(oldPrefix)) {
        this.#directories.delete(key);
      }
    }
    for (const [key, entry] of [...this.#files]) {
      if (entry.path.startsWith(oldPrefix)) this.#files.delete(key);
    }
  }

  #resolvePathIn(root: string, relative: string): string {
    if (!relative || relative.startsWith("/") || relative.split("/").includes("..")) {
      throw new DocumentPortError(
        "permission_denied",
        `Entry escapes the workspace root: ${relative}`,
      );
    }
    if (!this.#directories.has(this.#key(root))) {
      throw new DocumentPortError("not_found", `Workspace not found: ${root}`);
    }
    return `${root}/${relative}`;
  }
}
