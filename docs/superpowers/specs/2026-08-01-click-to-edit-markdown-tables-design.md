# Click-to-Edit Markdown Tables Design

## Problem

Interactive Markdown tables render correctly in the packaged Opus app, but a
native WKWebView click does not focus an editable cell. CodeMirror currently
handles every event originating in the replacement widget, so the editor can
take pointer focus away from the nested `contenteditable` cell. Browser E2E
tests hid this gap by placing the selection with `Range` after clicking.

The mode boundary also adds friction: a table shown in reading mode is static,
so a user must find the toolbar toggle before editing. The approved interaction
is Excel-like: clicking the desired cell is enough to begin editing.

## Interaction

- In editing mode, a primary click on a header or body cell focuses that cell
  and places the native caret at the clicked text position.
- In reading mode, a primary click records the table source position and cell
  index, switches the document to editing mode, then focuses the corresponding
  cell after CodeMirror rebuilds the widget.
- Switching modes or focusing a cell never changes the Markdown document and
  never saves automatically.
- Secondary clicks, pointer drags, text selection within one cell, keyboard
  navigation, IME composition, undo/redo, and read-only documents retain their
  existing behavior.
- A truly read-only document must not enter editable-cell mode.

This design supersedes only the original table design's statement that reading
mode table clicks are inert. Reading mode remains non-editable until a valid
primary cell click explicitly requests the existing editing mode.

## Architecture and Data Flow

`MarkdownTableWidget` will stop CodeMirror from handling pointer events that
belong to an editable cell while leaving keyboard, input, paste, composition,
and application shortcuts on the existing path. Native cell focus and caret
placement therefore remain owned by the browser engine instead of being
reconstructed from click coordinates.

The table extension gains an optional edit-request callback. A static reading
widget invokes it with a stable table identity and cell index on primary click.
`MarkdownEditor` forwards that request to the application mode owner. The mode
owner stores one pending table-focus request, changes to editing mode, and
passes the request back to the table extension. After the editing widget exists,
the plugin resolves the current table from the document, focuses the matching
owned cell, then consumes the request. Stale, missing, over-budget, or read-only
targets are discarded without changing the document.

The focus request contains no cell text and is not document state. It must not
enter undo history, recovery drafts, saved files, or persistent settings.

## Alternatives Rejected

- Keeping cells editable during reading mode would make the global read-only
  presentation misleading and bypass the existing mode state.
- Overlaying a separate input control would complicate caret positioning,
  selection, accessibility, IME, and table layout without improving the desired
  interaction.
- Programmatically synthesizing every caret from pointer coordinates would
  duplicate native editing behavior and be fragile across Chromium and WebKit.

## Verification

Add a failing real-`EditorView` regression test for the widget event contract:
pointer events inside an editable cell are ignored by CodeMirror, while input
and keyboard events remain on the existing handling path. Add component tests
for reading-mode cell click -> editing-mode transition, pending focus handoff,
stale request rejection, and read-only rejection.

Replace the E2E helper's unconditional scripted caret placement with a genuine
cell click assertion before typing. Cover reading-mode click transition, exact
cell focus, typing, dirty state, save output, Tab navigation, and undo/redo.

Run focused table/component tests, full Vitest, production build, Playwright,
Rust tests, formatting, and Clippy. Rebuild and ad-hoc sign `Opus.app`, install
it with a rollback backup, then manually verify in the real macOS WKWebView that
a reading-mode click enters editing at the selected cell. Do not modify or save
the user's document during manual focus verification.
