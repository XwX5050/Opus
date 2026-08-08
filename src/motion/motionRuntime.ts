import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  MAX_LIST_MOTION_TARGETS,
  MOTION,
} from "./motionConfig";

gsap.registerPlugin(useGSAP);

export const prefersReducedMotion = (): boolean => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

export const clampMotionTargets = <T>(targets: readonly T[]): T[] =>
  targets.slice(0, 16);

export const animatePanelIntro = (root: HTMLElement): gsap.core.Timeline => {
  const timeline = gsap.timeline({ defaults: { overwrite: "auto" } });
  if (prefersReducedMotion()) {
    timeline.set(root, { clearProps: "transform" });
    return timeline;
  }
  timeline.fromTo(
    root,
    { y: 10, scale: 0.985 },
    {
      y: 0,
      scale: 1,
      duration: MOTION.panel.duration,
      ease: MOTION.easing,
      clearProps: "transform",
    },
  );
  return timeline;
};

export const animateDialogIntro = (root: HTMLElement): gsap.core.Timeline => {
  const dialog = root.querySelector<HTMLElement>('[role="dialog"]');
  const content = dialog
    ? Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "h2, p, ul, pre",
        ),
      )
    : [];
  const timeline = gsap.timeline({ defaults: { overwrite: "auto" } });
  if (prefersReducedMotion()) {
    timeline.set([root, ...(dialog ? [dialog] : []), ...content], {
      clearProps: "transform",
    });
    return timeline;
  }
  if (dialog) {
    timeline.fromTo(
      dialog,
      { y: 18, scale: 0.9 },
      {
        y: 0,
        scale: 1,
        duration: MOTION.dialog.duration,
        ease: "back.out(1.35)",
        clearProps: "transform",
      },
    );
  }
  if (content.length > 0) {
    timeline.fromTo(
      content,
      { y: 8 },
      {
        y: 0,
        duration: 0.2,
        ease: MOTION.easing,
        stagger: MOTION.list.stagger,
        clearProps: "transform",
      },
      "-=0.16",
    );
  }
  return timeline;
};

export const animateListIntro = (
  root: HTMLElement,
  selector = "[data-motion-item]",
): gsap.core.Timeline => {
  const items = Array.from(root.querySelectorAll<HTMLElement>(selector)).slice(
    0,
    MAX_LIST_MOTION_TARGETS,
  ).filter((item) => {
    const active = document.activeElement;
    return (
      item.getAttribute("aria-selected") !== "true" &&
      item !== active &&
      !item.contains(active)
    );
  });
  const timeline = gsap.timeline({ defaults: { overwrite: "auto" } });
  if (prefersReducedMotion()) {
    timeline.set(items, { clearProps: "transform" });
    return timeline;
  }
  if (items.length > 0) {
    timeline.fromTo(
      items,
      { x: -12 },
      {
        x: 0,
        duration: 0.24,
        ease: "back.out(1.15)",
        stagger: MOTION.list.stagger,
        clearProps: "transform",
      },
    );
  }
  return timeline;
};

/**
 * Attaches elastic scale hover tweens to every enabled button under `root`.
 * CSS keeps ownership of background/color transitions; GSAP only animates
 * `transform`, so the two never fight over the same property.
 * Returns a cleanup that removes the listeners and clears any in-flight
 * transform. Skipped entirely when the user prefers reduced motion.
 */
export const bindButtonHoverMotion = (
  root: HTMLElement,
  selector = "button:not(:disabled)",
): (() => void) => {
  if (prefersReducedMotion()) return () => {};
  const cleanups: Array<() => void> = [];
  root.querySelectorAll<HTMLElement>(selector).forEach((button) => {
    const onEnter = () => {
      gsap.to(button, {
        scale: MOTION.hover.scale,
        duration: MOTION.hover.enter.duration,
        ease: MOTION.hover.enter.ease,
        overwrite: "auto",
      });
    };
    const onLeave = () => {
      gsap.to(button, {
        scale: 1,
        duration: MOTION.hover.exit.duration,
        ease: MOTION.hover.exit.ease,
        overwrite: "auto",
        clearProps: "transform",
      });
    };
    button.addEventListener("pointerenter", onEnter);
    button.addEventListener("pointerleave", onLeave);
    cleanups.push(() => {
      button.removeEventListener("pointerenter", onEnter);
      button.removeEventListener("pointerleave", onLeave);
      gsap.killTweensOf(button);
      gsap.set(button, { clearProps: "transform" });
    });
  });
  return () => {
    cleanups.forEach((cleanup) => cleanup());
  };
};

/**
 * Panel toggle icons (PanelLeftIcon / PanelRightIcon) draw a divider line
 * that splits the glyph into a narrow "panel" block and the content area.
 * The divider always rests at `base` so the small block stays legible; the
 * collapsed state is shown by filling that block ([data-panel-fill]), and
 * hovering slides the divider a short distance toward the side the toggle
 * would move it, then springs back.
 */
const PANEL_GLYPH = {
  left: { dividerBase: 9, hoverCollapseX: 6, hoverExpandX: 12 },
  right: { dividerBase: 15, hoverCollapseX: 18, hoverExpandX: 12 },
} as const;

const PANEL_FILL_OPACITY = { collapsed: 0.32, expanded: 0 } as const;

export type PanelDividerSide = keyof typeof PANEL_GLYPH;

const panelFillOpacity = (collapsed: boolean): number =>
  collapsed ? PANEL_FILL_OPACITY.collapsed : PANEL_FILL_OPACITY.expanded;

const panelGlyphTargets = (
  button: HTMLElement,
): { divider: Element; fill: Element | null } | null => {
  const divider = button.querySelector("[data-panel-divider]");
  if (!divider) return null;
  return { divider, fill: button.querySelector("[data-panel-fill]") };
};

const tweenPanelGlyph = (
  button: HTMLElement,
  side: PanelDividerSide,
  collapsed: boolean,
  hover: "idle" | "preview",
): void => {
  const targets = panelGlyphTargets(button);
  if (!targets) return;
  const glyph = PANEL_GLYPH[side];
  const dividerX =
    hover === "preview"
      ? collapsed
        ? glyph.hoverCollapseX
        : glyph.hoverExpandX
      : glyph.dividerBase;
  const elastic = hover === "idle";
  const duration = elastic ? MOTION.hover.exit.duration : MOTION.hover.enter.duration;
  const ease = elastic ? MOTION.hover.exit.ease : MOTION.hover.enter.ease;
  gsap.to(targets.divider, {
    attr: { x1: dividerX, x2: dividerX },
    duration,
    ease,
    overwrite: "auto",
  });
  if (targets.fill) {
    gsap.to(targets.fill, {
      opacity: panelFillOpacity(collapsed),
      duration,
      ease,
      overwrite: "auto",
    });
  }
};

/**
 * Rests a panel toggle icon at the position matching the panel's collapsed
 * state: divider back at its base, small block filled while collapsed.
 * Tweened (so clicking the toggle animates the icon too), unless the user
 * prefers reduced motion.
 */
export const setPanelDividerState = (
  button: HTMLElement,
  side: PanelDividerSide,
  collapsed: boolean,
): void => {
  const targets = panelGlyphTargets(button);
  if (!targets) return;
  if (prefersReducedMotion()) {
    const base = PANEL_GLYPH[side].dividerBase;
    gsap.set(targets.divider, { attr: { x1: base, x2: base } });
    if (targets.fill) {
      gsap.set(targets.fill, { opacity: panelFillOpacity(collapsed) });
    }
    return;
  }
  tweenPanelGlyph(button, side, collapsed, "idle");
};

/**
 * Hovering a panel toggle previews the click inside the icon itself: the
 * divider slides toward the position the toggle would produce and the small
 * block's fill crossfades to the post-click state; both elastically return
 * on leave. `isCollapsed` is read at event time, so callers should pass a
 * getter over live state.
 */
export const bindPanelDividerHover = (
  button: HTMLElement,
  side: PanelDividerSide,
  isCollapsed: () => boolean,
): (() => void) => {
  if (prefersReducedMotion()) return () => {};
  if (!panelGlyphTargets(button)) return () => {};
  const onEnter = () => tweenPanelGlyph(button, side, !isCollapsed(), "preview");
  const onLeave = () => tweenPanelGlyph(button, side, isCollapsed(), "idle");
  button.addEventListener("pointerenter", onEnter);
  button.addEventListener("pointerleave", onLeave);
  return () => {
    button.removeEventListener("pointerenter", onEnter);
    button.removeEventListener("pointerleave", onLeave);
    const targets = panelGlyphTargets(button);
    if (targets) {
      gsap.killTweensOf(targets.divider);
      if (targets.fill) gsap.killTweensOf(targets.fill);
    }
  };
};

/**
 * Hovering a collapse/expand-all toggle spreads its two chevrons apart —
 * top one drifts up, bottom one drifts down — then springs them back on
 * leave. Works on any icon whose paths carry data-chevron="top"/"bottom".
 */
export const bindChevronSpreadHover = (button: HTMLElement): (() => void) => {
  if (prefersReducedMotion()) return () => {};
  const top = button.querySelector('[data-chevron="top"]');
  const bottom = button.querySelector('[data-chevron="bottom"]');
  if (!top || !bottom) return () => {};
  const onEnter = () => {
    if (button instanceof HTMLButtonElement && button.disabled) return;
    gsap.to(top, {
      y: -2,
      duration: MOTION.hover.enter.duration,
      ease: MOTION.hover.enter.ease,
      overwrite: "auto",
    });
    gsap.to(bottom, {
      y: 2,
      duration: MOTION.hover.enter.duration,
      ease: MOTION.hover.enter.ease,
      overwrite: "auto",
    });
  };
  const onLeave = () => {
    // Single-target tweens only: killTweensOf cannot reliably find tweens
    // whose target list is an array, and cleanup must be able to kill these.
    [top, bottom].forEach((chevron) => {
      gsap.to(chevron, {
        y: 0,
        duration: MOTION.hover.exit.duration,
        ease: MOTION.hover.exit.ease,
        overwrite: "auto",
        clearProps: "transform",
      });
    });
  };
  button.addEventListener("pointerenter", onEnter);
  button.addEventListener("pointerleave", onLeave);
  return () => {
    button.removeEventListener("pointerenter", onEnter);
    button.removeEventListener("pointerleave", onLeave);
    // Kill per target: killTweensOf with an array misses tweens that were
    // created against a single element of that array.
    gsap.killTweensOf(top);
    gsap.killTweensOf(bottom);
    gsap.set([top, bottom], { clearProps: "transform" });
  };
};

/**
 * Hover animation for the reading/editing view-mode toggle. The icon is
 * queried at event time because the button swaps glyphs when the mode
 * changes: the book tilts open (3D flip around its spine) and the pencil
 * dips down-right as if starting to write; both elastically return on
 * leave. Skipped when the user prefers reduced motion.
 */
export const bindViewModeHover = (button: HTMLElement): (() => void) => {
  if (prefersReducedMotion()) return () => {};
  const icon = () => button.querySelector("[data-view-icon]");
  if (!icon()) return () => {};
  const onEnter = () => {
    const target = icon();
    if (!target) return;
    if (target.getAttribute("data-view-icon") === "book") {
      gsap.to(target, {
        rotationY: -24,
        transformPerspective: 240,
        transformOrigin: "left center",
        duration: MOTION.hover.enter.duration,
        ease: MOTION.hover.enter.ease,
        overwrite: "auto",
      });
    } else {
      gsap.to(target, {
        x: 2,
        y: 1,
        rotation: -6,
        duration: MOTION.hover.enter.duration,
        ease: MOTION.hover.enter.ease,
        overwrite: "auto",
      });
    }
  };
  const onLeave = () => {
    const target = icon();
    if (!target) return;
    gsap.to(target, {
      x: 0,
      y: 0,
      rotation: 0,
      rotationY: 0,
      duration: MOTION.hover.exit.duration,
      ease: MOTION.hover.exit.ease,
      overwrite: "auto",
      clearProps: "transform",
    });
  };
  button.addEventListener("pointerenter", onEnter);
  button.addEventListener("pointerleave", onLeave);
  return () => {
    button.removeEventListener("pointerenter", onEnter);
    button.removeEventListener("pointerleave", onLeave);
    const target = icon();
    if (target) {
      gsap.killTweensOf(target);
      gsap.set(target, { clearProps: "transform" });
    }
  };
};
