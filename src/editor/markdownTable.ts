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
  readonly columns: readonly MarkdownTableColumn[];
  readonly header: readonly MarkdownTableCell[];
  readonly rows: readonly (readonly MarkdownTableCell[])[];
}

export interface TableRange {
  readonly from: number;
  readonly to: number;
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

const structuralPipes = (line: string): number[] => {
  const pipes: number[] = [];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "|") continue;
    let backslashes = 0;
    for (let previous = index - 1; previous >= 0 && line[previous] === "\\"; previous -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) pipes.push(index);
  }
  return pipes;
};

const cellsForLine = (state: EditorState, from: number, to: number): MarkdownTableCell[] => {
  const line = state.sliceDoc(from, to);
  const pipes = structuralPipes(line);
  let firstContent = 0;
  while (firstContent < line.length && whitespace(line[firstContent])) firstContent += 1;
  let lastContent = line.length;
  while (lastContent > firstContent && whitespace(line[lastContent - 1])) lastContent -= 1;

  const hasLeadingPipe = pipes.includes(firstContent);
  const hasTrailingPipe = lastContent > 0 && pipes.includes(lastContent - 1);
  const start = hasLeadingPipe ? firstContent + 1 : 0;
  const end = hasTrailingPipe ? lastContent - 1 : line.length;
  if (start > end) return [];
  const separators = pipes.filter((pipe) => pipe >= start && pipe < end);
  const boundaries = [start, ...separators.map((pipe) => pipe + 1)];
  const ends = [...separators, end];

  return boundaries.flatMap((cellStart, index) => {
    const cellEnd = ends[index];
    if (cellStart > cellEnd) return [];
    let trimmedStart = cellStart;
    let trimmedEnd = cellEnd;
    while (trimmedStart < trimmedEnd && whitespace(line[trimmedStart])) trimmedStart += 1;
    while (trimmedEnd > trimmedStart && whitespace(line[trimmedEnd - 1])) trimmedEnd -= 1;
    const source = line.slice(trimmedStart, trimmedEnd);
    return [{
      from: from + trimmedStart,
      to: from + trimmedEnd,
      source,
      displayText: decodeTableCell(source),
    }];
  });
};

const alignmentFor = (cell: MarkdownTableCell): TableAlignment | null => {
  if (!/^:?-+:?$/.test(cell.source)) return null;
  if (cell.source.startsWith(":")) {
    return cell.source.endsWith(":") ? "center" : "left";
  }
  return cell.source.endsWith(":") ? "right" : "default";
};

const tableForNode = (state: EditorState, table: SyntaxNode): MarkdownTable | null => {
  let headerNode: SyntaxNode | null = null;
  let delimiterNode: SyntaxNode | null = null;
  const rowNodes: SyntaxNode[] = [];
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableHeader") headerNode = child;
    else if (child.name === "TableDelimiter") delimiterNode = child;
    else if (child.name === "TableRow") rowNodes.push(child);
  }
  if (!headerNode || !delimiterNode) return null;

  const header = cellsForLine(state, headerNode.from, headerNode.to);
  const delimiter = cellsForLine(state, delimiterNode.from, delimiterNode.to);
  const alignments = delimiter.map(alignmentFor);
  if (
    header.length === 0 ||
    header.length !== delimiter.length ||
    alignments.some((alignment) => alignment === null)
  ) return null;

  const rows = rowNodes.map((row) => cellsForLine(state, row.from, row.to));
  if (rows.some((row) => row.length !== header.length)) return null;

  return {
    from: table.from,
    to: table.to,
    source: state.sliceDoc(table.from, table.to),
    columns: alignments.map((alignment) => ({ alignment: alignment! })),
    header,
    rows,
  };
};

export const extractMarkdownTables = (
  state: EditorState,
  ranges?: readonly TableRange[],
): MarkdownTable[] => {
  const tables: MarkdownTable[] = [];
  const seen = new Set<string>();
  const tree = syntaxTree(state);
  for (const range of normalizeRanges(state.doc.length, ranges)) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.name !== "Table") return;
        if (node.from >= range.to || node.to <= range.from) return;
        const key = `${node.from}:${node.to}`;
        if (seen.has(key)) return;
        seen.add(key);
        const table = tableForNode(state, node.node);
        if (table) tables.push(table);
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
