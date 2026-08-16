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
  DiskEvent,
  OpenedFile,
  PathPlatform,
  PendingWriteRequest,
  PersistedSession,
  RecoveryDraft,
  RecoveryDraftInfo,
  SaveTarget,
} from "./types";
import type { TranslationSettings } from "../translate/types";

export interface MemoryDocumentPortOptions {
  readonly savePath?: string | null;
  readonly chosenPaths?: ReadonlyArray<string>;
  readonly pathPlatform?: PathPlatform;
  readonly clipboardImagePath?: string | null;
  readonly workspace?: WorkspaceRoot | null;
  readonly directories?: ReadonlyArray<string>;
  /** Pre-seeded recovery drafts, as if left behind by a crashed session. */
  readonly drafts?: ReadonlyArray<RecoveryDraft>;
  /** Pre-seeded session, as if persisted by a previous run. */
  readonly session?: PersistedSession | null;
}

export type MemoryScopeCall =
  | { readonly kind: "document"; readonly consumerId: string; readonly path: string }
  | { readonly kind: "workspace"; readonly consumerId: string; readonly root: string }
  | { readonly kind: "release"; readonly consumerId: string };

export type MemoryWatchCall =
  | { readonly kind: "document"; readonly consumerId: string; readonly path: string }
  | { readonly kind: "workspace"; readonly consumerId: string; readonly root: string }
  | { readonly kind: "unwatch"; readonly consumerId: string };

export interface MemoryClipboardImageSave {
  readonly bytes: Uint8Array;
  readonly mimeType: ClipboardImageInput["mimeType"];
  readonly documentPath: string | null;
}

/**
 * Fixed model ids served by `listTranslationModels` for the in-memory port.
 * Deliberately unsorted so callers that sort for display (the settings
 * dialog) are exercised, mirroring a real endpoint responding out of order.
 */
const MEMORY_TRANSLATION_MODELS: readonly string[] = ["gpt-4o-mini", "gpt-4o"];

const cloneOpenedFile = (file: OpenedFile): OpenedFile => ({ ...file });

/**
 * Pseudo-translation for the in-memory port: ASCII letters become their
 * full-width forms so translated segments are visually distinct in the demo
 * and detectable in tests. Unlike a marker prefix, this preserves the
 * Markdown structure exactly (heading/list markers stay at line start) and
 * adds no characters, mirroring what a real model is instructed to return.
 */
export const pseudoTranslate = (segment: string): string =>
  segment.replace(/[A-Za-z]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) + 0xfee0),
  );
const cloneRequest = (request: PendingWriteRequest): PendingWriteRequest =>
  Object.freeze({ ...request });
const cloneSession = (session: PersistedSession): PersistedSession => ({
  recent: session.recent.map((item) => ({ ...item })),
  openPaths: [...session.openPaths],
  activePath: session.activePath,
  workspacePath: session.workspacePath,
  ...(session.theme !== undefined ? { theme: session.theme } : {}),
  ...(session.editorPreferences !== undefined
    ? { editorPreferences: { ...session.editorPreferences } }
    : {}),
  ...(session.sidebar !== undefined ? { sidebar: { ...session.sidebar } } : {}),
  ...(session.outline !== undefined ? { outline: { ...session.outline } } : {}),
  ...(session.translationSettings !== undefined
    ? { translationSettings: { ...session.translationSettings } }
    : {}),
});
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
  readonly #watchCalls: MemoryWatchCall[] = [];
  readonly #drafts = new Map<string, { record: RecoveryDraft; updatedUnixMs: number }>();
  readonly #diskHandlers = new Set<(event: DiskEvent) => void>();
  readonly #closeHandlers = new Set<() => void | Promise<void>>();
  #session: PersistedSession | null;
  #nextRevision = 1;
  #nextDraftStamp = 1;
  /** Fake-translation cache keyed by settings + requested segment text. */
  readonly #translationCache = new Map<string, string[]>();
  #translationCallCount = 0;
  #translationRequestedSegments = 0;
  /** Recorded listTranslationModels calls, in order. */
  readonly #translationModelCalls: { endpoint: string; apiKey: string }[] = [];

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
      workspace: options.workspace ? { ...options.workspace } : undefined,
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
    for (const draft of options.drafts ?? []) {
      this.#drafts.set(draft.draftId, {
        record: { ...draft },
        updatedUnixMs: this.#nextDraftStamp++,
      });
    }
    this.#session = options.session ? cloneSession(options.session) : null;
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

  /** Number of translateSegments calls that produced new (uncached) work. */
  get translationCallCount(): number {
    return this.#translationCallCount;
  }

  /** Total segments sent for new (uncached) translation work. */
  get translationRequestedSegments(): number {
    return this.#translationRequestedSegments;
  }

  /** Recorded listTranslationModels calls (endpoint, api key), in order. */
  get translationModelCalls(): ReadonlyArray<{ endpoint: string; apiKey: string }> {
    return this.#translationModelCalls.map((call) => ({ ...call }));
  }

  async chooseAndOpenFiles(): Promise<ReadonlyArray<OpenedFile>> {
    const paths =
      this.#options.chosenPaths ??
      [...this.#files.values()].map((file) => file.path);
    // Mirror the real port's report-and-continue: a missing path must not
    // fail the whole dialog, only that one file.
    const results = await Promise.allSettled(
      paths.map((path) => this.openPath(path)),
    );
    return results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
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

  async translateSegments(
    settings: TranslationSettings,
    segments: string[],
  ): Promise<string[]> {
    const cacheKey =
      `${settings.model}\u0000${settings.targetLanguage}\u0000` +
      segments.join("\u0000");
    const cached = this.#translationCache.get(cacheKey);
    if (cached) return [...cached];
    const translated = segments.map(pseudoTranslate);
    this.#translationCache.set(cacheKey, translated);
    this.#translationCallCount += 1;
    this.#translationRequestedSegments += segments.length;
    return [...translated];
  }

  async listTranslationModels(
    endpoint: string,
    apiKey: string,
  ): Promise<string[]> {
    this.#translationModelCalls.push({ endpoint, apiKey });
    return [...MEMORY_TRANSLATION_MODELS];
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
    return this.#options.workspace ? { ...this.#options.workspace } : null;
  }

  async openWorkspacePath(path: string): Promise<WorkspaceRoot> {
    const directory = this.#directories.get(this.#key(path));
    if (!directory) {
      throw new DocumentPortError("not_found", `Workspace not found: ${path}`);
    }
    const name = directory.split("/").at(-1) ?? directory;
    return { path: directory, title: name };
  }

  /** No-op: the in-memory port has no backend workspace anchor to clear. */
  async closeWorkspace(): Promise<void> {}

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
      // The real backend skips every hidden entry (any name starting with
      // ".") when listing a directory.
      if (segment.startsWith(".")) return;
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
    // The real backend's create_new refuses the target whether an existing
    // entry there is a file or a directory.
    if (
      this.#files.has(this.#key(path)) ||
      this.#directories.has(this.#key(path))
    ) {
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
      // As in the real backend, a Markdown file cannot be renamed out of its
      // extension, the target must not collide with a file or a directory,
      // and renaming to the current name succeeds as a no-op.
      if (!/\.(md|markdown)$/i.test(toName)) {
        throw new DocumentPortError(
          "io",
          `Files must keep a .md or .markdown extension: ${toPath}`,
        );
      }
      if (
        toPath !== fromPath &&
        (this.#files.has(this.#key(toPath)) ||
          this.#directories.has(this.#key(toPath)))
      ) {
        throw new DocumentPortError("conflict", `Already exists: ${toPath}`);
      }
      if (toPath === fromPath) {
        return { name: toName, path: toPath, isDirectory: false };
      }
      this.#files.delete(this.#key(fromPath));
      this.#files.set(this.#key(toPath), { ...file, path: toPath });
      return { name: toName, path: toPath, isDirectory: false };
    }
    const directory = this.#directories.get(this.#key(fromPath));
    if (!directory) {
      throw new DocumentPortError("not_found", `Entry not found: ${fromPath}`);
    }
    if (toPath === fromPath) {
      return { name: toName, path: toPath, isDirectory: true };
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
    if (!directory) {
      throw new DocumentPortError("not_found", `Entry not found: ${path}`);
    }
    // The workspace root itself is never a valid trash target; the real
    // backend rejects it as OutsideRoot, which maps to permission_denied.
    if (this.#key(directory) === this.#key(root)) {
      throw new DocumentPortError(
        "permission_denied",
        `The workspace root cannot be trashed: ${path}`,
      );
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

  get watchCalls(): ReadonlyArray<MemoryWatchCall> {
    return this.#watchCalls.map((call) => ({ ...call }));
  }

  async watchDocument(consumerId: string, path: string): Promise<void> {
    this.#watchCalls.push({ kind: "document", consumerId, path });
  }

  async watchWorkspace(consumerId: string, root: string): Promise<void> {
    this.#watchCalls.push({ kind: "workspace", consumerId, root });
  }

  async unwatch(consumerId: string): Promise<void> {
    this.#watchCalls.push({ kind: "unwatch", consumerId });
  }

  async subscribeToDiskEvents(
    handler: (event: DiskEvent) => void,
  ): Promise<() => void> {
    this.#diskHandlers.add(handler);
    return () => {
      this.#diskHandlers.delete(handler);
    };
  }

  /** Test hook: delivers a scripted disk event to all subscribers. */
  emitDiskEvent(event: DiskEvent): void {
    for (const handler of [...this.#diskHandlers]) handler({ ...event });
  }

  /** Test hook: rewrites a stored file as an external process would. */
  updateFile(path: string, text: string, version: string, modifiedUnixMs = 0): void {
    const key = this.#key(path);
    const existing = this.#files.get(key);
    if (!existing) {
      throw new DocumentPortError("not_found", `Document not found: ${path}`);
    }
    this.#files.set(key, { ...existing, text, version, modifiedUnixMs });
  }

  /** Test hook: deletes a stored file as an external process would. */
  removeFile(path: string): void {
    if (!this.#files.delete(this.#key(path))) {
      throw new DocumentPortError("not_found", `Document not found: ${path}`);
    }
  }

  get drafts(): ReadonlyArray<RecoveryDraft> {
    return [...this.#drafts.values()].map((entry) => ({ ...entry.record }));
  }

  async listDrafts(): Promise<ReadonlyArray<RecoveryDraftInfo>> {
    return [...this.#drafts.values()]
      .map((entry) => this.#info(entry))
      .sort((a, b) => a.draftId.localeCompare(b.draftId));
  }

  async readDraft(draftId: string): Promise<RecoveryDraft> {
    const entry = this.#drafts.get(draftId);
    if (!entry) {
      throw new DocumentPortError("not_found", `No recovery draft: ${draftId}`);
    }
    return { ...entry.record };
  }

  async writeDraft(draft: RecoveryDraft): Promise<RecoveryDraftInfo> {
    const entry = {
      record: { ...draft },
      updatedUnixMs: this.#nextDraftStamp++,
    };
    this.#drafts.set(entry.record.draftId, entry);
    return this.#info(entry);
  }

  async discardDraft(draftId: string): Promise<void> {
    if (!this.#drafts.delete(draftId)) {
      throw new DocumentPortError("not_found", `No recovery draft: ${draftId}`);
    }
  }

  #info(entry: {
    record: RecoveryDraft;
    updatedUnixMs: number;
  }): RecoveryDraftInfo {
    return {
      draftId: entry.record.draftId,
      originalPath: entry.record.originalPath,
      title: entry.record.title,
      savedTextHash: entry.record.savedTextHash,
      savedVersion: entry.record.savedVersion,
      updatedUnixMs: entry.updatedUnixMs,
    };
  }

  get session(): PersistedSession | null {
    return this.#session ? cloneSession(this.#session) : null;
  }

  async loadSession(): Promise<PersistedSession | null> {
    return this.session;
  }

  async saveSession(session: PersistedSession): Promise<void> {
    this.#session = cloneSession(session);
  }

  /**
   * The in-memory port stores sessions synchronously on saveSession, so a
   * flush has nothing to defer; this no-op exists to honor the contract.
   */
  async flushSession(): Promise<void> {}

  async onCloseRequested(
    handler: () => void | Promise<void>,
  ): Promise<() => void> {
    this.#closeHandlers.add(handler);
    return () => {
      this.#closeHandlers.delete(handler);
    };
  }

  /** Test hook: runs every registered close-requested handler in order. */
  async emitCloseRequested(): Promise<void> {
    for (const handler of [...this.#closeHandlers]) await handler();
  }
}
