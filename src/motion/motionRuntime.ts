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
