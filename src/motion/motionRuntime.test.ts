import { describe, expect, it, vi } from "vitest";
import gsap from "gsap";
import { MAX_EDITOR_MOTION_TARGETS, MOTION } from "./motionConfig";
import {
  animateDialogIntro,
  animateListIntro,
  animatePanelIntro,
  bindButtonHoverMotion,
  bindChevronSpreadHover,
  bindPanelDividerHover,
  bindViewModeHover,
  clampMotionTargets,
  prefersReducedMotion,
  setPanelDividerState,
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

  it("tweens a hovered button and restores it on cleanup", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
    }));
    const root = document.createElement("div");
    root.innerHTML = "<button>保存</button>";
    const button = root.querySelector("button")!;

    const cleanup = bindButtonHoverMotion(root);
    button.dispatchEvent(new Event("pointerenter"));
    expect(gsap.getTweensOf(button).length).toBeGreaterThan(0);

    cleanup();
    expect(button.style.transform).toBe("");
    button.dispatchEvent(new Event("pointerenter"));
    expect(gsap.getTweensOf(button)).toHaveLength(0);
    vi.unstubAllGlobals();
    root.remove();
  });

  it("skips disabled buttons and reduced-motion sessions", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
    }));
    const root = document.createElement("div");
    root.innerHTML = "<button disabled>停用</button>";
    const disabled = root.querySelector("button")!;
    const cleanupDisabled = bindButtonHoverMotion(root);
    disabled.dispatchEvent(new Event("pointerenter"));
    expect(gsap.getTweensOf(disabled)).toHaveLength(0);
    cleanupDisabled();

    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
    }));
    const enabled = document.createElement("button");
    const host = document.createElement("div");
    host.append(enabled);
    const cleanupReduced = bindButtonHoverMotion(host);
    enabled.dispatchEvent(new Event("pointerenter"));
    expect(gsap.getTweensOf(enabled)).toHaveLength(0);
    cleanupReduced();
    vi.unstubAllGlobals();
    root.remove();
  });

  const panelButton = (): {
    button: HTMLElement;
    divider: Element;
    fill: Element;
  } => {
    const button = document.createElement("button");
    button.innerHTML =
      '<svg viewBox="0 0 24 24">' +
      '<rect data-panel-fill="" x="3" y="3" width="6" height="18" rx="2" opacity="0" />' +
      '<rect width="18" height="18" x="3" y="3" rx="2" />' +
      '<line data-panel-divider="" x1="9" y1="3" x2="9" y2="21" /></svg>';
    return {
      button,
      divider: button.querySelector("[data-panel-divider]")!,
      fill: button.querySelector("[data-panel-fill]")!,
    };
  };

  it("keeps the divider visible and fills the block when collapsed", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
    }));
    const { button, divider, fill } = panelButton();

    setPanelDividerState(button, "left", true);
    expect(divider.getAttribute("x1")).toBe("9");
    expect((fill as HTMLElement).style.opacity).toBe("0.32");
    setPanelDividerState(button, "left", false);
    expect(divider.getAttribute("x1")).toBe("9");
    expect((fill as HTMLElement).style.opacity).toBe("0");
    vi.unstubAllGlobals();
  });

  it("previews the toggle inside the icon while hovering", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
    }));
    const { button, divider } = panelButton();
    let collapsed = false;

    const cleanup = bindPanelDividerHover(button, "left", () => collapsed);
    button.dispatchEvent(new Event("pointerenter"));
    expect(gsap.getTweensOf(divider).length).toBeGreaterThan(0);
    button.dispatchEvent(new Event("pointerleave"));
    expect(gsap.getTweensOf(divider).length).toBeGreaterThan(0);

    collapsed = true;
    cleanup();
    button.dispatchEvent(new Event("pointerenter"));
    expect(gsap.getTweensOf(divider)).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("no-ops the divider bindings for buttons without a divider line", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
    }));
    const button = document.createElement("button");
    const cleanup = bindPanelDividerHover(button, "left", () => false);
    setPanelDividerState(button, "left", true);
    expect(() => cleanup()).not.toThrow();
    vi.unstubAllGlobals();
  });

  it("spreads the toggle-all chevrons on hover and springs them back", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
    }));
    const button = document.createElement("button");
    button.innerHTML =
      '<svg viewBox="0 0 24 24">' +
      '<path data-chevron="top" d="m6 5 6 4 6-4" />' +
      '<path data-chevron="bottom" d="m6 19 6-4 6 4" /></svg>';
    const top = button.querySelector('[data-chevron="top"]')!;
    const bottom = button.querySelector('[data-chevron="bottom"]')!;

    const cleanup = bindChevronSpreadHover(button);
    button.dispatchEvent(new Event("pointerenter"));
    expect(gsap.getTweensOf(top).length).toBeGreaterThan(0);
    expect(gsap.getTweensOf(bottom).length).toBeGreaterThan(0);
    button.dispatchEvent(new Event("pointerleave"));
    expect(gsap.getTweensOf(top).length).toBeGreaterThan(0);

    cleanup();
    button.dispatchEvent(new Event("pointerenter"));
    expect(gsap.getTweensOf(top)).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("does not spread chevrons on a disabled toggle-all button", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
    }));
    const button = document.createElement("button");
    button.disabled = true;
    button.innerHTML =
      '<svg viewBox="0 0 24 24">' +
      '<path data-chevron="top" d="m6 5 6 4 6-4" />' +
      '<path data-chevron="bottom" d="m6 19 6-4 6 4" /></svg>';

    const cleanup = bindChevronSpreadHover(button);
    button.dispatchEvent(new Event("pointerenter"));
    expect(
      gsap.getTweensOf(button.querySelector('[data-chevron="top"]')!),
    ).toHaveLength(0);
    cleanup();
    vi.unstubAllGlobals();
  });

  it("animates the view-mode icon on hover for both glyphs", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
    }));
    const button = document.createElement("button");
    button.innerHTML = '<svg data-view-icon="book" viewBox="0 0 24 24"></svg>';

    const cleanup = bindViewModeHover(button);
    button.dispatchEvent(new Event("pointerenter"));
    const book = button.querySelector("[data-view-icon]")!;
    expect(gsap.getTweensOf(book).length).toBeGreaterThan(0);
    button.dispatchEvent(new Event("pointerleave"));

    // The button swaps glyphs when the mode changes; the binding must
    // follow the current icon instead of the one present at bind time.
    button.innerHTML = '<svg data-view-icon="pencil" viewBox="0 0 24 24"></svg>';
    button.dispatchEvent(new Event("pointerenter"));
    const pencil = button.querySelector("[data-view-icon]")!;
    expect(gsap.getTweensOf(pencil).length).toBeGreaterThan(0);

    cleanup();
    button.dispatchEvent(new Event("pointerenter"));
    expect(gsap.getTweensOf(pencil)).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
