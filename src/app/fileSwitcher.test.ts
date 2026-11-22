import { describe, expect, it } from "vitest";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import { collectWorkspaceFiles, normalizeNewMarkdownPath } from "./fileSwitcher";

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
});
