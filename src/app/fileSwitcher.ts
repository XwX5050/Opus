import type { DocumentPort } from "../document/DocumentPort";

export const collectWorkspaceFiles = async (
  port: DocumentPort,
  root: string,
  limit = 1000,
): Promise<string[]> => {
  const files: string[] = [];
  const pending = [""];
  const visited = new Set<string>();
  while (pending.length > 0 && files.length < limit) {
    const relative = pending.shift()!;
    if (visited.has(relative)) continue;
    visited.add(relative);
    const entries = await port.listDirectory(root, relative);
    for (const entry of entries) {
      if (entry.isDirectory) {
        pending.push(relative ? `${relative}/${entry.name}` : entry.name);
      } else {
        files.push(entry.path);
        if (files.length === limit) break;
      }
    }
  }
  return files;
};

export const normalizeNewMarkdownPath = (query: string): string | null => {
  const normalized = query.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return null;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  const name = segments.at(-1)!;
  segments[segments.length - 1] = /\.(md|markdown)$/i.test(name)
    ? name
    : `${name}.md`;
  return segments.join("/");
};

export interface DisplayPath {
  readonly dir: string;
  readonly name: string;
}

/**
 * Splits a workspace-relative path into the parent directory and the file
 * name so the quick switcher can emphasize the name and mute the rest.
 */
export const splitDisplayPath = (relative: string): DisplayPath => {
  const trimmed = relative.replace(/[\\/]+$/, "");
  const separator = Math.max(
    trimmed.lastIndexOf("/"),
    trimmed.lastIndexOf("\\"),
  );
  if (separator < 0) return { dir: "", name: trimmed };
  return {
    dir: trimmed.slice(0, separator),
    name: trimmed.slice(separator + 1),
  };
};

export interface HighlightSegment {
  readonly text: string;
  readonly match: boolean;
}

const HIGHLIGHT_ESCAPE = /[.*+?^${}()|[\]\\]/g;

const highlightTokens = (query: string): string[] =>
  query
    .trim()
    .split(/[\\/]+/)
    .filter((token) => token.length > 0);

/**
 * Splits display text into plain and matched segments for `mark` rendering.
 * The query is matched case-insensitively per path segment, so
 * `drafts/gamma` highlights both the directory and the file name.
 */
export const highlightSegments = (
  text: string,
  query: string,
): ReadonlyArray<HighlightSegment> => {
  if (!text) return [];
  const tokens = highlightTokens(query);
  if (tokens.length === 0) return [{ text, match: false }];
  const pattern = new RegExp(
    tokens
      .map((token) => token.replace(HIGHLIGHT_ESCAPE, "\\$&"))
      .sort((left, right) => right.length - left.length)
      .join("|"),
    "gi",
  );
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const found of text.matchAll(pattern)) {
    const index = found.index ?? cursor;
    if (index > cursor) segments.push({ text: text.slice(cursor, index), match: false });
    segments.push({ text: found[0], match: true });
    cursor = index + found[0].length;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), match: false });
  }
  return segments;
};

export interface SwitcherShortcut {
  readonly key: string;
  readonly label: string;
}

/**
 * Footer hints follow the same platform split as the rest of the shell:
 * macOS keeps glyph keycaps, Windows/Linux spell the keys out.
 */
export const quickSwitcherShortcuts = (
  isMac: boolean,
): ReadonlyArray<SwitcherShortcut> =>
  isMac
    ? [
        { key: "↵", label: "打开" },
        { key: "⇧↵", label: "创建" },
        { key: "esc", label: "关闭" },
      ]
    : [
        { key: "Enter", label: "打开" },
        { key: "Shift+Enter", label: "创建" },
        { key: "Esc", label: "关闭" },
      ];
