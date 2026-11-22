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
