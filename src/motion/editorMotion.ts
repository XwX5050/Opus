import gsap from "gsap";
import type { PerformanceMode } from "../editor/performanceMode";
import type { EditorViewMode } from "../editor/viewMode";
import {
  MAX_EDITOR_MOTION_TARGETS,
  MOTION,
} from "./motionConfig";
import {
  clampMotionTargets,
  prefersReducedMotion,
} from "./motionRuntime";

export const EDITOR_MOTION_SELECTOR =
  ".cm-line, .md-image-widget, .md-table, .katex";

const WIDGET_MOTION_SELECTOR = ".md-image-widget, .md-table, .katex";

export const collectEditorMotionTargets = (
  host: HTMLElement,
  performanceMode: PerformanceMode,
): HTMLElement[] => {
  if (performanceMode === "light") return [];
  return clampMotionTargets(
    [...host.querySelectorAll<HTMLElement>(EDITOR_MOTION_SELECTOR)],
  );
};

const reveal = (timeline: gsap.core.Timeline, targets: HTMLElement[]) => {
  if (targets.length === 0) return;
  timeline.set(targets, { clearProps: "transform" });
};

export const playEditorIntro = (
  host: HTMLElement,
  performanceMode: PerformanceMode,
  viewMode: EditorViewMode = "editing",
): gsap.core.Timeline => {
  const timeline = gsap.timeline({ defaults: { overwrite: "auto" } });
  if (viewMode === "editing") return timeline;
  if (prefersReducedMotion()) {
    timeline.set(host, { clearProps: "transform" });
    reveal(timeline, collectEditorMotionTargets(host, performanceMode));
    return timeline;
  }
  const targets = collectEditorMotionTargets(host, performanceMode);
  if (targets.length > 0) {
    timeline.fromTo(
      targets,
      { y: 12 },
      {
        y: 0,
        duration: MOTION.content.duration,
        ease: MOTION.easing,
        stagger: MOTION.content.stagger,
        clearProps: "transform",
      },
    );
  }
  return timeline;
};

const widgetTargetsFromMutation = (
  mutation: MutationRecord,
): HTMLElement[] => {
  const targets: HTMLElement[] = [];
  for (const node of mutation.addedNodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.matches(WIDGET_MOTION_SELECTOR)) targets.push(node);
    targets.push(...node.querySelectorAll<HTMLElement>(WIDGET_MOTION_SELECTOR));
  }
  return targets;
};

export const observeEditorWidgets = (
  host: HTMLElement,
  performanceMode: PerformanceMode,
): (() => void) => {
  if (performanceMode === "light") return () => undefined;
  const seen = new WeakSet<HTMLElement>();
  let activeTimeline: gsap.core.Timeline | null = null;
  const observer = new MutationObserver((mutations) => {
    const targets = clampMotionTargets(
      mutations.flatMap(widgetTargetsFromMutation).filter((target) => {
        if (seen.has(target)) return false;
        seen.add(target);
        return true;
      }),
    );
    if (targets.length === 0) return;
    activeTimeline?.kill();
    activeTimeline = gsap.timeline({ defaults: { overwrite: "auto" } });
    if (prefersReducedMotion()) {
      reveal(activeTimeline, targets);
      return;
    }
    activeTimeline.fromTo(
      targets,
      { y: 10, scale: 0.96 },
      {
        y: 0,
        scale: 1,
        duration: 0.24,
        ease: "back.out(1.2)",
        stagger: MOTION.content.stagger,
        clearProps: "transform",
      },
    );
  });
  observer.observe(host, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    activeTimeline?.kill();
    activeTimeline = null;
  };
};

export { MAX_EDITOR_MOTION_TARGETS };
