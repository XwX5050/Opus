import { markdown } from "@codemirror/lang-markdown";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, describe, expect, it } from "vitest";
import {
  codeBlockAutoClose,
  codeBlockAutoCloseBackspace,
  codeBlockAutoCloseInput,
} from "./codeBlockAutoClose";

const views: EditorView[] = [];

const createView = (
  doc: string,
  anchor = doc.length,
  head?: number,
  extraExtensions: Extension = [],
) => {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: head === undefined ? { anchor } : { anchor, head },
      extensions: [markdown({ extensions: [GFM] }), codeBlockAutoClose(), extraExtensions],
    }),
  });
  views.push(view);
  return view;
};

// Simulates a single keystroke through the exact contract the
// EditorView.inputHandler facet invokes: the handler runs against the
// pre-insertion state, and a false return falls through to the default
// insertion (which the facet applies when no handler claims the input).
const type = (view: EditorView, text: string): boolean => {
  const main = view.state.selection.main;
  const handled = codeBlockAutoCloseInput(view, main.from, main.to, text);
  if (!handled) {
    view.dispatch({
      changes: { from: main.from, to: main.to, insert: text },
      selection: { anchor: main.from + text.length },
      userEvent: "input.type",
    });
  }
  return handled;
};

afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.replaceChildren();
});

describe("fence auto-close", () => {
  it("inserts the closing fence once when the third backtick completes a bare line", () => {
    const view = createView("");
    type(view, "`");
    expect(view.state.doc.toString()).toBe("`");
    type(view, "`");
    expect(view.state.doc.toString()).toBe("``");
    type(view, "`");
    expect(view.state.doc.toString()).toBe("```\n```");
    // The cursor sits at the end of the opening fence, ready for a language
    // name before Enter drops into the block.
    expect(view.state.selection.main.from).toBe(3);
    expect(view.state.selection.main.empty).toBe(true);
  });

  it("never inserts a second closing fence on repeated input", () => {
    const view = createView("");
    [..."``````"].forEach((char) => type(view, char));
    expect(view.state.doc.toString()).toBe("``````\n```");
    expect(view.state.selection.main.from).toBe(6);
  });

  it("skips when a closing fence already exists below", () => {
    const view = createView("``\n\n```\n", 2);
    expect(type(view, "`")).toBe(false);
    expect(view.state.doc.toString()).toBe("```\n\n```\n");
  });

  it("does not treat a fence typed inside an open block as an opener", () => {
    const view = createView("```js\ncode\n``", 12);
    expect(type(view, "`")).toBe(false);
    expect(view.state.doc.toString()).toBe("```js\ncode\n```");
  });

  it("auto-closes ~~~ fences too", () => {
    const view = createView("");
    type(view, "~");
    type(view, "~");
    type(view, "~");
    expect(view.state.doc.toString()).toBe("~~~\n~~~");
    expect(view.state.selection.main.from).toBe(3);
  });
});

describe("pair auto-close inside fenced code", () => {
  it.each([
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ])("inserts %s%s with the cursor between, then steps over the closer", (open, close) => {
    const view = createView("```js\nfoo\n```", 9);
    expect(type(view, open)).toBe(true);
    expect(view.state.doc.toString()).toBe(`\`\`\`js\nfoo${open}${close}\n\`\`\``);
    expect(view.state.selection.main.from).toBe(10);
    // Typing the closer when the next char is already it just steps over.
    expect(type(view, close)).toBe(true);
    expect(view.state.doc.toString()).toBe(`\`\`\`js\nfoo${open}${close}\n\`\`\``);
    expect(view.state.selection.main.from).toBe(11);
  });

  it("wraps an active selection inside the block", () => {
    const view = createView("```js\nfoo\n```", 6, 9);
    expect(type(view, "[")).toBe(true);
    expect(view.state.doc.toString()).toBe("```js\n[foo]\n```");
    expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([7, 10]);
  });

  it("inserts the quote pair away from word characters", () => {
    const view = createView("```js\nabc \n```", 10);
    expect(type(view, "'")).toBe(true);
    expect(view.state.doc.toString()).toBe("```js\nabc ''\n```");
    expect(view.state.selection.main.from).toBe(11);
  });

  it("keeps quotes plain directly after a word character", () => {
    const view = createView("```js\nabc\n```", 9);
    expect(type(view, '"')).toBe(false);
    expect(view.state.doc.toString()).toBe("```js\nabc\"\n```");
  });

  it("deletes an empty pair on Backspace inside the block", () => {
    const view = createView("```js\n()\n```", 7);
    expect(codeBlockAutoCloseBackspace(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("```js\n\n```");
    expect(view.state.selection.main.from).toBe(6);
  });

  it("never auto-closes backticks as a pair — they belong to fences", () => {
    const view = createView("```js\nfoo\n```", 9);
    expect(type(view, "`")).toBe(false);
    expect(view.state.doc.toString()).toBe("```js\nfoo`\n```");
  });

  it("leaves a closer alone when the next char is not it", () => {
    const view = createView("```js\nfoo\n```", 9);
    expect(type(view, ")")).toBe(false);
    expect(view.state.doc.toString()).toBe("```js\nfoo)\n```");
  });

  it("is inert in read-only views", () => {
    const view = createView("```js\nfoo\n```", 9, undefined, [
      EditorState.readOnly.of(true),
    ]);
    const main = view.state.selection.main;
    expect(codeBlockAutoCloseInput(view, main.from, main.to, "(")).toBe(false);
    expect(view.state.doc.toString()).toBe("```js\nfoo\n```");
  });
});

describe("pair auto-close stays outside fenced code", () => {
  it("leaves prose paragraphs untouched", () => {
    const view = createView("hello world", 5);
    expect(type(view, "(")).toBe(false);
    expect(view.state.doc.toString()).toBe("hello( world");
  });

  it("does not step over closers in prose", () => {
    const view = createView("a)b", 1);
    expect(type(view, ")")).toBe(false);
    expect(view.state.doc.toString()).toBe("a))b");
  });

  it("leaves an empty pair alone on Backspace in prose", () => {
    const view = createView("a () b", 3);
    expect(codeBlockAutoCloseBackspace(view)).toBe(false);
  });

  it("leaves inline code untouched", () => {
    const view = createView("`code` here", 3);
    expect(type(view, "(")).toBe(false);
    expect(view.state.doc.toString()).toBe("`co(de` here");
    expect(codeBlockAutoCloseBackspace(view)).toBe(false);
  });

  it("does not wrap prose selections", () => {
    const view = createView("hello world", 0, 5);
    expect(type(view, "(")).toBe(false);
    expect(view.state.doc.toString()).toBe("( world");
  });
});
