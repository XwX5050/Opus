import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAppController } from "../../../../src/app/useAppController";
import { MemoryDocumentPort } from "../../../../src/document/memoryDocumentPort";
import type { OpenedFile, RecoveryDraft } from "../../../../src/document/types";
import { translateDocument } from "../../../../src/translate/translate";
import { DEFAULT_TRANSLATION_SETTINGS } from "../../../../src/translate/types";
import { splitMarkdownSegments } from "../../../../src/translate/segments";
import { documentReducer, initialDocumentState } from "../../../../src/document/documentReducer";

afterEach(cleanup);
const file: OpenedFile = {
  path: "/docs/original.md", text: "Original English text", hasUtf8Bom: false,
  newline: "lf", modifiedUnixMs: 1, version: "v1",
};
const draft = (changes: Partial<RecoveryDraft> = {}): RecoveryDraft => ({
  draftId: "draft-document-1", originalPath: null, title: "Unsaved note",
  text: "Unique recovered text", savedTextHash: "811c9dc5", savedVersion: null,
  hasUtf8Bom: false, newline: "lf", ...changes,
});
const configured = async (port: MemoryDocumentPort) => {
  const hook = renderHook(() => useAppController(port));
  await act(async () => {});
  await act(async () => { await hook.result.current.openPath(file.path); });
  act(() => hook.result.current.setTranslationSettings({
    ...DEFAULT_TRANSLATION_SETTINGS, apiKey: "audit-placeholder-not-a-real-key",
  }));
  return hook;
};

it("F03 keeps translation indexes when a Chinese paragraph is skipped", async () => {
  const input = "First English paragraph.\n\n这是一段已经写好的中文内容。\n\nLast English paragraph.\n";
  const result = await translateDocument({ translateSegments: async (_settings, texts) =>
    texts.map(text => text.includes("First") ? "第一段译文。" : "最后一段译文。"),
  }, DEFAULT_TRANSLATION_SETTINGS, input);
  expect(result).toBe("第一段译文。\n\n这是一段已经写好的中文内容。\n\n最后一段译文。\n");
});

it("F04 keeps a durable copy when restoring an untitled draft with a reused ID", async () => {
  const port = new MemoryDocumentPort(new Map(), { drafts: [draft()] });
  const { result } = renderHook(() => useAppController(port));
  await waitFor(() => expect(result.current.recoveryDrafts).toHaveLength(1));
  await act(async () => { await result.current.restoreDraft(result.current.recoveryDrafts![0]); });
  expect(port.drafts.some(item => item.text === "Unique recovered text")).toBe(true);
});

it("F04 durably migrates a draft merged into a tab already restored from disk", async () => {
  const port = new MemoryDocumentPort(new Map([[file.path, file]]), {
    drafts: [draft({ draftId: "leftover-9", originalPath: file.path })],
    session: { recent: [], openPaths: [file.path], activePath: file.path, workspacePath: null },
  });
  const { result } = renderHook(() => useAppController(port));
  await waitFor(() => expect(result.current.state.tabs).toHaveLength(1));
  await act(async () => { await result.current.restoreDraft(result.current.recoveryDrafts![0]); });
  expect(port.drafts.some(item => item.text === "Unique recovered text")).toBe(true);
});

it("F05 preserves an intentionally emptied document as an unsaved recovery edit", async () => {
  const port = new MemoryDocumentPort(new Map(), {
    drafts: [draft({ text: "", originalPath: "/docs/deleted-body.md", savedVersion: "v-old", savedTextHash: "nonempty-before" })],
  });
  const { result } = renderHook(() => useAppController(port));
  await waitFor(() => expect(result.current.recoveryDrafts).toHaveLength(1));
  await act(async () => { await result.current.restoreDraft(result.current.recoveryDrafts![0]); });
  expect(result.current.state.tabs[0].status).toBe("dirty");
});

it("F06 retargets a document watch after an in-app rename", async () => {
  const port = new MemoryDocumentPort(new Map([[file.path, file]]));
  const { result } = await configured(port);
  const id = result.current.state.activeId!;
  await act(async () => { await result.current.renameDocument(id, "renamed"); });
  expect(port.watchCalls).toContainEqual({ kind: "document", consumerId: id, path: "/docs/renamed.md" });
});

it("F07 permits save-and-close of the original dirty text while its translation is visible", async () => {
  const port = new MemoryDocumentPort(new Map([[file.path, file]]));
  const { result } = await configured(port);
  const id = result.current.state.activeId!;
  act(() => result.current.changeText(id, "New original English text"));
  act(() => result.current.toggleTranslation(id));
  await waitFor(() => expect(result.current.translationOf(id)?.state.phase).toBe("ready"));
  act(() => result.current.close(id));
  await act(async () => { await result.current.confirmClose("save"); });
  expect(port.writes.at(-1)?.text).toBe("New original English text");
  expect(result.current.state.tabs).toHaveLength(0);
});

it("F08 accepts edits again after a translation error", async () => {
  const port = new MemoryDocumentPort(new Map([[file.path, file]]));
  vi.spyOn(port, "translateSegments").mockRejectedValue(new Error("Simulated HTTP 401"));
  const { result } = await configured(port);
  const id = result.current.state.activeId!;
  act(() => result.current.toggleTranslation(id));
  await waitFor(() => expect(result.current.translationOf(id)?.state.phase).toBe("error"), { timeout: 4000 });
  act(() => result.current.changeText(id, "User text after error"));
  expect(result.current.state.tabs[0].text).toBe("User text after error");
});

it("F09 invalidates a hidden translation when its target language changes", async () => {
  const port = new MemoryDocumentPort(new Map([[file.path, file]]));
  const translate = vi.spyOn(port, "translateSegments");
  const { result } = await configured(port);
  const id = result.current.state.activeId!;
  act(() => result.current.toggleTranslation(id));
  await waitFor(() => expect(result.current.translationOf(id)?.state.phase).toBe("ready"));
  act(() => result.current.toggleTranslation(id));
  act(() => result.current.setTranslationSettings({
    ...result.current.translationSettings, targetLanguage: "日本語",
  }));
  act(() => result.current.toggleTranslation(id));
  await act(async () => {});
  expect(translate.mock.calls.at(-1)?.[0].targetLanguage).toBe("日本語");
});

it("F10 reopening a closed file refreshes content changed while it was closed", async () => {
  const port = new MemoryDocumentPort(new Map([[file.path, file]]));
  const { result } = await configured(port);
  act(() => result.current.close(result.current.state.activeId!));
  port.updateFile(file.path, { text: "External new text", version: "v2" });
  act(() => result.current.reopenClosed());
  await act(async () => {});
  expect(result.current.state.tabs[0].text).toBe("External new text");
});

it("F11 rejects a stale external read completed after a Save As retarget", async () => {
  const port = new MemoryDocumentPort(new Map([[file.path, file]]), { savePath: "/docs/saved-as.md" });
  const { result } = await configured(port);
  let resolveRead!: (opened: OpenedFile) => void;
  vi.spyOn(port, "openPath").mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
  act(() => port.emitDiskEvent({ kind: "changed", path: file.path, modifiedUnixMs: 2, version: "v2" }));
  await act(async () => { await result.current.saveAs(); });
  expect(result.current.state.tabs[0].path).toBe("/docs/saved-as.md");
  await act(async () => { resolveRead({ ...file, text: "Late old-path contents", version: "v2" }); });
  expect(result.current.state.tabs[0].path).toBe("/docs/saved-as.md");
});

it("F12 keeps viewport priority available after ordinary typing", async () => {
  const port = new MemoryDocumentPort(new Map([[file.path, file]]));
  const { result } = await configured(port);
  const visibleRange = vi.fn(() => ({ from: 0, to: 12 }));
  act(() => result.current.setTranslationViewportProvider(visibleRange));
  act(() => result.current.changeText(result.current.state.activeId!, "Edited English paragraph"));
  act(() => result.current.toggleTranslation(result.current.state.activeId!));
  await waitFor(() => expect(result.current.translationOf(result.current.state.activeId!)?.state.phase).toBe("ready"));
  expect(visibleRange).toHaveBeenCalled();
});

it("F13 does not treat a code-fence line with a suffix as a closing fence", () => {
  const source = "~~~text\ncode one\n~~~not-a-closing-fence\ncode two\n~~~\n";
  expect(splitMarkdownSegments(source).filter(segment => segment.kind === "translatable")).toEqual([]);
});

it("F13 protects fenced code nested in a blockquote", () => {
  const source = "> ~~~text\n> code inside a blockquote\n> ~~~\n";
  expect(splitMarkdownSegments(source).filter(segment => segment.kind === "translatable")).toEqual([]);
});

it("F14 prevents Save As overwriting an already-open Windows file through a plain-path alias", () => {
  let state = documentReducer(initialDocumentState, {
    type: "fileOpened", id: "target", pathPlatform: "windows",
    file: { ...file, path: "\\\\?\\C:\\docs\\target.md" },
  });
  state = documentReducer(state, { type: "newDocument", id: "source" });
  state = documentReducer(state, {
    type: "saveRequested", id: "source", pathPlatform: "windows",
    target: { path: "C:\\docs\\target.md", expectedVersion: "v1" },
  });
  expect(state.tabs.find(tab => tab.id === "source")?.pendingSave).toBeUndefined();
});
