# Interactive Markdown Tables Design

## Problem

Opus already enables the GFM parser, so valid pipe-table syntax is represented
in the shared Lezer tree as `Table`, `TableHeader`, `TableRow`, and `TableCell`
nodes. The live-preview layer has no table renderer, however, and therefore
shows the raw pipes and delimiter row instead of a formatted table.

Tables are a special editing surface. They must remain visually tabular while
the user edits them rather than reverting the whole block to Markdown source
when the selection enters the table.

## Goals

- Render valid GFM pipe tables as semantic HTML tables in editing and reading
  modes.
- Let users edit cell contents directly without exposing pipe or delimiter
  syntax.
- Preserve the existing Markdown document as the source of truth.
- Support keyboard movement with `Tab` and `Shift+Tab`; pressing `Tab` in the
  final cell adds a body row.
- Preserve column alignment, undo/redo, dirty-state tracking, saving, recovery,
  conflict detection, and source mode.
- Fall back to unmodified Markdown source when a table cannot be represented
  safely.

## Non-Goals

- Do not introduce a separate preview pane or a second Markdown parser.
- Do not add spreadsheet features such as formulas, sorting, merged cells,
  column resizing, row drag-and-drop, or multi-cell selection.
- Do not reinterpret invalid or incomplete table syntax as a table.
- Do not support multiline GFM cells; each cell remains one logical Markdown
  line.
- Do not make reading mode interactive.

## Interaction

In live-preview editing mode, a valid GFM table is always displayed as a real
table. Clicking a header or body cell places an editing caret in that cell
without revealing the surrounding pipes or delimiter row. Editing a cell
immediately updates the corresponding source range through a CodeMirror
transaction.

`Tab` moves to the next cell and `Shift+Tab` moves to the previous cell.
Pressing `Tab` in the final body cell appends a new row with the table's current
column count, writes that row to Markdown as one undoable transaction, and
focuses its first cell. `Shift+Tab` in the first cell leaves focus in that cell.
Native pointer selection and text-selection behavior remain available within a
single cell.

The editing surface accepts single-line text. A literal `|` is serialized as
`\|` so it cannot split the table. Line breaks are rejected. Existing escaped
pipes are displayed as literal pipes and remain escaped after unrelated cell
edits.

Reading mode renders the same table without editable cells or tab stops. Source
mode continues to show and edit the exact Markdown text using the normal
CodeMirror surface.

## Rendering and Styling

Replace each complete, valid `Table` syntax range with one block widget whose
DOM root contains a semantic `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<th>`,
and `<td>` structure. Header cells use the existing primary text color and
semibold weight. The table uses the existing surface, divider, radius, spacing,
and body-font tokens. Borders form one continuous rounded rectangle, matching
the supplied reference without introducing fixed colors.

Column alignment comes from GFM delimiter cells:

- `---` uses the normal start alignment.
- `:---` aligns left.
- `:---:` centers.
- `---:` aligns right.

Cells wrap long content and the table may scroll horizontally when its minimum
content width exceeds the editor column. No source text is altered merely by
rendering.

## Markdown Model

Add a focused table-model module that derives an immutable representation from
the production CodeMirror syntax tree and document:

```ts
interface MarkdownTable {
  readonly from: number;
  readonly to: number;
  readonly columns: ReadonlyArray<{
    readonly alignment: "default" | "left" | "center" | "right";
  }>;
  readonly header: MarkdownTableCell[];
  readonly rows: ReadonlyArray<ReadonlyArray<MarkdownTableCell>>;
}

interface MarkdownTableCell {
  readonly from: number;
  readonly to: number;
  readonly displayText: string;
}
```

The parser records source ranges for cell content rather than reconstructing
the whole table during ordinary edits. Updating a cell replaces only that
cell's source range. Adding a row inserts one normalized pipe row immediately
after the table and does not normalize existing rows, whitespace, delimiter
spelling, BOMs, or line endings.

Inline Markdown inside a cell remains in source form for the initial release.
This keeps direct editing lossless and avoids nesting independent editable
widgets. Escaped pipes are decoded for display and re-escaped for serialization;
other backslashes and Markdown markers are preserved verbatim.

## CodeMirror Integration

Create a table view plugin alongside the existing live-preview, math, and image
plugins. It uses the shared Lezer syntax tree and the same visible-range
planning strategy. In live-preview modes, each eligible `Table` becomes a
`Decoration.replace` block widget and an atomic range. Source mode omits the
plugin through the existing preview compartment.

The widget receives the current view mode and a stable table snapshot. In
editing mode it renders cell-owned editable elements and handles input,
composition, paste, and table-navigation keys. All document mutations dispatch
CodeMirror transactions, so history, React `onChange`, dirty state, recovery,
and save behavior remain unchanged.

The widget must not dispatch during IME composition. It commits the composed
cell text after `compositionend`, then maps focus back to the corresponding
cell in the refreshed widget. Widget equality is based on table content, mode,
and alignment data so unrelated editor updates do not discard active focus.

Because a replacement widget cannot contain the CodeMirror caret, the table
plugin owns cell focus while the table is active. Arrow keys and pointer
interactions remain native inside a cell; `Escape` returns focus to the editor
immediately after the table without changing the document.

## Safety and Fallbacks

Render a widget only when the syntax tree supplies one header row, a delimiter
row with the same column count, and body rows that can be mapped safely. If
column counts or source ranges are inconsistent, leave that table as raw
Markdown.

Before dispatching an edit, confirm that the current document slice still
matches the widget snapshot. If it does not, abandon that edit and rebuild from
the current syntax tree rather than writing through stale offsets. Empty cells,
leading or trailing pipes, escaped pipes, and CRLF documents must retain valid
Markdown.

Cell input is plain text from the browser editing surface. Pasted line breaks
are converted to spaces, and pasted pipes are escaped. No HTML from paste is
inserted into the widget or document.

## Component Boundaries

- `src/editor/markdownTable.ts`: syntax-tree extraction, cell decoding and
  serialization, alignment parsing, and row insertion text.
- `src/editor/tableWidgets.ts`: table widget DOM, direct cell editing,
  composition handling, keyboard navigation, stale-snapshot checks, and the
  CodeMirror view plugin.
- `src/editor/MarkdownEditor.tsx`: supplies editing or reading mode to the table
  extension through the existing preview configuration.
- `src/theme/app.css`: semantic table layout and focus styles using existing
  design tokens.

The generic live-preview planner remains responsible for inline and line-level
Markdown. It does not acquire table-specific mutation logic.

## Verification

Model tests cover tables with and without outer pipes, header/delimiter
validation, all four alignments, empty cells, escaped pipes, source-range
mapping, serialization, CRLF insertion, and invalid-table fallback.

Real `EditorView` tests verify semantic table DOM, hidden source syntax,
direct cell edits, literal-pipe escaping, paste sanitization, `Tab` and
`Shift+Tab` movement, final-cell row insertion, one-step undo, IME composition,
stale-widget protection, source-mode raw text, and reading-mode read-only
behavior. Tests also confirm that unrelated document content and existing
inline live-preview decorations continue to work.

Run the focused table tests, full frontend test suite, frontend build, browser
E2E workflows, Rust tests, formatting, and Clippy. Complete a native macOS
manual check in light and dark themes, including Chinese IME input, horizontal
overflow, keyboard navigation, undo/redo, and save/reopen fidelity.
