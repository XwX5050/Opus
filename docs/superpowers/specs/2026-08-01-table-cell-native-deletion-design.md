# Native Markdown Table Cell Deletion Design

## Problem

Editable Markdown-table cells accept typed text, but macOS deletion shortcuts do
not change the cell. `MarkdownTableWidget` renders the table as an atomic
CodeMirror range. Its current event policy lets native pointer events reach the
nested `contenteditable` cell, while `Backspace` and `Delete` still reach
CodeMirror's default keymap. That keymap prevents the browser default action,
and atomic-range protection prevents CodeMirror from deleting the table source.

## Approved Interaction

Within an editable table cell, native deletion must work exactly as it does in
a normal contenteditable text field:

- `Backspace` and `Delete` remove text backward and forward.
- `Option` plus either deletion key removes by word/group.
- `Command` plus either deletion key removes to the beginning or end of the
  cell's editable line.
- Browser selection deletion, IME, paste, direct typing, and updates to the
  Markdown source continue to use the existing delegated input pipeline.

The change applies only to editable, non-read-only table widgets. Tab and
Shift+Tab cell navigation, Escape, CodeMirror undo/redo, application save,
table atomic-range protection, and reading-mode behavior are unchanged.

## Design

Add a narrowly scoped keyboard-event predicate to `MarkdownTableWidget`.
For an editable table widget it returns `true` from `ignoreEvent` for keyboard
events whose key is `Backspace` or `Delete`, including modifier combinations.
CodeMirror therefore leaves those key events to the browser's nested
`contenteditable` cell. The existing root-level `input` listener observes the
resulting native deletion, serializes the affected cell, and commits its text
back to the corresponding Markdown table cell.

No deletion command is reimplemented. This keeps native selection, caret,
composition, and macOS word/line deletion semantics intact. The existing
delegated keydown handler still intercepts only Tab and Escape, and CodeMirror
continues to own undo/redo and save shortcuts because they do not match the
deletion predicate.

## Rejected Alternatives

- Dispatching CodeMirror deletion commands manually would require duplicating
  native selection and composition behavior across six shortcut variants.
- Removing the table atomic range would make it possible for editor commands
  to accidentally alter table syntax outside the current cell.

## Verification

Add a widget event-policy unit test for normal, Option, and Command variants
of Backspace/Delete, plus non-editable/read-only rejection. Extend the real
browser workflow to click a table cell, use each native deletion shortcut, and
save the resulting Markdown. The test must show the exact source preserves the
table structure and surrounding document text.

Run focused tests, the full Vitest suite, frontend build, Playwright workflow,
and relevant packaging checks. Before installing a replacement `/Applications/Opus.app`,
build and ad-hoc sign it, validate the ARM64 bundle, and retain an explicit
rollback copy. Do not launch the replacement automatically.
