import type { DocumentPortError, SavedFile } from "./DocumentPort";
import type {
  DocumentSnapshot,
  DocumentState,
  OpenedFile,
  PathPlatform,
  PendingWriteRequest,
  RecoveryDraft,
  SaveTarget,
} from "./types";

export type DocumentAction =
  | { type: "newDocument"; id: string; title?: string }
  | {
      type: "fileOpened";
      id: string;
      file: OpenedFile;
      pathPlatform?: PathPlatform;
    }
  | { type: "activate"; id: string }
  | { type: "textChanged"; id: string; text: string }
  | {
      type: "saveRequested";
      id: string;
      target?: SaveTarget;
      pathPlatform?: PathPlatform;
    }
  | {
      type: "saveSucceeded";
      requestId: string;
      result: SavedFile;
    }
  | { type: "saveFailed"; requestId: string; error: DocumentPortError }
  | { type: "saveCancelled"; requestId: string }
  | {
      type: "externalConflict";
      id: string;
      modifiedUnixMs: number;
      version: string;
    }
  | { type: "externalMissing"; id: string }
  | { type: "externalChanged"; id: string; file: OpenedFile }
  | {
      type: "externalMoved";
      from: string;
      to: string;
      pathPlatform?: PathPlatform;
    }
  | {
      type: "documentRestored";
      id: string;
      draft: RecoveryDraft;
      pathPlatform?: PathPlatform;
    }
  | { type: "diskVersionLoaded"; id: string; file: OpenedFile }
  | { type: "conflictKeptLocal"; id: string }
  | {
      type: "closeConfirmed";
      id: string;
      disposition: "saved" | "discarded";
      pathPlatform?: PathPlatform;
    }
  | { type: "reopenLastClosed"; pathPlatform?: PathPlatform };

export const initialDocumentState: DocumentState = {
  tabs: [],
  activeId: null,
  recentlyClosed: [],
  nextSaveSequence: 0,
};

const collapseSegments = (
  path: string,
  separator: "/" | "\\",
  rooted: boolean,
): string => {
  const segments = path.split(separator);
  const collapsed: string[] = [];

  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && collapsed.length > 0 && collapsed.at(-1) !== "..") {
      collapsed.pop();
    } else if (segment !== ".." || !rooted) {
      collapsed.push(segment);
    }
  }

  return collapsed.join(separator);
};

const normalizePosixPath = (path: string): string => {
  const rooted = path.startsWith("/");
  const collapsed = collapseSegments(path, "/", rooted);
  return rooted ? `/${collapsed}` : collapsed;
};

const normalizeWindowsPath = (path: string): string => {
  const windowsPath = path.replaceAll("/", "\\");
  const lower = (value: string) => value.toLocaleLowerCase("en-US");

  if (windowsPath.startsWith("\\\\?\\") || windowsPath.startsWith("\\\\.\\")) {
    return lower(windowsPath);
  }

  if (windowsPath.startsWith("\\\\")) {
    const parts = windowsPath.slice(2).split("\\").filter(Boolean);
    const server = parts.shift() ?? "";
    const share = parts.shift() ?? "";
    const root = `\\\\${server}\\${share}`;
    const tail = collapseSegments(parts.join("\\"), "\\", true);
    return lower(tail ? `${root}\\${tail}` : root);
  }

  const drive = windowsPath.match(/^([A-Za-z]):(.*)$/);
  if (drive) {
    const drivePrefix = `${lower(drive[1])}:`;
    const absolute = drive[2].startsWith("\\");
    const tail = collapseSegments(drive[2], "\\", absolute);
    return lower(
      absolute ? `${drivePrefix}\\${tail}` : `${drivePrefix}${tail}`,
    );
  }

  const rooted = windowsPath.startsWith("\\");
  const tail = collapseSegments(windowsPath, "\\", rooted);
  return lower(rooted ? `\\${tail}` : tail);
};

/**
 * Produces a lexical key only; it never accesses the file system.
 * Linux remains case-sensitive and treats backslash as a normal character.
 * macOS uses the common case-insensitive volume policy. Windows accepts both
 * separators and is case-insensitive. Callers can select Linux for a
 * case-sensitive macOS volume when exact path semantics are known.
 */
export const normalizePathKey = (
  path: string,
  platform: PathPlatform = "macos",
): string => {
  if (platform === "linux") return normalizePosixPath(path);
  if (platform === "windows") return normalizeWindowsPath(path);

  return normalizePosixPath(path.normalize("NFC")).toLocaleLowerCase("en-US");
};

const titleFromPath = (path: string): string => {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
};

const snapshotFromFile = (id: string, file: OpenedFile): DocumentSnapshot => ({
  id,
  path: file.path,
  title: titleFromPath(file.path),
  text: file.text,
  savedText: file.text,
  hasUtf8Bom: file.hasUtf8Bom,
  newline: file.newline,
  modifiedUnixMs: file.modifiedUnixMs,
  version: file.version,
  status: "clean",
});

const replaceTab = (
  state: DocumentState,
  id: string,
  update: (document: DocumentSnapshot) => DocumentSnapshot,
): DocumentState => {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== id) return tab;
    changed = true;
    return update(tab);
  });
  return changed ? { ...state, tabs } : state;
};

const discardedSnapshot = (document: DocumentSnapshot): DocumentSnapshot => ({
  ...document,
  text: document.savedText,
  status: "clean",
  pendingSave: undefined,
});

const cloneSnapshot = (document: DocumentSnapshot): DocumentSnapshot => ({
  ...document,
  pendingSave: undefined,
});

const assertNever = (action: never): never => {
  throw new Error(`Unhandled document action: ${JSON.stringify(action)}`);
};

export const documentReducer = (
  state: DocumentState,
  action: DocumentAction,
): DocumentState => {
  switch (action.type) {
    case "newDocument": {
      if (state.tabs.some((tab) => tab.id === action.id)) {
        return { ...state, activeId: action.id };
      }
      const document: DocumentSnapshot = {
        id: action.id,
        path: null,
        title: action.title ?? "Untitled",
        text: "",
        savedText: "",
        hasUtf8Bom: false,
        newline: "lf",
        modifiedUnixMs: null,
        version: null,
        status: "clean",
      };
      return { ...state, tabs: [...state.tabs, document], activeId: action.id };
    }

    case "fileOpened": {
      const sameId = state.tabs.find((tab) => tab.id === action.id);
      if (sameId) return { ...state, activeId: sameId.id };

      const platform = action.pathPlatform ?? "macos";
      const key = normalizePathKey(action.file.path, platform);
      const existing = state.tabs.find(
        (tab) => tab.path !== null && normalizePathKey(tab.path, platform) === key,
      );
      if (existing) return { ...state, activeId: existing.id };
      return {
        ...state,
        tabs: [...state.tabs, snapshotFromFile(action.id, action.file)],
        activeId: action.id,
      };
    }

    case "activate":
      return state.tabs.some((tab) => tab.id === action.id)
        ? { ...state, activeId: action.id }
        : state;

    case "textChanged":
      return replaceTab(state, action.id, (document) => ({
        ...document,
        text: action.text,
        status:
          document.status === "conflict" || document.status === "missing"
            ? document.status
            : action.text === document.savedText
              ? "clean"
              : "dirty",
      }));

    case "saveRequested": {
      const document = state.tabs.find((tab) => tab.id === action.id);
      if (!document) return state;

      const target =
        action.target ??
        (document.path === null
          ? null
          : { path: document.path, expectedVersion: document.version });
      if (!target) return state;

      const platform = action.pathPlatform ?? "macos";
      const targetKey = normalizePathKey(target.path, platform);
      const collision = state.tabs.some(
        (tab) =>
          tab.id !== document.id &&
          tab.path !== null &&
          normalizePathKey(tab.path, platform) === targetKey,
      );
      if (collision) {
        return replaceTab(state, document.id, (tab) => ({
          ...tab,
          status: "conflict",
        }));
      }

      const nextSaveSequence = state.nextSaveSequence + 1;
      const pendingSave: PendingWriteRequest = Object.freeze({
        requestId: `save-${nextSaveSequence}`,
        documentId: document.id,
        targetPath: target.path,
        text: document.text,
        hasUtf8Bom: document.hasUtf8Bom,
        newline: document.newline,
        expectedVersion: target.expectedVersion,
        pathPlatform: platform,
      });
      const withPending = replaceTab(state, document.id, (tab) => ({
        ...tab,
        pendingSave,
      }));
      return { ...withPending, nextSaveSequence };
    }

    case "saveSucceeded": {
      const document = state.tabs.find(
        (tab) => tab.pendingSave?.requestId === action.requestId,
      );
      if (!document) {
        return state;
      }
      const pendingSave = document.pendingSave;
      if (!pendingSave) return state;

      const platform = pendingSave.pathPlatform;
      const resultKey = normalizePathKey(action.result.path, platform);
      const targetMismatch =
        normalizePathKey(pendingSave.targetPath, platform) !== resultKey;
      const collides = state.tabs.some(
        (tab) =>
          tab.id !== document.id &&
          tab.path !== null &&
          normalizePathKey(tab.path, platform) === resultKey,
      );
      if (targetMismatch || collides) {
        return {
          ...state,
          tabs: state.tabs.map((tab) => {
            const isSource = tab.id === document.id;
            const isTarget =
              tab.id !== document.id &&
              tab.path !== null &&
              normalizePathKey(tab.path, platform) === resultKey;
            if (!isSource && !isTarget) return tab;
            return {
              ...tab,
              status: "conflict",
              pendingSave: isSource ? undefined : tab.pendingSave,
            };
          }),
        };
      }

      const savedText = pendingSave.text;
      return replaceTab(state, document.id, (tab) => ({
        ...tab,
        path: action.result.path,
        title: titleFromPath(action.result.path),
        savedText,
        modifiedUnixMs: action.result.modifiedUnixMs,
        version: action.result.version,
        status: tab.text === savedText ? "clean" : "dirty",
        pendingSave: undefined,
      }));
    }

    case "saveFailed":
    case "saveCancelled": {
      const document = state.tabs.find(
        (tab) => tab.pendingSave?.requestId === action.requestId,
      );
      if (!document) return state;
      return replaceTab(state, document.id, (tab) => ({
        ...tab,
        pendingSave: undefined,
      }));
    }

    case "externalConflict":
      return replaceTab(state, action.id, (document) => ({
        ...document,
        modifiedUnixMs: action.modifiedUnixMs,
        version: action.version,
        status: "conflict",
      }));

    case "externalMissing":
      return replaceTab(state, action.id, (document) => ({
        ...document,
        status: "missing",
      }));

    case "externalChanged":
      return replaceTab(state, action.id, (document) => {
        // A clean tab with no write in flight follows the disk; anything else
        // keeps the local buffer and surfaces a conflict. The decision is made
        // here, atomically, so edits racing the reload are never overwritten.
        if (document.status === "clean" && !document.pendingSave) {
          return snapshotFromFile(document.id, action.file);
        }
        return {
          ...document,
          modifiedUnixMs: action.file.modifiedUnixMs,
          version: action.file.version,
          status: "conflict",
        };
      });

    case "externalMoved": {
      const platform = action.pathPlatform ?? "macos";
      const fromKey = normalizePathKey(action.from, platform);
      const toKey = normalizePathKey(action.to, platform);
      if (fromKey === toKey) return state;
      const tab = state.tabs.find(
        (candidate) =>
          candidate.path !== null &&
          normalizePathKey(candidate.path, platform) === fromKey,
      );
      // Only clean tabs follow a move. A dirty/conflicted/missing tab keeps
      // its original path and text, so the user's buffer stays saveable at
      // the location it was opened from instead of silently retargeting a
      // file another process now owns.
      if (!tab || tab.status !== "clean" || tab.pendingSave) return state;
      const collision = state.tabs.some(
        (candidate) =>
          candidate.id !== tab.id &&
          candidate.path !== null &&
          normalizePathKey(candidate.path, platform) === toKey,
      );
      if (collision) return state;
      return replaceTab(state, tab.id, (document) => ({
        ...document,
        path: action.to,
        title: titleFromPath(action.to),
      }));
    }

    case "documentRestored": {
      const sameId = state.tabs.find((tab) => tab.id === action.id);
      if (sameId) return { ...state, activeId: sameId.id };

      const platform = action.pathPlatform ?? "macos";
      const draft = action.draft;
      const existing =
        draft.originalPath === null
          ? undefined
          : state.tabs.find(
              (tab) =>
                tab.path !== null &&
                normalizePathKey(tab.path, platform) ===
                  normalizePathKey(draft.originalPath!, platform),
            );
      if (existing) {
        // Session restore may already have reopened the file from disk; merge
        // the draft's unsaved text into that tab instead of duplicating it.
        const tabs = state.tabs.map((tab): DocumentSnapshot =>
          tab.id === existing.id
            ? {
                ...tab,
                text: draft.text,
                hasUtf8Bom: draft.hasUtf8Bom,
                newline: draft.newline,
                status: draft.text === tab.savedText ? "clean" : "dirty",
                pendingSave: undefined,
              }
            : tab,
        );
        return { ...state, tabs, activeId: existing.id };
      }

      // The draft only stores a hash of the last saved text, so the restored
      // tab treats the saved text as unknown ("") and stays dirty until the
      // user saves or discards it.
      const restored: DocumentSnapshot = {
        id: action.id,
        path: draft.originalPath,
        title: draft.title,
        text: draft.text,
        savedText: "",
        hasUtf8Bom: draft.hasUtf8Bom,
        newline: draft.newline,
        modifiedUnixMs: null,
        version: draft.savedVersion,
        status: draft.text === "" ? "clean" : "dirty",
      };
      return { ...state, tabs: [...state.tabs, restored], activeId: action.id };
    }

    case "diskVersionLoaded":
      return replaceTab(state, action.id, (document) =>
        snapshotFromFile(document.id, action.file),
      );

    case "conflictKeptLocal":
      return replaceTab(state, action.id, (document) => ({
        ...document,
        status: document.text === document.savedText ? "clean" : "dirty",
      }));

    case "closeConfirmed": {
      const closedIndex = state.tabs.findIndex((tab) => tab.id === action.id);
      if (closedIndex === -1) return state;

      const closed = state.tabs[closedIndex];
      if (closed.pendingSave) return state;
      const stored =
        action.disposition === "discarded"
          ? discardedSnapshot(closed)
          : cloneSnapshot(closed);
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      const activeId =
        state.activeId !== action.id
          ? state.activeId
          : (tabs[closedIndex]?.id ?? tabs[closedIndex - 1]?.id ?? null);

      const platform = action.pathPlatform ?? "macos";
      const duplicate = (candidate: DocumentSnapshot): boolean =>
        stored.path === null
          ? candidate.path === null && candidate.id === stored.id
          : candidate.path !== null &&
            normalizePathKey(candidate.path, platform) ===
              normalizePathKey(stored.path, platform);

      return {
        tabs,
        activeId,
        recentlyClosed: [
          { document: stored, closedIndex },
          ...state.recentlyClosed.filter(
            ({ document }) => !duplicate(document),
          ).map(({ document, closedIndex }) => ({
            document: cloneSnapshot(document),
            closedIndex,
          })),
        ].slice(0, 20),
        nextSaveSequence: state.nextSaveSequence,
      };
    }

    case "reopenLastClosed": {
      const [closed, ...remainingClosed] = state.recentlyClosed;
      if (!closed) return state;
      const recentlyClosed = remainingClosed.map(
        ({ document, closedIndex }) => ({
          document: cloneSnapshot(document),
          closedIndex,
        }),
      );

      const platform = action.pathPlatform ?? "macos";
      const sameId = state.tabs.find((tab) => tab.id === closed.document.id);
      if (sameId) {
        return { ...state, activeId: sameId.id, recentlyClosed };
      }

      const path = closed.document.path;
      const existing =
        path === null
          ? undefined
          : state.tabs.find(
              (tab) =>
                tab.path !== null &&
                normalizePathKey(tab.path, platform) ===
                  normalizePathKey(path, platform),
            );
      if (existing) {
        return { ...state, activeId: existing.id, recentlyClosed };
      }

      const insertAt = Math.max(
        0,
        Math.min(closed.closedIndex, state.tabs.length),
      );
      const tabs = [...state.tabs];
      tabs.splice(insertAt, 0, cloneSnapshot(closed.document));
      return {
        tabs,
        activeId: closed.document.id,
        recentlyClosed,
        nextSaveSequence: state.nextSaveSequence,
      };
    }

    default:
      return assertNever(action);
  }
};

export type { DocumentState, PathPlatform } from "./types";
