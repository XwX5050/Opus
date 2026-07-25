import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ImageWidget,
  imageWidgetsExtension,
  planImageWidgets,
  resolveImageSrc,
  type ImageWidgetEnvironment,
} from "./imageWidgets";

const fakeResolve = (path: string) => `asset://resolved${path}`;

const environment = (documentPath: string | null = "/notes/a.md"): ImageWidgetEnvironment => ({
  getDocumentPath: () => documentPath,
  resolveLocalUrl: fakeResolve,
});

const createState = (doc: string, anchor = doc.length) =>
  EditorState.create({
    doc,
    selection: EditorSelection.create([EditorSelection.cursor(anchor)]),
    extensions: [markdown({ extensions: [GFM] })],
  });

const views: EditorView[] = [];

afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.replaceChildren();
});

describe("resolveImageSrc", () => {
  it("resolves relative paths from the active document directory", () => {
    expect(resolveImageSrc("pics/cat.png", "/notes/a.md", fakeResolve)).toBe(
      "asset://resolved/notes/pics/cat.png",
    );
  });

  it("passes absolute paths straight to the local resolver", () => {
    expect(resolveImageSrc("/img/cat.png", "/notes/a.md", fakeResolve)).toBe(
      "asset://resolved/img/cat.png",
    );
  });

  it("keeps https URLs untouched", () => {
    expect(resolveImageSrc("https://example.com/cat.png", "/notes/a.md", fakeResolve)).toBe(
      "https://example.com/cat.png",
    );
  });

  it("rejects relative paths for unsaved documents", () => {
    expect(resolveImageSrc("pics/cat.png", null, fakeResolve)).toBeNull();
  });

  it.each([
    ["document.pdf"],
    ["https://example.com/document.pdf"],
    ["https://example.com/no-extension"],
    ["javascript:alert(1)"],
    ["data:image/png;base64,AAAA"],
    ["file:///etc/passwd.png"],
  ])("rejects %s", (url) => {
    expect(resolveImageSrc(url, "/notes/a.md", fakeResolve)).toBeNull();
  });
});

describe("planImageWidgets", () => {
  it("plans widgets for relative, absolute, and https images with alt text", () => {
    const doc = "![cat](pics/cat.png)\n\n![abs](/img/dog.jpg)\n\n![net](https://example.com/x.gif) rest";
    const planned = planImageWidgets(createState(doc), environment());
    expect(planned.map(({ alt, src }) => ({ alt, src }))).toEqual([
      { alt: "cat", src: "asset://resolved/notes/pics/cat.png" },
      { alt: "abs", src: "asset://resolved/img/dog.jpg" },
      { alt: "net", src: "https://example.com/x.gif" },
    ]);
  });

  it("skips non-image and dangerous destinations", () => {
    const doc = "![doc](spec.pdf)\n\n![bad](javascript:alert(1))\n\n![ok](fine.png) rest";
    const planned = planImageWidgets(createState(doc), environment());
    expect(planned).toHaveLength(1);
    expect(planned[0].alt).toBe("ok");
  });

  it("unwraps angle-bracket destinations", () => {
    const planned = planImageWidgets(createState("![x](<my pic.png>) rest"), environment());
    expect(planned[0].src).toBe("asset://resolved/notes/my pic.png");
  });

  it("reveals the Markdown source when the selection touches the image", () => {
    const doc = "![cat](pics/cat.png) rest";
    const selected = planImageWidgets(createState(doc, 5), environment());
    expect(selected).toEqual([]);
    const outside = planImageWidgets(createState(doc, doc.length), environment());
    expect(outside).toHaveLength(1);
  });

  it("keeps the widget planned under the cursor when revealSelection is false", () => {
    const doc = "![cat](pics/cat.png) rest";
    const planned = planImageWidgets(
      createState(doc, 5),
      environment(),
      undefined,
      undefined,
      { revealSelection: false },
    );
    expect(planned).toHaveLength(1);
    expect(planned[0].alt).toBe("cat");
  });

  it("only plans widgets inside the given ranges", () => {
    const doc = "![a](a.png)\n\n![b](b.png)";
    const planned = planImageWidgets(createState(doc), environment(), [
      { from: 0, to: 10 },
    ]);
    expect(planned).toHaveLength(1);
    expect(planned[0].alt).toBe("a");
  });
});

describe("ImageWidget", () => {
  it("renders an img with the resolved src and alt text", () => {
    const dom = new ImageWidget("asset://resolved/notes/cat.png", "cat").toDOM();
    const image = dom.querySelector("img");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("src")).toBe("asset://resolved/notes/cat.png");
    expect(image?.getAttribute("alt")).toBe("cat");
  });

  it("shows alt text and a broken indicator when loading fails", () => {
    const dom = new ImageWidget("asset://resolved/notes/missing.png", "missing cat").toDOM();
    dom.querySelector("img")?.dispatchEvent(new Event("error"));
    expect(dom).toHaveClass("md-image-broken");
    expect(dom.querySelector("img")).toBeNull();
    const indicator = dom.querySelector(".md-image-broken-indicator");
    expect(indicator).not.toBeNull();
    expect(indicator).toHaveTextContent("missing cat");
    expect(indicator?.getAttribute("aria-label")).toContain("missing cat");
  });
});

describe("imageWidgetsExtension", () => {
  const createView = (doc: string, anchor = doc.length) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor },
        extensions: [
          markdown({ extensions: [GFM] }),
          imageWidgetsExtension(environment()),
        ],
      }),
    });
    views.push(view);
    return view;
  };

  it("mounts image widgets in the live view", () => {
    createView("![cat](cat.png) rest");
    const image = document.querySelector<HTMLImageElement>(".md-image-widget img");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("src")).toBe("asset://resolved/notes/cat.png");
  });

  it("never mounts a widget for javascript: destinations", () => {
    const view = createView("![bad](javascript:alert(1)) rest");
    expect(document.querySelector(".md-image-widget")).toBeNull();
    expect(view.state.doc.toString()).toBe("![bad](javascript:alert(1)) rest");
  });

  it("reveals the source while the cursor is inside and restores the widget after leaving", () => {
    const doc = "![cat](cat.png) rest";
    const view = createView(doc, 3);
    expect(document.querySelector(".md-image-widget")).toBeNull();
    view.dispatch({ selection: { anchor: doc.length } });
    expect(document.querySelector(".md-image-widget")).not.toBeNull();
  });
});
