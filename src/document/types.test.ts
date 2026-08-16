import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  clampSidebarWidthToWindow,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WINDOW_WIDTH_FRACTION,
} from "./types";

describe("clampSidebarWidth", () => {
  it("keeps the fixed pixel bounds for restored/preference widths", () => {
    expect(clampSidebarWidth(260)).toBe(260);
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(900)).toBe(SIDEBAR_MAX_WIDTH);
  });
});

describe("clampSidebarWidthToWindow", () => {
  it("applies the fixed bounds on windows wide enough for them", () => {
    const cap = clampSidebarWidthToWindow(SIDEBAR_MAX_WIDTH, 2000);
    expect(cap).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("shrinks the upper bound with the window width", () => {
    // 760px window (close to the macOS 680px minimum): cap = 40% ≈ 304px.
    expect(clampSidebarWidthToWindow(900, 760)).toBe(304);
  });

  it("leaves the editor room when both panels are open at the caps", () => {
    // At the macOS minimum window both caps together stay under the window.
    const cap = clampSidebarWidthToWindow(SIDEBAR_MAX_WIDTH, 680);
    expect(cap).toBe(Math.round(680 * SIDEBAR_WINDOW_WIDTH_FRACTION));
    expect(cap * 2).toBeLessThan(680);
  });

  it("still floors at the fixed minimum width", () => {
    expect(clampSidebarWidthToWindow(10, 760)).toBe(SIDEBAR_MIN_WIDTH);
    // A degenerate window clamp never drops below the fixed minimum either.
    expect(clampSidebarWidthToWindow(480, 300)).toBe(SIDEBAR_MIN_WIDTH);
  });
});