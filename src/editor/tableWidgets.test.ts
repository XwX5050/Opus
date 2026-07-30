import { history } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, describe, expect, it } from "vitest";
import "../theme/app.css";
import { livePreviewExtension } from "./livePreview";
import { extractMarkdownTables } from "./markdownTable";
import {
  MarkdownTableWidget,
  tableWidgetsExtension,
} from "./tableWidgets";

const views: EditorView[] = [];

const createView = (
  doc: string,
  editable = true,
  extraExtensions: Extension = [],
) => {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ extensions: [GFM] }),
        history(),
        tableWidgetsExtension({ editable }),
        extraExtensions,
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

describe("tableWidgetsExtension", () => {
  it("renders a valid GFM table semantically without changing its Markdown", () => {
    const doc = [
      "| A | B |",
      "| :--- | ---: |",
      "| one | two |",
    ].join("\n");
    const view = createView(doc);
    const table = view.dom.querySelector<HTMLTableElement>("table.md-table");

    expect(table).not.toBeNull();
    expect(table?.parentElement).toHaveClass("md-table-scroll");
    expect(table).toHaveAttribute("role", "grid");
    expect(table).toHaveAttribute("aria-label", "Markdown 表格");
    expect(table?.querySelectorAll("thead tr")).toHaveLength(1);
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(table?.querySelectorAll("th")).toHaveLength(2);
    expect(table?.querySelectorAll("td")).toHaveLength(2);
    expect(table?.querySelector("th")?.dataset.alignment).toBe("left");
    expect(table?.querySelector("th:last-child")?.getAttribute("data-alignment"))
      .toBe("right");
    expect(view.contentDOM.textContent).not.toContain("---");
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("renders header and body text with stable semantic cell indices", () => {
    const view = createView([
      "| Name | Note |",
      "| --- | --- |",
      "| Ada | First |",
      "| Lin | Second |",
    ].join("\n"));
    const cells = [...view.dom.querySelectorAll<HTMLElement>("th, td")];

    expect(cells.map((cell) => cell.textContent)).toEqual([
      "Name",
      "Note",
      "Ada",
      "First",
      "Lin",
      "Second",
    ]);
    expect(cells.map((cell) => cell.dataset.cellIndex)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(
      [...view.dom.querySelectorAll("th")]
        .map((cell) => cell.getAttribute("role")),
    ).toEqual(["columnheader", "columnheader"]);
    expect(
      [...view.dom.querySelectorAll("td")]
        .map((cell) => cell.getAttribute("role")),
    ).toEqual(["gridcell", "gridcell", "gridcell", "gridcell"]);
    expect(cells.every((cell) => cell.contentEditable === "true")).toBe(true);
    expect(cells.every((cell) => cell.spellcheck)).toBe(true);
    expect(cells.every((cell) => cell.tabIndex === 0)).toBe(true);
    expect(new Set(cells.map((cell) => cell.dataset.tableFrom))).toEqual(
      new Set(["0"]),
    );
  });

  it("preserves empty cells and decodes escaped pipes as text", () => {
    const doc = [
      "|  | B |",
      "| --- | --- |",
      String.raw`| A\|B |  |`,
    ].join("\n");
    const view = createView(doc);

    expect(
      [...view.dom.querySelectorAll<HTMLElement>("th, td")]
        .map((cell) => cell.textContent),
    ).toEqual(["", "B", "A|B", ""]);
  });

  it("renders a table without outer pipes", () => {
    const view = createView([
      "A | B",
      "--- | ---",
      "one | two",
    ].join("\n"));

    expect(view.dom.querySelectorAll("table.md-table")).toHaveLength(1);
    expect(view.dom.querySelector("thead")?.textContent).toBe("AB");
    expect(view.dom.querySelector("tbody")?.textContent).toBe("onetwo");
  });

  it("exposes default, left, center, and right alignment on every row", () => {
    const view = createView([
      "| Default | Left | Center | Right |",
      "| --- | :--- | :---: | ---: |",
      "| d | l | c | r |",
    ].join("\n"));

    expect(
      [...view.dom.querySelectorAll<HTMLElement>("th")]
        .map((cell) => cell.dataset.alignment),
    ).toEqual(["default", "left", "center", "right"]);
    expect(
      [...view.dom.querySelectorAll<HTMLElement>("td")]
        .map((cell) => cell.dataset.alignment),
    ).toEqual(["default", "left", "center", "right"]);
  });

  it("makes the complete raw table a single atomic range", () => {
    const doc = ["| A |", "| --- |", "| one |"].join("\n");
    const view = createView(doc);

    expect(atomicRanges(view)).toEqual([{ from: 0, to: doc.length }]);
  });

  it("leaves invalid or incomplete table syntax as raw source", () => {
    const doc = ["A | B", "not a delimiter", "one | two"].join("\n");
    const view = createView(doc);

    expect(view.dom.querySelector("table.md-table")).toBeNull();
    expect(view.contentDOM.textContent).toContain("not a delimiter");
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("does not make read-only table cells editable or tabbable", () => {
    const view = createView(["A | B", "--- | ---", "one | two"].join("\n"), false);
    const cells = [...view.dom.querySelectorAll<HTMLElement>("th, td")];

    expect(cells).not.toHaveLength(0);
    expect(cells.every((cell) => !cell.hasAttribute("contenteditable"))).toBe(true);
    expect(cells.every((cell) => !cell.hasAttribute("spellcheck"))).toBe(true);
    expect(cells.every((cell) => cell.tabIndex === -1)).toBe(true);
    expect(view.dom.querySelector("table")?.hasAttribute("role")).toBe(false);
    expect(view.dom.querySelector("table")).toHaveAttribute(
      "aria-label",
      "Markdown 表格",
    );
    expect(cells.every((cell) => !cell.hasAttribute("role"))).toBe(true);
  });

  it("renders multiple non-overlapping tables in source order", () => {
    const first = ["A | B", "--- | ---", "one | two"].join("\n");
    const second = ["C | D", "--- | ---", "three | four"].join("\n");
    const doc = `${first}\n\nbetween\n\n${second}`;
    const view = createView(doc);
    const tables = [...view.dom.querySelectorAll<HTMLTableElement>("table.md-table")];

    expect(tables).toHaveLength(2);
    expect(tables.map((table) => table.textContent)).toEqual([
      "ABonetwo",
      "CDthreefour",
    ]);
    expect(atomicRanges(view)).toEqual(expect.arrayContaining([
      { from: 0, to: first.length },
      { from: doc.indexOf(second), to: doc.length },
    ]));
  });

  it("coexists with live preview outside the table", () => {
    const doc = [
      "**before**",
      "",
      "| A | B |",
      "| --- | --- |",
      "| one | two |",
      "",
      "*after*",
    ].join("\n");

    expect(() => {
      const view = createView(doc, true, livePreviewExtension({
        revealSelection: false,
      }));
      expect(view.dom.querySelector("table.md-table")).not.toBeNull();
      expect(view.dom.querySelectorAll(".cm-live-preview-strong")).toHaveLength(1);
      expect(view.dom.querySelectorAll(".cm-live-preview-emphasis")).toHaveLength(1);
    }).not.toThrow();
  });

  it("preserves a blockquote shell around a nested table", () => {
    const view = createView([
      "> A | B",
      "> --- | ---",
      "> one | two",
    ].join("\n"), true, livePreviewExtension({ revealSelection: false }));
    const finalLine = view.dom.querySelector<HTMLElement>(
      ".cm-table-continuation.cm-live-preview-quote-line-last",
    );

    expect(view.dom.querySelector("table.md-table")).not.toBeNull();
    expect(finalLine).not.toBeNull();
    expect(finalLine).toHaveClass(
      "cm-table-continuation",
      "cm-live-preview-quote-line",
      "cm-live-preview-quote-line-last",
    );
    expect(getComputedStyle(finalLine!).lineHeight).toBe("0");
    expect(getComputedStyle(finalLine!).height).toBe("auto");
    expect(getComputedStyle(finalLine!).paddingBottom).toBe("var(--space-3)");
    const quoteShellRule = [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .find((rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule &&
        rule.selectorText.endsWith(
          ".cm-table-continuation.cm-live-preview-quote-line-last",
        ),
    );
    expect(quoteShellRule?.style.paddingBottom).toBe("var(--space-3)");
  });

  it("renders a list-contained table without overlapping line decorations", () => {
    const view = createView([
      "- A | B",
      "  --- | ---",
      "  one | two",
    ].join("\n"), true, livePreviewExtension({ revealSelection: false }));
    const firstLine = view.dom.querySelector(".cm-line");

    expect(view.dom.querySelector("table.md-table")).not.toBeNull();
    expect(firstLine?.querySelector(".cm-live-preview-list-marker")).not.toBeNull();
    expect(firstLine?.querySelector(".md-table-scroll")).not.toBeNull();
    expect(view.dom.querySelectorAll(".cm-table-continuation")).toHaveLength(2);
  });

  it("collapses continuation source lines without cross-line replacements", () => {
    const view = createView([
      "| A | B |",
      "| --- | --- |",
      "| one | two |",
    ].join("\n"));
    const continuations = view.dom.querySelectorAll<HTMLElement>(
      ".cm-table-continuation",
    );

    expect(continuations).toHaveLength(2);
    expect(getComputedStyle(continuations[0]).height).toBe("0px");
    expect(getComputedStyle(continuations[0]).lineHeight).toBe("0");
  });

  it("refreshes after document changes", () => {
    const original = ["A | B", "--- | ---", "one | two"].join("\n");
    const updated = ["C | D", "--- | ---", "three | four"].join("\n");
    const view = createView(original);

    view.dispatch({
      changes: { from: 0, to: original.length, insert: updated },
    });

    expect(view.dom.querySelector("table.md-table")?.textContent)
      .toBe("CDthreefour");
    expect(view.state.doc.toString()).toBe(updated);
  });

  it("does not rebuild a table widget for selection-only updates", () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const view = createView(doc);
    const provider = view.state.facet(EditorView.atomicRanges)[0];
    const originalAtomicRanges = provider(view);

    view.dispatch({ selection: { anchor: doc.length } });

    expect(provider(view)).toBe(originalAtomicRanges);
  });

  it("removes the inner header border when the table has no body rows", () => {
    const view = createView(["A | B", "--- | ---"].join("\n"));
    const table = view.dom.querySelector<HTMLTableElement>("table.md-table");
    const header = table?.querySelector<HTMLElement>("th");

    expect(table).toHaveClass("md-table-no-body");
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(getComputedStyle(header!).borderBottomWidth).toBe("0px");
  });
});

describe("MarkdownTableWidget", () => {
  const tableFor = (doc: string) => {
    const state = EditorState.create({
      doc,
      extensions: [markdown({ extensions: [GFM] })],
    });
    return extractMarkdownTables(state)[0];
  };

  it("uses table position, exact source, and editability for equality", () => {
    const source = ["A | B", "--- | ---"].join("\n");
    const table = tableFor(source);
    const sameSourceElsewhere = tableFor(`\n${source}`);

    expect(new MarkdownTableWidget(table, true).eq(
      new MarkdownTableWidget(table, true),
    )).toBe(true);
    expect(new MarkdownTableWidget(table, true).eq(
      new MarkdownTableWidget(table, false),
    )).toBe(false);
    expect(new MarkdownTableWidget(table, true).eq(
      new MarkdownTableWidget(sameSourceElsewhere, true),
    )).toBe(false);
    expect(new MarkdownTableWidget(table, true).ignoreEvent()).toBe(false);
  });

  it("returns false when compared with another WidgetType", () => {
    class OtherWidget extends WidgetType {
      toDOM() {
        return document.createElement("span");
      }
    }
    const table = tableFor(["A | B", "--- | ---"].join("\n"));

    expect(new MarkdownTableWidget(table, true).eq(new OtherWidget())).toBe(false);
  });

  it("inserts cell content as text rather than HTML", () => {
    const table = tableFor([
      "Value | Safe",
      "--- | ---",
      "<img src=x onerror=alert(1)> | ok",
    ].join("\n"));
    const dom = new MarkdownTableWidget(table, true).toDOM();

    expect(dom.querySelector("img")).toBeNull();
    expect(dom.querySelector("td")?.textContent)
      .toBe("<img src=x onerror=alert(1)>");
  });
});
