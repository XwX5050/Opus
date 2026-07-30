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
  type MarkdownTable,
  type MarkdownTableCell,
} from "./markdownTable";

export interface TableWidgetsOptions {
  readonly editable: boolean;
}

export class MarkdownTableWidget extends WidgetType {
  constructor(
    readonly table: MarkdownTable,
    readonly editable: boolean,
  ) {
    super();
  }

  eq(other: WidgetType) {
    return (
      other instanceof MarkdownTableWidget &&
      other.table.from === this.table.from &&
      other.table.source === this.table.source &&
      other.editable === this.editable
    );
  }

  toDOM() {
    const scroll = document.createElement("div");
    scroll.className = "md-table-scroll";

    const tableElement = document.createElement("table");
    tableElement.className = "md-table";
    tableElement.setAttribute("aria-label", "Markdown 表格");
    if (this.editable) tableElement.setAttribute("role", "grid");
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
      if (this.editable) {
        element.setAttribute(
          "role",
          tagName === "th" ? "columnheader" : "gridcell",
        );
        element.contentEditable = "true";
        element.spellcheck = true;
        element.tabIndex = 0;
      }
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
    return scroll;
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
              ? new MarkdownTableWidget(table, options.editable)
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
    if (update.docChanged || update.viewportChanged || syntaxChanged) {
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
