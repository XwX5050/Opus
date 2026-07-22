import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DocumentPort, SavedFile } from "../document/DocumentPort";
import type { OpenedFile, PendingWriteRequest, SaveTarget } from "../document/types";
import { useAppController } from "./useAppController";

const file: OpenedFile = {
  path: "/notes/exact.md",
  text: "base",
  hasUtf8Bom: true,
  newline: "cr_lf",
  modifiedUnixMs: 1,
  version: "v1",
};

class InspectableControllerPort implements DocumentPort {
  request: PendingWriteRequest | undefined;

  constructor(
    private readonly file: OpenedFile,
    private readonly writeResult: Promise<SavedFile>,
    private readonly saveTarget: SaveTarget | null = null,
  ) {}

  async chooseAndOpenFiles() { return [this.file]; }
  async openPath() { return this.file; }
  async chooseSavePath() { return this.saveTarget; }
  write(request: PendingWriteRequest) {
    this.request = request;
    return this.writeResult;
  }
}

describe("useAppController", () => {
  it("passes the exact frozen reducer request to write and keeps later edits dirty", async () => {
    let resolveWrite!: (value: SavedFile) => void;
    const write = new Promise<SavedFile>((resolve) => { resolveWrite = resolve; });
    const port = new InspectableControllerPort(file, write);
    const hook = renderHook(() => useAppController(port));

    await act(() => hook.result.current.openFiles());
    const id = hook.result.current.state.activeId!;
    act(() => hook.result.current.changeText(id, "snapshot A"));
    let saving!: Promise<boolean>;
    act(() => { saving = hook.result.current.save(id); });

    await waitFor(() => expect(port.request).toBeDefined());
    const pending = hook.result.current.state.tabs[0].pendingSave;
    expect(port.request).toBe(pending);
    expect(Object.isFrozen(port.request)).toBe(true);
    expect(port.request?.text).toBe("snapshot A");

    act(() => hook.result.current.changeText(id, "snapshot B"));
    resolveWrite({ path: file.path, modifiedUnixMs: 2, version: "v2" });
    await act(() => saving);
    expect(hook.result.current.state.tabs[0]).toMatchObject({
      text: "snapshot B",
      savedText: "snapshot A",
      status: "dirty",
    });
  });

  it("supports Save As for an existing document through a reducer-owned target", async () => {
    const port = new InspectableControllerPort(
      file,
      Promise.resolve({ path: "/notes/copy.md", modifiedUnixMs: 2, version: "copy-v1" }),
      { path: "/notes/copy.md", expectedVersion: null },
    );
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openFiles());
    const id = hook.result.current.state.activeId!;
    act(() => hook.result.current.changeText(id, "copy text"));

    await act(() => hook.result.current.saveAs(id));

    expect(port.request).toMatchObject({
      documentId: id,
      targetPath: "/notes/copy.md",
      text: "copy text",
      expectedVersion: null,
    });
    expect(hook.result.current.state.tabs[0]).toMatchObject({
      path: "/notes/copy.md",
      savedText: "copy text",
      status: "clean",
    });
  });
});
