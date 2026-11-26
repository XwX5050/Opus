import { describe, expect, it } from "vitest";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import {
  collectWorkspaceFiles,
  highlightSegments,
  normalizeNewMarkdownPath,
  quickSwitcherShortcuts,
  splitDisplayPath,
} from "./fileSwitcher";

const file = (path: string) => ({
  path,
  text: "",
  hasUtf8Bom: false,
  newline: "lf" as const,
  modifiedUnixMs: 1,
  version: path,
});

describe("file switcher paths", () => {
  it("collects only Markdown files recursively", async () => {
    const port = new MemoryDocumentPort(
      new Map([
        ["/ws/root.md", file("/ws/root.md")],
        ["/ws/nested/note.markdown", file("/ws/nested/note.markdown")],
      ]),
      { workspace: { path: "/ws", title: "ws" } },
    );

    await expect(collectWorkspaceFiles(port, "/ws")).resolves.toEqual([
      "/ws/root.md",
      "/ws/nested/note.markdown",
    ]);
  });

  it("normalizes new Markdown paths and rejects traversal", () => {
    expect(normalizeNewMarkdownPath(" 笔记 ")).toBe("笔记.md");
    expect(normalizeNewMarkdownPath("drafts/new.markdown")).toBe("drafts/new.markdown");
    expect(normalizeNewMarkdownPath("drafts/new")).toBe("drafts/new.md");
    expect(normalizeNewMarkdownPath("../outside")).toBeNull();
    expect(normalizeNewMarkdownPath("/absolute")).toBeNull();
    expect(normalizeNewMarkdownPath("drafts/")).toBeNull();
  });

  it("splits the display name from its parent directories", () => {
    expect(splitDisplayPath("root.md")).toEqual({ dir: "", name: "root.md" });
    expect(splitDisplayPath("drafts/new.md")).toEqual({
      dir: "drafts",
      name: "new.md",
    });
    expect(splitDisplayPath("a/b/note.markdown")).toEqual({
      dir: "a/b",
      name: "note.markdown",
    });
    expect(splitDisplayPath("a\\b\\note.md")).toEqual({
      dir: "a\\b",
      name: "note.md",
    });
  });

  it("highlights query characters per path segment", () => {
    expect(highlightSegments("gamma.md", "GAM")).toEqual([
      { text: "gam", match: true },
      { text: "ma.md", match: false },
    ]);
    expect(highlightSegments("drafts/gamma.md", "drafts/gam")).toEqual([
      { text: "drafts", match: true },
      { text: "/", match: false },
      { text: "gam", match: true },
      { text: "ma.md", match: false },
    ]);
  });

  it("treats query characters literally and leaves blank queries plain", () => {
    expect(highlightSegments("aXmd.md", "a.md")).toEqual([
      { text: "aXmd.md", match: false },
    ]);
    expect(highlightSegments("a.md", "a.md")).toEqual([{ text: "a.md", match: true }]);
    expect(highlightSegments("note.md", "  ")).toEqual([
      { text: "note.md", match: false },
    ]);
    expect(highlightSegments("", "note")).toEqual([]);
  });

  it("labels quick-switcher shortcuts per platform", () => {
    expect(quickSwitcherShortcuts(true)).toEqual([
      { key: "↵", label: "打开" },
      { key: "⇧↵", label: "创建" },
      { key: "esc", label: "关闭" },
    ]);
    expect(quickSwitcherShortcuts(false)).toEqual([
      { key: "Enter", label: "打开" },
      { key: "Shift+Enter", label: "创建" },
      { key: "Esc", label: "关闭" },
    ]);
  });
});
