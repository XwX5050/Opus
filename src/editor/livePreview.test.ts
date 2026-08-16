import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { highlightMarkdownExtension } from "./highlightExtension";
import {
  livePreviewExtension,
  planLivePreview,
  type PlannedDecoration,
} from "./livePreview";

const createState = (
  doc: string,
  ranges: readonly { anchor: number; head?: number }[] = [{ anchor: doc.length }],
) =>
  EditorState.create({
    doc,
    selection: EditorSelection.create(
      ranges.map(({ anchor, head = anchor }) => EditorSelection.range(anchor, head)),
    ),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ extensions: [GFM, highlightMarkdownExtension] }),
    ],
  });

const hiddenSource = (state: EditorState, plan: readonly PlannedDecoration[]) =>
  plan
    .filter(({ kind }) => kind !== "mark" && kind !== "line")
    .map(({ from, to }) => state.sliceDoc(from, to));

const markedAs = (plan: readonly PlannedDecoration[], className: string) =>
  plan.filter((item) => item.kind === "mark" && item.className === className);

const linesMarkedAs = (
  plan: readonly PlannedDecoration[],
  className: string,
) =>
  plan.filter(
    (item) => item.kind === "line" && item.className?.includes(className),
  );

describe("planLivePreview", () => {
  it("plans all supported constructs from a real GFM syntax tree", () => {
    const doc = [
      "# Head",
      "",
      "*em* **strong** ~~strike~~ `code` [label](https://example.com)",
      "",
      "> quote",
      "",
      "1. ordered",
      "- bullet",
      "",
      "```ts",
      "const answer = 42",
      "```",
      "",
      "---",
    ].join("\n");
    const state = createState(doc, [{ anchor: doc.indexOf("Head") + 1 }]);

    expect(syntaxTree(state).toString()).toContain("StrongEmphasis");
    expect(syntaxTree(state).toString()).toContain("FencedCode");

    const plan = planLivePreview(state);
    const hidden = hiddenSource(state, plan);
    expect(hidden).toEqual(
      expect.arrayContaining([
        "*",
        "**",
        "~~",
        "`",
        "[",
        "]",
        "(https://example.com)",
        ">",
        "1.",
        "-",
        "```",
        "ts",
        "---",
      ]),
    );
    expect(hidden).not.toContain("#");
    expect(hidden).not.toContain("const answer = 42");
    expect(markedAs(plan, "cm-live-preview-heading-1")).toHaveLength(1);
    expect(markedAs(plan, "cm-live-preview-emphasis")).toHaveLength(1);
    expect(markedAs(plan, "cm-live-preview-strong")).toHaveLength(1);
    expect(markedAs(plan, "cm-live-preview-strikethrough")).toHaveLength(1);
    expect(markedAs(plan, "cm-live-preview-inline-code")).toHaveLength(1);
    expect(markedAs(plan, "cm-live-preview-quote")).toHaveLength(1);
    expect(markedAs(plan, "cm-live-preview-code-block")).toHaveLength(1);
    expect(markedAs(plan, "cm-live-preview-link")).toHaveLength(1);
  });

  it("plans a single card line for a one-line blockquote", () => {
    const state = createState("> quote", [{ anchor: 7 }]);

    expect(
      linesMarkedAs(
        planLivePreview(state),
        "cm-live-preview-quote-line-single",
      ),
    ).toEqual([
      {
        from: 0,
        to: 7,
        kind: "line",
        className:
          "cm-live-preview-quote-line cm-live-preview-quote-line-single",
      },
    ]);
  });

  it("plans continuous first, middle, and last blockquote card lines", () => {
    const doc = "> first\n> middle\n> last";
    const state = createState(doc, [{ anchor: doc.length }]);

    expect(
      planLivePreview(state)
        .filter(({ kind }) => kind === "line")
        .map(({ from, to, className }) => ({ from, to, className })),
    ).toEqual([
      {
        from: 0,
        to: 7,
        className:
          "cm-live-preview-quote-line cm-live-preview-quote-line-first",
      },
      {
        from: 8,
        to: 16,
        className:
          "cm-live-preview-quote-line cm-live-preview-quote-line-middle",
      },
      {
        from: 17,
        to: 23,
        className:
          "cm-live-preview-quote-line cm-live-preview-quote-line-last",
      },
    ]);
  });

  it.each([
    ["opening delimiter", 0],
    ["content", 4],
    ["closing delimiter", 8],
    ["node end boundary", 9],
  ])("reveals an entire strong node at its %s", (_label, cursor) => {
    const state = createState("**world** rest", [{ anchor: cursor }]);
    expect(hiddenSource(state, planLivePreview(state))).not.toContain("**");
  });

  it("hides both strong delimiters when every selection is outside", () => {
    const state = createState("**world** rest", [{ anchor: 12 }]);
    expect(hiddenSource(state, planLivePreview(state)).filter((text) => text === "**"))
      .toHaveLength(2);
  });

  it("hides markers even under the cursor when revealSelection is false", () => {
    const state = createState("**world** rest", [{ anchor: 4 }]);
    const plan = planLivePreview(state, undefined, undefined, {
      revealSelection: false,
    });
    expect(hiddenSource(state, plan).filter((text) => text === "**")).toHaveLength(2);
  });

  it("marks the complete highlight node and hides both delimiters outside selection", () => {
    const state = createState("==重点== outside", [{ anchor: 10 }]);
    const plan = planLivePreview(state);

    expect(hiddenSource(state, plan)).toEqual(["==", "=="]);
    expect(markedAs(plan, "cm-live-preview-highlight")).toEqual([
      {
        from: 0,
        to: 6,
        kind: "mark",
        className: "cm-live-preview-highlight",
      },
    ]);
  });

  it("reveals highlight delimiters under the cursor without removing the highlight", () => {
    const state = createState("==重点== outside", [{ anchor: 3 }]);
    const plan = planLivePreview(state);

    expect(hiddenSource(state, plan)).toEqual([]);
    expect(markedAs(plan, "cm-live-preview-highlight")).toHaveLength(1);
  });

  it("keeps revealed nested source markers inside the highlight while editing", () => {
    const doc = "> 📌 ==text `D = -D`==";
    const state = createState(doc, [
      { anchor: doc.indexOf("D = -D") + 2 },
    ]);
    const plan = planLivePreview(state);

    expect(markedAs(plan, "cm-live-preview-highlight")).toEqual([
      {
        from: doc.indexOf("=="),
        to: doc.lastIndexOf("==") + 2,
        kind: "mark",
        className: "cm-live-preview-highlight",
      },
    ]);
    expect(hiddenSource(state, plan)).toEqual([]);
  });

  it("hides every nested source marker while keeping the full reading highlight", () => {
    const doc = "> 📌 ==text `D = -D`==";
    const state = createState(doc, [
      { anchor: doc.indexOf("D = -D") + 2 },
    ]);
    const plan = planLivePreview(state, undefined, undefined, {
      revealSelection: false,
    });
    const hidden = hiddenSource(state, plan);

    expect(hidden.filter((source) => source === ">")).toHaveLength(1);
    expect(hidden.filter((source) => source === "==")).toHaveLength(2);
    expect(hidden.filter((source) => source === "`")).toHaveLength(2);
    expect(markedAs(plan, "cm-live-preview-highlight")).toEqual([
      {
        from: doc.indexOf("=="),
        to: doc.lastIndexOf("==") + 2,
        kind: "mark",
        className: "cm-live-preview-highlight",
      },
    ]);
  });

  it("keeps highlight delimiters hidden in reading mode under the cursor", () => {
    const state = createState("==重点== outside", [{ anchor: 3 }]);
    const plan = planLivePreview(state, undefined, undefined, {
      revealSelection: false,
    });

    expect(hiddenSource(state, plan)).toEqual(["==", "=="]);
    expect(markedAs(plan, "cm-live-preview-highlight")).toHaveLength(1);
  });

  it("reveals both adjacent structures when the cursor sits on their shared boundary", () => {
    const doc = "*one*~~two~~";
    const boundary = doc.indexOf("~~");
    const state = createState(doc, [{ anchor: boundary }]);
    expect(hiddenSource(state, planLivePreview(state))).toEqual([]);
  });

  it("reveals every structure touched by multiple cursors and selections", () => {
    const doc = "*one* and **two** and ~~three~~";
    const state = createState(doc, [
      { anchor: doc.indexOf("one") + 1 },
      { anchor: doc.indexOf("two"), head: doc.indexOf("three") + 2 },
    ]);
    expect(hiddenSource(state, planLivePreview(state))).toEqual([]);
  });

  it("reveals parent and child delimiters for a selection inside a nested link", () => {
    const doc = "[*nested*](url) outside";
    const from = doc.indexOf("nested");
    const state = createState(doc, [{ anchor: from, head: from + 3 }]);
    expect(hiddenSource(state, planLivePreview(state))).toEqual([]);
  });

  it("emits sorted, unique, valid ranges without overlapping replacements", () => {
    const state = createState("***both*** [label](url) `code`", [{ anchor: 12 }]);
    const plan = planLivePreview(state);
    expect(plan).toEqual([...plan].sort((a, b) => a.from - b.from || a.to - b.to || a.kind.localeCompare(b.kind)));
    expect(new Set(plan.map((item) => `${item.kind}:${item.from}:${item.to}:${item.className ?? ""}`)).size)
      .toBe(plan.length);
    for (const item of plan) {
      expect(item.from).toBeGreaterThanOrEqual(0);
      expect(item.to).toBeGreaterThan(item.from);
      expect(item.to).toBeLessThanOrEqual(state.doc.length);
    }
    const replacements = plan.filter(({ kind }) => kind !== "mark");
    for (let index = 1; index < replacements.length; index += 1) {
      expect(replacements[index - 1].to).toBeLessThanOrEqual(replacements[index].from);
    }
  });

  it("replaces source list marks with equivalent bullet and number plans", () => {
    const doc = "- bullet\n\n2. ordered\n\noutside";
    const state = createState(doc, [{ anchor: doc.length }]);
    const listMarkers = planLivePreview(state).filter(({ kind }) => kind === "list-marker");
    expect(listMarkers.map(({ displayText }) => displayText)).toEqual(["•", "2."]);
  });

  it("styles autolinks while hiding only their angle brackets", () => {
    const state = createState("<https://example.com> outside", [{ anchor: 24 }]);
    const plan = planLivePreview(state);
    expect(hiddenSource(state, plan)).toEqual(["<", ">"]);
    expect(markedAs(plan, "cm-live-preview-link")).toHaveLength(1);
  });

  it("hides inline link destinations, titles, and delimiters while keeping the label", () => {
    const doc = "[label](url \"title\") outside";
    const state = createState(doc, [{ anchor: doc.length }]);
    expect(syntaxTree(state).toString()).toContain("URL,LinkTitle");
    expect(hiddenSource(state, planLivePreview(state))).toEqual([
      "[",
      "]",
      "(url \"title\")",
    ]);
  });

  it.each([
    ["trailing space", "[label](url ) outside", "(url )"],
    ["line break", "[label](url\n) outside", "(url\n)"],
    ["angled destination spacing", "[label]( <url> ) outside", "( <url> )"],
  ])("collapses the complete inline destination with %s", (_label, doc, destination) => {
    const state = createState(doc, [{ anchor: doc.length }]);
    expect(syntaxTree(state).toString()).toContain("Link(LinkMark,LinkMark,LinkMark,URL,LinkMark)");
    expect(hiddenSource(state, planLivePreview(state))).toEqual(["[", "]", destination]);
  });

  it("hides a reference link label but keeps and marks its definition as source", () => {
    const doc = "[label][ref]\n\n[ref]: https://example.com \"Title\"\n\noutside";
    const state = createState(doc, [{ anchor: doc.length }]);
    const tree = syntaxTree(state).toString();
    expect(tree).toContain("LinkLabel");
    expect(tree).toContain("LinkReference");
    const plan = planLivePreview(state);
    expect(hiddenSource(state, plan)).toEqual(["[", "]", "[ref]"]);
    expect(markedAs(plan, "cm-live-preview-reference-definition")).toHaveLength(1);
  });

  it("marks bare GFM URLs without replacing their readable text", () => {
    const doc = "https://example.com and www.example.com outside";
    const state = createState(doc, [{ anchor: doc.length }]);
    expect(syntaxTree(state).toString()).toContain("Paragraph(URL,URL)");
    const plan = planLivePreview(state);
    expect(hiddenSource(state, plan)).toEqual([]);
    expect(markedAs(plan, "cm-live-preview-link")).toHaveLength(2);
  });

  it("marks bare URLs under emphasis, strong emphasis, and table-cell ancestors", () => {
    const doc = [
      "*https://example.com* **www.example.com**",
      "",
      "| url |",
      "| --- |",
      "| https://table.example.com |",
      "",
      "outside",
    ].join("\n");
    const state = createState(doc, [{ anchor: doc.length }]);
    const tree = syntaxTree(state).toString();
    expect(tree).toContain("Emphasis(EmphasisMark,URL,EmphasisMark)");
    expect(tree).toContain("StrongEmphasis(EmphasisMark,URL,EmphasisMark)");
    expect(tree).toContain("TableCell(URL)");
    const links = markedAs(planLivePreview(state), "cm-live-preview-link");
    expect(links).toHaveLength(3);
    expect(new Set(links.map(({ from, to }) => `${from}:${to}`)).size).toBe(3);
  });

  it("plans checked and unchecked task widgets from GFM nodes", () => {
    const doc = "- [ ] todo\n- [x] done\n\noutside";
    const state = createState(doc, [{ anchor: doc.length }]);
    expect(syntaxTree(state).toString()).toContain("Task(TaskMarker)");
    const tasks = planLivePreview(state).filter(({ kind }) => kind === "task-checkbox");
    expect(tasks.map(({ checked }) => checked)).toEqual([false, true]);
    expect(hiddenSource(state, tasks)).toEqual(["[ ]", "[x]"]);
  });

  it("reveals the task source while keeping the sibling task's marker hidden", () => {
    const doc = "- [ ] todo\n- [x] done\n\noutside";
    const state = createState(doc, [{ anchor: doc.indexOf("[ ]") + 1 }]);
    const hidden = hiddenSource(state, planLivePreview(state));
    expect(hidden).not.toContain("[ ]");
    // The sibling task hides both its dash and its TaskMarker.
    expect(hidden).toEqual(["- ", "[x]"]);
  });

  it("plans a strike-through mark covering only the text of checked tasks", () => {
    const doc = "- [ ] todo\n- [x] done\n\noutside";
    const state = createState(doc, [{ anchor: doc.length }]);
    const done = markedAs(planLivePreview(state), "cm-live-preview-task-done");
    expect(done).toEqual([
      { from: 17, to: 21, kind: "mark", className: "cm-live-preview-task-done" },
    ]);
    expect(state.sliceDoc(17, 21)).toBe("done");
  });

  it("strikes only the checked task's own line, not continuation lines or later paragraphs", () => {
    const doc = "- [x] done\n  continuation\n\nnext paragraph";
    const state = createState(doc, [{ anchor: doc.length }]);
    // The Task node spans both lines, but the strike must end at the hard
    // line break so a manually started line stays plain.
    const done = markedAs(planLivePreview(state), "cm-live-preview-task-done");
    expect(done.map(({ from, to }) => state.sliceDoc(from, to))).toEqual(["done"]);
  });

  it("limits planned decorations and syntax visits to requested document ranges", () => {
    const lines = Array.from({ length: 600 }, (_, index) => `**item-${index}**`);
    const doc = lines.join("\n\n");
    const targetText = "**item-100**";
    const targetFrom = doc.indexOf(targetText);
    const targetTo = targetFrom + targetText.length;
    const state = createState(doc, [{ anchor: doc.length }]);
    const fullDiagnostics = { visitedNodes: 0 };
    const rangeDiagnostics = { visitedNodes: 0 };

    const fullPlan = planLivePreview(state, undefined, fullDiagnostics);
    const rangePlan = planLivePreview(
      state,
      [{ from: targetFrom + 2, to: targetTo - 2 }],
      rangeDiagnostics,
    );

    expect(rangePlan).not.toHaveLength(0);
    expect(rangePlan.every(({ from, to }) => from >= targetFrom && to <= targetTo)).toBe(true);
    expect(rangePlan.length).toBeLessThan(fullPlan.length / 100);
    expect(rangeDiagnostics.visitedNodes).toBeLessThan(fullDiagnostics.visitedNodes / 100);
  });

  it("limits blockquote line decorations to requested document ranges", () => {
    const doc = Array.from(
      { length: 300 },
      (_, index) => `> quote-${index}`,
    ).join("\n");
    const state = createState(doc, [{ anchor: doc.length }]);
    const target = state.doc.line(151);

    const plan = planLivePreview(state, [
      { from: target.from, to: target.to },
    ]);

    expect(plan.filter(({ kind }) => kind === "line")).toEqual([
      {
        from: target.from,
        to: target.to,
        kind: "line",
        className:
          "cm-live-preview-quote-line cm-live-preview-quote-line-middle",
      },
    ]);
  });

  it("does not duplicate blockquote line decorations across disjoint ranges", () => {
    const doc = "> first\n> middle\n> last";
    const state = createState(doc, [{ anchor: doc.length }]);
    const first = state.doc.line(1);
    const last = state.doc.line(3);

    const plan = planLivePreview(state, [
      { from: first.from, to: first.to },
      { from: last.from, to: last.to },
    ]);

    expect(
      plan
        .filter(({ kind }) => kind === "line")
        .map(({ from, to, className }) => ({ from, to, className })),
    ).toEqual([
      {
        from: first.from,
        to: first.to,
        className:
          "cm-live-preview-quote-line cm-live-preview-quote-line-first",
      },
      {
        from: last.from,
        to: last.to,
        className:
          "cm-live-preview-quote-line cm-live-preview-quote-line-last",
      },
    ]);
  });
});

describe("livePreviewExtension", () => {
  const createView = (doc = "**world** rest", readingMode = false) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdown({ extensions: [GFM, highlightMarkdownExtension] }),
        livePreviewExtension(
          readingMode ? { revealSelection: false } : undefined,
        ),
        ...(readingMode
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : []),
      ],
    });
    return new EditorView({ state, parent });
  };

  it("renders semantic marks and hides source delimiters", () => {
    const view = createView();
    expect(view.dom.querySelector(".cm-live-preview-strong")).not.toBeNull();
    expect(view.contentDOM.textContent).not.toContain("**");
    view.destroy();
  });

  it.each(["#", "##", "###", "####", "#####", "######"])(
    "aligns rendered %s headings with paragraph text",
    (marker) => {
      const view = createView(`${marker} Heading\n\nParagraph`);
      const lines = view.contentDOM.querySelectorAll<HTMLElement>(".cm-line");
      expect(lines[0]?.textContent).toBe("Heading");
      expect(lines[2]?.textContent).toBe("Paragraph");
      view.destroy();
    },
  );

  it("reveals the complete ATX heading prefix when the heading is selected", () => {
    const view = createView("### Heading\n\nParagraph");
    view.dispatch({ selection: { anchor: 0 } });
    expect(
      view.contentDOM.querySelector<HTMLElement>(".cm-line")?.textContent,
    ).toBe("### Heading");
    view.destroy();
  });

  it("renders a titled inline link as only its readable label", () => {
    const view = createView("[label](url \"title\") outside");
    expect(view.contentDOM.textContent).toBe("label outside");
    view.destroy();
  });

  it.each([
    ["[label](url ) outside"],
    ["[label](url\n) outside"],
    ["[label]( <url> ) outside"],
  ])("renders %s without destination whitespace", (doc) => {
    const view = createView(doc);
    expect(view.contentDOM.textContent).toBe("label outside");
    view.destroy();
  });

  it("exposes replacement and widget ranges as atomic without making marks atomic", () => {
    const view = createView("**world**\n\n- [ ] todo\n\noutside");
    const ranges: { from: number; to: number }[] = [];
    for (const provider of view.state.facet(EditorView.atomicRanges)) {
      provider(view).between(0, view.state.doc.length, (from, to) => {
        ranges.push({ from, to });
      });
    }
    expect(ranges).toEqual([
      { from: 0, to: 2 },
      { from: 7, to: 9 },
      { from: 11, to: 13 },
      { from: 13, to: 16 },
    ]);
    expect(ranges).not.toContainEqual({ from: 0, to: 9 });
    view.destroy();
  });

  it("applies minimal semantic styling to live preview marks", () => {
    const view = createView("# heading\n\n**strong** and *em*");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const heading = view.dom.querySelector<HTMLElement>(".cm-live-preview-heading-1");
    const strong = view.dom.querySelector<HTMLElement>(".cm-live-preview-strong");
    expect(getComputedStyle(heading!).fontWeight).toBe("700");
    expect(getComputedStyle(strong!).fontWeight).toBe("700");
    view.destroy();
  });

  it("temporarily reveals source during composition and restores preview afterward", () => {
    const view = createView();
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(view.contentDOM.textContent).toContain("**world**");
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(view.contentDOM.textContent).not.toContain("**");
    view.destroy();
  });

  it("temporarily reveals highlight source during composition and restores it afterward", () => {
    const view = createView("==重点== outside");
    expect(view.contentDOM.textContent).not.toContain("==");
    expect(view.dom.querySelector(".cm-live-preview-highlight")).not.toBeNull();

    view.contentDOM.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    expect(view.contentDOM.textContent).toContain("==重点==");

    view.contentDOM.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    expect(view.contentDOM.textContent).not.toContain("==");
    expect(view.dom.querySelector(".cm-live-preview-highlight")).not.toBeNull();
    view.destroy();
  });

  it("keeps decorations disabled through composition document updates", () => {
    const view = createView();
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view.dispatch({ changes: { from: 2, to: 7, insert: "中文" } });
    expect(view.state.doc.toString()).toBe("**中文** rest");
    expect(view.contentDOM.textContent).toContain("**中文**");
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(view.contentDOM.textContent).not.toContain("**");
    view.destroy();
  });

  it("uses separator and readable checkbox semantics for widgets", () => {
    const view = createView("---\n\n- [x] done\n\noutside");
    const rule = view.dom.querySelector(".cm-live-preview-horizontal-rule");
    const checkbox = view.dom.querySelector(".cm-live-preview-task-checkbox");
    expect(rule).toHaveAttribute("role", "separator");
    expect(checkbox).toHaveAttribute("role", "checkbox");
    expect(checkbox).toHaveAttribute("aria-checked", "true");
    expect(checkbox).toHaveAccessibleName("已完成任务");
    view.destroy();
  });

  it("renders task widgets as clickable controls that toggle the document", () => {
    const doc = "- [ ] todo\n- [x] done\n\noutside";
    const view = createView(doc);
    const checkboxes = view.dom.querySelectorAll<HTMLInputElement>(
      ".cm-live-preview-task-checkbox",
    );
    // Task items render no bullet marker; plain lists keep theirs.
    expect(view.dom.querySelectorAll(".cm-live-preview-list-marker")).toHaveLength(0);
    expect(checkboxes).toHaveLength(2);
    expect([...checkboxes].map((checkbox) => checkbox.checked)).toEqual([false, true]);
    for (const checkbox of checkboxes) {
      expect(checkbox.disabled).toBe(false);
      expect(checkbox).toHaveAttribute("role", "checkbox");
      expect(checkbox).toHaveAttribute("aria-checked", String(checkbox.checked));
      expect(checkbox).not.toHaveAttribute("aria-disabled");
      checkbox.click();
    }
    expect(view.state.doc.toString()).toBe("- [x] todo\n- [ ] done\n\noutside");
    view.destroy();
  });

  it("reuses the checkbox DOM across toggles instead of rebuilding it", async () => {
    const view = createView("- [ ] todo\n\noutside");
    const checkbox = view.dom.querySelector<HTMLInputElement>(
      ".cm-live-preview-task-checkbox",
    )!;
    checkbox.click();
    expect(view.state.doc.toString()).toBe("- [x] todo\n\noutside");
    // The widget was updated in place: same node, synced state. The DOM
    // sync completes on a microtask after the click's native activation.
    await Promise.resolve();
    expect(view.dom.querySelector(".cm-live-preview-task-checkbox")).toBe(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(checkbox).toHaveAttribute("aria-checked", "true");
    expect(checkbox).toHaveAccessibleName("已完成任务");
    view.destroy();
  });

  it("keeps the document unchanged when a task checkbox is clicked in reading mode", () => {
    const doc = "- [ ] todo\n- [x] done\n\noutside";
    const view = createView(doc, true);
    const checkboxes = view.dom.querySelectorAll<HTMLInputElement>(
      ".cm-live-preview-task-checkbox",
    );
    expect(checkboxes).toHaveLength(2);
    checkboxes[0]!.click();
    checkboxes[1]!.click();
    // Widget handlers bypass CodeMirror's editing pipeline, so they must
    // honor the read-only state themselves instead of dispatching edits.
    expect(view.state.doc.toString()).toBe(doc);
    const after = view.dom.querySelectorAll<HTMLInputElement>(
      ".cm-live-preview-task-checkbox",
    );
    expect(after).toHaveLength(2);
    expect([...after].map((checkbox) => checkbox.checked)).toEqual([false, true]);
    view.destroy();
  });

  it("does not re-sync a checkbox detached before the post-click resync runs", async () => {
    const view = createView("- [ ] todo\n\noutside");
    const checkbox = view.dom.querySelector<HTMLInputElement>(
      ".cm-live-preview-task-checkbox",
    )!;
    checkbox.click();
    expect(view.state.doc.toString()).toBe("- [x] todo\n\noutside");
    // A change elsewhere shifts the task and rebuilds its widget, detaching
    // the node the click handler captured before the resync microtask runs.
    // The stale range then reads as "[x]", which would flip the detached
    // node if the guard did not stop the microtask first.
    view.dispatch({ changes: { from: 0, insert: "xx[x]\n" } });
    const rebuilt = view.dom.querySelector<HTMLInputElement>(
      ".cm-live-preview-task-checkbox",
    );
    expect(checkbox.isConnected).toBe(false);
    expect(rebuilt).not.toBe(checkbox);
    expect(rebuilt!.checked).toBe(true);
    await Promise.resolve();
    expect(checkbox.checked).toBe(false);
    view.destroy();
  });

  it("strikes through the text of checked tasks and leaves unchecked task text plain", () => {
    const view = createView("- [ ] todo\n- [x] done\n\noutside");
    const doneMarks = view.dom.querySelectorAll<HTMLElement>(
      ".cm-live-preview-task-done",
    );
    expect(doneMarks).toHaveLength(1);
    expect(doneMarks[0]?.textContent).toBe("done");
    view.destroy();
  });

  it("gives bullet and ordered list-marker widgets readable names", () => {
    const view = createView("- bullet\n\n2. ordered\n\noutside");
    const markers = view.dom.querySelectorAll<HTMLElement>(
      ".cm-live-preview-list-marker",
    );
    expect([...markers].map((marker) => marker.textContent)).toEqual(["•", "2."]);
    for (const marker of markers) {
      expect(marker).toHaveAttribute("role", "listitem");
    }
    expect([...markers].map((marker) => marker.getAttribute("aria-label"))).toEqual([
      "项目符号",
      "列表序号 2.",
    ]);
    view.destroy();
  });
});
