# Interactive Markdown Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render valid GFM tables as always-tabular, directly editable CodeMirror widgets with safe Markdown round-tripping and spreadsheet-style Tab navigation.

**Architecture:** Derive a lossless table model from the production Lezer GFM tree, then render it through a dedicated CodeMirror view plugin. The first source line hosts the semantic table widget while continuation-line decorations collapse the remaining source lines; all edits dispatch narrow CodeMirror transactions so the existing history, controlled-value, save, and recovery paths remain authoritative.

**Tech Stack:** React 19, TypeScript 7, CodeMirror 6, `@lezer/markdown` GFM, Vitest, Testing Library, CSS design tokens.

---

## File Map

- Create `src/editor/markdownTable.ts`: table extraction, source ranges,
  alignment decoding, cell decoding/serialization, stale-snapshot lookup, and
  appended-row Markdown.
- Create `src/editor/markdownTable.test.ts`: pure model and serialization
  coverage against the real GFM parser.
- Create `src/editor/tableWidgets.ts`: semantic DOM widget, editable-cell event
  handling, focus restoration, keyboard navigation, CodeMirror decorations,
  and atomic ranges.
- Create `src/editor/tableWidgets.test.ts`: real `EditorView` rendering,
  mutation, composition, navigation, fallback, and undo tests.
- Modify `src/editor/MarkdownEditor.tsx`: install the table extension in editing
  and reading modes.
- Modify `src/editor/MarkdownEditor.test.tsx`: mode, performance, and
  controlled `onChange` integration.
- Modify `src/theme/app.css`: table layout, borders, alignment, editing focus,
  overflow, and collapsed continuation lines.
- Modify `src/app/accessibility.test.tsx`: protect token-based table styles and
  focus visibility.
- Modify `docs/testing.md`: add the native Chinese IME and table workflow checks.

### Task 1: Lossless GFM Table Model

**Files:**
- Create: `src/editor/markdownTable.ts`
- Create: `src/editor/markdownTable.test.ts`

- [ ] **Step 1: Write failing extraction tests using the real GFM tree**

Create `src/editor/markdownTable.test.ts` with a production-shaped state helper
and assertions for outer-pipe and no-outer-pipe syntax:

```ts
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import {
  decodeTableCell,
  extractMarkdownTables,
  serializeTableCell,
} from "./markdownTable";

const state = (doc: string) =>
  EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM] })],
  });

describe("extractMarkdownTables", () => {
  it("extracts cell ranges, empty cells, escaped pipes, and alignments", () => {
    const doc = [
      "| Name | Empty | Score |",
      "| :--- | :---: | ---: |",
      "| A\\|B |  | 42 |",
    ].join("\n");
    const [table] = extractMarkdownTables(state(doc));

    expect(table.source).toBe(doc);
    expect(table.columns.map(({ alignment }) => alignment)).toEqual([
      "left",
      "center",
      "right",
    ]);
    expect(table.header.map(({ displayText }) => displayText)).toEqual([
      "Name",
      "Empty",
      "Score",
    ]);
    expect(table.rows[0].map(({ displayText }) => displayText)).toEqual([
      "A|B",
      "",
      "42",
    ]);
    expect(doc.slice(table.rows[0][1].from, table.rows[0][1].to)).toBe("");
  });

  it("extracts a table without leading or trailing pipes", () => {
    const [table] = extractMarkdownTables(
      state("A | B\n--- | ---\nx | y"),
    );
    expect(table.header.map(({ displayText }) => displayText)).toEqual(["A", "B"]);
    expect(table.rows[0].map(({ displayText }) => displayText)).toEqual(["x", "y"]);
  });

  it("returns no model for incomplete Markdown that GFM does not parse", () => {
    expect(extractMarkdownTables(state("| A | B |\n| x | y |"))).toEqual([]);
  });
});

describe("table cell round-tripping", () => {
  it("decodes escaped pipes and serializes every structural pipe safely", () => {
    expect(decodeTableCell(String.raw`A\|B`)).toBe("A|B");
    expect(serializeTableCell("A|B")).toBe(String.raw`A\|B`);
    expect(serializeTableCell("A\nB")).toBe("A B");
  });
});
```

- [ ] **Step 2: Run the model test and verify RED**

Run:

```bash
npm test -- src/editor/markdownTable.test.ts
```

Expected: FAIL because `./markdownTable` does not exist.

- [ ] **Step 3: Implement table types and pipe-aware row scanning**

Create `src/editor/markdownTable.ts` with these public contracts:

```ts
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
  readonly columns: ReadonlyArray<MarkdownTableColumn>;
  readonly header: ReadonlyArray<MarkdownTableCell>;
  readonly rows: ReadonlyArray<ReadonlyArray<MarkdownTableCell>>;
}

export interface TableRange {
  readonly from: number;
  readonly to: number;
}

export const decodeTableCell = (source: string): string => {
  let result = "";
  for (let index = 0; index < source.length;) {
    if (source[index] !== "\\") {
      result += source[index++];
      continue;
    }
    let end = index;
    while (source[end] === "\\") end += 1;
    const count = end - index;
    if (source[end] === "|" && count % 2 === 1) {
      result += "\\".repeat((count - 1) / 2) + "|";
      index = end + 1;
    } else {
      result += "\\".repeat(count);
      index = end;
    }
  }
  return result;
};

export const serializeTableCell = (text: string): string => {
  const normalized = text.replace(/\r\n?|\n/g, " ");
  let result = "";
  for (let index = 0; index < normalized.length;) {
    if (normalized[index] !== "\\") {
      result += normalized[index] === "|" ? "\\|" : normalized[index];
      index += 1;
      continue;
    }
    let end = index;
    while (normalized[end] === "\\") end += 1;
    const count = end - index;
    result += normalized[end] === "|"
      ? `${"\\".repeat(count * 2 + 1)}|`
      : "\\".repeat(count);
    index = normalized[end] === "|" ? end + 1 : end;
  }
  return result;
};

export const extractMarkdownTables = (
  state: EditorState,
  ranges?: readonly TableRange[],
): MarkdownTable[] => {
  // Iterate only syntax nodes named "Table". For each node, read its
  // TableHeader, delimiter-line TableDelimiter, and TableRow children.
  // Scan row text one code unit at a time and treat a pipe as structural only
  // when it has an even number of immediately preceding backslashes.
  // Outer pipes define boundaries rather than empty columns. Trim only spaces
  // and tabs from each cell boundary, retaining exact insertion positions for
  // empty cells. Require the header and every emitted row to match the
  // delimiter column count; otherwise skip the whole Table node.
};
```

Implement private helpers `isEscapedPipe`, `scanRowCells`,
`alignmentForDelimiter`, and `tableFromNode`. Use the `Table` syntax node only
as the eligibility gate; the scanner exists solely to recover empty-cell ranges
that Lezer intentionally omits.

- [ ] **Step 4: Run extraction tests and add edge-case assertions**

Add cases for an empty first/last cell, an escaped backslash before a pipe, a
body row with fewer or extra cells, range-limited extraction, and whitespace
preservation around a replaced cell.

Run:

```bash
npm test -- src/editor/markdownTable.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the model**

```bash
git add src/editor/markdownTable.ts src/editor/markdownTable.test.ts
git commit -m "feat: model GFM markdown tables"
```

### Task 2: Semantic Table Rendering

**Files:**
- Create: `src/editor/tableWidgets.ts`
- Create: `src/editor/tableWidgets.test.ts`
- Modify: `src/theme/app.css`

- [ ] **Step 1: Write the failing semantic rendering test**

Create `src/editor/tableWidgets.test.ts` with a real `EditorView` fixture:

```ts
import { history } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, describe, expect, it } from "vitest";
import { tableWidgetsExtension } from "./tableWidgets";

const views: EditorView[] = [];
const createView = (doc: string, editable = true) => {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        markdown({ extensions: [GFM] }),
        tableWidgetsExtension({ editable }),
      ],
    }),
  });
  views.push(view);
  return view;
};

afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.replaceChildren();
});

describe("tableWidgetsExtension", () => {
  it("renders semantic table DOM and hides all pipe syntax", () => {
    const view = createView("| A | B |\n| :--- | ---: |\n| x | y |");
    expect(view.dom.querySelectorAll("table.md-table")).toHaveLength(1);
    expect(view.dom.querySelectorAll("thead th")).toHaveLength(2);
    expect(view.dom.querySelectorAll("tbody td")).toHaveLength(2);
    expect(view.dom.querySelector('[data-alignment="left"]')).not.toBeNull();
    expect(view.dom.querySelector('[data-alignment="right"]')).not.toBeNull();
    expect(view.contentDOM.textContent).not.toContain("---");
    expect(view.state.doc.toString()).toContain("| :--- | ---: |");
  });
});
```

- [ ] **Step 2: Run the widget test and verify RED**

Run:

```bash
npm test -- src/editor/tableWidgets.test.ts
```

Expected: FAIL because `./tableWidgets` does not exist.

- [ ] **Step 3: Implement the widget and multiline decoration plan**

Create `src/editor/tableWidgets.ts` with:

```ts
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

  eq(other: WidgetType): boolean {
    return (
      other instanceof MarkdownTableWidget &&
      other.table.source === this.table.source &&
      other.table.from === this.table.from &&
      other.editable === this.editable
    );
  }

  toDOM(view: EditorView): HTMLElement {
    // Build .md-table-scroll > table.md-table with thead/tbody and th/td.
    // Each cell receives data-table-from, data-cell-index, data-alignment,
    // textContent, role="gridcell", spellcheck, and contenteditable only when
    // editable. Use textContent exclusively; never inject cell HTML.
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export const tableWidgetsExtension = (
  options: TableWidgetsOptions,
): Extension => [
  ViewPlugin.define(
    (view) => new TableWidgetsPlugin(view, options),
    {
      decorations: (plugin) => plugin.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(plugin)?.atomicRanges ?? Decoration.none,
        ),
    },
  ),
];
```

For each table, replace only its first source line with the widget. Add
`.cm-table-continuation` line decorations and empty replacements for the
delimiter/body lines, following the proven multiline block-math strategy in
`mathWidgets.ts`. Add one `Decoration.mark({})` atomic range covering the
complete table. Recompute on document, syntax-tree, or viewport changes and
plan from `view.visibleRanges`.

- [ ] **Step 4: Add token-based table CSS**

Append styles to `src/theme/app.css`:

```css
.md-table-scroll {
  display: block;
  width: 100%;
  overflow-x: auto;
  margin-block: var(--space-3);
}

.md-table {
  width: 100%;
  min-width: max-content;
  border-spacing: 0;
  border: 1px solid var(--divider);
  border-radius: var(--radius-medium);
  background: var(--surface);
  overflow: hidden;
}

.md-table th,
.md-table td {
  min-width: 6rem;
  padding: var(--space-2) var(--space-3);
  border-right: 1px solid var(--divider);
  border-bottom: 1px solid var(--divider);
  color: var(--text-primary);
  white-space: normal;
}

.md-table th {
  font-weight: 650;
  background: var(--surface-hover);
}

.md-table [data-alignment="center"] { text-align: center; }
.md-table [data-alignment="right"] { text-align: right; }
.md-table [data-alignment="left"],
.md-table [data-alignment="default"] { text-align: left; }

.cm-table-continuation {
  height: 0;
  min-height: 0;
  line-height: 0;
  overflow: hidden;
  padding: 0 !important;
}
```

Add final-child border removal and rounded corner rules without hard-coded
colors.

- [ ] **Step 5: Verify rendering and existing preview compatibility**

Extend the test to assert header/body text, empty cells, escaped-pipe display,
outer-pipe-free rendering, atomic table ranges, and raw-source fallback for
invalid syntax.

Run:

```bash
npm test -- src/editor/tableWidgets.test.ts src/editor/livePreview.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit semantic rendering**

```bash
git add src/editor/tableWidgets.ts src/editor/tableWidgets.test.ts src/theme/app.css
git commit -m "feat: render semantic markdown tables"
```

### Task 3: Direct Cell Editing and Safe Transactions

**Files:**
- Modify: `src/editor/markdownTable.ts`
- Modify: `src/editor/markdownTable.test.ts`
- Modify: `src/editor/tableWidgets.ts`
- Modify: `src/editor/tableWidgets.test.ts`

- [ ] **Step 1: Write failing direct-edit and stale-snapshot tests**

Add real DOM-event tests:

```ts
it("edits one cell through a narrow CodeMirror transaction", () => {
  const view = createView("| A | B |\n| --- | --- |\n| old | keep |");
  const cells = view.dom.querySelectorAll<HTMLElement>("tbody [data-cell-index]");
  cells[0].textContent = "new|value";
  cells[0].dispatchEvent(new InputEvent("input", { bubbles: true }));

  expect(view.state.doc.toString()).toBe(
    "| A | B |\n| --- | --- |\n| new\\|value | keep |",
  );
  expect(view.state.doc.toString()).toContain("| keep |");
});

it("abandons an edit when the widget snapshot no longer matches", () => {
  const view = createView("| A |\n| --- |\n| old |");
  const stale = view.dom.querySelector<HTMLElement>("tbody [data-cell-index]")!;
  view.dispatch({ changes: { from: 0, to: 1, insert: " " } });
  stale.textContent = "must-not-land";
  stale.dispatchEvent(new InputEvent("input", { bubbles: true }));
  expect(view.state.doc.toString()).not.toContain("must-not-land");
});
```

Also add tests proving paste converts HTML to plain text, newlines to spaces,
and pipes to escaped pipes.

- [ ] **Step 2: Run direct-edit tests and verify RED**

Run:

```bash
npm test -- src/editor/tableWidgets.test.ts
```

Expected: FAIL because cell events do not dispatch document changes.

- [ ] **Step 3: Add fresh-table lookup and narrow replacement helpers**

Export these helpers from `markdownTable.ts`:

```ts
export const findCurrentTable = (
  state: EditorState,
  tableFrom: number,
  expectedSource: string,
): MarkdownTable | null =>
  extractMarkdownTables(state).find(
    (table) =>
      table.from === tableFrom &&
      table.source === expectedSource &&
      state.sliceDoc(table.from, table.to) === expectedSource,
  ) ?? null;

export const tableCells = (table: MarkdownTable): MarkdownTableCell[] => [
  ...table.header,
  ...table.rows.flat(),
];
```

Test both successful and stale lookup before wiring DOM events.

- [ ] **Step 4: Handle editable cell input, paste, and focus preservation**

In `tableWidgets.ts`, delegate `beforeinput`, `input`, `paste`,
`compositionstart`, and `compositionend` from the widget root:

```ts
const commitCell = (
  view: EditorView,
  root: HTMLElement,
  cell: HTMLElement,
): boolean => {
  const table = currentTableForRoot(view.state, root);
  const index = Number(cell.dataset.cellIndex);
  const target = table ? tableCells(table)[index] : undefined;
  if (
    !table ||
    !target ||
    view.state.readOnly ||
    root.dataset.editable !== "true"
  ) return false;
  const insert = serializeTableCell(cell.textContent ?? "");
  view.dispatch({
    changes: { from: target.from, to: target.to, insert },
    userEvent: "input.type",
  });
  return true;
};
```

Store composition state on the root and do not dispatch between
`compositionstart` and `compositionend`. Override paste, take only
`text/plain`, normalize line breaks, insert it with `document.execCommand`
fallback-free DOM Range operations, then call `commitCell`. Implement
`updateDOM` so document updates refresh non-active cells but preserve the
active cell and caret.

- [ ] **Step 5: Verify direct edits, composition, undo, and sanitization**

Add tests for:

- one `onChange`-equivalent document transaction per ordinary input;
- no dispatch during composition and one commit at `compositionend`;
- one-step undo restoring the previous cell source;
- pasted `<b>x</b>` appearing as literal/plain text, never an element;
- stale DOM never overwriting a newer document;
- empty-cell insertion positions.

Run:

```bash
npm test -- src/editor/markdownTable.test.ts src/editor/tableWidgets.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit direct editing**

```bash
git add src/editor/markdownTable.ts src/editor/markdownTable.test.ts src/editor/tableWidgets.ts src/editor/tableWidgets.test.ts
git commit -m "feat: edit markdown table cells directly"
```

### Task 4: Tab Navigation and Row Insertion

**Files:**
- Modify: `src/editor/markdownTable.ts`
- Modify: `src/editor/markdownTable.test.ts`
- Modify: `src/editor/tableWidgets.ts`
- Modify: `src/editor/tableWidgets.test.ts`

- [ ] **Step 1: Write failing navigation and row-insertion tests**

Add:

```ts
it("moves with Tab and Shift+Tab and appends from the final cell", () => {
  const view = createView("| A | B |\n| --- | --- |\n| x | y |");
  const cells = () =>
    [...view.dom.querySelectorAll<HTMLElement>("[data-cell-index]")];

  cells()[0].focus();
  cells()[0].dispatchEvent(new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
  }));
  expect(document.activeElement).toBe(cells()[1]);

  cells().at(-1)!.focus();
  cells().at(-1)!.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
  }));
  expect(view.state.doc.toString()).toBe(
    "| A | B |\n| --- | --- |\n| x | y |\n|  |  |",
  );
  expect(document.activeElement).toBe(cells().at(-2));
});
```

Add separate cases for `Shift+Tab`, first-cell clamping, header-to-body
movement, a header-only table, and `Escape`.

- [ ] **Step 2: Run navigation tests and verify RED**

Run:

```bash
npm test -- src/editor/tableWidgets.test.ts
```

Expected: FAIL because the widget does not handle table-navigation keys.

- [ ] **Step 3: Implement source-preserving row insertion**

Add to `markdownTable.ts`:

```ts
export const appendedTableRow = (table: MarkdownTable): string =>
  `\n| ${table.columns.map(() => "").join(" | ")} |`;
```

Test the one- and multi-column outputs. In `tableWidgets.ts`, intercept only
unmodified `Tab`/`Shift+Tab` and `Escape`. For normal movement, prevent default
and focus the adjacent indexed cell. At the final cell, dispatch:

```ts
view.dispatch({
  changes: {
    from: table.to,
    insert: appendedTableRow(table),
  },
  userEvent: "input.type",
});
```

Queue a microtask that resolves the refreshed widget by `data-table-from` and
focuses the first cell of the appended row. `Escape` focuses CodeMirror and
sets its selection to `table.to` without a document change.

- [ ] **Step 4: Verify navigation and history**

Assert the new row is added once, focused correctly, emitted as one document
change, and removed by one undo. Confirm `Shift+Tab` never inserts or edits
source.

Run:

```bash
npm test -- src/editor/markdownTable.test.ts src/editor/tableWidgets.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit navigation**

```bash
git add src/editor/markdownTable.ts src/editor/markdownTable.test.ts src/editor/tableWidgets.ts src/editor/tableWidgets.test.ts
git commit -m "feat: navigate markdown tables by keyboard"
```

### Task 5: Editor Modes, Accessibility, and Release Verification

**Files:**
- Modify: `src/editor/MarkdownEditor.tsx`
- Modify: `src/editor/MarkdownEditor.test.tsx`
- Modify: `src/theme/app.css`
- Modify: `src/app/accessibility.test.tsx`
- Modify: `docs/testing.md`

- [ ] **Step 1: Write failing editor-integration tests**

Add tests to `MarkdownEditor.test.tsx`:

```tsx
it("keeps tables rendered and editable only in editing mode", () => {
  const doc = "| A |\n| --- |\n| x |";
  const rendered = renderEditor({ value: doc, viewMode: "editing" });
  expect(rendered.container.querySelector(".md-table")).not.toBeNull();
  expect(rendered.container.querySelector("[contenteditable=true]")).not.toBeNull();

  rendered.rerender(
    <MarkdownEditor {...rendered.props} viewMode="reading" />,
  );
  expect(rendered.container.querySelector(".md-table")).not.toBeNull();
  expect(rendered.container.querySelector("[contenteditable=true]")).toBeNull();
});
```

Add an `onChange` assertion for a cell edit and an assertion that mode changes
never modify the Markdown.

- [ ] **Step 2: Run integration tests and verify RED**

Run:

```bash
npm test -- src/editor/MarkdownEditor.test.tsx
```

Expected: FAIL because `MarkdownEditor` does not install the table extension.

- [ ] **Step 3: Install the table extension in the preview compartment**

Modify `MarkdownEditor.tsx`:

```ts
import { tableWidgetsExtension } from "./tableWidgets";

// Inside previewExtensionsFor:
return [
  ...readOnly,
  livePreviewExtension({ revealSelection: mode !== "reading" }),
  tableWidgetsExtension({ editable: mode === "editing" }),
  ...(perf === "light" ? [] : [mathWidgetsExtension(...), imageWidgetsExtension(...)]),
];
```

Tables remain enabled in light mode because they replace raw syntax with an
essential Markdown reading surface; the planner remains visible-range bounded.

- [ ] **Step 4: Add accessible focus and regression assertions**

Give the table `role="grid"` and an accessible label of `Markdown 表格`.
Editing cells use `role="gridcell"`, `tabIndex={0}` semantics in DOM, and
`:focus-visible` with the existing accent and focus-ring tokens. Reading cells
have no tab stop and no `contenteditable`.

Extend `src/app/accessibility.test.tsx` to assert that table focus uses tokenized
styles and that reading-mode table cells are absent from the tab order.

- [ ] **Step 5: Document manual macOS acceptance**

Add a `Markdown tables` subsection to `docs/testing.md`:

```md
### Markdown tables

- Open a GFM table in editing and reading modes; confirm pipes and delimiter
  rows remain hidden in both themes.
- Edit header, body, empty, Chinese, and escaped-pipe cells; save and reopen.
- Use Tab/Shift+Tab through every cell and add a row from the final cell.
- Undo and redo both a cell edit and an inserted row.
- Enter Chinese text with the system IME; confirm no intermediate composition
  text is committed and focus remains in the cell.
- Narrow the window until horizontal scrolling appears; confirm borders and
  focus rings remain visible.
```

- [ ] **Step 6: Run focused and full frontend verification**

Run:

```bash
npm test -- src/editor/markdownTable.test.ts src/editor/tableWidgets.test.ts src/editor/MarkdownEditor.test.tsx src/app/accessibility.test.tsx
npm test
npm run build
```

Expected: all Vitest tests pass and TypeScript/Vite build succeeds without
warnings.

- [ ] **Step 7: Run repository-wide verification**

Run:

```bash
npm run test:e2e
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: Playwright, formatting, Clippy, and Rust tests pass. If native dialogs
or sandbox prerequisites prevent an E2E case, record the exact blocked case
rather than reporting it as passed.

- [ ] **Step 8: Commit integration and verification documentation**

```bash
git add src/editor/MarkdownEditor.tsx src/editor/MarkdownEditor.test.tsx src/theme/app.css src/app/accessibility.test.tsx docs/testing.md
git commit -m "feat: integrate interactive markdown tables"
```

- [ ] **Step 9: Perform native acceptance without overwriting release artifacts**

Run the development app manually with:

```bash
npm run tauri dev
```

Exercise every Markdown-table item in `docs/testing.md`, especially Chinese
IME, focus restoration, undo/redo, dark/light themes, and save/reopen. Do not
build, sign, install, or launch a release bundle unless separately requested.
