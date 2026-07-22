import type { SavedFile } from "./DocumentPort";
import type {
  DocumentSnapshot,
  DocumentState,
  OpenedFile,
} from "./types";

export type PathPlatform = "linux" | "macos" | "windows";

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
      type: "saveStarted";
      id: string;
      requestId: string;
      targetPath: string;
      writtenText: string;
      previousVersion: string | null;
    }
  | {
      type: "saveSucceeded";
      id: string;
      requestId: string;
      result: SavedFile;
      pathPlatform?: PathPlatform;
    }
  | {
      type: "externalConflict";
      id: string;
      modifiedUnixMs: number;
      version: string;
    }
  | { type: "externalMissing"; id: string }
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
  pendingSave: document.pendingSave ? { ...document.pendingSave } : undefined,
});

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

    case "saveStarted":
      return replaceTab(state, action.id, (document) => ({
        ...document,
        pendingSave: {
          requestId: action.requestId,
          targetPath: action.targetPath,
          writtenText: action.writtenText,
          previousVersion: action.previousVersion,
        },
      }));

    case "saveSucceeded": {
      const document = state.tabs.find((tab) => tab.id === action.id);
      if (!document || document.pendingSave?.requestId !== action.requestId) {
        return state;
      }

      const platform = action.pathPlatform ?? "macos";
      const resultKey = normalizePathKey(action.result.path, platform);
      const targetMismatch =
        normalizePathKey(document.pendingSave.targetPath, platform) !== resultKey;
      const collides = state.tabs.some(
        (tab) =>
          tab.id !== action.id &&
          tab.path !== null &&
          normalizePathKey(tab.path, platform) === resultKey,
      );
      if (targetMismatch || collides) {
        return replaceTab(state, action.id, (tab) => ({
          ...tab,
          status: "conflict",
          pendingSave: undefined,
        }));
      }

      const writtenText = document.pendingSave.writtenText;
      return replaceTab(state, action.id, (tab) => ({
        ...tab,
        path: action.result.path,
        title: titleFromPath(action.result.path),
        savedText: writtenText,
        modifiedUnixMs: action.result.modifiedUnixMs,
        version: action.result.version,
        status: tab.text === writtenText ? "clean" : "dirty",
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

    case "closeConfirmed": {
      const closedIndex = state.tabs.findIndex((tab) => tab.id === action.id);
      if (closedIndex === -1) return state;

      const closed = state.tabs[closedIndex];
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
          ),
        ].slice(0, 20),
      };
    }

    case "reopenLastClosed": {
      const [closed, ...recentlyClosed] = state.recentlyClosed;
      if (!closed) return state;

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
      };
    }

    default:
      return state;
  }
};

export type { DocumentState } from "./types";
