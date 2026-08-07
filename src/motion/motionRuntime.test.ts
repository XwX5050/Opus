import { describe, expect, it, vi } from "vitest";
import { MAX_EDITOR_MOTION_TARGETS, MOTION } from "./motionConfig";
import {
  animateDialogIntro,
  animateListIntro,
  animatePanelIntro,
  clampMotionTargets,
  prefersReducedMotion,
} from "./motionRuntime";

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

  it("keeps focused list items interactive while animating siblings", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<button data-motion-item aria-selected="true">active</button>' +
      '<button data-motion-item>next</button>';
    document.body.append(root);
    const active = root.querySelector<HTMLElement>("[aria-selected]");
    active?.focus();

    animateListIntro(root);

    expect(active?.style.visibility).not.toBe("hidden");
    expect(active?.style.transform).toBe("");
    expect(root.querySelectorAll<HTMLElement>("[data-motion-item]")[1]?.style.visibility)
      .not.toBe("hidden");
    root.remove();
  });

  it("does not hide dialog controls during the entrance timeline", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div role="dialog"><h2>Title</h2><button>Confirm</button></div>';

    animateDialogIntro(root);

    const button = root.querySelector<HTMLButtonElement>("button");
    expect(button?.style.visibility).not.toBe("hidden");
    expect(button?.style.opacity).not.toBe("0");
  });

  it("clears panel transforms immediately when reduced motion is enabled", () => {
    const original = window.matchMedia;
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
    }));
    const panel = document.createElement("div");
    animatePanelIntro(panel);
    expect(panel.style.transform).toBe("");
    vi.stubGlobal("matchMedia", original);
  });
});
