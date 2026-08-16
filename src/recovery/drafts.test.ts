import { describe, expect, it } from "vitest";
import type { DocumentSnapshot } from "../document/types";
import {
  draftFromSnapshot,
  draftIdForTab,
  hashText,
  needsRecoveryDraft,
} from "./drafts";

/** A clean, saved snapshot; override fields per case. */
const snapshot = (overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot => ({
  id: "document-1",
  path: "/notes/a.md",
  title: "a.md",
  text: "已保存内容\n",
  savedText: "已保存内容\n",
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: "v1",
  status: "clean",
  ...overrides,
});

describe("hashText", () => {
  it("is deterministic: the same input always hashes to the same value", () => {
    const text = "未保存的修改\nwith 中文 and cr_lf\r\n";
    expect(hashText(text)).toBe(hashText(text));
  });

  it("matches the FNV-1a offset basis for the empty string", () => {
    // FNV-1a starts from its offset basis and hashes zero units for "".
    expect(hashText("")).toBe("811c9dc5");
  });

  it("returns a fixed-width lowercase hex string and differs for different text", () => {
    expect(hashText("a")).toMatch(/^[0-9a-f]{8}$/);
    expect(hashText("a")).not.toBe(hashText("b"));
    expect(hashText("ab")).not.toBe(hashText("ba"));
  });
});

describe("needsRecoveryDraft", () => {
  it("is false for a clean tab whose buffer matches the saved text", () => {
    expect(needsRecoveryDraft(snapshot())).toBe(false);
  });

  it("is true while the buffer holds unsaved text", () => {
    expect(needsRecoveryDraft(snapshot({ text: "已保存内容\n未保存" }))).toBe(true);
  });

  it("is true when the status is not clean even if the text matches", () => {
    for (const status of ["conflict", "missing"] as const) {
      expect(needsRecoveryDraft(snapshot({ status }))).toBe(true);
    }
  });
});

describe("draftIdForTab", () => {
  it("prefixes the stable tab id with draft-", () => {
    expect(draftIdForTab("document-1")).toBe("draft-document-1");
    expect(draftIdForTab("document-42")).toBe("draft-document-42");
  });
});

describe("draftFromSnapshot", () => {
  it("maps every snapshot field onto the recovery draft", () => {
    const draft = draftFromSnapshot(
      snapshot({
        id: "document-7",
        path: "/notes/draft.md",
        title: "draft.md",
        text: "未保存内容\n",
        savedText: "已保存内容\n",
        hasUtf8Bom: true,
        newline: "cr_lf",
        version: "v3",
      }),
    );
    expect(draft).toEqual({
      draftId: "draft-document-7",
      originalPath: "/notes/draft.md",
      title: "draft.md",
      text: "未保存内容\n",
      hasUtf8Bom: true,
      newline: "cr_lf",
      savedTextHash: hashText("已保存内容\n"),
      savedVersion: "v3",
    });
  });

  it("keeps a null path and version when the tab was never saved", () => {
    const draft = draftFromSnapshot(
      snapshot({ path: null, version: null, title: "Untitled" }),
    );
    expect(draft.originalPath).toBeNull();
    expect(draft.savedVersion).toBeNull();
    expect(draft.title).toBe("Untitled");
  });
});