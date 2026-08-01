# Native Markdown Table Cell Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every macOS native deletion shortcut work inside an editable
Markdown table cell without weakening table syntax protection or changing other
editor shortcuts.

**Architecture:** Keep Markdown tables atomic in CodeMirror. Extend only the
table widget's event-ownership policy so editable cells own `Backspace` and
`Delete` keyboard events (with any modifiers); the existing delegated native
`input` handler will serialize the resulting cell text back into Markdown.

**Tech Stack:** React 19, TypeScript, CodeMirror 6, Vitest/JSDOM, Playwright,
Vite, Tauri 2.

---

## File Structure

- `src/editor/tableWidgets.ts` owns the table replacement widget and decides
  whether CodeMirror or the nested `contenteditable` cell handles an event.
- `src/editor/tableWidgets.test.ts` tests the widget event contract directly.
- `tests/e2e/notepad.spec.ts` drives real CodeMirror DOM table cells and
  verifies persisted Markdown source.

### Task 1: Specify the native-deletion event contract

**Files:**
- Modify: `src/editor/tableWidgets.test.ts:1364-1384`

- [ ] **Step 1: Add a failing widget-policy regression test**

  Replace the existing pointer-event test with the following assertions after
  its pointer-event loop. Keep the existing Tab and input assertions.

  ```ts
  for (const key of ["Backspace", "Delete"]) {
    expect(widget.ignoreEvent(new KeyboardEvent("keydown", { key })))
      .toBe(true);
    expect(widget.ignoreEvent(new KeyboardEvent("keydown", {
      key,
      altKey: true,
    }))).toBe(true);
    expect(widget.ignoreEvent(new KeyboardEvent("keydown", {
      key,
      metaKey: true,
    }))).toBe(true);
  }

  expect(new MarkdownTableWidget(table, false).ignoreEvent(
    new KeyboardEvent("keydown", { key: "Backspace" }),
  )).toBe(false);
  expect(new MarkdownTableWidget(table, true, true).ignoreEvent(
    new KeyboardEvent("keydown", { key: "Delete" }),
  )).toBe(false);
  ```

- [ ] **Step 2: Run the focused unit test and confirm it fails**

  Run: `npm test -- src/editor/tableWidgets.test.ts`

  Expected: the new expectations for `Backspace` and `Delete` fail because
  `MarkdownTableWidget.ignoreEvent` currently returns `false` for all keyboard
  events.

- [ ] **Step 3: Commit the failing regression test**

  ```bash
  git add src/editor/tableWidgets.test.ts
  git commit -m "test: cover native table cell deletion events"
  ```

### Task 2: Reproduce Chromium-supported deletion variants through the browser shell

**Files:**
- Modify: `tests/e2e/notepad.spec.ts:88-95, after the existing table typing test`

- [ ] **Step 1: Add an explicit DOM caret helper**

  Directly below `clickEditableTableCell`, add this helper. It is used only to
  position a caret after a real click has established native focus; it does not
  mutate the document.

  ```ts
  const placeTableCaret = async (cell: Locator, offset: number) => {
    await cell.evaluate((element, caretOffset) => {
      const text = element.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE) {
        throw new Error("Expected a plain-text Markdown table cell");
      }
      const range = document.createRange();
      range.setStart(text, caretOffset);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, offset);
  };
  ```

- [ ] **Step 2: Add the failing end-to-end regression**

  Add a test named `"deletes table-cell text with browser-supported native shortcuts and saves exact source"`.
  Seed this exact document, click each body cell with `clickEditableTableCell`,
  place its caret at the stated offset, then press the stated key:

  ```ts
  const deletionDocumentSource = [
    "Before untouched",
    "",
    "| Backspace | Delete | Option backward | Option forward | Command backward | Command forward |",
    "| --- | --- | --- | --- | --- | --- |",
    "| abc | def | alpha | bravo | charlie | delta |",
    "",
    "After untouched",
    "",
  ].join("\\n");
  ```

  Use body-cell indices `6` through `10` and verify each Chromium-supported
  transformation immediately:

  ```ts
  await clickEditableTableCell(markdownTableCell(page, 6));
  await placeTableCaret(markdownTableCell(page, 6), 3);
  await page.keyboard.press("Backspace");
  await expect(markdownTableCell(page, 6)).toHaveText("ab");

  await clickEditableTableCell(markdownTableCell(page, 7));
  await placeTableCaret(markdownTableCell(page, 7), 0);
  await page.keyboard.press("Delete");
  await expect(markdownTableCell(page, 7)).toHaveText("ef");

  await clickEditableTableCell(markdownTableCell(page, 8));
  await placeTableCaret(markdownTableCell(page, 8), 5);
  await page.keyboard.press("Alt+Backspace");
  await expect(markdownTableCell(page, 8)).toHaveText("");

  await clickEditableTableCell(markdownTableCell(page, 9));
  await placeTableCaret(markdownTableCell(page, 9), 0);
  await page.keyboard.press("Alt+Delete");
  await expect(markdownTableCell(page, 9)).toHaveText("");

  await clickEditableTableCell(markdownTableCell(page, 10));
  await placeTableCaret(markdownTableCell(page, 10), 7);
  await page.keyboard.press("Meta+Backspace");
  await expect(markdownTableCell(page, 10)).toHaveText("");

  ```

  Chromium does not natively mutate plain `contenteditable` text for
  `Meta+Delete`. The Task 1 widget event-policy unit test covers this sixth
  event variant, and Task 4's packaged macOS WKWebView acceptance must verify
  its text mutation manually.

  Press `Meta+s`, assert the dirty indicator clears, and assert the only write
  equals the source above with the body row replaced by
  `"| ab | ef |  |  |  | delta |"`. This verifies native events reached the cell,
  the existing input listener committed changes, and table delimiters plus
  surrounding text remained intact.

  Also validate outerless two-column body rows: after native deletion empties
  the first or last cell of `old | keep`, the exact saved source is respectively
  `|  | keep` or `old |  |`. These boundary outputs are additional expectations;
  all existing expected source outputs above remain unchanged.

- [ ] **Step 3: Run the focused browser regression and confirm it fails**

  Run: `npm run test:e2e -- --grep "browser-supported native shortcuts"`

  Expected: the first Backspace assertion fails because CodeMirror prevents
  the native deletion action while the table remains atomic.

- [ ] **Step 4: Commit the failing E2E regression**

  ```bash
  git add tests/e2e/notepad.spec.ts
  git commit -m "test: limit browser deletion coverage to supported shortcuts"
  ```

### Task 3: Give editable cells ownership of deletion keys

**Files:**
- Modify: `src/editor/tableWidgets.ts:95-101, 836-838`

- [ ] **Step 1: Add the narrow deletion predicate**

  Immediately after `nativeCellPointerEvents`, add:

  ```ts
  const nativeCellDeletionKeys = new Set(["Backspace", "Delete"]);

  const isNativeCellDeletionEvent = (event: Event) =>
    event instanceof KeyboardEvent && nativeCellDeletionKeys.has(event.key);
  ```

- [ ] **Step 2: Extend widget event ownership only when a cell can edit**

  Replace `ignoreEvent` with:

  ```ts
  ignoreEvent(event: Event) {
    return nativeCellPointerEvents.has(event.type) ||
      (this.editable && !this.readOnly && isNativeCellDeletionEvent(event));
  }
  ```

  Do not add a CodeMirror deletion command, change `handleKeyDown`, or remove
  the atomic range. The browser will emit the existing `input` event after its
  native deletion; `handleInput` already calls `commitCell`.

- [ ] **Step 3: Run the two focused regressions**

  Run: `npm test -- src/editor/tableWidgets.test.ts`

  Expected: PASS, including normal, Option, and Command deletion-event policy.

  Run: `npm run test:e2e -- --grep "browser-supported native shortcuts"`

  Expected: PASS, with one saved write that preserves the Markdown table and
  surrounding text.

- [ ] **Step 4: Commit the production fix**

  ```bash
  git add src/editor/tableWidgets.ts
  git commit -m "fix: allow native table cell deletion"
  ```

### Task 4: Run full regression and package validation

**Files:**
- Verify only: `src/editor/tableWidgets.ts`, `src/editor/tableWidgets.test.ts`, `tests/e2e/notepad.spec.ts`

- [ ] **Step 1: Run all frontend checks**

  Run: `npm test`

  Expected: PASS with the new table widget regression.

  Run: `npm run build`

  Expected: TypeScript and Vite production build PASS.

  Run: `npm run test:e2e`

  Expected: all browser workflows PASS, including the native-deletion scenario.

- [ ] **Step 2: Validate the native package before replacement**

  Run: `npm run tauri build -- --bundles app`

  Run: `codesign --force --deep --sign - --entitlements src-tauri/entitlements.plist "src-tauri/target/release/bundle/macos/Opus.app"`

  Run: `./scripts/verify-macos-bundle.sh`

  Expected: an ARM64 ad-hoc-signed `Opus.app` passes structural verification and
  is reported as non-release. Copy it to `/Applications/Opus.app` only after
  making a timestamped rollback copy of the existing app. Before install
  handoff, place the caret at the start of `delta` in an editable table cell and
  verify Command+Forward Delete leaves the cell empty in the packaged WKWebView
  app. On keyboards without a dedicated Forward Delete key, use
  Fn+Command+Delete (DOM `Meta+Delete`); do not launch the replacement
  automatically.

- [ ] **Step 3: Inspect the final changes and commit any verification-only adjustment**

  Run: `git status --short && git log --oneline -3`

  Expected: only the three focused commits from this plan; no generated output,
  app bundle, dependency directory, or user `.DS_Store` is tracked.
