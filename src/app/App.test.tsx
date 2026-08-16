import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocumentPortError, type DocumentPort } from "../document/DocumentPort";
import App from "./App";

const mockedTauri = vi.hoisted(() => ({
  onError: null as null | ((error: DocumentPortError) => void),
}));

vi.mock("../document/tauriDocumentPort", () => ({
  createTauriDocumentPort: (onError: (error: DocumentPortError) => void): DocumentPort => {
    mockedTauri.onError = onError;
    return {
      async chooseAndOpenFiles() { return []; },
      async openPath() { throw new DocumentPortError("not_found", "missing"); },
      async chooseSavePath() { return null; },
      async write() { throw new DocumentPortError("io", "not writable"); },
      async saveClipboardImage() { return null; },
      async translateSegments() { return []; },
      async acquireDocumentScope() {},
      async acquireWorkspaceScope() {},
      async releaseAssetScope() {},
      async chooseWorkspace() { return null; },
      async openWorkspacePath(path: string) { return { path, title: path.split("/").at(-1) ?? path }; },
      async listDirectory() { return []; },
      async createMarkdownFile() { throw new DocumentPortError("io", "not supported"); },
      async renameEntry() { throw new DocumentPortError("io", "not supported"); },
      async trashEntry() {},
      async watchDocument() {},
      async watchWorkspace() {},
      async unwatch() {},
      async subscribeToDiskEvents() { return () => {}; },
      async listDrafts() { return []; },
      async readDraft() { throw new DocumentPortError("not_found", "no drafts"); },
      async writeDraft() { throw new DocumentPortError("io", "not supported"); },
      async discardDraft() {},
      async loadSession() { return null; },
      async saveSession() {},
      async onCloseRequested() { return () => {}; },
    };
  },
  subscribeToOpenPaths: async () => ({
    async ready() {},
    async dispose() {},
  }),
  subscribeToImageDrops: async () => () => {},
  subscribeToMenuActions: async () => () => {},
  tauriImagePreviewUrl: (path: string) => path,
  restoreWindowGeometry: async () => () => {},
}));

describe("App", () => {
  it("surfaces and acknowledges production document-picker errors in the shell", async () => {
    const user = userEvent.setup();
    render(<App />);
    act(() => mockedTauri.onError?.(new DocumentPortError("permission_denied", "permission denied")));
    expect(screen.getByRole("alert")).toHaveTextContent("permission denied");
    await user.click(screen.getByRole("button", { name: "关闭错误提示" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
