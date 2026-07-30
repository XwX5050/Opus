import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import {
  decodeTableCell,
  extractMarkdownTables,
  findCurrentTable,
  serializeTableCell,
  tableCells,
} from "./markdownTable";

const parse = (doc: string) =>
  EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM] })],
  });

const expectLosslessCellRanges = (state: EditorState) => {
  for (const table of extractMarkdownTables(state)) {
    for (const cell of [...table.header, ...table.rows.flat()]) {
      expect(cell.from).toBeLessThanOrEqual(cell.to);
      expect(state.sliceDoc(cell.from, cell.to)).toBe(cell.source);
    }
  }
};

describe("markdownTable", () => {
  it("extracts an outer-pipe GFM table losslessly", () => {
    const doc = [
      "| Name | Note | End |",
      "| :--- | :--: | ---: |",
      String.raw`| Ada | A\|B | |`,
    ].join("\n");

    expect(extractMarkdownTables(parse(doc))).toEqual([
      {
        from: 0,
        to: doc.length,
        source: doc,
        columns: [
          { alignment: "left" },
          { alignment: "center" },
          { alignment: "right" },
        ],
        header: [
          { from: 2, to: 6, source: "Name", displayText: "Name" },
          { from: 9, to: 13, source: "Note", displayText: "Note" },
          { from: 16, to: 19, source: "End", displayText: "End" },
        ],
        rows: [[
          { from: doc.indexOf("Ada"), to: doc.indexOf("Ada") + 3, source: "Ada", displayText: "Ada" },
          { from: doc.indexOf(String.raw`A\|B`), to: doc.indexOf(String.raw`A\|B`) + 4, source: String.raw`A\|B`, displayText: "A|B" },
          { from: doc.length - 1, to: doc.length - 1, source: "", displayText: "" },
        ]],
      },
    ]);
  });

  it("extracts a GFM table without outer pipes", () => {
    const doc = ["A | B", "--- | ---", "one | two"].join("\n");
    const [table] = extractMarkdownTables(parse(doc));

    expect(table.columns).toEqual([{ alignment: "default" }, { alignment: "default" }]);
    expect(table.header.map((cell) => cell.displayText)).toEqual(["A", "B"]);
    expect(table.rows[0].map((cell) => cell.displayText)).toEqual(["one", "two"]);
  });

  it("does not extract incomplete Markdown as a table", () => {
    expect(extractMarkdownTables(parse("A | B\nnot a delimiter\none | two"))).toEqual([]);
  });

  it("decodes escaped pipes", () => {
    expect(decodeTableCell(String.raw`A\|B`)).toBe("A|B");
  });

  it("serializes literal pipes", () => {
    expect(serializeTableCell("A|B")).toBe(String.raw`A\|B`);
  });

  it("serializes line breaks as spaces", () => {
    expect(serializeTableCell("A\r\nB\rC\nD")).toBe("A B C D");
  });

  it("keeps empty first and last cells as zero-width replacement ranges", () => {
    const doc = ["|  | B |  |", "| --- | --- | --- |", "|  | two |  |"].join("\n");
    const table = extractMarkdownTables(parse(doc))[0];

    expect(table.header.map(({ from, to, source }) => ({ from, to, source }))).toEqual([
      { from: 3, to: 3, source: "" },
      { from: 5, to: 6, source: "B" },
      { from: 10, to: 10, source: "" },
    ]);
    expect(table.rows[0].map((cell) => cell.displayText)).toEqual(["", "two", ""]);
  });

  it("falls back for a lone-pipe body row that the GFM parser accepts", () => {
    expect(extractMarkdownTables(parse(["| A |", "| --- |", "|"].join("\n")))).toEqual([]);
  });

  it.each(["||", "| |"])("keeps %s as a valid one-empty-cell body row", (body) => {
    const state = parse(["| A |", "| --- |", body].join("\n"));
    const cell = extractMarkdownTables(state)[0].rows[0][0];

    expect(cell).toMatchObject({ source: "", displayText: "" });
    expect(cell.from).toBeLessThanOrEqual(cell.to);
    expect(state.sliceDoc(cell.from, cell.to)).toBe("");
  });

  it("keeps every emitted cell range ordered and lossless", () => {
    expectLosslessCellRanges(parse(["| A | B |", "| --- | --- |", "| one | |"].join("\n")));
    expectLosslessCellRanges(parse(["> A | B", "> --- | ---", "> one | two"].join("\n")));
  });

  it("round-trips backslash runs before literal pipes", () => {
    expect(decodeTableCell(String.raw`A\\\|B`)).toBe(String.raw`A\|B`);
    expect(decodeTableCell(String.raw`A\\|B`)).toBe(String.raw`A\\|B`);
    expect(serializeTableCell(String.raw`A\\|B`)).toBe(`A${"\\".repeat(5)}|B`);
  });

  it("uses backslash parity to distinguish structural and literal cell pipes", () => {
    const even = ["A | B | C", "--- | --- | ---", String.raw`one\\ | two | three`].join("\n");
    const odd = ["A | B", "--- | ---", String.raw`one\|two | three`].join("\n");

    expect(extractMarkdownTables(parse(even))[0].rows[0].map((cell) => cell.source)).toEqual([
      String.raw`one\\`, "two", "three",
    ]);
    expect(extractMarkdownTables(parse(odd))[0].rows[0].map((cell) => cell.displayText)).toEqual([
      "one|two", "three",
    ]);
  });

  it.each([
    ["fewer cells", ["A | B", "--- | ---", "one"].join("\n")],
    ["extra cells", ["A | B", "--- | ---", "one | two | three"].join("\n")],
  ])("falls back when a body row has %s", (_label, doc) => {
    expect(extractMarkdownTables(parse(doc))).toEqual([]);
  });

  it("limits extraction to tables intersecting normalized ranges", () => {
    const first = ["A | B", "--- | ---", "one | two"].join("\n");
    const second = ["C | D", "--- | ---", "three | four"].join("\n");
    const doc = `${first}\n\n${second}`;
    const secondFrom = doc.indexOf(second);

    expect(extractMarkdownTables(parse(doc), [
      { from: secondFrom + 1, to: secondFrom + 2 },
      { from: secondFrom, to: secondFrom + 3 },
    ]).map((table) => table.source)).toEqual([second]);
  });

  it("does not emit a table for a range that only touches its boundary", () => {
    const doc = `before\n${["A | B", "--- | ---", "one | two"].join("\n")}\nafter`;
    const state = parse(doc);
    const tableNode = syntaxTree(state).topNode.getChild("Table")!;

    expect(extractMarkdownTables(state, [{ from: 0, to: tableNode.from }])).toEqual([]);
    expect(extractMarkdownTables(state, [{ from: tableNode.to, to: doc.length }])).toEqual([]);
  });

  it("scans parser-provided row spans for a blockquote table", () => {
    const doc = ["> A | B", "> --- | ---", "> one | two"].join("\n");
    const state = parse(doc);
    const tableNode = syntaxTree(state).topNode.getChild("Blockquote")!.getChild("Table")!;
    const [table] = extractMarkdownTables(state);
    const cells = [...table.header, ...table.rows.flat()];

    expect(table.columns).toEqual([{ alignment: "default" }, { alignment: "default" }]);
    expect(table.header.map((cell) => cell.source)).toEqual(["A", "B"]);
    expect(table.rows[0].map((cell) => cell.source)).toEqual(["one", "two"]);
    expect(cells.every((cell) => cell.from >= tableNode.from && cell.to <= tableNode.to)).toBe(true);
  });

  it("scans parser-provided row spans for a list-contained table", () => {
    const doc = ["- A | B", "  --- | ---", "  one | two"].join("\n");
    const state = parse(doc);
    const tableNode = syntaxTree(state).topNode
      .getChild("BulletList")!
      .getChild("ListItem")!
      .getChild("Table")!;
    const [table] = extractMarkdownTables(state);
    const cells = [...table.header, ...table.rows.flat()];

    expect(table.header.map((cell) => cell.source)).toEqual(["A", "B"]);
    expect(table.rows[0].map((cell) => cell.source)).toEqual(["one", "two"]);
    expect(cells.every((cell) => cell.from >= tableNode.from && cell.to <= tableNode.to)).toBe(true);
  });

  it("preserves surrounding whitespace while giving exact replacement ranges", () => {
    const doc = ["|  value\t | \t |", "| --- | --- |"].join("\n");
    const [first, second] = extractMarkdownTables(parse(doc))[0].header;

    expect(first).toMatchObject({
      from: doc.indexOf("value"),
      to: doc.indexOf("value") + "value".length,
      source: "value",
    });
    expect(second).toMatchObject({
      from: doc.indexOf("| \t |") + "| \t ".length,
      to: doc.indexOf("| \t |") + "| \t ".length,
      source: "",
    });
  });

  it("finds a table only while its exact source snapshot is current", () => {
    const source = ["A | B", "--- | ---", "one | two"].join("\n");
    const state = parse(`before\n\n${source}\n\nafter`);
    const table = extractMarkdownTables(state)[0];

    expect(findCurrentTable(state, table.from, table.source)).toEqual(table);
    expect(findCurrentTable(state, table.from, `${table.source} `)).toBeNull();

    const changed = state.update({
      changes: {
        from: table.from + table.source.indexOf("one"),
        to: table.from + table.source.indexOf("one") + 3,
        insert: "three",
      },
    }).state;
    expect(findCurrentTable(changed, table.from, table.source)).toBeNull();
  });

  it("rejects an unchanged table snapshot at a stale position", () => {
    const source = ["A | B", "--- | ---", "one | two"].join("\n");
    const state = parse(source);
    const moved = parse(`prefix\n${source}`);

    expect(findCurrentTable(moved, 0, source)).toBeNull();
    expect(findCurrentTable(state, 1, source)).toBeNull();
  });

  it("returns header then body cells in DOM index order", () => {
    const table = extractMarkdownTables(parse([
      "| A | B |",
      "| --- | --- |",
      "| one | two |",
      "| three | four |",
    ].join("\n")))[0];

    expect(tableCells(table).map((cell) => cell.displayText)).toEqual([
      "A",
      "B",
      "one",
      "two",
      "three",
      "four",
    ]);
  });
});
