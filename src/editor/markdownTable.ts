import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

export type TableAlignment = "default" | "left" | "center" | "right";

export interface MarkdownTableCell {
  readonly from: number;
  readonly to: number;
  readonly source: string;
  readonly displayText: string;
}

export interface MarkdownTableColumn {
  readonly alignment: TableAlignment;
}

export interface MarkdownTable {
  readonly from: number;
  readonly to: number;
  readonly source: string;
  readonly continuationPrefix: string;
  readonly columns: readonly MarkdownTableColumn[];
  readonly header: readonly MarkdownTableCell[];
  readonly rows: readonly (readonly MarkdownTableCell[])[];
}

export interface TableRange {
  readonly from: number;
  readonly to: number;
}

export interface MarkdownTableExtractionDiagnostics {
  /** Body rows parsed into cell models. */
  materializedRows: number;
  /** Header and body cells parsed into cell models; delimiter cells are excluded. */
  materializedCells: number;
  /** Tables rejected before extraction because they exceeded maxCells. */
  skippedForCellLimit: number;
}

export interface MarkdownTableExtractionOptions {
  /** Undefined is unlimited; invalid/nonpositive values extract no tables. */
  readonly maxCells?: number;
  readonly diagnostics?: MarkdownTableExtractionDiagnostics;
}

const whitespace = (character: string) => character === " " || character === "\t";

export const decodeTableCell = (source: string): string =>
  source.replace(/\\+\|/g, (escapedPipe) => {
    const backslashes = escapedPipe.length - 1;
    if (backslashes % 2 === 0) return escapedPipe;
    return `${"\\".repeat((backslashes - 1) / 2)}|`;
  });

export const serializeTableCell = (text: string): string =>
  text
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/(\\*)\|/g, (_pipe, backslashes: string) =>
      `${"\\".repeat(backslashes.length * 2 + 1)}|`,
    );

const normalizeRanges = (
  docLength: number,
  ranges: readonly TableRange[] | undefined,
): TableRange[] => {
  if (docLength === 0) return [];
  const requested = ranges ?? [{ from: 0, to: docLength }];
  const normalized = requested
    .map((range) => {
      let from = Math.max(0, Math.min(range.from, range.to, docLength));
      let to = Math.max(0, Math.min(Math.max(range.from, range.to), docLength));
      if (from === to) {
        if (to < docLength) to += 1;
        else from -= 1;
      }
      return { from, to };
    })
    .filter(({ from, to }) => from >= 0 && to > from)
    .sort((left, right) => left.from - right.from || left.to - right.to);

  const merged: { from: number; to: number }[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
};

const normalizeCellLimit = (maxCells: number | undefined) =>
  maxCells === undefined
    ? undefined
    : Number.isFinite(maxCells) && maxCells > 0
      ? Math.floor(maxCells)
      : 0;

export type MarkdownTableLineCells =
  | { readonly overflow: false; readonly cells: MarkdownTableCell[] }
  | { readonly overflow: true };

const isStructuralPipeAt = (line: string, index: number): boolean => {
  if (line[index] !== "|") return false;
  let backslashes = 0;
  for (
    let previous = index - 1;
    previous >= 0 && line[previous] === "\\";
    previous -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 0;
};

export const cellsForLine = (
  state: EditorState,
  from: number,
  to: number,
  maxCells?: number,
): MarkdownTableLineCells => {
  // EditorState exposes range text as a string, so one line slice is unavoidable.
  // Separator and cell arrays are only created within the normalized cell limit.
  const line = state.sliceDoc(from, to);
  const cellLimit = normalizeCellLimit(maxCells);
  let firstContent = 0;
  while (firstContent < line.length && whitespace(line[firstContent])) firstContent += 1;
  let lastContent = line.length;
  while (lastContent > firstContent && whitespace(line[lastContent - 1])) lastContent -= 1;

  const hasLeadingPipe = line[firstContent] === "|";
  const hasTrailingPipe = lastContent > 0 &&
    isStructuralPipeAt(line, lastContent - 1);
  const start = hasLeadingPipe ? firstContent + 1 : 0;
  const end = hasTrailingPipe ? lastContent - 1 : line.length;
  if (start > end) return { overflow: false, cells: [] };

  const separators: number[] = [];
  let backslashRun = 0;
  for (let index = start; index < end; index += 1) {
    const character = line[index];
    if (character === "\\") {
      backslashRun += 1;
      continue;
    }
    if (character === "|" && backslashRun % 2 === 0) {
      if (cellLimit !== undefined && separators.length + 2 > cellLimit) {
        return { overflow: true };
      }
      separators.push(index);
    }
    backslashRun = 0;
  }
  if (cellLimit !== undefined && separators.length + 1 > cellLimit) {
    return { overflow: true };
  }

  const cells: MarkdownTableCell[] = [];
  let cellStart = start;
  for (let index = 0; index <= separators.length; index += 1) {
    const cellEnd = separators[index] ?? end;
    let trimmedStart = cellStart;
    let trimmedEnd = cellEnd;
    while (trimmedStart < trimmedEnd && whitespace(line[trimmedStart])) trimmedStart += 1;
    while (trimmedEnd > trimmedStart && whitespace(line[trimmedEnd - 1])) trimmedEnd -= 1;
    const source = line.slice(trimmedStart, trimmedEnd);
    cells.push({
      from: from + trimmedStart,
      to: from + trimmedEnd,
      source,
      displayText: decodeTableCell(source),
    });
    cellStart = cellEnd + 1;
  }
  return { overflow: false, cells };
};

const alignmentFor = (cell: MarkdownTableCell): TableAlignment | null => {
  if (!/^:?-+:?$/.test(cell.source)) return null;
  if (cell.source.startsWith(":")) {
    return cell.source.endsWith(":") ? "center" : "left";
  }
  return cell.source.endsWith(":") ? "right" : "default";
};

const tableForNode = (
  state: EditorState,
  table: SyntaxNode,
  maxCells: number | undefined,
  diagnostics: MarkdownTableExtractionDiagnostics | undefined,
): MarkdownTable | null => {
  if (maxCells === 0) {
    if (diagnostics) diagnostics.skippedForCellLimit += 1;
    return null;
  }

  let headerNode: SyntaxNode | null = null;
  let delimiterNode: SyntaxNode | null = null;
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableHeader") headerNode = child;
    else if (child.name === "TableDelimiter") delimiterNode = child;
    if (headerNode && delimiterNode) break;
  }
  if (!headerNode || !delimiterNode) return null;

  const headerResult = cellsForLine(
    state,
    headerNode.from,
    headerNode.to,
    maxCells,
  );
  if (headerResult.overflow) {
    if (diagnostics) diagnostics.skippedForCellLimit += 1;
    return null;
  }
  const header = headerResult.cells;
  if (diagnostics) diagnostics.materializedCells += header.length;
  if (header.length === 0) return null;

  const delimiterResult = cellsForLine(
    state,
    delimiterNode.from,
    delimiterNode.to,
    header.length,
  );
  if (delimiterResult.overflow) {
    if (diagnostics) diagnostics.skippedForCellLimit += 1;
    return null;
  }
  const delimiter = delimiterResult.cells;
  const alignments = delimiter.map(alignmentFor);
  if (
    header.length !== delimiter.length ||
    alignments.some((alignment) => alignment === null)
  ) return null;

  const rows: MarkdownTableCell[][] = [];
  let materializedTableCells = header.length;
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name !== "TableRow") continue;
    if (
      maxCells !== undefined &&
      materializedTableCells + header.length > maxCells
    ) {
      if (diagnostics) diagnostics.skippedForCellLimit += 1;
      return null;
    }
    const remainingCells = maxCells === undefined
      ? header.length
      : Math.min(header.length, maxCells - materializedTableCells);
    const rowResult = cellsForLine(
      state,
      child.from,
      child.to,
      remainingCells,
    );
    if (rowResult.overflow) {
      if (diagnostics) diagnostics.skippedForCellLimit += 1;
      return null;
    }
    const row = rowResult.cells;
    if (diagnostics) {
      diagnostics.materializedRows += 1;
      diagnostics.materializedCells += row.length;
    }
    if (row.length !== header.length) return null;
    rows.push(row);
    materializedTableCells += row.length;
  }

  const delimiterLine = state.doc.lineAt(delimiterNode.from);
  return {
    from: table.from,
    to: table.to,
    source: state.sliceDoc(table.from, table.to),
    continuationPrefix: state.sliceDoc(
      delimiterLine.from,
      delimiterNode.from,
    ),
    columns: alignments.map((alignment) => ({ alignment: alignment! })),
    header,
    rows,
  };
};

export const extractMarkdownTables = (
  state: EditorState,
  ranges?: readonly TableRange[],
  options: MarkdownTableExtractionOptions = {},
): MarkdownTable[] => {
  const tables: MarkdownTable[] = [];
  const seen = new Set<string>();
  const tree = syntaxTree(state);
  const maxCells = normalizeCellLimit(options.maxCells);
  for (const range of normalizeRanges(state.doc.length, ranges)) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.name !== "Table") return;
        if (node.from >= range.to || node.to <= range.from) return;
        const key = `${node.from}:${node.to}`;
        if (seen.has(key)) return false;
        seen.add(key);
        const table = tableForNode(
          state,
          node.node,
          maxCells,
          options.diagnostics,
        );
        if (table) tables.push(table);
        return false;
      },
    });
  }
  return tables;
};

export const findCurrentTable = (
  state: EditorState,
  tableFrom: number,
  expectedSource: string,
): MarkdownTable | null => {
  const tableTo = tableFrom + expectedSource.length;
  if (
    expectedSource.length === 0 ||
    tableFrom < 0 ||
    tableTo > state.doc.length ||
    state.sliceDoc(tableFrom, tableTo) !== expectedSource
  ) {
    return null;
  }

  return extractMarkdownTables(state, [{ from: tableFrom, to: tableTo }])
    .find((table) =>
      table.from === tableFrom &&
      table.to === tableTo &&
      table.source === expectedSource
    ) ?? null;
};

export const tableCells = (table: MarkdownTable): MarkdownTableCell[] => [
  ...table.header,
  ...table.rows.flat(),
];

export const appendedTableRow = (table: MarkdownTable): string =>
  `\n${table.continuationPrefix}| ${
    table.columns.map(() => "").join(" | ")
  } |`;
