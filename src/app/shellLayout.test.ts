import { describe, expect, it } from "vitest";
import {
  activeHeadingIdAt,
  clampPanelResizeWidth,
  EDITOR_MIN_WIDTH,
  flattenOutline,
  panelMaxWidth,
  panelRoomOf,
  panelWidthLimit,
  resolvePanelDisplayWidths,
  settlePanelLayout,
  SHELL_ACTIVITY_RAIL_WIDTH,
  type PanelLayoutSnapshot,
} from "./shellLayout";
import type { OutlineHeading } from "../editor/outline";

const snapshot = (
  overrides: Partial<PanelLayoutSnapshot> = {},
): PanelLayoutSnapshot => ({
  windowWidth: 1200,
  sidebarWidth: 260,
  sidebarCollapsed: false,
  sidebarAutoHidden: false,
  outlineWidth: 300,
  outlineOpen: true,
  ...overrides,
});

const settle = (
  input: PanelLayoutSnapshot,
  memory = { outline: false },
  allowRestore = true,
) => settlePanelLayout(input, memory, { allowRestore });

const heading = (
  id: string,
  from: number,
  children: ReadonlyArray<OutlineHeading> = [],
): OutlineHeading => ({
  id,
  level: 1,
  text: id,
  from,
  textFrom: from,
  children,
});

describe("panel width limits", () => {
  it("reserves the activity rail and the editor floor", () => {
    expect(panelRoomOf(1200)).toBe(
      1200 - SHELL_ACTIVITY_RAIL_WIDTH - EDITOR_MIN_WIDTH,
    );
    expect(panelRoomOf(300)).toBe(0);
  });

  it("subtracts the other visible panel from the available room", () => {
    expect(panelWidthLimit(1200, 300)).toBe(
      1200 - SHELL_ACTIVITY_RAIL_WIDTH - EDITOR_MIN_WIDTH - 300,
    );
    expect(panelWidthLimit(680, 300)).toBe(
      680 - SHELL_ACTIVITY_RAIL_WIDTH - EDITOR_MIN_WIDTH - 300,
    );
  });

  it("caps a panel at the window fraction, the maximum and the layout room", () => {
    // 1024: 50% is 512, the layout room with no other panel is 668.
    expect(panelMaxWidth(1024, 0)).toBe(512);
    // With a 300px outline open, only 368px remain.
    expect(panelMaxWidth(1024, 300)).toBe(
      1024 - SHELL_ACTIVITY_RAIL_WIDTH - EDITOR_MIN_WIDTH - 300,
    );
    // 680: 50% is 340, but the editor floor leaves 324 for a lone panel.
    expect(panelMaxWidth(680, 0)).toBe(
      680 - SHELL_ACTIVITY_RAIL_WIDTH - EDITOR_MIN_WIDTH,
    );
    // A 600px preference can never be dragged wider than the room.
    expect(panelMaxWidth(680, 0)).toBeLessThan(600);
  });

  it("clamps resize values into the panel and layout bounds", () => {
    expect(clampPanelResizeWidth(10, 500)).toBe(120);
    expect(clampPanelResizeWidth(900, 500)).toBe(500);
    expect(clampPanelResizeWidth(300, 500)).toBe(300);
  });
});

describe("resolvePanelDisplayWidths", () => {
  it("keeps both preferred widths when they fit", () => {
    const display = resolvePanelDisplayWidths(snapshot());
    expect(display).toEqual({
      room: 844,
      sidebarVisible: true,
      sidebarWidth: 260,
      outlineVisible: true,
      outlineWidth: 300,
    });
  });

  it("clamps a restored wide sidebar instead of letting it crush the editor", () => {
    const display = resolvePanelDisplayWidths(
      snapshot({ windowWidth: 680, sidebarWidth: 600, outlineOpen: false }),
    );
    expect(display.sidebarVisible).toBe(true);
    expect(display.sidebarWidth).toBe(
      680 - SHELL_ACTIVITY_RAIL_WIDTH - EDITOR_MIN_WIDTH,
    );
    expect(
      680 - SHELL_ACTIVITY_RAIL_WIDTH - display.sidebarWidth,
    ).toBe(EDITOR_MIN_WIDTH);
  });

  it("clamps a wide outline to the room left beside the explorer", () => {
    const display = resolvePanelDisplayWidths(
      snapshot({ windowWidth: 680, outlineWidth: 600 }),
    );
    expect(display.outlineWidth).toBe(
      680 - SHELL_ACTIVITY_RAIL_WIDTH - EDITOR_MIN_WIDTH - 260,
    );
  });

  it("never reports more panel width than the room allows", () => {
    const display = resolvePanelDisplayWidths(
      snapshot({ windowWidth: 680, sidebarWidth: 600, outlineWidth: 600 }),
    );
    expect(display.sidebarWidth + display.outlineWidth).toBeLessThanOrEqual(
      display.room,
    );
  });

  it("uses the runtime auto-hide without touching the preference", () => {
    const display = resolvePanelDisplayWidths(
      snapshot({ sidebarAutoHidden: true }),
    );
    expect(display.sidebarVisible).toBe(false);
    expect(display.sidebarWidth).toBe(0);
    expect(display.outlineWidth).toBe(300);
  });
});

describe("settlePanelLayout", () => {
  it("keeps both panels open while the preferred widths fit", () => {
    expect(settle(snapshot({ windowWidth: 1000 }))).toEqual({
      sidebarAutoHidden: false,
      outlineOpen: true,
      autoOutline: false,
    });
  });

  it("reclaims the outline first when both preferred widths no longer fit", () => {
    const settled = settle(snapshot({ windowWidth: 680 }));
    expect(settled.outlineOpen).toBe(false);
    expect(settled.autoOutline).toBe(true);
    expect(settled.sidebarAutoHidden).toBe(false);
  });

  it("keeps a clamped explorer instead of hiding it at 560px", () => {
    const settled = settle(
      snapshot({ windowWidth: 560, outlineOpen: false }),
    );
    expect(settled.sidebarAutoHidden).toBe(false);
  });

  it("hides the explorer when even its minimum width would break the editor floor", () => {
    const settled = settle(
      snapshot({ windowWidth: 470, outlineOpen: false }),
    );
    expect(settled.sidebarAutoHidden).toBe(true);
  });

  it("does not touch the user's collapse preference", () => {
    const settled = settle(
      snapshot({ windowWidth: 470, sidebarCollapsed: true }),
    );
    expect(settled.sidebarAutoHidden).toBe(false);
    // The result carries only runtime visibility, never a persisted flag.
    expect(settled).not.toHaveProperty("sidebarCollapsed");
  });

  it("restores auto-hidden panels on a widening resize", () => {
    const narrowed = settle(snapshot({ windowWidth: 470 }));
    expect(narrowed.sidebarAutoHidden).toBe(true);

    const widened = settle(
      snapshot({ windowWidth: 1200 }),
      { outline: narrowed.autoOutline },
    );
    expect(widened.sidebarAutoHidden).toBe(false);
    expect(widened.outlineOpen).toBe(true);
    expect(widened.autoOutline).toBe(false);
  });

  it("does not restore panels when only a preference arrives late", () => {
    const late = settle(
      snapshot({
        windowWidth: 900,
        sidebarAutoHidden: true,
        outlineOpen: false,
      }),
      { outline: true },
      false,
    );
    expect(late.sidebarAutoHidden).toBe(true);
    expect(late.outlineOpen).toBe(false);
  });

  it("keeps an auto-hidden panel closed inside the restore hysteresis band", () => {
    const room = SHELL_ACTIVITY_RAIL_WIDTH + EDITOR_MIN_WIDTH;
    const restored = settle(
      snapshot({
        windowWidth: room + 300,
        outlineOpen: false,
        sidebarAutoHidden: true,
      }),
      { outline: false },
    );
    expect(restored.sidebarAutoHidden).toBe(false);
    const banded = settle(
      snapshot({
        windowWidth: room + 130,
        outlineOpen: false,
        sidebarAutoHidden: true,
      }),
      { outline: false },
    );
    // 130px of room is above the 120px minimum but below minimum + margin.
    expect(banded.sidebarAutoHidden).toBe(true);
  });

  it("clears a stale auto-hide when the user collapsed the explorer", () => {
    const settled = settle(
      snapshot({ sidebarCollapsed: true, sidebarAutoHidden: true }),
    );
    expect(settled.sidebarAutoHidden).toBe(false);
  });

  it("is stable when fed its own result", () => {
    const first = settle(snapshot({ windowWidth: 680 }));
    const second = settle(
      snapshot({
        windowWidth: 680,
        outlineOpen: first.outlineOpen,
        sidebarAutoHidden: first.sidebarAutoHidden,
      }),
      { outline: first.autoOutline },
    );
    expect(second).toEqual(first);
  });

  it("is stable across a restore rerun", () => {
    const narrowed = settle(snapshot({ windowWidth: 470 }));
    const restored = settle(
      snapshot({
        windowWidth: 1200,
        outlineOpen: narrowed.outlineOpen,
        sidebarAutoHidden: narrowed.sidebarAutoHidden,
      }),
      { outline: narrowed.autoOutline },
    );
    const rerun = settle(
      snapshot({
        windowWidth: 1200,
        outlineOpen: restored.outlineOpen,
        sidebarAutoHidden: restored.sidebarAutoHidden,
      }),
      { outline: restored.autoOutline },
    );
    expect(rerun).toEqual(restored);
  });
});

describe("outline scroll helpers", () => {
  it("flattens nested headings in document order", () => {
    const tree = [
      heading("a", 0, [heading("a-1", 10), heading("a-2", 20, [heading("a-2-x", 30)])]),
      heading("b", 40),
    ];
    expect(flattenOutline(tree).map((item) => item.id)).toEqual([
      "a",
      "a-1",
      "a-2",
      "a-2-x",
      "b",
    ]);
  });

  it("picks the last heading at or above the viewport offset", () => {
    const flat = flattenOutline([heading("a", 0), heading("b", 100)]);
    expect(activeHeadingIdAt(flat, 0)).toBe("a");
    expect(activeHeadingIdAt(flat, 99)).toBe("a");
    expect(activeHeadingIdAt(flat, 100)).toBe("b");
    expect(activeHeadingIdAt(flat, 500)).toBe("b");
  });

  it("reports no active heading above the first one", () => {
    const flat = flattenOutline([heading("a", 10)]);
    expect(activeHeadingIdAt(flat, 5)).toBeNull();
    expect(flattenOutline(null)).toEqual([]);
  });
});
