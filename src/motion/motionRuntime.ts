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

const revealTargets = (timeline: gsap.core.Timeline, targets: Element[]) => {
  if (targets.length === 0) return;
  timeline.set(targets, { autoAlpha: 1, clearProps: "transform,visibility" });
};

export const animatePanelIntro = (root: HTMLElement): gsap.core.Timeline => {
  const timeline = gsap.timeline({ defaults: { overwrite: "auto" } });
  if (prefersReducedMotion()) {
    timeline.set(root, { autoAlpha: 1, clearProps: "transform,visibility" });
    return timeline;
  }
  timeline.fromTo(
    root,
    { autoAlpha: 0, y: 10, scale: 0.985 },
    {
      autoAlpha: 1,
      y: 0,
      scale: 1,
      duration: MOTION.panel.duration,
      ease: MOTION.easing,
      clearProps: "transform,visibility",
    },
  );
  return timeline;
};

export const animateDialogIntro = (root: HTMLElement): gsap.core.Timeline => {
  const dialog = root.querySelector<HTMLElement>('[role="dialog"]');
  const content = dialog
    ? Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "h2, p, .dialog-actions > *, > button, > ul, > pre",
        ),
      )
    : [];
  const timeline = gsap.timeline({ defaults: { overwrite: "auto" } });
  if (prefersReducedMotion()) {
    revealTargets(timeline, [root, ...(dialog ? [dialog] : []), ...content]);
    return timeline;
  }
  timeline.fromTo(
    root,
    { autoAlpha: 0 },
    { autoAlpha: 1, duration: 0.16, ease: "power1.out" },
  );
  if (dialog) {
    timeline.fromTo(
      dialog,
      { autoAlpha: 0, y: 18, scale: 0.9 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: MOTION.dialog.duration,
        ease: "back.out(1.35)",
        clearProps: "transform,visibility",
      },
      "<",
    );
  }
  if (content.length > 0) {
    timeline.fromTo(
      content,
      { autoAlpha: 0, y: 8 },
      {
        autoAlpha: 1,
        y: 0,
        duration: 0.2,
        ease: MOTION.easing,
        stagger: MOTION.list.stagger,
        clearProps: "transform,visibility",
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
  );
  const timeline = gsap.timeline({ defaults: { overwrite: "auto" } });
  if (prefersReducedMotion()) {
    revealTargets(timeline, items);
    return timeline;
  }
  if (items.length > 0) {
    timeline.fromTo(
      items,
      { autoAlpha: 0, x: -12 },
      {
        autoAlpha: 1,
        x: 0,
        duration: 0.24,
        ease: "back.out(1.15)",
        stagger: MOTION.list.stagger,
        clearProps: "transform,visibility",
      },
    );
  }
  return timeline;
};
