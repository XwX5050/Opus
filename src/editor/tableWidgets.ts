import { isolateHistory } from "@codemirror/commands";
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
  appendedTableRow,
  extractMarkdownTables,
  findCurrentTable,
  serializeTableCell,
  tableCells,
  type MarkdownTable,
  type MarkdownTableCell,
} from "./markdownTable";

export interface TableWidgetsOptions {
  readonly editable: boolean;
  /** Undefined is unlimited; invalid/nonpositive limits render no tables. */
  readonly maxRenderedCells?: number;
  readonly onRequestEdit?: (request: TableCellEditRequest) => void;
}

export interface TableCellEditRequest {
  readonly tableFrom: number;
  /** Immutable source snapshot used to reject a replacement at the same offset. */
  readonly expectedSource: string;
  readonly cellIndex: number;
  readonly clientX: number;
  readonly clientY: number;
}

interface TableWidgetContext {
  readonly view: EditorView;
  table: MarkdownTable;
  editable: boolean;
  onRequestEdit?: (request: TableCellEditRequest) => void;
  ownedCells: readonly HTMLElement[];
  readonly composing: Map<HTMLElement, CompositionSnapshot>;
}

interface CompositionSnapshot {
  readonly index: number;
  readonly source: string;
}

interface ResolvedCell {
  readonly context: TableWidgetContext;
  readonly element: HTMLElement;
  readonly index: number;
  readonly model: MarkdownTableCell;
  readonly table: MarkdownTable;
}

const widgetContexts = new WeakMap<HTMLElement, TableWidgetContext>();

const normalizeLineBreaks = (text: string) =>
  text.replace(/\r\n|\r|\n/g, " ");

const blockElements = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "DL",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "UL",
]);

const nativeCellPointerEvents = new Set([
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
]);

const nativeCellDeletionKeys = new Set(["Backspace", "Delete"]);

const isNativeCellDeletionEvent = (event: Event) =>
  event instanceof KeyboardEvent && nativeCellDeletionKeys.has(event.key);

interface DOMPoint {
  readonly node: Node;
  readonly offset: number;
}

const plainCellText = (
  cell: HTMLElement,
  points: readonly DOMPoint[] = [],
) => {
  let text = "";
  const pointOffsets = points.map<number | null>(() => null);

  const recordPoint = (node: Node, offset: number) => {
    points.forEach((point, index) => {
      if (
        pointOffsets[index] === null &&
        point.node === node &&
        point.offset === offset
      ) {
        pointOffsets[index] = text.length;
      }
    });
  };

  const walkChildren = (parent: Node) => {
    let previousWasBlock = false;
    [...parent.childNodes].forEach((child, index) => {
      recordPoint(parent, index);
      const currentIsBlock = child instanceof Element &&
        blockElements.has(child.tagName);
      if (
        (previousWasBlock || currentIsBlock) &&
        text.length > 0 &&
        !/\s$/.test(text)
      ) {
        text += " ";
      }
      walkNode(child);
      previousWasBlock = currentIsBlock;
    });
    recordPoint(parent, parent.childNodes.length);
  };

  const walkNode = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = node.nodeValue ?? "";
      points.forEach((point, index) => {
        if (pointOffsets[index] === null && point.node === node) {
          pointOffsets[index] = text.length +
            normalizeLineBreaks(data.slice(0, point.offset)).length;
        }
      });
      text += normalizeLineBreaks(data);
    } else if (node instanceof HTMLBRElement) {
      text += " ";
    } else {
      walkChildren(node);
    }
  };

  walkChildren(cell);
  return { text, pointOffsets };
};

const normalizeCellContent = (cell: HTMLElement) => {
  const selection = document.getSelection();
  const selectedRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const selectionInsideCell = selectedRange !== null &&
    cell.contains(selectedRange.startContainer) &&
    cell.contains(selectedRange.endContainer);
  const points = selectionInsideCell
    ? [
        {
          node: selectedRange.startContainer,
          offset: selectedRange.startOffset,
        },
        {
          node: selectedRange.endContainer,
          offset: selectedRange.endOffset,
        },
      ]
    : [];
  const { text, pointOffsets } = plainCellText(cell, points);
  const normalizedText = cell.childNodes.length === 1 &&
      cell.firstChild instanceof HTMLBRElement
    ? ""
    : text;
  if (
    cell.childNodes.length === 1 &&
    cell.firstChild?.nodeType === Node.TEXT_NODE &&
    cell.firstChild.nodeValue === normalizedText
  ) {
    return normalizedText;
  }

  const textNode = document.createTextNode(normalizedText);
  cell.replaceChildren(textNode);
  if (
    selection &&
    pointOffsets[0] !== null &&
    pointOffsets[0] !== undefined &&
    pointOffsets[1] !== null &&
    pointOffsets[1] !== undefined
  ) {
    const range = document.createRange();
    range.setStart(textNode, Math.min(pointOffsets[0], normalizedText.length));
    range.setEnd(textNode, Math.min(pointOffsets[1], normalizedText.length));
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return normalizedText;
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
  return (
    cell &&
    event.target === cell &&
    cell.closest(".md-table-scroll") === root
  ) ? cell : null;
};

const resolveCurrentCell = (
  root: HTMLElement,
  event: Event,
): ResolvedCell | null => {
  const context = widgetContexts.get(root);
  const element = cellElementForEvent(root, event);
  if (!context || !element) return null;
  const resolved = resolveCurrentOwnedCell(root, context, element);
  if (
    !resolved ||
    !context.editable ||
    context.view.state.readOnly
  ) {
    return null;
  }
  return resolved;
};

const resolveCurrentOwnedCell = (
  root: HTMLElement,
  context: TableWidgetContext,
  element: HTMLElement,
): ResolvedCell | null => {
  const ownedIndex = context.ownedCells.indexOf(element);

  const currentTable = findCurrentTable(
    context.view.state,
    context.table.from,
    context.table.source,
  );
  if (
    !currentTable ||
    !context.view.dom.contains(root) ||
    ownedIndex < 0 ||
    element.dataset.cellIndex !== String(ownedIndex) ||
    element.dataset.tableFrom !== String(currentTable.from)
  ) {
    return null;
  }

  const cells = tableCells(currentTable);
  if (ownedIndex >= cells.length) {
    return null;
  }

  return {
    context,
    element,
    index: ownedIndex,
    model: cells[ownedIndex],
    table: currentTable,
  };
};

const handleClick = (root: HTMLElement, event: MouseEvent) => {
  if (event.button !== 0) return;
  const context = widgetContexts.get(root);
  const element = cellElementForEvent(root, event);
  if (!context || !element || context.editable || !context.onRequestEdit) return;
  const resolved = resolveCurrentOwnedCell(root, context, element);
  if (!resolved) return;
  context.onRequestEdit({
    tableFrom: resolved.table.from,
    expectedSource: resolved.table.source,
    cellIndex: resolved.index,
    clientX: event.clientX,
    clientY: event.clientY,
  });
};

const commitCell = (resolved: ResolvedCell) => {
  const insert = serializeTableCell(
    normalizeCellContent(resolved.element),
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
  if (resolved) {
    resolved.context.composing.set(resolved.element, {
      index: resolved.index,
      source: resolved.model.source,
    });
  }
};

const handleCompositionEnd = (root: HTMLElement, event: CompositionEvent) => {
  const context = widgetContexts.get(root);
  const element = cellElementForEvent(root, event);
  if (!context || !element) return;
  const snapshot = context.composing.get(element);
  if (!snapshot) return;
  context.composing.delete(element);

  const resolved = resolveCurrentCell(root, event);
  if (!resolved) return;
  if (
    resolved.index !== snapshot.index ||
    resolved.model.source !== snapshot.source
  ) {
    resolved.element.replaceChildren(
      document.createTextNode(resolved.model.displayText),
    );
    return;
  }
  commitCell(resolved);
};

const ownedCellAt = (
  root: HTMLElement,
  context: TableWidgetContext,
  table: MarkdownTable,
  index: number,
) => {
  const element = context.ownedCells[index];
  if (
    !element ||
    !context.view.dom.contains(root) ||
    element.closest(".md-table-scroll") !== root ||
    element.dataset.tableFrom !== String(table.from) ||
    element.dataset.cellIndex !== String(index)
  ) {
    return null;
  }
  return element;
};

const placeCaretInCell = (
  cell: HTMLElement,
  clientX: number,
  clientY: number,
) => {
  const selection = document.getSelection();
  if (!selection) return;
  const caretDocument = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => {
      offsetNode: Node;
      offset: number;
    } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let range: Range | null = null;
  const caretPosition = caretDocument.caretPositionFromPoint?.(clientX, clientY);
  if (caretPosition && cell.contains(caretPosition.offsetNode)) {
    range = document.createRange();
    try {
      range.setStart(caretPosition.offsetNode, caretPosition.offset);
      range.collapse(true);
    } catch {
      range = null;
    }
  }
  if (!range) {
    const caretRange = caretDocument.caretRangeFromPoint?.(clientX, clientY);
    if (caretRange && cell.contains(caretRange.startContainer)) {
      range = caretRange.cloneRange();
      range.collapse(true);
    }
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
};

/**
 * Focuses a rendered editing cell after resolving its table identity against
 * the current document. Requests are transient: this never dispatches a
 * CodeMirror transaction or restores a stale document offset.
 */
export const focusMarkdownTableCell = (
  view: EditorView,
  request: TableCellEditRequest,
): boolean => {
  if (view.state.readOnly || !view.dom.isConnected) return false;
  const roots = view.dom.querySelectorAll<HTMLElement>(".md-table-scroll");
  for (const root of roots) {
    const context = widgetContexts.get(root);
    if (!context || context.view !== view || !context.editable) continue;
    const currentTable = findCurrentTable(
      view.state,
      context.table.from,
      context.table.source,
    );
    if (
      !currentTable ||
      currentTable.from !== request.tableFrom ||
      currentTable.source !== request.expectedSource
    ) {
      continue;
    }
    const cell = ownedCellAt(root, context, currentTable, request.cellIndex);
    if (!cell) continue;
    cell.focus();
    placeCaretInCell(cell, request.clientX, request.clientY);
    return true;
  }
  return false;
};

const queueCellFocus = (
  view: EditorView,
  tableFrom: number,
  index: number,
  expectedSource: string,
) => {
  queueMicrotask(() => {
    if (!view.dom.isConnected) return;
    const roots = view.dom.querySelectorAll<HTMLElement>(".md-table-scroll");
    for (const root of roots) {
      const context = widgetContexts.get(root);
      if (!context || context.view !== view) continue;
      const currentTable = findCurrentTable(
        view.state,
        context.table.from,
        context.table.source,
      );
      if (
        !currentTable ||
        currentTable.from !== tableFrom ||
        currentTable.source !== expectedSource
      ) {
        continue;
      }
      const element = ownedCellAt(root, context, currentTable, index);
      if (element) {
        element.focus();
        return;
      }
    }
  });
};

const handleKeyDown = (root: HTMLElement, event: KeyboardEvent) => {
  const isTab = event.key === "Tab";
  const isEscape = event.key === "Escape";
  if (
    (!isTab && !isEscape) ||
    event.repeat ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    (isEscape && event.shiftKey)
  ) {
    return;
  }

  const resolved = resolveCurrentCell(root, event);
  if (
    !resolved ||
    event.isComposing ||
    resolved.context.composing.has(resolved.element)
  ) {
    return;
  }

  const cells = tableCells(resolved.table);
  let targetCell: HTMLElement | null = null;
  if (isTab && (event.shiftKey || resolved.index < cells.length - 1)) {
    const targetIndex = event.shiftKey
      ? Math.max(0, resolved.index - 1)
      : resolved.index + 1;
    targetCell = ownedCellAt(
      root,
      resolved.context,
      resolved.table,
      targetIndex,
    );
    if (!targetCell) return;
  }

  event.preventDefault();
  event.stopPropagation();

  if (isEscape) {
    const tableEnd = Math.min(
      resolved.context.view.state.doc.length,
      resolved.table.to,
    );
    resolved.context.view.focus();
    resolved.context.view.dispatch({
      selection: { anchor: tableEnd },
    });
    return;
  }

  if (targetCell) {
    targetCell.focus();
    return;
  }

  const firstNewCellIndex = cells.length;
  const tableFrom = resolved.table.from;
  const appendedRow = appendedTableRow(resolved.table);
  resolved.context.view.dispatch({
    changes: {
      from: resolved.table.to,
      insert: appendedRow,
    },
    annotations: isolateHistory.of("full"),
    userEvent: "input.type",
  });
  queueCellFocus(
    resolved.context.view,
    tableFrom,
    firstNewCellIndex,
    `${resolved.table.source}${appendedRow}`,
  );
};

const addDelegatedListeners = (root: HTMLElement) => {
  root.addEventListener("click", (event) => {
    handleClick(root, event as MouseEvent);
  });
  root.addEventListener("keydown", (event) => {
    handleKeyDown(root, event);
  });
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
  editableOption: boolean,
  readOnly: boolean,
) => {
  if (editableOption && !readOnly) {
    element.setAttribute(
      "role",
      tagName === "th" ? "columnheader" : "gridcell",
    );
    element.contentEditable = "true";
    element.setAttribute("contenteditable", "true");
    element.spellcheck = true;
    element.tabIndex = 0;
  } else {
    element.removeAttribute("role");
    element.spellcheck = false;
    element.removeAttribute("spellcheck");
    element.removeAttribute("tabindex");
    if (editableOption) {
      element.contentEditable = "false";
      element.setAttribute("contenteditable", "false");
    } else {
      element.contentEditable = "inherit";
      element.removeAttribute("contenteditable");
    }
  }
};

export class MarkdownTableWidget extends WidgetType {
  constructor(
    readonly table: MarkdownTable,
    readonly editable: boolean,
    readonly readOnly = false,
    readonly onRequestEdit?: (request: TableCellEditRequest) => void,
  ) {
    super();
  }

  eq(other: WidgetType) {
    return (
      other instanceof MarkdownTableWidget &&
      other.table.from === this.table.from &&
      other.table.source === this.table.source &&
      other.editable === this.editable &&
      other.readOnly === this.readOnly &&
      other.onRequestEdit === this.onRequestEdit
    );
  }

  toDOM(view?: EditorView) {
    const scroll = document.createElement("div");
    scroll.className = "md-table-scroll";
    scroll.contentEditable = "false";
    scroll.setAttribute("contenteditable", "false");

    const tableElement = document.createElement("table");
    tableElement.className = "md-table";
    tableElement.setAttribute("aria-label", "Markdown 表格");
    const readOnly = this.readOnly || view?.state.readOnly === true;
    if (this.editable && !readOnly) tableElement.setAttribute("role", "grid");
    if (this.table.rows.length === 0) {
      tableElement.classList.add("md-table-no-body");
    }

    let cellIndex = 0;
    const ownedCells: HTMLElement[] = [];
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
      setCellEditability(element, tagName, this.editable, readOnly);
      element.textContent = cell.displayText;
      row.append(element);
      ownedCells.push(element);
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
        onRequestEdit: this.onRequestEdit,
        ownedCells,
        composing: new Map(),
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
    dom.contentEditable = "false";
    dom.setAttribute("contenteditable", "false");

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
    const readOnly = this.readOnly || view.state.readOnly;
    const editable = this.editable && !readOnly;
    const composing = editable
      ? previous?.composing ?? new Map()
      : new Map<HTMLElement, CompositionSnapshot>();
    widgetContexts.set(dom, {
      view,
      table: this.table,
      editable: this.editable,
      onRequestEdit: this.onRequestEdit,
      ownedCells: elements,
      composing,
    });

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
      setCellEditability(element, tagName, this.editable, readOnly);

      const activeCellMatchesSource = document.activeElement === element &&
        element.textContent === cell.displayText;
      const isComposing = composing.has(element);
      if (!activeCellMatchesSource && !isComposing) {
        element.textContent = cell.displayText;
      }
    });
    return true;
  }

  ignoreEvent(event: Event) {
    return nativeCellPointerEvents.has(event.type) ||
      (this.editable && !this.readOnly && isNativeCellDeletionEvent(event));
  }
}

const decorationSetsFor = (
  state: EditorState,
  view: EditorView,
  options: TableWidgetsOptions,
): { decorations: DecorationSet; atomicRanges: DecorationSet } => {
  const replacements: ReturnType<Decoration["range"]>[] = [];
  const atomicRanges: ReturnType<Decoration["range"]>[] = [];

  for (const table of extractMarkdownTables(
    state,
    view.visibleRanges,
    { maxCells: options.maxRenderedCells },
  )) {
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
                  options.onRequestEdit,
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
