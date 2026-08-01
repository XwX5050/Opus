import {
  history,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from "@codemirror/state";
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
  maxRenderedCells?: number,
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
        tableWidgetsExtension({ editable, maxRenderedCells }),
        extraExtensions,
      ],
    }),
  });
  views.push(view);
  return view;
};

const generatedTable = (
  columns: number,
  bodyRows: number,
  prefix = "cell",
) => {
  const row = (label: string) =>
    `| ${Array.from({ length: columns }, (_, index) => `${label}-${index}`).join(" | ")} |`;
  return [
    row(`${prefix}-header`),
    `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`,
    ...Array.from({ length: bodyRows }, (_, index) =>
      row(`${prefix}-row-${index}`)
    ),
  ].join("\n");
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

const tableCell = (view: EditorView, index: number) => {
  const cell = view.dom.querySelector<HTMLElement>(
    `[data-cell-index="${index}"]`,
  );
  if (!cell) throw new Error(`Missing table cell ${index}`);
  return cell;
};

const dispatchInput = (cell: HTMLElement) => {
  cell.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
  }));
};

const selectCellContents = (cell: HTMLElement, collapseToEnd = false) => {
  const selection = document.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(cell);
  if (collapseToEnd) range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
};

const dispatchPaste = (
  cell: HTMLElement,
  plainText: string,
  html: string,
) => {
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => {
        if (type === "text/plain") return plainText;
        if (type === "text/html") return html;
        return "";
      },
    },
  });
  cell.dispatchEvent(event);
  return event;
};

const dispatchKeyDown = (
  cell: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
) => {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...init,
  });
  cell.dispatchEvent(event);
  return event;
};

const flushQueuedFocus = async () => {
  await Promise.resolve();
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

  it("renders a table whose cell count is exactly the configured limit", () => {
    const doc = generatedTable(4, 2);
    const view = createView(doc, true, [], 12);

    expect(view.dom.querySelectorAll("table.md-table")).toHaveLength(1);
    expect(view.dom.querySelectorAll(".md-table th, .md-table td"))
      .toHaveLength(12);
    expect(atomicRanges(view)).toEqual([{ from: 0, to: doc.length }]);
  });

  it.each([11, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "leaves an over-budget table as non-atomic raw source for limit %s",
    (maxRenderedCells) => {
      const doc = generatedTable(4, 2);
      const view = createView(doc, true, [], maxRenderedCells);

      expect(view.dom.querySelector("table.md-table")).toBeNull();
      expect(view.contentDOM.textContent).toContain("cell-header-0");
      expect(view.contentDOM.textContent).toContain("---");
      expect(atomicRanges(view)).toEqual([]);
      expect(view.state.doc.toString()).toBe(doc);
    },
  );

  it("renders an in-budget table while leaving a later oversized table raw", () => {
    const small = generatedTable(2, 1, "small");
    const huge = generatedTable(5, 4, "huge");
    const doc = `${small}\n\noutside\n\n${huge}`;
    const view = createView(doc, true, [], 4);

    expect(view.dom.querySelectorAll("table.md-table")).toHaveLength(1);
    expect(view.dom.querySelectorAll(".md-table th, .md-table td"))
      .toHaveLength(4);
    expect(view.dom.querySelector("table.md-table")?.textContent)
      .toContain("small-row-0-1");
    expect(view.contentDOM.textContent).toContain("huge-header-0");
    expect(view.contentDOM.textContent).toContain("outside");
    expect(atomicRanges(view)).toEqual([{ from: 0, to: small.length }]);
  });

  it("keeps an edited pressure-sized table raw while extraction stays bounded", () => {
    const doc = generatedTable(2, 10_001, "pressure");
    const view = createView(doc, true, [], 1_000);
    const editFrom = view.state.doc.toString().indexOf("pressure-row-9000-0");

    expect(view.dom.querySelector("table.md-table")).toBeNull();
    expect(atomicRanges(view)).toEqual([]);
    view.dispatch({
      changes: {
        from: editFrom,
        to: editFrom + "pressure".length,
        insert: "updated",
      },
    });

    const diagnostics = {
      materializedRows: 0,
      materializedCells: 0,
      skippedForCellLimit: 0,
    };
    expect(view.dom.querySelector("table.md-table")).toBeNull();
    expect(atomicRanges(view)).toEqual([]);
    expect(extractMarkdownTables(view.state, undefined, {
      maxCells: 1_000,
      diagnostics,
    })).toEqual([]);
    expect(diagnostics).toEqual({
      materializedRows: 499,
      materializedCells: 1_000,
      skippedForCellLimit: 1,
    });
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

  it("isolates table cells behind an explicit non-editable widget root", () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const editableView = createView(doc, true);
    const staticView = createView(doc, false);

    for (const view of [editableView, staticView]) {
      const root = view.dom.querySelector<HTMLElement>(".md-table-scroll")!;
      expect(root).toHaveAttribute("contenteditable", "false");
      expect(root.contentEditable).toBe("false");
    }
    expect(tableCell(editableView, 2)).toHaveAttribute(
      "contenteditable",
      "true",
    );
    expect(tableCell(editableView, 2).contentEditable).toBe("true");
    expect(tableCell(staticView, 2)).not.toHaveAttribute("contenteditable");
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

  it("moves Tab from the header across the header-body boundary", () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const view = createView(doc);
    const first = tableCell(view, 0);
    const second = tableCell(view, 1);
    const firstBody = tableCell(view, 2);
    first.focus();

    const firstEvent = dispatchKeyDown(first, "Tab");
    expect(firstEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(second);

    const boundaryEvent = dispatchKeyDown(second, "Tab");
    expect(boundaryEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(firstBody);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("moves Shift+Tab backward and traps it on the first cell", () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const view = createView(doc);
    const first = tableCell(view, 0);
    const second = tableCell(view, 1);
    second.focus();

    const previousEvent = dispatchKeyDown(second, "Tab", { shiftKey: true });
    expect(previousEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const trappedEvent = dispatchKeyDown(first, "Tab", { shiftKey: true });
    expect(trappedEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("appends one row from the final body cell and focuses its first cell", async () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const view = createView(doc);
    const finalCell = tableCell(view, 3);
    finalCell.focus();

    const event = dispatchKeyDown(finalCell, "Tab");
    await flushQueuedFocus();

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(`${doc}\n|  |  |`);
    expect(tableCell(view, 4)).toBe(document.activeElement);
    expect(tableCell(view, 4).textContent).toBe("");
    expect(view.dom.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("appends the first body row from a header-only table", async () => {
    const doc = ["| A | B |", "| --- | --- |"].join("\n");
    const view = createView(doc);
    const finalHeader = tableCell(view, 1);
    finalHeader.focus();

    dispatchKeyDown(finalHeader, "Tab");
    await flushQueuedFocus();

    expect(view.state.doc.toString()).toBe(`${doc}\n|  |  |`);
    expect(view.dom.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(tableCell(view, 2)).toBe(document.activeElement);
  });

  it.each([
    {
      container: "blockquote",
      doc: ["> A | B", "> --- | ---", "> one | two"].join("\n"),
      appended: "\n> |  |  |",
    },
    {
      container: "list",
      doc: ["- A | B", "  --- | ---", "  one | two"].join("\n"),
      appended: "\n  |  |  |",
    },
  ])("appends and focuses a row inside a $container table", async ({
    doc,
    appended,
  }) => {
    const view = createView(doc);
    const originalTable = extractMarkdownTables(view.state)[0];
    const finalIndex = originalTable.header.length +
      originalTable.rows.flat().length - 1;

    dispatchKeyDown(tableCell(view, finalIndex), "Tab");
    await flushQueuedFocus();

    const [refreshedTable] = extractMarkdownTables(view.state);
    expect(view.state.doc.toString()).toBe(`${doc}${appended}`);
    expect(refreshedTable.from).toBe(originalTable.from);
    expect(refreshedTable.rows).toHaveLength(2);
    expect(tableCell(view, finalIndex + 1)).toBe(document.activeElement);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(undo(view)).toBe(false);
  });

  it("inserts an appended row in one input.type transaction undone once", async () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const docTransactions: {
      readonly userEvent: string | undefined;
      readonly changeCount: number;
    }[] = [];
    const view = createView(doc, true, EditorView.updateListener.of((update) => {
      for (const transaction of update.transactions) {
        if (!transaction.docChanged) continue;
        let changeCount = 0;
        transaction.changes.iterChanges(() => {
          changeCount += 1;
        });
        docTransactions.push({
          userEvent: transaction.annotation(Transaction.userEvent),
          changeCount,
        });
      }
    }));

    dispatchKeyDown(tableCell(view, 3), "Tab");
    await flushQueuedFocus();

    expect(docTransactions).toEqual([{
      userEvent: "input.type",
      changeCount: 1,
    }]);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(undo(view)).toBe(false);
  });

  it("keeps a final-cell edit separate from the appended-row history event", async () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const edited = ["A | B", "--- | ---", "one | changed"].join("\n");
    const appended = `${edited}\n|  |  |`;
    const view = createView(doc);
    const finalCell = tableCell(view, 3);
    finalCell.textContent = "changed";

    dispatchInput(finalCell);
    dispatchKeyDown(tableCell(view, 3), "Tab");
    await flushQueuedFocus();

    expect(view.state.doc.toString()).toBe(appended);
    expect(undoDepth(view.state)).toBe(2);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(edited);
    expect(undoDepth(view.state)).toBe(1);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(undoDepth(view.state)).toBe(0);
    expect(redoDepth(view.state)).toBe(2);

    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(edited);
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(appended);
    expect(redo(view)).toBe(false);
  });

  it("preserves surrounding Markdown and existing table spelling when appending", async () => {
    const tableSource = [
      "  Left\t |Right",
      "  :--- | ---:",
      "  old\t | keep  ",
    ].join("\n");
    const doc = `before **untouched**\n\n${tableSource}\n\nafter _untouched_`;
    const view = createView(doc);
    const originalTable = extractMarkdownTables(view.state)[0];
    const finalIndex = originalTable.header.length +
      originalTable.rows.flat().length - 1;

    dispatchKeyDown(tableCell(view, finalIndex), "Tab");
    await flushQueuedFocus();

    expect(view.state.doc.toString()).toBe(
      `before **untouched**\n\n${tableSource}\n  |  |  |\n\nafter _untouched_`,
    );
  });

  it("ignores modified Tab keydowns", () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const view = createView(doc);
    const finalCell = tableCell(view, 3);
    finalCell.focus();

    for (const modifiers of [
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
    ]) {
      const event = dispatchKeyDown(finalCell, "Tab", modifiers);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(finalCell);
      expect(view.state.doc.toString()).toBe(doc);
    }
  });

  it("does not navigate or insert for read-only widget options or state", () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const optionReadOnly = createView(doc, false);
    const stateReadOnly = createView(
      doc,
      true,
      EditorState.readOnly.of(true),
    );

    for (const view of [optionReadOnly, stateReadOnly]) {
      const event = dispatchKeyDown(tableCell(view, 3), "Tab");
      expect(event.defaultPrevented).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    }
  });

  it("rejects navigation from detached stale and tampered cells", () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const staleView = createView(doc);
    const staleCell = tableCell(staleView, 3);
    const replacement = [
      "C | D | E",
      "--- | --- | ---",
      "three | four | five",
    ].join("\n");
    staleView.dispatch({
      changes: { from: 0, to: doc.length, insert: replacement },
    });
    const staleEvent = dispatchKeyDown(staleCell, "Tab");

    expect(staleEvent.defaultPrevented).toBe(false);
    expect(staleCell.isConnected).toBe(false);
    expect(staleView.state.doc.toString()).toBe(replacement);

    const tamperedView = createView(doc);
    const tamperedCell = tableCell(tamperedView, 1);
    tamperedCell.focus();
    tamperedCell.dataset.cellIndex = "2";
    const tamperedEvent = dispatchKeyDown(tamperedCell, "Tab");

    expect(tamperedEvent.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(tamperedCell);
    expect(tamperedView.state.doc.toString()).toBe(doc);
  });

  it("ignores Tab when the adjacent destination cell is tampered", () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const view = createView(doc);
    const origin = tableCell(view, 0);
    const destination = tableCell(view, 1);
    origin.focus();
    destination.dataset.cellIndex = "99";

    const event = dispatchKeyDown(origin, "Tab");

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(origin);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("ignores Tab while a cell composition is active", () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const view = createView(doc);
    const finalCell = tableCell(view, 3);
    finalCell.focus();
    finalCell.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
    }));

    const event = dispatchKeyDown(finalCell, "Tab", { isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(finalCell);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("focuses CodeMirror at the table end on Escape without changing history", () => {
    const tableSource = ["A | B", "--- | ---", "one | two"].join("\n");
    const doc = `before\n\n${tableSource}\n\nafter`;
    const view = createView(doc);
    const table = extractMarkdownTables(view.state)[0];

    for (const index of [0, 3]) {
      const cell = tableCell(view, index);
      cell.focus();
      const event = dispatchKeyDown(cell, "Escape");

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(view.contentDOM);
      expect(view.state.selection.main.anchor).toBe(table.to);
      expect(view.state.doc.toString()).toBe(doc);
      expect(undo(view)).toBe(false);
    }
  });

  it("does not append another row for a repeated final-cell Tab", async () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const view = createView(doc);
    const finalCell = tableCell(view, 3);

    const repeated = dispatchKeyDown(finalCell, "Tab", { repeat: true });
    await flushQueuedFocus();

    expect(repeated.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.dom.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("does not move queued focus into a replacement table at the same position", async () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const replacement = [
      "C | D",
      "--- | ---",
      "three | four",
      "five | six",
    ].join("\n");
    const view = createView(doc);
    const outside = document.createElement("button");
    document.body.append(outside);

    dispatchKeyDown(tableCell(view, 3), "Tab");
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: replacement,
      },
    });
    outside.focus();
    await flushQueuedFocus();

    expect(view.state.doc.toString()).toBe(replacement);
    expect(document.activeElement).toBe(outside);
  });

  it("edits only one body cell source range and preserves surrounding whitespace", () => {
    const doc = [
      "| Left | Right |",
      "| --- | --- |",
      "|  old \t| \tkeep  |",
    ].join("\n");
    const view = createView(doc);
    const cell = tableCell(view, 2);

    cell.textContent = "new|value";
    dispatchInput(cell);

    expect(view.state.doc.toString()).toBe(doc.replace(
      "old",
      String.raw`new\|value`,
    ));
  });

  it("inserts edited text into an empty zero-width cell", () => {
    const doc = ["| A | B |", "| --- | --- |", "|  | two |"].join("\n");
    const view = createView(doc);
    const cell = tableCell(view, 2);

    cell.textContent = "one";
    dispatchInput(cell);

    expect(view.state.doc.toString()).toBe(
      ["| A | B |", "| --- | --- |", "|  one| two |"].join("\n"),
    );
  });

  it("records a direct cell edit as one undoable transaction", () => {
    const doc = ["A | B", "--- | ---", "old | keep"].join("\n");
    const view = createView(doc);
    const cell = tableCell(view, 2);

    cell.textContent = "new";
    dispatchInput(cell);

    expect(view.state.doc.toString()).toContain("new | keep");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(undo(view)).toBe(false);
  });

  it("rejects an event from a detached stale widget after an external change", () => {
    const doc = ["A | B", "--- | ---", "old | keep"].join("\n");
    const view = createView(doc);
    const staleCell = tableCell(view, 2);
    const replacement = [
      "C | D | E",
      "--- | --- | ---",
      "fresh | value | third",
    ].join("\n");

    view.dispatch({
      changes: { from: 0, to: doc.length, insert: replacement },
    });
    staleCell.textContent = "must-not-land";
    dispatchInput(staleCell);

    expect(staleCell.isConnected).toBe(false);
    expect(view.state.doc.toString()).toBe(replacement);
  });

  it("rejects a valid-looking cell index tampered onto another owned cell", () => {
    const doc = ["A | B", "--- | ---", "old | keep"].join("\n");
    const view = createView(doc);
    const cell = tableCell(view, 2);
    cell.dataset.cellIndex = "3";
    cell.textContent = "must-not-land";

    dispatchInput(cell);

    expect(view.state.doc.toString()).toBe(doc);
  });

  it("pastes text/plain as literal single-line text without creating elements", () => {
    const doc = ["A | B", "--- | ---", "old | keep"].join("\n");
    const view = createView(doc);
    const cell = tableCell(view, 2);
    selectCellContents(cell);

    const event = dispatchPaste(
      cell,
      "<b>x|y</b>\r\nnext",
      "<img src=x onerror=alert(1)>",
    );

    expect(event.defaultPrevented).toBe(true);
    expect(cell.textContent).toBe("<b>x|y</b> next");
    expect(cell.querySelector("*")).toBeNull();
    expect(view.state.doc.toString()).toBe(
      ["A | B", "--- | ---", String.raw`<b>x\|y</b> next | keep`].join("\n"),
    );
  });

  it("commits Chinese composition exactly once at compositionend", () => {
    const doc = ["A | B", "--- | ---", "old | keep"].join("\n");
    let docChanges = 0;
    const view = createView(doc, true, EditorView.updateListener.of((update) => {
      if (update.docChanged) docChanges += 1;
    }));
    const cell = tableCell(view, 2);

    cell.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
    }));
    cell.textContent = "中";
    dispatchInput(cell);
    expect(view.state.doc.toString()).toBe(doc);

    cell.textContent = "中文";
    cell.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "中文",
    }));

    expect(view.state.doc.toString()).toBe(
      ["A | B", "--- | ---", "中文 | keep"].join("\n"),
    );
    expect(tableCell(view, 2).textContent).toBe("中文");
    expect(docChanges).toBe(1);
  });

  it("preserves an active composition across an unrelated table edit", () => {
    const doc = ["A | B", "--- | ---", "old | keep"].join("\n");
    const view = createView(doc);
    const cell = tableCell(view, 2);
    cell.focus();
    cell.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
    }));
    cell.textContent = "中";

    const keepFrom = view.state.doc.toString().indexOf("keep");
    view.dispatch({
      changes: {
        from: keepFrom,
        to: keepFrom + "keep".length,
        insert: "other",
      },
    });

    expect(tableCell(view, 2)).toBe(cell);
    expect(cell.textContent).toBe("中");
    cell.textContent = "中文";
    cell.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "中文",
    }));
    expect(view.state.doc.toString()).toBe(
      ["A | B", "--- | ---", "中文 | other"].join("\n"),
    );
  });

  it("rejects a composition when the same source cell changed externally", () => {
    const doc = ["A | B", "--- | ---", "old | keep"].join("\n");
    const view = createView(doc);
    const cell = tableCell(view, 2);
    cell.focus();
    cell.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
    }));
    cell.textContent = "候选";

    const oldFrom = view.state.doc.toString().indexOf("old");
    view.dispatch({
      changes: {
        from: oldFrom,
        to: oldFrom + "old".length,
        insert: "external",
      },
    });

    expect(tableCell(view, 2)).toBe(cell);
    expect(cell.textContent).toBe("候选");
    cell.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "候选",
    }));

    expect(view.state.doc.toString()).toBe(
      ["A | B", "--- | ---", "external | keep"].join("\n"),
    );
    expect(cell.textContent).toBe("external");
  });

  it("normalizes a fallback DOM newline without leaving a multiline cell", () => {
    const doc = ["A | B", "--- | ---", "old | keep"].join("\n");
    const view = createView(doc);
    const cell = tableCell(view, 2);
    cell.focus();
    cell.textContent = "new\nline";
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(cell.firstChild!, "new\nline".length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    dispatchInput(cell);

    expect(view.state.doc.toString()).toBe(
      ["A | B", "--- | ---", "new line | keep"].join("\n"),
    );
    expect(cell.textContent).toBe("new line");
    expect(cell.textContent).not.toContain("\n");
    expect(selection.anchorOffset).toBe("new line".length);
  });

  it("normalizes a visual BR to one plain-text space", () => {
    const doc = ["A | B", "--- | ---", "old | keep"].join("\n");
    const view = createView(doc);
    const cell = tableCell(view, 2);
    cell.replaceChildren(
      document.createTextNode("new"),
      document.createElement("br"),
      document.createTextNode("line"),
    );

    dispatchInput(cell);

    expect(view.state.doc.toString()).toBe(
      ["A | B", "--- | ---", "new line | keep"].join("\n"),
    );
    expect(cell.childNodes).toHaveLength(1);
    expect(cell.firstChild).toBeInstanceOf(Text);
    expect(cell.textContent).toBe("new line");
  });

  it("preserves a space boundary around block children", () => {
    const doc = ["A | B", "--- | ---", "old | keep"].join("\n");
    const view = createView(doc);
    const cell = tableCell(view, 2);
    const block = document.createElement("div");
    block.textContent = "line";
    cell.replaceChildren(document.createTextNode("new"), block);

    dispatchInput(cell);

    expect(view.state.doc.toString()).toBe(
      ["A | B", "--- | ---", "new line | keep"].join("\n"),
    );
    expect(cell.childNodes).toHaveLength(1);
    expect(cell.textContent).toBe("new line");
  });

  it("keeps the active cell node, focus, and caret after committing", () => {
    const doc = ["A | B", "--- | ---", "old | keep"].join("\n");
    const view = createView(doc);
    const cell = tableCell(view, 2);
    cell.focus();
    cell.textContent = "new";
    const text = cell.firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    dispatchInput(cell);

    expect(tableCell(view, 2)).toBe(cell);
    expect(document.activeElement).toBe(cell);
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(2);
  });

  it("turns beforeinput line breaks into a single committed space", () => {
    const doc = ["A | B", "--- | ---", "old | keep"].join("\n");
    const view = createView(doc);
    const cell = tableCell(view, 2);
    cell.focus();
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(cell.firstChild!, 1);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertParagraph",
    });

    cell.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(cell.textContent).toBe("o ld");
    expect(view.state.doc.toString()).toBe(
      ["A | B", "--- | ---", "o ld | keep"].join("\n"),
    );
  });

  it("never mutates when the widget option or editor state is read-only", () => {
    const doc = ["A | B", "--- | ---", "old | keep"].join("\n");
    const optionReadOnly = createView(doc, false);
    const stateReadOnly = createView(doc, true, EditorState.readOnly.of(true));

    for (const view of [optionReadOnly, stateReadOnly]) {
      const cell = tableCell(view, 2);
      cell.textContent = "new";
      dispatchInput(cell);
      expect(view.state.doc.toString()).toBe(doc);
    }
  });

  it("removes editability when the editor becomes read-only dynamically", () => {
    const doc = ["A | B", "--- | ---", "old | keep"].join("\n");
    const readOnly = new Compartment();
    const view = createView(
      doc,
      true,
      readOnly.of([]),
    );

    expect(view.state.readOnly).toBe(false);
    expect(tableCell(view, 2).contentEditable).toBe("true");
    view.dispatch({
      effects: readOnly.reconfigure(EditorState.readOnly.of(true)),
    });

    const cell = tableCell(view, 2);
    const root = view.dom.querySelector<HTMLElement>(".md-table-scroll")!;
    expect(root).toHaveAttribute("contenteditable", "false");
    expect(root.contentEditable).toBe("false");
    expect(cell).toHaveAttribute("contenteditable", "false");
    expect(cell.contentEditable).toBe("false");
    expect(cell.isContentEditable).not.toBe(true);
    expect(cell).not.toHaveAttribute("role");
    expect(cell.tabIndex).toBe(-1);
    expect(view.dom.querySelector("table")).not.toHaveAttribute("role");

    cell.textContent = "must-not-land";
    dispatchInput(cell);
    expect(view.state.doc.toString()).toBe(doc);
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
  });

  it("leaves native pointer and mouse events to editable table cells", () => {
    const table = tableFor(["A | B", "--- | ---"].join("\n"));
    const widget = new MarkdownTableWidget(table, true);

    expect(widget.ignoreEvent(new MouseEvent("mousedown"))).toBe(true);

    for (const type of [
      "pointerdown",
      "pointerup",
      "mouseup",
      "click",
    ]) {
      expect(widget.ignoreEvent(new Event(type))).toBe(true);
    }

    expect(widget.ignoreEvent(new KeyboardEvent("keydown", { key: "Tab" })))
      .toBe(false);
    expect(widget.ignoreEvent(new InputEvent("input", {
      inputType: "insertText",
    }))).toBe(false);
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
