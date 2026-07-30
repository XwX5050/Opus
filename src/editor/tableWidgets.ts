import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  extractMarkdownTables,
  findCurrentTable,
  serializeTableCell,
  tableCells,
  type MarkdownTable,
  type MarkdownTableCell,
} from "./markdownTable";

export interface TableWidgetsOptions {
  readonly editable: boolean;
}

interface TableWidgetContext {
  readonly view: EditorView;
  table: MarkdownTable;
  editable: boolean;
  readonly composing: WeakSet<HTMLElement>;
}

interface ResolvedCell {
  readonly context: TableWidgetContext;
  readonly element: HTMLElement;
  readonly model: MarkdownTableCell;
}

const widgetContexts = new WeakMap<HTMLElement, TableWidgetContext>();

const normalizeLineBreaks = (text: string) =>
  text.replace(/\r\n|\r|\n/g, " ");

const textOffsetWithin = (
  cell: HTMLElement,
  node: Node,
  offset: number,
) => {
  const prefix = document.createRange();
  prefix.selectNodeContents(cell);
  prefix.setEnd(node, offset);
  return prefix.toString().length;
};

const normalizeCellLineBreaks = (cell: HTMLElement) => {
  const text = cell.textContent ?? "";
  const normalized = normalizeLineBreaks(text);
  if (normalized === text) return normalized;

  const selection = document.getSelection();
  const selectedRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const selectionInsideCell = selectedRange !== null &&
    cell.contains(selectedRange.startContainer) &&
    cell.contains(selectedRange.endContainer);
  const startOffset = selectionInsideCell
    ? textOffsetWithin(
        cell,
        selectedRange.startContainer,
        selectedRange.startOffset,
      )
    : null;
  const endOffset = selectionInsideCell
    ? textOffsetWithin(
        cell,
        selectedRange.endContainer,
        selectedRange.endOffset,
      )
    : null;

  const textNode = document.createTextNode(normalized);
  cell.replaceChildren(textNode);
  if (
    selection &&
    startOffset !== null &&
    endOffset !== null
  ) {
    const range = document.createRange();
    range.setStart(
      textNode,
      normalizeLineBreaks(text.slice(0, startOffset)).length,
    );
    range.setEnd(
      textNode,
      normalizeLineBreaks(text.slice(0, endOffset)).length,
    );
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return normalized;
};

const cellElementForEvent = (
  root: HTMLElement,
  event: Event,
): HTMLElement | null => {
  const target = event.target;
  const element = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
  const cell = element?.closest<HTMLElement>(
    "th[data-cell-index], td[data-cell-index]",
  ) ?? null;
  return cell && cell.closest(".md-table-scroll") === root ? cell : null;
};

const resolveCurrentCell = (
  root: HTMLElement,
  event: Event,
): ResolvedCell | null => {
  const context = widgetContexts.get(root);
  const element = cellElementForEvent(root, event);
  if (!context || !element) return null;

  const currentTable = findCurrentTable(
    context.view.state,
    context.table.from,
    context.table.source,
  );
  if (
    !currentTable ||
    !context.editable ||
    context.view.state.readOnly ||
    !context.view.dom.contains(root) ||
    element.dataset.tableFrom !== String(currentTable.from)
  ) {
    return null;
  }

  const indexSource = element.dataset.cellIndex;
  const index = indexSource === undefined ? Number.NaN : Number(indexSource);
  const cells = tableCells(currentTable);
  if (!Number.isInteger(index) || index < 0 || index >= cells.length) {
    return null;
  }

  return {
    context,
    element,
    model: cells[index],
  };
};

const commitCell = (resolved: ResolvedCell) => {
  const insert = serializeTableCell(
    normalizeCellLineBreaks(resolved.element),
  );
  if (insert === resolved.model.source) return;
  resolved.context.view.dispatch({
    changes: {
      from: resolved.model.from,
      to: resolved.model.to,
      insert,
    },
    userEvent: "input.type",
  });
};

const insertPlainText = (cell: HTMLElement, text: string) => {
  const textNode = document.createTextNode(text);
  const selection = document.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const selectionInsideCell = range !== null &&
    cell.contains(range.startContainer) &&
    cell.contains(range.endContainer);

  if (selectionInsideCell) {
    range.deleteContents();
    range.insertNode(textNode);
  } else {
    cell.append(textNode);
  }

  if (selection) {
    const caret = document.createRange();
    caret.setStartAfter(textNode);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
  }
};

const handleBeforeInput = (root: HTMLElement, event: InputEvent) => {
  if (
    event.inputType !== "insertParagraph" &&
    event.inputType !== "insertLineBreak"
  ) {
    return;
  }
  const resolved = resolveCurrentCell(root, event);
  if (!resolved) return;
  event.preventDefault();
  insertPlainText(resolved.element, " ");
  commitCell(resolved);
};

const handleInput = (root: HTMLElement, event: InputEvent) => {
  const resolved = resolveCurrentCell(root, event);
  if (!resolved || resolved.context.composing.has(resolved.element)) return;
  commitCell(resolved);
};

const handlePaste = (root: HTMLElement, event: ClipboardEvent) => {
  const resolved = resolveCurrentCell(root, event);
  if (!resolved) return;
  event.preventDefault();
  const text = normalizeLineBreaks(
    event.clipboardData?.getData("text/plain") ?? "",
  );
  insertPlainText(resolved.element, text);
  commitCell(resolved);
};

const handleCompositionStart = (root: HTMLElement, event: CompositionEvent) => {
  const resolved = resolveCurrentCell(root, event);
  if (resolved) resolved.context.composing.add(resolved.element);
};

const handleCompositionEnd = (root: HTMLElement, event: CompositionEvent) => {
  const resolved = resolveCurrentCell(root, event);
  if (!resolved || !resolved.context.composing.has(resolved.element)) return;
  resolved.context.composing.delete(resolved.element);
  commitCell(resolved);
};

const addDelegatedListeners = (root: HTMLElement) => {
  root.addEventListener("beforeinput", (event) => {
    handleBeforeInput(root, event as InputEvent);
  });
  root.addEventListener("input", (event) => {
    handleInput(root, event as InputEvent);
  });
  root.addEventListener("paste", (event) => {
    handlePaste(root, event as ClipboardEvent);
  });
  root.addEventListener("compositionstart", (event) => {
    handleCompositionStart(root, event as CompositionEvent);
  });
  root.addEventListener("compositionend", (event) => {
    handleCompositionEnd(root, event as CompositionEvent);
  });
};

const setCellEditability = (
  element: HTMLElement,
  tagName: "th" | "td",
  editable: boolean,
) => {
  if (editable) {
    element.setAttribute(
      "role",
      tagName === "th" ? "columnheader" : "gridcell",
    );
    element.contentEditable = "true";
    element.spellcheck = true;
    element.tabIndex = 0;
  } else {
    element.removeAttribute("role");
    element.contentEditable = "inherit";
    element.spellcheck = false;
    element.removeAttribute("contenteditable");
    element.removeAttribute("spellcheck");
    element.removeAttribute("tabindex");
  }
};

export class MarkdownTableWidget extends WidgetType {
  constructor(
    readonly table: MarkdownTable,
    readonly editable: boolean,
    readonly readOnly = false,
  ) {
    super();
  }

  eq(other: WidgetType) {
    return (
      other instanceof MarkdownTableWidget &&
      other.table.from === this.table.from &&
      other.table.source === this.table.source &&
      other.editable === this.editable &&
      other.readOnly === this.readOnly
    );
  }

  toDOM(view?: EditorView) {
    const scroll = document.createElement("div");
    scroll.className = "md-table-scroll";

    const tableElement = document.createElement("table");
    tableElement.className = "md-table";
    tableElement.setAttribute("aria-label", "Markdown 表格");
    const editable = this.editable && !this.readOnly && !view?.state.readOnly;
    if (editable) tableElement.setAttribute("role", "grid");
    if (this.table.rows.length === 0) {
      tableElement.classList.add("md-table-no-body");
    }

    let cellIndex = 0;
    const appendCell = (
      row: HTMLTableRowElement,
      tagName: "th" | "td",
      cell: MarkdownTableCell,
      columnIndex: number,
    ) => {
      const element = document.createElement(tagName);
      element.dataset.tableFrom = String(this.table.from);
      element.dataset.cellIndex = String(cellIndex);
      element.dataset.alignment = this.table.columns[columnIndex].alignment;
      setCellEditability(element, tagName, editable);
      element.textContent = cell.displayText;
      row.append(element);
      cellIndex += 1;
    };

    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    this.table.header.forEach((cell, columnIndex) => {
      appendCell(headerRow, "th", cell, columnIndex);
    });
    head.append(headerRow);
    tableElement.append(head);

    const body = document.createElement("tbody");
    for (const cells of this.table.rows) {
      const row = document.createElement("tr");
      cells.forEach((cell, columnIndex) => {
        appendCell(row, "td", cell, columnIndex);
      });
      body.append(row);
    }
    tableElement.append(body);
    scroll.append(tableElement);
    if (view) {
      widgetContexts.set(scroll, {
        view,
        table: this.table,
        editable: this.editable,
        composing: new WeakSet(),
      });
      addDelegatedListeners(scroll);
    }
    return scroll;
  }

  updateDOM(dom: HTMLElement, view: EditorView) {
    if (
      !dom.classList.contains("md-table-scroll") ||
      !(dom.firstElementChild instanceof HTMLTableElement) ||
      !dom.firstElementChild.classList.contains("md-table") ||
      dom.children.length !== 1
    ) {
      return false;
    }

    const tableElement = dom.firstElementChild;
    const headRows = tableElement.tHead?.rows;
    const bodyRows = tableElement.tBodies.item(0)?.rows;
    if (
      !headRows ||
      headRows.length !== 1 ||
      !bodyRows ||
      bodyRows.length !== this.table.rows.length ||
      headRows[0].cells.length !== this.table.header.length ||
      [...bodyRows].some((row, index) =>
        row.cells.length !== this.table.rows[index].length
      )
    ) {
      return false;
    }

    const elements = [
      ...headRows[0].cells,
      ...[...bodyRows].flatMap((row) => [...row.cells]),
    ] as HTMLElement[];
    const cells = tableCells(this.table);
    if (
      elements.length !== cells.length ||
      elements.some((element, index) =>
        element.tagName !== (index < this.table.header.length ? "TH" : "TD")
      )
    ) {
      return false;
    }

    const previous = widgetContexts.get(dom);
    const previousCells = previous ? tableCells(previous.table) : [];
    widgetContexts.set(dom, {
      view,
      table: this.table,
      editable: this.editable,
      composing: previous?.composing ?? new WeakSet(),
    });

    const editable = this.editable && !this.readOnly && !view.state.readOnly;
    tableElement.setAttribute("aria-label", "Markdown 表格");
    tableElement.classList.toggle(
      "md-table-no-body",
      this.table.rows.length === 0,
    );
    if (editable) tableElement.setAttribute("role", "grid");
    else tableElement.removeAttribute("role");

    elements.forEach((element, index) => {
      const cell = cells[index];
      const columnIndex = index < this.table.header.length
        ? index
        : index % this.table.columns.length;
      const tagName = index < this.table.header.length ? "th" : "td";
      element.dataset.tableFrom = String(this.table.from);
      element.dataset.cellIndex = String(index);
      element.dataset.alignment = this.table.columns[columnIndex].alignment;
      setCellEditability(element, tagName, editable);

      const activeCellMatchesSource = document.activeElement === element &&
        element.textContent === cell.displayText;
      const composingCellSourceIsUnchanged =
        previous?.composing.has(element) === true &&
        previousCells[index]?.source === cell.source;
      if (!activeCellMatchesSource && !composingCellSourceIsUnchanged) {
        element.textContent = cell.displayText;
      }
    });
    return true;
  }

  ignoreEvent() {
    return false;
  }
}

const decorationSetsFor = (
  state: EditorState,
  view: EditorView,
  options: TableWidgetsOptions,
): { decorations: DecorationSet; atomicRanges: DecorationSet } => {
  const replacements: ReturnType<Decoration["range"]>[] = [];
  const atomicRanges: ReturnType<Decoration["range"]>[] = [];

  for (const table of extractMarkdownTables(state, view.visibleRanges)) {
    let segmentFrom = table.from;
    let firstLine = true;
    while (segmentFrom < table.to) {
      const line = state.doc.lineAt(segmentFrom);
      const segmentTo = Math.min(line.to, table.to);
      if (!firstLine) {
        replacements.push(
          Decoration.line({
            attributes: { class: "cm-table-continuation" },
          }).range(line.from),
        );
      }
      if (segmentTo > segmentFrom) {
        replacements.push(
          Decoration.replace({
            widget: firstLine
              ? new MarkdownTableWidget(
                  table,
                  options.editable,
                  state.readOnly,
                )
              : undefined,
          }).range(segmentFrom, segmentTo),
        );
      }
      firstLine = false;
      if (segmentTo === table.to) break;
      segmentFrom = line.to + 1;
    }
    atomicRanges.push(Decoration.mark({}).range(table.from, table.to));
  }

  return {
    decorations: Decoration.set(replacements, true),
    atomicRanges: Decoration.set(atomicRanges, true),
  };
};

class TableWidgetsPlugin {
  decorations: DecorationSet;
  atomicRanges: DecorationSet;

  constructor(
    view: EditorView,
    private readonly options: TableWidgetsOptions,
  ) {
    const sets = decorationSetsFor(view.state, view, options);
    this.decorations = sets.decorations;
    this.atomicRanges = sets.atomicRanges;
  }

  update(update: ViewUpdate) {
    const syntaxChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
    const readOnlyChanged =
      update.startState.readOnly !== update.state.readOnly;
    if (
      update.docChanged ||
      update.viewportChanged ||
      syntaxChanged ||
      readOnlyChanged
    ) {
      const sets = decorationSetsFor(update.state, update.view, this.options);
      this.decorations = sets.decorations;
      this.atomicRanges = sets.atomicRanges;
    }
  }
}

export const tableWidgetsExtension = (
  options: TableWidgetsOptions,
): Extension => {
  const plugin = ViewPlugin.fromClass(
    class extends TableWidgetsPlugin {
      constructor(view: EditorView) {
        super(view, options);
      }
    },
    {
      decorations: (value) => value.decorations,
      provide: (extension) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(extension)?.atomicRanges ?? Decoration.none,
        ),
    },
  );
  const continuationTheme = EditorView.baseTheme({
    ".cm-table-continuation": {
      height: "0",
      minHeight: "0",
      lineHeight: "0",
      overflow: "hidden",
      padding: "0",
    },
    ".cm-table-continuation.cm-live-preview-quote-line-last": {
      height: "auto",
      minHeight: "0",
      lineHeight: "0",
      overflow: "hidden",
      paddingTop: "0 !important",
      paddingRight: "var(--space-5) !important",
      paddingBottom: "var(--space-3) !important",
      paddingLeft: "var(--space-5) !important",
      borderRadius: "0 0 var(--radius-medium) var(--radius-medium)",
    },
    ".md-table-no-body thead tr:last-child > *": {
      borderBottom: "0",
    },
  });
  return [plugin, continuationTheme];
};
