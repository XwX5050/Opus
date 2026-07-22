import { act, render, screen } from "@testing-library/react";
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
    };
  },
  subscribeToOpenPaths: async () => ({
    async ready() {},
    async dispose() {},
  }),
}));

describe("App", () => {
  it("surfaces production document-picker errors in the shell", () => {
    render(<App />);
    act(() => mockedTauri.onError?.(new DocumentPortError("permission_denied", "permission denied")));
    expect(screen.getByRole("alert")).toHaveTextContent("permission denied");
  });
});
