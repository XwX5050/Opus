import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, describe, expect, it } from "vitest";
import { mathMarkdownExtension } from "./mathExtension";
import {
  MathWidget,
  mathWidgetsExtension,
  planMathWidgets,
} from "./mathWidgets";

const createState = (
  doc: string,
  selections: readonly { anchor: number; head?: number }[] = [
    { anchor: doc.length },
  ],
) =>
  EditorState.create({
    doc,
    selection: EditorSelection.create(
      selections.map(({ anchor, head = anchor }) =>
        EditorSelection.range(anchor, head),
      ),
    ),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ extensions: [GFM, mathMarkdownExtension] }),
    ],
  });

const views: EditorView[] = [];
const createView = (
  doc: string,
  anchor = doc.length,
  extraExtensions: Extension = [],
) => {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdown({ extensions: [GFM, mathMarkdownExtension] }),
        mathWidgetsExtension(),
        extraExtensions ?? [],
      ],
    }),
  });
  views.push(view);
  return view;
};

const atomicRanges = (view: EditorView) => {
  const ranges: { from: number; to: number }[] = [];
  for (const provider of view.state.facet(EditorView.atomicRanges)) {
    provider(view).between(0, view.state.doc.length, (from, to) => {
      ranges.push({ from, to });
    });
  }
  return ranges;
};

afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.replaceChildren();
});

describe("MathWidget", () => {
  it("renders valid inline and display formulas with KaTeX", () => {
    const inline = new MathWidget("x^2", false).toDOM();
    const block = new MathWidget("x^2", true).toDOM();

    expect(inline).toHaveClass("md-math", "md-math-inline");
    expect(block).toHaveClass("md-math", "md-math-block");
    expect(inline.querySelector(".katex")).not.toBeNull();
    expect(block.querySelector(".katex-display")).not.toBeNull();
  });

  it("uses source/displayMode equality and lets the editor handle selection events", () => {
    const widget = new MathWidget("x", false);
    expect(widget.eq(new MathWidget("x", false))).toBe(true);
    expect(widget.eq(new MathWidget("x", true))).toBe(false);
    expect(widget.eq(new MathWidget("y", false))).toBe(false);
    expect(widget.ignoreEvent()).toBe(false);
  });

  it("turns invalid math into readable text without injecting user HTML", () => {
    const source = String.raw`\bad{<img src=x onerror=alert(1)>`;
    const dom = new MathWidget(source, false).toDOM();

    expect(dom).toHaveClass("md-math-error");
    expect(dom.textContent).toContain(source);
    expect(dom.querySelector("img")).toBeNull();
  });

  it("does not create trusted links or HTML from security payloads", () => {
    const href = new MathWidget(
      String.raw`\href{javascript:alert(1)}{click}`,
      false,
    ).toDOM();
    const html = new MathWidget("<button onclick=alert(1)>x</button>", false).toDOM();

    expect(href.querySelector("a")).toBeNull();
    expect(html.querySelector("button")).toBeNull();
    expect(href.querySelector(".katex")).not.toBeNull();
    expect(html.querySelector(".katex")).not.toBeNull();
  });
});

describe("planMathWidgets", () => {
  it("extracts inline source and block interior while preserving interior line breaks", () => {
    const doc = ["$x^2$", "", "  $$  ", "a +", "b", "  $$", "", "end"].join("\n");
    const state = createState(doc);

    expect(planMathWidgets(state).map(({ source, displayMode }) => ({ source, displayMode })))
      .toEqual([
        { source: "x^2", displayMode: false },
        { source: "a +\nb", displayMode: true },
      ]);
  });

  it.each([
    ["opening delimiter", 0],
    ["content", 2],
    ["closing delimiter", 4],
    ["node end boundary", 5],
  ])("reveals the full source at the %s", (_label, cursor) => {
    expect(planMathWidgets(createState("$x^2$ outside", [{ anchor: cursor }]))).toEqual([]);
  });

  it("reveals every formula touched by multiple cursors and a cross-formula selection", () => {
    const doc = "$a$ and $b$ and $c$";
    const state = createState(doc, [
      { anchor: 1 },
      { anchor: doc.indexOf("$b$"), head: doc.indexOf("$c$") + 2 },
    ]);
    expect(planMathWidgets(state)).toEqual([]);
  });

  it("keeps the widget planned under the cursor when revealSelection is false", () => {
    const state = createState("$x^2$ outside", [{ anchor: 2 }]);
    const planned = planMathWidgets(state, undefined, undefined, [], {
      revealSelection: false,
    });
    expect(planned).toHaveLength(1);
    expect(planned[0].source).toBe("x^2");
  });

  it("limits syntax traversal and plans to requested visible ranges", () => {
    const doc = `${Array.from({ length: 200 }, (_, index) => `$x_${index}$`).join("\n\n")}\n\noutside`;
    const state = createState(doc);
    const target = "$x_100$";
    const from = doc.indexOf(target);
    const full = { visitedNodes: 0 };
    const visible = { visitedNodes: 0 };

    expect(planMathWidgets(state, undefined, full)).toHaveLength(200);
    expect(planMathWidgets(state, [{ from, to: from + target.length }], visible))
      .toEqual([{ from, to: from + target.length, source: "x_100", displayMode: false }]);
    expect(visible.visitedNodes).toBeLessThan(full.visitedNodes / 100);
  });
});

describe("mathWidgetsExtension", () => {
  it("replaces a complete node with a widget and makes that node atomic", () => {
    const view = createView("$x^2$ outside");
    const widget = view.dom.querySelector(".md-math");

    expect(widget?.querySelector(".katex")).not.toBeNull();
    expect(view.contentDOM.textContent).not.toContain("$x^2$");
    expect(atomicRanges(view)).toContainEqual({ from: 0, to: 5 });
  });

  it("renders multiline BlockMath as a display widget in an EditorView", () => {
    const doc = "$$\na +\nb\n$$\n\noutside";
    const view = createView(doc);
    const widget = view.dom.querySelector(".md-math-block");
    const continuationLines = view.dom.querySelectorAll(
      ".cm-block-math-continuation",
    );

    expect(widget).toHaveClass("md-math");
    expect(widget?.querySelector(".katex-display")).not.toBeNull();
    expect(view.contentDOM.textContent).not.toContain("$$");
    expect(continuationLines).toHaveLength(3);
    expect(getComputedStyle(continuationLines[0]).height).toBe("0px");
    expect(getComputedStyle(continuationLines[0]).lineHeight).toBe("0");
    expect(atomicRanges(view)).toContainEqual({ from: 0, to: 11 });
  });

  it("keeps another atomicRanges provider instead of overwriting it", () => {
    const other = EditorView.atomicRanges.of(() => DecorationSetFixture);
    const view = createView("$x$ outside", "$x$ outside".length, other);

    expect(view.state.facet(EditorView.atomicRanges)).toHaveLength(2);
    expect(atomicRanges(view)).toContainEqual({ from: 0, to: 3 });
    expect(atomicRanges(view)).toContainEqual({ from: 4, to: 5 });
  });

  it("keeps the composing formula as source until composition ends", () => {
    const doc = "$first$ and $second$ outside";
    const view = createView(doc, 2);
    expect(view.dom.querySelectorAll(".md-math")).toHaveLength(1);

    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view.dispatch({ selection: { anchor: doc.length } });
    expect(view.contentDOM.textContent).toContain("$first$");
    expect(view.dom.querySelectorAll(".md-math")).toHaveLength(1);

    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(view.contentDOM.textContent).not.toContain("$first$");
    expect(view.dom.querySelectorAll(".md-math")).toHaveLength(2);
  });
});

// A small non-empty RangeSet fixture for testing provider composition.
const DecorationSetFixture = Decoration.set([
  Decoration.replace({}).range(4, 5),
]);
