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
  | { type: "saveSucceeded"; id: string; result: SavedFile }
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
    }
  | { type: "reopenLastClosed"; pathPlatform?: PathPlatform };

export const initialDocumentState: DocumentState = {
  tabs: [],
  activeId: null,
  recentlyClosed: [],
};

const collapseSegments = (path: string, separator: "/" | "\\"): string => {
  const hasRoot = path.startsWith(separator);
  const segments = path.split(separator);
  const collapsed: string[] = [];

  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && collapsed.length > 0 && collapsed.at(-1) !== "..") {
      collapsed.pop();
    } else if (segment !== ".." || !hasRoot) {
      collapsed.push(segment);
    }
  }

  return `${hasRoot ? separator : ""}${collapsed.join(separator)}` || separator;
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
  if (platform === "linux") return collapseSegments(path, "/");

  if (platform === "windows") {
    return collapseSegments(path.replaceAll("/", "\\"), "\\").toLocaleLowerCase(
      "en-US",
    );
  }

  return collapseSegments(path.normalize("NFC"), "/").toLocaleLowerCase("en-US");
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

    case "saveSucceeded":
      return replaceTab(state, action.id, (document) => ({
        ...document,
        path: action.result.path,
        title: titleFromPath(action.result.path),
        savedText: document.text,
        modifiedUnixMs: action.result.modifiedUnixMs,
        version: action.result.version,
        status: "clean",
      }));

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
        action.disposition === "discarded" ? discardedSnapshot(closed) : closed;
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      const activeId =
        state.activeId !== action.id
          ? state.activeId
          : (tabs[closedIndex]?.id ?? tabs[closedIndex - 1]?.id ?? null);

      return {
        tabs,
        activeId,
        recentlyClosed: [
          { document: stored, closedIndex },
          ...state.recentlyClosed,
        ].slice(0, 20),
      };
    }

    case "reopenLastClosed": {
      const [closed, ...recentlyClosed] = state.recentlyClosed;
      if (!closed) return state;

      const platform = action.pathPlatform ?? "macos";
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

      const insertAt = Math.min(closed.closedIndex, state.tabs.length);
      const tabs = [...state.tabs];
      tabs.splice(insertAt, 0, closed.document);
      return {
        tabs,
        activeId: closed.document.id,
        recentlyClosed,
      };
    }
  }
};

export type { DocumentState } from "./types";
