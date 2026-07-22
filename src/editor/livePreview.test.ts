import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
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
      markdown({ extensions: [GFM] }),
    ],
  });

const hiddenSource = (state: EditorState, plan: readonly PlannedDecoration[]) =>
  plan
    .filter(({ kind }) => kind !== "mark")
    .map(({ from, to }) => state.sliceDoc(from, to));

const markedAs = (plan: readonly PlannedDecoration[], className: string) =>
  plan.filter((item) => item.kind === "mark" && item.className === className);

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
        "(",
        "https://example.com",
        ")",
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

  it("plans non-interactive checked and unchecked task widgets from GFM nodes", () => {
    const doc = "- [ ] todo\n- [x] done\n\noutside";
    const state = createState(doc, [{ anchor: doc.length }]);
    expect(syntaxTree(state).toString()).toContain("Task(TaskMarker)");
    const tasks = planLivePreview(state).filter(({ kind }) => kind === "task-checkbox");
    expect(tasks.map(({ checked }) => checked)).toEqual([false, true]);
    expect(hiddenSource(state, tasks)).toEqual(["[ ]", "[x]"]);
  });

  it("reveals the task source and parent list marker when its checkbox is selected", () => {
    const doc = "- [ ] todo\n- [x] done\n\noutside";
    const state = createState(doc, [{ anchor: doc.indexOf("[ ]") + 1 }]);
    const hidden = hiddenSource(state, planLivePreview(state));
    expect(hidden).not.toContain("[ ]");
    expect(hidden.filter((source) => source === "-")).toHaveLength(1);
    expect(hidden).toContain("[x]");
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
});

describe("livePreviewExtension", () => {
  const createView = (doc = "**world** rest") => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [markdown({ extensions: [GFM] }), livePreviewExtension()],
    });
    return new EditorView({ state, parent });
  };

  it("renders semantic marks and hides source delimiters", () => {
    const view = createView();
    expect(view.dom.querySelector(".cm-live-preview-strong")).not.toBeNull();
    expect(view.contentDOM.textContent).not.toContain("**");
    view.destroy();
  });

  it("renders a titled inline link as only its readable label", () => {
    const view = createView("[label](url \"title\") outside");
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
      { from: 11, to: 12 },
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

  it("renders task widgets as disabled, hidden-from-ARIA controls that cannot edit the document", () => {
    const doc = "- [ ] todo\n- [x] done\n\noutside";
    const view = createView(doc);
    const checkboxes = view.dom.querySelectorAll<HTMLInputElement>(
      ".cm-live-preview-task-checkbox",
    );
    const listMarkers = view.dom.querySelectorAll<HTMLElement>(
      ".cm-live-preview-list-marker",
    );
    expect([...listMarkers].map((marker) => marker.textContent)).toEqual(["•", "•"]);
    expect(checkboxes).toHaveLength(2);
    expect([...checkboxes].map((checkbox) => checkbox.checked)).toEqual([false, true]);
    for (const checkbox of checkboxes) {
      expect(checkbox.disabled).toBe(true);
      expect(checkbox.tabIndex).toBe(-1);
      expect(checkbox).toHaveAttribute("role", "checkbox");
      expect(checkbox).toHaveAttribute("aria-checked", String(checkbox.checked));
      expect(checkbox).toHaveAttribute("aria-disabled", "true");
      checkbox.click();
    }
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });
});
