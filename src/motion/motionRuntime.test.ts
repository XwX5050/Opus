import { describe, expect, it, vi } from "vitest";
import { MAX_EDITOR_MOTION_TARGETS, MOTION } from "./motionConfig";
import { clampMotionTargets, prefersReducedMotion } from "./motionRuntime";

describe("motion runtime", () => {
  it("exports bounded motion constants", () => {
    expect(MOTION.panel.duration).toBe(0.42);
    expect(MOTION.list.stagger).toBeGreaterThan(0);
    expect(MAX_EDITOR_MOTION_TARGETS).toBe(16);
  });

  it("caps editor targets without mutating the source array", () => {
    const source = Array.from({ length: 20 }, (_, index) => index);
    expect(clampMotionTargets(source)).toEqual(source.slice(0, 16));
    expect(source).toHaveLength(20);
  });

  it("reads prefers-reduced-motion from matchMedia", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true, media: "(prefers-reduced-motion: reduce)" }),
    });
    expect(prefersReducedMotion()).toBe(true);
  });

  it("falls back to normal motion when matchMedia is unavailable", () => {
    const original = window.matchMedia;
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
    vi.stubGlobal("matchMedia", original);
  });
});
