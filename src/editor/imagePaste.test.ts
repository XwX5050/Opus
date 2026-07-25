import { markdown } from "@codemirror/lang-markdown";
import { undo } from "@codemirror/commands";
import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClipboardImageInput } from "../document/DocumentPort";
import {
  escapeMarkdownImageDestination,
  imagePasteExtension,
} from "./imagePaste";

const views: EditorView[] = [];

const createView = (
  saveClipboardImage: (input: ClipboardImageInput) => Promise<string | null>,
  documentPath: string | null = "/notes/a.md",
  doc = "",
) => {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        history(),
        markdown({ extensions: [GFM] }),
        imagePasteExtension({ saveClipboardImage, getDocumentPath: () => documentPath }),
      ],
    }),
  });
  views.push(view);
  return view;
};

const pasteEvent = (file: File | null, type = "image/png") => {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [{ kind: "file", type, getAsFile: () => file }],
    },
  });
  return event;
};

const dropEvent = (file: File, extras: Record<string, string> = {}) => {
  const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    value: {
      files: [file],
      getData: (type: string) => extras[type] ?? "",
    },
  });
  Object.defineProperty(event, "clientX", { value: 0 });
  Object.defineProperty(event, "clientY", { value: 0 });
  return event;
};

afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.replaceChildren();
});

describe("escapeMarkdownImageDestination", () => {
  it.each([
    ["assets/pic.png", "assets/pic.png"],
    ["assets/my pic.png", "<assets/my pic.png>"],
    ["assets/pic (1).png", "<assets/pic (1).png>"],
    ["assets/a<b>.png", "<assets/a%3Cb%3E.png>"],
  ])("escapes %s", (input, expected) => {
    expect(escapeMarkdownImageDestination(input)).toBe(expected);
  });
});

describe("imagePasteExtension", () => {
  it("saves a pasted PNG bitmap and inserts markdown in one undoable transaction", async () => {
    const saveClipboardImage = vi.fn(async (_input: ClipboardImageInput) => "assets/pasted.png");
    const view = createView(saveClipboardImage);

    const event = pasteEvent(new File([new Uint8Array([1, 2, 3])], "clipboard.png", { type: "image/png" }));
    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("![image](assets/pasted.png)"));
    expect(saveClipboardImage).toHaveBeenCalledTimes(1);
    const input = saveClipboardImage.mock.calls[0][0];
    expect(input.mimeType).toBe("image/png");
    expect(input.documentPath).toBe("/notes/a.md");
    expect([...input.bytes]).toEqual([1, 2, 3]);

    undo(view);
    expect(view.state.doc.toString()).toBe("");
  });

  it("inserts nothing when the save dialog is cancelled", async () => {
    const saveClipboardImage = vi.fn(async (_input: ClipboardImageInput) => null);
    const view = createView(saveClipboardImage);

    const event = pasteEvent(new File([new Uint8Array([1])], "clipboard.png", { type: "image/png" }));
    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(saveClipboardImage).toHaveBeenCalledTimes(1));
    expect(view.state.doc.toString()).toBe("");
  });

  it("supports unsaved documents by passing a null document path", async () => {
    const saveClipboardImage = vi.fn(async (_input: ClipboardImageInput) => "/tmp/image-1.png");
    const view = createView(saveClipboardImage, null);

    view.contentDOM.dispatchEvent(
      pasteEvent(new File([new Uint8Array([255, 216])], "clipboard.jpg", { type: "image/jpeg" }), "image/jpeg"),
    );

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("![image](/tmp/image-1.png)"));
    expect(saveClipboardImage.mock.calls[0][0]).toMatchObject({
      mimeType: "image/jpeg",
      documentPath: null,
    });
  });

  it("escapes spaces in the saved path", async () => {
    const saveClipboardImage = vi.fn(async (_input: ClipboardImageInput) => "assets/my pic.png");
    const view = createView(saveClipboardImage);

    view.contentDOM.dispatchEvent(
      pasteEvent(new File([new Uint8Array([1])], "clipboard.png", { type: "image/png" })),
    );

    await vi.waitFor(() =>
      expect(view.state.doc.toString()).toBe("![image](<assets/my pic.png>)"),
    );
  });

  it("ignores non-image clipboard content", async () => {
    const saveClipboardImage = vi.fn(async (_input: ClipboardImageInput) => "x.png");
    const view = createView(saveClipboardImage);

    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
        getData: () => "",
      },
    });
    view.contentDOM.dispatchEvent(event);

    expect(saveClipboardImage).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("");
  });

  it("inserts a dropped image file in place without copying it", async () => {
    const saveClipboardImage = vi.fn(async (_input: ClipboardImageInput) => "copied.png");
    const view = createView(saveClipboardImage);
    const file = new File([new Uint8Array([1])], "dropped pic.png", { type: "image/png" });
    Object.defineProperty(file, "path", { value: "/Pictures/dropped pic.png" });

    const event = dropEvent(file);
    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("![image](</Pictures/dropped pic.png>)");
    expect(saveClipboardImage).not.toHaveBeenCalled();
  });

  it("resolves a dropped file from a file:// uri-list when no path is carried", async () => {
    const saveClipboardImage = vi.fn(async (_input: ClipboardImageInput) => null);
    const view = createView(saveClipboardImage);
    const file = new File([new Uint8Array([1])], "pic.png", { type: "image/png" });

    view.contentDOM.dispatchEvent(
      dropEvent(file, { "text/uri-list": "file:///Pictures/pic%20one.png" }),
    );

    expect(view.state.doc.toString()).toBe("![image](</Pictures/pic one.png>)");
    expect(saveClipboardImage).not.toHaveBeenCalled();
  });

  it("ignores drops without an image file", async () => {
    const saveClipboardImage = vi.fn(async (_input: ClipboardImageInput) => null);
    const view = createView(saveClipboardImage);
    const file = new File([new Uint8Array([1])], "note.md", { type: "text/markdown" });

    view.contentDOM.dispatchEvent(
      dropEvent(file, { "text/uri-list": "file:///notes/note.md" }),
    );

    expect(view.state.doc.toString()).toBe("");
    expect(saveClipboardImage).not.toHaveBeenCalled();
  });

  it("swallows drops on a read-only view without inserting", async () => {
    const saveClipboardImage = vi.fn(async (_input: ClipboardImageInput) => null);
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "locked",
        extensions: [
          EditorState.readOnly.of(true),
          markdown({ extensions: [GFM] }),
          imagePasteExtension({ saveClipboardImage, getDocumentPath: () => "/notes/a.md" }),
        ],
      }),
    });
    views.push(view);
    const file = new File([new Uint8Array([1])], "pic.png", { type: "image/png" });

    const event = dropEvent(file, { "text/uri-list": "file:///Pictures/pic.png" });
    view.contentDOM.dispatchEvent(event);

    // The drop is consumed (no browser navigation) but never inserted.
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("locked");
    expect(saveClipboardImage).not.toHaveBeenCalled();
  });
});
