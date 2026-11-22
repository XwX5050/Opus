import type { DocumentSnapshot } from "../document/types";
import {
  assertNativeE2eIdentifier,
  findEditDraft,
  findTabByPath,
  isNativeE2eScenario,
  nativeE2eEnabled,
  normalizeNewlines,
  runNativeE2e,
  waitFor,
} from "./nativeE2e";
import type { NativeE2eHost } from "./nativeE2e";

const tab = (overrides: Partial<DocumentSnapshot>): DocumentSnapshot => ({
  id: "document-1",
  path: "/tmp/note.md",
  title: "note.md",
  text: "",
  savedText: "",
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: "v1",
  status: "clean",
  ...overrides,
});

describe("nativeE2e scenario names", () => {
  it("accepts exactly the scenarios the runner implements", () => {
    for (const scenario of ["smoke", "edit-save", "external-change", "recovery"]) {
      expect(isNativeE2eScenario(scenario)).toBe(true);
    }
  });

  it("rejects orchestrator-only and unknown scenario values", () => {
    for (const value of ["all", "", "edit_save", "smoke ", null, undefined, 42]) {
      expect(isNativeE2eScenario(value)).toBe(false);
    }
  });
});

describe("nativeE2eEnabled", () => {
  it("is enabled only by the dedicated native-e2e Vite mode", () => {
    expect(nativeE2eEnabled({ MODE: "native-e2e" })).toBe(true);
    expect(nativeE2eEnabled({})).toBe(false);
    expect(nativeE2eEnabled({ MODE: "production" })).toBe(false);
    expect(nativeE2eEnabled({ MODE: "development" })).toBe(false);
    expect(nativeE2eEnabled({ MODE: "native-e2e2" })).toBe(false);
  });
});

describe("assertNativeE2eIdentifier", () => {
  it("accepts the dedicated identifier and other native-e2e identifiers", () => {
    expect(() =>
      assertNativeE2eIdentifier("com.xiongweini.markdown-edit.native-e2e"),
    ).not.toThrow();
    expect(() => assertNativeE2eIdentifier("com.example.opus.native-e2e")).not.toThrow();
  });

  it("rejects the production identifier and unprefixed values", () => {
    expect(() =>
      assertNativeE2eIdentifier("com.xiongweini.markdown-edit"),
    ).toThrow(/native-e2e/);
    expect(() => assertNativeE2eIdentifier("com.xiongweini.markdown-edit.debug")).toThrow(
      /native-e2e/,
    );
    expect(() => assertNativeE2eIdentifier(".native-e2e")).toThrow(/native-e2e/);
  });
});

describe("waitFor", () => {
  it("returns an immediately available value without waiting", async () => {
    await expect(waitFor(() => "ready", 1_000)).resolves.toBe("ready");
    await expect(waitFor(() => 0, 1_000)).resolves.toBe(0);
  });

  it("polls until a value appears", async () => {
    let reads = 0;
    const value = await waitFor(() => (++reads >= 3 ? reads : null), 1_000, 5);
    expect(value).toBe(3);
  });

  it("rejects with the configured timeout when no value appears", async () => {
    await expect(waitFor(() => false, 40, 5)).rejects.toThrow(
      "Timed out after 40 ms",
    );
  });
});

describe("normalizeNewlines", () => {
  it("folds CRLF and lone CR to LF, matching CodeMirror's internal text", () => {
    expect(normalizeNewlines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(normalizeNewlines("a\nb\n")).toBe("a\nb\n");
  });
});

describe("findTabByPath", () => {
  it("matches macOS paths case-insensitively and NFC-normalized", () => {
    const tabs = [tab({ id: "a", path: "/tmp/Note.md" })];
    expect(findTabByPath(tabs, "/tmp/note.md", "macos")?.id).toBe("a");
    expect(findTabByPath(tabs, "/tmp/../tmp/note.md", "macos")?.id).toBe("a");
  });

  it("keeps Linux paths case-sensitive", () => {
    const tabs = [tab({ id: "a", path: "/tmp/Note.md" })];
    expect(findTabByPath(tabs, "/tmp/note.md", "linux")).toBeUndefined();
    expect(findTabByPath(tabs, "/tmp/Note.md", "linux")?.id).toBe("a");
  });

  it("folds Windows separators and case", () => {
    const tabs = [tab({ id: "a", path: "C:\\Docs\\Note.md" })];
    expect(findTabByPath(tabs, "c:/docs/note.md", "windows")?.id).toBe("a");
  });

  it("never matches an untitled tab", () => {
    const tabs = [tab({ id: "a", path: null })];
    expect(findTabByPath(tabs, "/tmp/note.md", "macos")).toBeUndefined();
  });
});

describe("findEditDraft", () => {
  const draftInfo = (draftId: string) => ({
    draftId,
    originalPath: "/tmp/note.md",
    title: "note.md",
    savedTextHash: "hash",
    savedVersion: "v1",
    updatedUnixMs: 1,
  });
  const token = "\n\nnative-e2e-native-edit\n";

  it("uses the real launch-namespaced ids returned by the store", async () => {
    const infos = [
      draftInfo("draft-11111111-1111-4111-8111-111111111111-document-1"),
      draftInfo("draft-22222222-2222-4222-8222-222222222222-document-1"),
    ];
    const read = vi.fn(async (draftId: string) =>
      draftId === infos[1].draftId
        ? { text: `body${token}` }
        : { text: "unrelated draft" },
    );

    const found = await findEditDraft(infos, read, token);

    expect(found?.info.draftId).toBe(infos[1].draftId);
    expect(found?.text).toBe(`body${token}`);
    expect(read).toHaveBeenNthCalledWith(1, infos[0].draftId);
    expect(read).toHaveBeenNthCalledWith(2, infos[1].draftId);
  });

  it("skips unreadable drafts instead of failing the search", async () => {
    const infos = [draftInfo("draft-a-document-1"), draftInfo("draft-b-document-1")];
    const read = vi.fn(async (draftId: string) => {
      if (draftId === "draft-a-document-1") throw new Error("corrupt");
      return { text: `recovered${token}` };
    });

    const found = await findEditDraft(infos, read, token);

    expect(found?.info.draftId).toBe("draft-b-document-1");
  });

  it("returns null when no draft carries the edit", async () => {
    const found = await findEditDraft(
      [draftInfo("draft-a-document-1")],
      async () => ({ text: "nothing here" }),
      token,
    );
    expect(found).toBeNull();
  });
});

describe("runNativeE2e smoke", () => {
  it("reports the controller tab text and never re-opens the fixture", async () => {
    const fixtureText = "# Native E2E smoke\r\n\r\n- first line\r\n";
    const openPath = vi.fn(async () => {
      throw new Error("smoke must not re-read the file through the port");
    });
    const host = {
      port: { openPath },
      controller: () => ({
        state: {
          tabs: [
            tab({
              text: fixtureText,
              hasUtf8Bom: true,
              newline: "cr_lf",
            }),
          ],
        },
      }),
      editorView: () => ({}),
    } as unknown as NativeE2eHost;
    const reports: Array<Record<string, unknown>> = [];
    const markers: string[] = [];

    await runNativeE2e(host, {
      context: async () => ({
        scenario: "smoke",
        identifier: "com.xiongweini.markdown-edit.native-e2e",
      }),
      marker: async (phase) => {
        markers.push(phase);
      },
      report: async (report) => {
        reports.push(report);
      },
    });

    expect(openPath).not.toHaveBeenCalled();
    expect(markers).toEqual(["opened", "done"]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: "passed",
      path: "/tmp/note.md",
      text: fixtureText,
      hasUtf8Bom: true,
      newline: "cr_lf",
    });
  });
});
