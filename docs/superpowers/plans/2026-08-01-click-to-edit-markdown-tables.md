# Click-to-Edit Markdown Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a primary click focus and edit the chosen Markdown table cell in native WKWebView, automatically leaving reading mode when necessary.

**Architecture:** Keep Markdown as the source of truth and retain the existing table widget input pipeline. Give cell pointer events to the widget instead of CodeMirror, and pass a small transient focus request from a reading widget through `MarkdownEditor` and `AppShell`; after the preview compartment switches to editing, resolve the current table and focus the matching owned cell.

**Tech Stack:** React 19, TypeScript, CodeMirror 6, Vitest/jsdom, Testing Library, Playwright, Tauri 2/WKWebView.

---

## File Structure

- Modify `src/editor/tableWidgets.ts`: pointer-event ownership, static-cell edit requests, and safe current-widget cell focusing.
- Modify `src/editor/tableWidgets.test.ts`: widget event-contract and request/focus regressions using a real `EditorView`.
- Modify `src/editor/MarkdownEditor.tsx`: table-edit request props, preview callback wiring, and post-reconfigure focus consumption.
- Modify `src/editor/MarkdownEditor.test.tsx`: reading-to-editing request and exact focus handoff tests.
- Modify `src/app/AppShell.tsx`: tab-scoped pending focus state and reading-to-editing transition.
- Modify `src/app/AppShell.test.tsx`: shell-level single-click mode transition without document mutation.
- Modify `tests/e2e/notepad.spec.ts`: replace scripted selection as the click proof and cover reading-mode click-to-edit.
- Modify `docs/testing.md`: record the native WKWebView click, IME, save, and reopen checks.

### Task 1: Give Cell Pointer Events to the Table Widget

**Files:**
- Modify: `src/editor/tableWidgets.ts:18-25, 196-252, 480-710`
- Test: `src/editor/tableWidgets.test.ts:1187-1222`
- Test: `tests/e2e/notepad.spec.ts:78-100,163-213`

- [ ] **Step 1: Write the failing widget event-contract test**

Replace the unconditional `ignoreEvent()` assertion with explicit pointer and input cases:

```ts
it("keeps cell pointer focus native while preserving the input pipeline", () => {
  const table = tableFor(["A | B", "--- | ---"].join("\n"));
  const widget = new MarkdownTableWidget(table, true);

  expect(widget.ignoreEvent(new MouseEvent("mousedown"))).toBe(true);
  expect(widget.ignoreEvent(new MouseEvent("mouseup"))).toBe(true);
  expect(widget.ignoreEvent(new MouseEvent("click"))).toBe(true);
  expect(widget.ignoreEvent(new KeyboardEvent("keydown", { key: "Tab" })))
    .toBe(false);
  expect(widget.ignoreEvent(new InputEvent("input", { inputType: "insertText" })))
    .toBe(false);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- src/editor/tableWidgets.test.ts -t "keeps cell pointer focus native"
```

Expected: FAIL because `ignoreEvent()` currently returns `false` for `mousedown`.

- [ ] **Step 3: Implement the minimal pointer-event policy**

Add a focused event-type set and leave keyboard/input/composition events unchanged:

```ts
const nativeTablePointerEvents = new Set([
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
]);

ignoreEvent(event: Event) {
  return nativeTablePointerEvents.has(event.type);
}
```

Do not call `preventDefault()` for editable-cell primary clicks; WebKit must be allowed to place its native caret at the click position.

- [ ] **Step 4: Add a genuine-click E2E assertion**

Change `placeCaretAtEnd` so it is only used where an explicit end position is required. At the start of the table typing workflow, use:

```ts
const cell = markdownTableCell(page, 2);
await cell.click();
await expect(cell).toBeFocused();
await page.keyboard.type("中文");
await expect(cell).toHaveText("Ada中文");
```

This assertion must occur before any `Range`, `focus()`, or `evaluate()` call.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm test -- src/editor/tableWidgets.test.ts
npm run test:e2e -- --grep "types and pastes plain text into a Markdown table"
```

Expected: table widget tests pass; Playwright confirms the clicked cell is focused and exact Markdown serialization still passes.

- [ ] **Step 6: Commit**

```bash
git add src/editor/tableWidgets.ts src/editor/tableWidgets.test.ts tests/e2e/notepad.spec.ts
git commit -m "fix: preserve native table cell pointer focus"
```

### Task 2: Request Editing from a Reading-Mode Cell

**Files:**
- Modify: `src/editor/tableWidgets.ts:18-25,196-252,460-620,790-820`
- Test: `src/editor/tableWidgets.test.ts`

- [ ] **Step 1: Write failing request and focus tests**

Extend the options and create-view helper in the test's wished-for API:

```ts
const requests: TableCellEditRequest[] = [];
const view = createView(source, false, [], undefined, {
  onRequestEdit: (request) => requests.push(request),
});
const cell = tableCell(view, 3);
cell.dispatchEvent(new MouseEvent("click", {
  bubbles: true,
  button: 0,
  clientX: 140,
  clientY: 220,
}));

expect(requests).toEqual([{
  tableFrom: source.indexOf("| Name"),
  cellIndex: 3,
  clientX: 140,
  clientY: 220,
}]);
```

Add a second test that reconfigures the table extension as editable, calls the wished-for `focusMarkdownTableCell(view, request)`, and expects `document.activeElement` to be the requested current cell. Also assert that a stale `tableFrom` and an out-of-range `cellIndex` return `false` without moving focus.

Add a third assertion that a static widget created without `onRequestEdit`
ignores the click. This is the widget-level read-only contract: only an owning
application that supplies the transition callback can leave reading mode.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- src/editor/tableWidgets.test.ts -t "requests editing|focuses the current requested cell"
```

Expected: TypeScript/test failure because `TableCellEditRequest`, `onRequestEdit`, and `focusMarkdownTableCell` do not exist.

- [ ] **Step 3: Add the transient request API**

Add:

```ts
export interface TableCellEditRequest {
  readonly tableFrom: number;
  readonly cellIndex: number;
  readonly clientX: number;
  readonly clientY: number;
}

export interface TableWidgetsOptions {
  readonly editable: boolean;
  readonly maxRenderedCells?: number;
  readonly onRequestEdit?: (request: TableCellEditRequest) => void;
}
```

Store `onRequestEdit` in `TableWidgetContext`. Add one delegated `click` listener that accepts only `button === 0`, validates the owned cell and current table snapshot without requiring `context.editable`, and invokes the callback only when the widget is static. It must not dispatch a document transaction.

- [ ] **Step 4: Add safe focus resolution**

Export:

```ts
export const focusMarkdownTableCell = (
  view: EditorView,
  request: TableCellEditRequest,
): boolean => {
  // Find a connected widget whose current table starts at request.tableFrom.
  // Validate ownership and request.cellIndex, focus the cell, restore a caret
  // from client coordinates when the browser exposes caretPositionFromPoint or
  // caretRangeFromPoint, and otherwise collapse a Range at the cell end.
};
```

The function must re-resolve the table from `view.state`, reject stale or missing widgets, and never dispatch changes. Keep the existing queued row-append focus path working by routing it through the same owned-cell validation where practical.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm test -- src/editor/tableWidgets.test.ts
```

Expected: all table widget tests pass, including stale snapshot, IME, paste, Tab, undo/redo, request, and focus cases.

- [ ] **Step 6: Commit**

```bash
git add src/editor/tableWidgets.ts src/editor/tableWidgets.test.ts
git commit -m "feat: request editing from static table cells"
```

### Task 3: Hand Focus Through MarkdownEditor and AppShell

**Files:**
- Modify: `src/editor/MarkdownEditor.tsx:25-70,80-135,215-266`
- Test: `src/editor/MarkdownEditor.test.tsx:90-200`
- Modify: `src/app/AppShell.tsx:1-25,200-250,779-800`
- Test: `src/app/AppShell.test.tsx:123-167,311-357`

- [ ] **Step 1: Write the failing MarkdownEditor handoff test**

Add public props:

```ts
export interface TableFocusRequest extends TableCellEditRequest {
  readonly sequence: number;
}

onRequestTableEdit?(request: TableCellEditRequest): void;
tableFocusRequest?: TableFocusRequest | null;
```

The test renders reading mode, clicks cell 3, expects `onRequestTableEdit` once with the exact table/cell identity, rerenders in editing mode with `{ ...request, sequence: 1 }`, and waits for cell 3 to be `document.activeElement`. Assert `onChange` remains untouched.

- [ ] **Step 2: Run the MarkdownEditor test and verify RED**

Run:

```bash
npm test -- src/editor/MarkdownEditor.test.tsx -t "hands a reading table click into the requested editing cell"
```

Expected: FAIL because the new props and focus consumption do not exist.

- [ ] **Step 3: Wire request and focus consumption in MarkdownEditor**

Keep callbacks in `callbacksRef`, pass `onRequestEdit` to `tableWidgetsExtension`, and consume each sequence once:

```ts
const consumedTableFocusRef = useRef(0);

useEffect(() => {
  const view = viewRef.current;
  if (
    !view ||
    viewMode !== "editing" ||
    !tableFocusRequest ||
    tableFocusRequest.sequence <= consumedTableFocusRef.current
  ) return;
  consumedTableFocusRef.current = tableFocusRequest.sequence;
  focusMarkdownTableCell(view, tableFocusRequest);
}, [tableFocusRequest, viewMode]);
```

The preview reconfiguration effect appears before this effect so the editing widgets exist first. Update callback refs every render so the compartment does not need rebuilding merely because a callback identity changes.

- [ ] **Step 4: Write the failing AppShell transition test**

Open a table document, switch to reading mode, click body cell 3, and assert:

```ts
expect(screen.getByRole("button", { name: "编辑模式" }))
  .toHaveAttribute("aria-pressed", "false");
expect(tableCell(3)).toHaveFocus();
expect(port.writes).toHaveLength(0);
```

Also assert the active tab is not dirty until text is typed.

- [ ] **Step 5: Add tab-scoped pending focus state in AppShell**

Define:

```ts
interface PendingTableFocus extends TableFocusRequest {
  readonly tabId: string;
}
```

Use one sequence ref and state value. The callback passed to the active editor records `{ tabId, sequence, ...request }` and calls `controller.setViewMode(active.id, "editing")`. Pass the request back only when its `tabId` matches the active tab. Clear or supersede stale requests when the tab closes; switching tabs must never focus a cell in another document.

```ts
const [tableFocusRequest, setTableFocusRequest] = useState<
  PendingTableFocus | null
>(null);
const tableFocusSequenceRef = useRef(0);

const requestTableEdit = (request: TableCellEditRequest) => {
  if (!active) return;
  const tabId = active.id;
  setTableFocusRequest({
    ...request,
    tabId,
    sequence: ++tableFocusSequenceRef.current,
  });
  controller.setViewMode(tabId, "editing");
};

useEffect(() => {
  if (
    tableFocusRequest &&
    !controller.state.tabs.some((tab) => tab.id === tableFocusRequest.tabId)
  ) {
    setTableFocusRequest(null);
  }
}, [controller.state.tabs, tableFocusRequest]);
```

Pass `onRequestTableEdit={requestTableEdit}` and the request filtered by
`tableFocusRequest?.tabId === active.id`. The sequence makes a second click on
the same cell consumable without retaining any document or persistence state.

- [ ] **Step 6: Run component tests and verify GREEN**

Run:

```bash
npm test -- src/editor/MarkdownEditor.test.tsx src/app/AppShell.test.tsx
```

Expected: both suites pass; reading click changes mode and focus without changing text, history, dirty state, or save state.

- [ ] **Step 7: Commit**

```bash
git add src/editor/MarkdownEditor.tsx src/editor/MarkdownEditor.test.tsx src/app/AppShell.tsx src/app/AppShell.test.tsx
git commit -m "feat: enter table editing from a cell click"
```

### Task 4: End-to-End and Native Acceptance

**Files:**
- Modify: `tests/e2e/notepad.spec.ts:215-309`
- Modify: `docs/testing.md`

- [ ] **Step 1: Add the reading-click E2E workflow**

After entering reading mode, click a known body cell and assert the toolbar returns to editing, that exact cell is focused, typing changes only that cell, `Tab` still advances, and `Meta+s` writes the expected escaped Markdown. Do not call `evaluate`, `focus`, or construct a `Range` before the focus assertion.

- [ ] **Step 2: Run the focused E2E workflow**

Run:

```bash
npm run test:e2e -- --grep "Markdown table"
```

Expected: all table E2E cases pass using real clicks.

- [ ] **Step 3: Update native testing guidance**

Add a checklist to `docs/testing.md`:

```md
- In reading mode, click a header and a body cell; each click must switch to
  editing and place the caret in the selected cell.
- In editing mode, click near the start, middle, and end of cell text and type;
  insertion must occur at the clicked position.
- Repeat with Chinese IME composition, Tab/Shift+Tab, undo/redo, save, quit,
  and reopen. Verify the exact Markdown remains valid.
```

- [ ] **Step 4: Run all verification gates**

Run:

```bash
npm test
npm run build
npm run test:e2e
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: 0 failures. Run the real FSEvents test and Playwright outside the sandbox if macOS event delivery or local port binding is blocked.

- [ ] **Step 5: Commit E2E and documentation**

```bash
git add tests/e2e/notepad.spec.ts docs/testing.md
git commit -m "test: cover native table click editing"
```

- [ ] **Step 6: Build, install, and verify the local App**

Run:

```bash
npm run tauri build -- --bundles app
codesign --force --deep --sign - --entitlements src-tauri/entitlements.plist \
  src-tauri/target/release/bundle/macos/Opus.app
./scripts/verify-macos-bundle.sh \
  src-tauri/target/release/bundle/macos/Opus.app
```

Back up `/Applications/Opus.app` to a new `/private/tmp/opus-before-click-to-edit.XXXXXX/Opus.app`, install the verified bundle, confirm source and installed executable SHA-256 hashes match, and do not auto-launch it. In the user's already-open document, perform only focus checks unless the user explicitly authorizes typing or saving.
