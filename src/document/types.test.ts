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
    expect(clampSidebarWidth(120)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(1200)).toBe(SIDEBAR_MAX_WIDTH);
  });
});

describe("clampSidebarWidthToWindow", () => {
  it("applies the fixed bounds on windows wide enough for them", () => {
    const cap = clampSidebarWidthToWindow(SIDEBAR_MAX_WIDTH, 2600);
    expect(cap).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("shrinks the upper bound with the window width", () => {
    // 760px window (close to the macOS 680px minimum): cap = 50% = 380px.
    expect(clampSidebarWidthToWindow(1200, 760)).toBe(380);
  });

  it("caps a single panel at half the window", () => {
    // At the macOS minimum window the cap is exactly half the window, so one
    // panel can never swallow the editor on its own.
    const cap = clampSidebarWidthToWindow(SIDEBAR_MAX_WIDTH, 680);
    expect(cap).toBe(Math.round(680 * SIDEBAR_WINDOW_WIDTH_FRACTION));
    expect(cap).toBeLessThan(680);
  });

  it("still floors at the fixed minimum width", () => {
    expect(clampSidebarWidthToWindow(10, 760)).toBe(SIDEBAR_MIN_WIDTH);
    // A degenerate window clamp never drops below the fixed minimum either.
    expect(clampSidebarWidthToWindow(480, 200)).toBe(SIDEBAR_MIN_WIDTH);
  });
});