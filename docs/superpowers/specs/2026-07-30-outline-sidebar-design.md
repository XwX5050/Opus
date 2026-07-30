# Outline Sidebar Design

## Problem

Opus can render Markdown headings but offers no document-level navigation. Long
notes require manual scrolling, and the existing left sidebar only represents
open tabs and workspace files. Add a lightweight outline on the right without
turning the editor into a multi-panel knowledge-management application.

## Goals

- Derive a hierarchical outline from the active document's Markdown headings.
- Open the outline from a titlebar control beside the reading/editing control.
- Mirror the left sidebar's sizing, collapse behavior, animation, and control
  affordances on the right.
- Navigate accurately in editing and reading modes.
- Keep branch state per tab for the current process while starting every app
  launch with the whole right sidebar collapsed.
- Preserve the chosen right-sidebar width between launches.

## Non-Goals

- Do not add backlinks, tags, graph navigation, heading drag-and-drop, document
  restructuring, or an active-heading scroll spy.
- Do not persist individual expanded/collapsed branches.
- Do not add Rust commands or change Markdown file contents.
- Do not treat the filename as a synthetic root heading.

## Titlebar and Right Sidebar

When an active document exists, render a `ListTreeIcon` immediately after the
reading/editing control. The button uses the existing 36px `icon-button`
geometry, exposes `aria-expanded` and `aria-controls="app-outline"`, and adopts
the existing pressed-state treatment while the outline is open. It is absent
from the empty state.

The outline enters from the right of `.app-body`. Its rail transitions width
and opacity with the same `--transition-sidebar` token as the left rail. The
panel fills the available body height, has a left divider, and becomes
`inert`, `aria-hidden`, invisible, and non-interactive when collapsed.

The default width is 300px. A separator on the panel's left edge supports
pointer drag and Left/Right keyboard resizing from 200px through 480px. Dragging
left increases the width; dragging right decreases it. Persist only the width
in the optional session outline preference. The open state is component-local
and always initializes to `false`, including after session restoration.

The outline toolbar uses the approved A layout:

1. `大纲` on the left.
2. An icon-only `全部折叠` button using two inward-facing chevrons with an
   approximately 6px gap between their tips.
3. A `PanelRightIcon` button labelled `收起右侧栏`.

All outline icons use the same Lucide-style 18px drawing, approximately 1.8px
stroke, round caps, muted color, and hover surface as the reference. Disclosure
chevrons are smaller and lower contrast.

## Outline Model and Extraction

Add an editor-owned outline extension so extraction reuses the active
CodeMirror Markdown parser rather than scanning source with regular
expressions. The extension publishes:

```ts
interface OutlineHeading {
  readonly id: string;
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly text: string;
  readonly from: number;
  readonly textFrom: number;
  readonly children: ReadonlyArray<OutlineHeading>;
}
```

Support ATX and Setext headings while naturally excluding heading-like text
inside fenced/indented code and other non-heading syntax. Trim Markdown heading
markers and surrounding whitespace from the displayed label. Empty headings
remain navigable and display `无标题`.

Use a stack to build parent/child relationships. A heading becomes a child of
the nearest preceding heading with a smaller numeric level. Skipped levels are
valid: an H4 directly after an H2 belongs to that H2. Stable IDs combine the
hierarchical heading text path with a document-order occurrence number, so
duplicate labels remain distinct and edits above a heading do not invalidate
every branch solely because source offsets moved.

Extraction runs after the initial editor mount and after document changes. A
120ms debounce coalesces typing. Force the existing Lezer parse toward the end
of the document in bounded idle slices; discard stale generations when the
document changes again or the editor unmounts. The active editor remains the
single source of the outline, including in large-document light mode.

## Panel Interaction

`OutlinePanel` receives an immutable heading tree and a set of collapsed parent
IDs. Every parent row has a separate disclosure button:

- Clicking the disclosure toggles only that branch.
- Clicking the label issues a navigation request.
- `全部折叠` adds every current parent ID to the collapsed set and is disabled
  when no expandable parent exists or all parents are already collapsed.
- Each newly opened document starts fully expanded.
- Each open tab retains its collapsed set while the app process is alive.
- Outline refreshes retain IDs that still exist and prune removed IDs.

When the outline is open before extraction finishes, show `正在生成大纲…`.
When extraction finishes with no headings, show `当前文档没有标题`. Neither
state closes the panel.

Rows are buttons with visible keyboard focus. Disclosure buttons expose
`aria-expanded`; the tree uses nested lists with an accessible label of
`文档大纲`. Escape does not close the panel because it is persistent
navigation, not a modal.

## Navigation

The shell sends navigation requests to `MarkdownEditor` with a monotonically
increasing sequence and the target positions. The editor ignores stale
sequences.

- In editing mode, dispatch a CodeMirror selection at `textFrom`, focus the
  editor, and scroll the heading near the top with a small vertical margin.
- In reading mode, preserve the current selection and focus, and only scroll
  `from` into view.

Navigation never changes the reading/editing mode and never modifies document
text or undo history.

## State and Component Boundaries

- `src/editor/outline.ts`: outline types, extraction, hierarchy construction,
  stable IDs, and parent-ID collection.
- `src/editor/outlineExtension.ts`: debounced, generation-safe publication from
  the current CodeMirror syntax tree.
- `src/editor/OutlinePanel.tsx`: toolbar, nested tree, branch state callbacks,
  empty/loading states, and accessible controls.
- `src/editor/MarkdownEditor.tsx`: installs the extension and consumes
  navigation requests.
- `src/app/AppShell.tsx`: titlebar toggle, right rail/resizer, per-tab outline
  cache and collapsed sets, navigation sequence, and runtime open state.
- `src/app/icons.tsx`: `ListTreeIcon`, `CollapseAllIcon`, `PanelRightIcon`, and
  the disclosure chevron.
- `src/document/types.ts` and `src/app/useAppController.ts`: normalize and
  persist the optional outline width without persisting open state.
- `src/theme/app.css`: mirrored rail, panel, resizer, toolbar, tree, and motion
  styles using existing tokens.

Closing a tab prunes its cached outline and collapsed IDs. Switching tabs shows
the cached outline immediately, then replaces it when the newly mounted editor
publishes its current tree.

## Verification

Test extraction with ATX/Setext headings, duplicate labels, skipped levels,
empty headings, fenced and indented code, and live edits. Component tests cover
nested rendering, disclosure behavior, `全部折叠`, disabled/empty/loading
states, keyboard access, titlebar button order, inert collapsed rails, per-tab
state, width clamping/persistence, and launch-time collapse.

Real `EditorView` tests verify editing-mode selection/focus/scroll behavior and
reading-mode scroll-only behavior. Playwright opens a heading-rich fixture,
checks hierarchy, folds one branch and all branches, switches modes and tabs,
and exercises resize/toggle behavior. Run frontend tests and build, browser
E2E, Rust formatting/Clippy/tests, then perform a native macOS visual check in
both themes before rebuilding and updating `Opus.app`.
