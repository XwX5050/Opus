# Table Horizontal Slider Design

## Context

Rendered Markdown tables already scroll horizontally through `.md-table-scroll`, but macOS can hide the native scrollbar until scrolling begins. Users need a persistent, visible control when a table is wider than its container.

## Approved design

- Add an independent range slider immediately below the table scrolling area.
- Show it only when `scrollWidth > clientWidth`; hide it without reserving space otherwise.
- Synchronize slider input to `scrollLeft` and native scrolling back to the slider.
- Recalculate overflow after content updates and through `ResizeObserver` on the scrolling area and table.
- Keep the existing semantic `<table>` and cell ownership/editing model unchanged.
- Give the slider the accessible name `横向滚动表格`; native range keyboard behavior remains available.
- Hide the duplicate native horizontal scrollbar while retaining touchpad and wheel scrolling.
- Release observers and listeners when CodeMirror destroys the widget.

## Implementation boundaries

`tableHorizontalScroll.ts` owns measurement, synchronization, and cleanup. `tableWidgets.ts` owns the frame DOM, mounts the controller, refreshes it after updates, and excludes slider events from editor/cell handling. `app.css` styles the frame and slider without changing table cell layout.

## Verification

Unit tests cover hidden non-overflowing tables, overflow visibility, both synchronization directions, update/destroy cleanup, and slider keyboard-event isolation. A Playwright scenario drags/fills the slider, verifies native scrolling updates it, confirms that a narrow table has no slider, and checks that editing and reading modes preserve the Markdown source.
