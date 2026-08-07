import { describe, expect, it } from "vitest";
import {
  collectEditorMotionTargets,
  EDITOR_MOTION_SELECTOR,
  playEditorIntro,
} from "./editorMotion";

describe("editor motion targets", () => {
  it("collects visible editor targets in DOM order and caps them", () => {
    const host = document.createElement("div");
    host.innerHTML = Array.from(
      { length: 20 },
      (_, index) => `<div class="cm-line">line ${index}</div>`,
    ).join("");

    expect(EDITOR_MOTION_SELECTOR).toContain(".cm-line");
    const targets = collectEditorMotionTargets(host, "full");

    expect(targets).toHaveLength(16);
    expect(targets[0]?.textContent).toBe("line 0");
    expect(targets.at(-1)?.textContent).toBe("line 15");
  });

  it("skips content targets in light performance mode", () => {
    const host = document.createElement("div");
    host.innerHTML = '<div class="cm-line">line</div><span class="katex">x</span>';

    expect(collectEditorMotionTargets(host, "light")).toEqual([]);
  });

  it("keeps the editor host visible to interaction during its intro", () => {
    const host = document.createElement("div");
    host.innerHTML = '<div class="cm-line">line</div>';

    const timeline = playEditorIntro(host, "full");

    expect(host.style.visibility).not.toBe("hidden");
    timeline.kill();
  });

  it("does not transform editable CodeMirror content", () => {
    const host = document.createElement("div");
    host.innerHTML = '<div class="cm-line">line</div>';

    const timeline = playEditorIntro(host, "full", "editing");

    expect(host.querySelector<HTMLElement>(".cm-line")?.style.transform).toBe("");
    timeline.kill();
  });
});
