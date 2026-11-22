# Table Horizontal Slider Implementation Plan

> **For agentic workers:** Execute inline with test-driven development. Do not commit unless the user asks.

**Goal:** Add an accessible horizontal slider below overflowing rendered Markdown tables.

**Architecture:** A small DOM controller synchronizes the existing table scroller with a sibling range input. The CodeMirror widget owns controller lifecycle; existing table/cell context remains keyed by the scroller.

**Tech Stack:** TypeScript, CodeMirror 6 WidgetType, ResizeObserver, CSS, Vitest/jsdom, Playwright.

---

### Task 1: Synchronization controller

**Files:**
- Create: `src/editor/tableHorizontalScroll.ts`
- Test: `src/editor/tableHorizontalScroll.test.ts`

- [x] Write tests that create a scroller and range input, set measured widths, and assert overflow visibility, slider-to-scroll input, scroll-to-slider updates, and idempotent cleanup.
- [x] Run `npm test -- src/editor/tableHorizontalScroll.test.ts` and verify the module is missing.
- [x] Implement `attachTableHorizontalScroll(scroll, slider)` returning `{ sync, destroy }`; clamp values, observe both scroller and table, and remove listeners on destroy.
- [x] Re-run the focused test and verify all cases pass.

### Task 2: Widget and styles

**Files:**
- Modify: `src/editor/tableWidgets.ts`
- Modify: `src/editor/tableWidgets.test.ts`
- Modify: `src/theme/app.css`

- [x] Add failing widget tests for the frame/scroller/slider structure, accessible name, updateDOM reuse, slider event isolation, and controller destruction.
- [x] Run `npm test -- src/editor/tableWidgets.test.ts` and verify the new cases fail because the slider is absent.
- [x] Render `.md-table-frame > .md-table-scroll + input.md-table-horizontal-slider[type=range]`, store the controller by frame, synchronize after updates, and destroy with the widget.
- [x] Move table margin to the frame, hide only the duplicate native table scrollbar, and style the range track/thumb with existing tokens. Include `[hidden] { display: none; }` so author display rules cannot reveal it.
- [x] Re-run table tests and `npm run build`.

### Task 3: End-to-end acceptance

**Files:**
- Modify: `tests/e2e/notepad.spec.ts`
- Modify: `AGENTS.md`

- [x] Add a Playwright test with one wide and one narrow table. Assert the slider appears only for the wide table, changes `scrollLeft`, follows programmatic native scrolling, accepts keyboard arrows, and leaves the source unchanged.
- [x] Run `npm run test:e2e -- tests/e2e/notepad.spec.ts` and verify the scenario.
- [x] Update the editor module guidance with the slider lifecycle and accessibility contract.
- [x] Run `npm run check && npm run test:e2e`; inspect the rendered wide table and slider in the built-in browser.
