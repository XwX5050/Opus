import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PresentationOverlay from "./PresentationOverlay";

const renderOverlay = (
  overrides: Partial<React.ComponentProps<typeof PresentationOverlay>> = {},
) => {
  const props = {
    markdown: "",
    documentPath: "/notes/deck.md",
    resolveImageUrl: (path: string) => `asset://localhost${path}`,
    onExit: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<PresentationOverlay {...props} />) };
};

const overlayRoot = (container: HTMLElement) => {
  const root = container.querySelector(".presentation-overlay");
  if (!root) throw new Error("PresentationOverlay not mounted");
  return root;
};

const slideText = (container: HTMLElement) => {
  const content = container.querySelector(
    ".presentation-slide-host .cm-content",
  );
  return content?.textContent ?? "";
};

const counterOf = (container: HTMLElement) =>
  container.querySelector(".presentation-counter")?.textContent ?? "";

/** Dispatches a bubbling, cancelable keydown through React and returns it. */
const dispatchKey = (
  root: Element,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    root.dispatchEvent(event);
  });
  return event;
};

/** Dispatches a bubbling, cancelable wheel event and returns it. */
const dispatchWheel = (root: Element, deltaY: number): WheelEvent => {
  const event = new WheelEvent("wheel", {
    deltaY,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    root.dispatchEvent(event);
  });
  return event;
};

/** Eight-line paragraph block; ~289px at the jsdom presentation font. */
const paragraphBlock = (n: number) =>
  Array.from({ length: 8 }, (_, line) => `Paragraph ${n} line ${line}`).join(
    "\n",
  );

describe("PresentationOverlay", () => {
  it("follows manual `---` slide separators and advances forward on click", async () => {
    const onExit = vi.fn();
    const rendered = renderOverlay({
      markdown: "Slide one\n\n---\n\nSlide two",
      onExit,
    });

    expect(counterOf(rendered.container)).toBe("1 / 2");

    const root = overlayRoot(rendered.container);
    await waitFor(() =>
      expect(slideText(rendered.container)).toContain("Slide one"),
    );

    fireEvent.click(root);
    expect(counterOf(rendered.container)).toBe("2 / 2");
    await waitFor(() =>
      expect(slideText(rendered.container)).toContain("Slide two"),
    );

    // Clicking the last slide neither advances nor exits — leaving the deck
    // is reserved for Escape and the exit button.
    fireEvent.click(root);
    expect(counterOf(rendered.container)).toBe("2 / 2");
    expect(root.classList.contains("presentation-overlay--exiting")).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("calls onExit when Escape is pressed", async () => {
    const onExit = vi.fn();
    const rendered = renderOverlay({
      markdown: "First\n\n---\n\nSecond",
      onExit,
    });

    fireEvent.keyDown(overlayRoot(rendered.container), { key: "Escape" });
    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
  });

  it("paginates documents without separators via the auto path and stops on the last slide", async () => {
    const onExit = vi.fn();
    // jsdom has no layout, so the line-count heuristic fallback paginates:
    // each 8-line paragraph measures ~36px per line at the presentation
    // font, fitting two paragraphs per usable-height slide.
    const paragraph = (n: number) =>
      Array.from({ length: 8 }, (_, line) => `Paragraph ${n} line ${line}`).join(
        "\n",
      );
    const markdown = Array.from({ length: 24 }, (_, i) => paragraph(i)).join(
      "\n\n",
    );
    const rendered = renderOverlay({ markdown, onExit });

    expect(counterOf(rendered.container)).toBe("1 / 12");
    await waitFor(() =>
      expect(slideText(rendered.container)).toContain("Paragraph 0 line 0"),
    );

    const root = overlayRoot(rendered.container);
    for (let click = 0; click < 11; click++) {
      fireEvent.click(root);
    }
    expect(counterOf(rendered.container)).toBe("12 / 12");

    // The last slide ignores further clicks: no advance, no exit.
    fireEvent.click(root);
    expect(counterOf(rendered.container)).toBe("12 / 12");
    expect(root.classList.contains("presentation-overlay--exiting")).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("paginates an over-tall manual `---` section while short sections stay single slides", async () => {
    const markdown =
      "Intro\n\n---\n\n" +
      Array.from({ length: 24 }, (_, i) => paragraphBlock(i)).join("\n\n") +
      "\n\n---\n\nOutro";
    const rendered = renderOverlay({ markdown });
    const root = overlayRoot(rendered.container);

    // The tall middle section's 24 paragraph blocks pack two per slide under
    // the jsdom heuristic (12 slides); the short sections keep one slide each.
    expect(counterOf(rendered.container)).toBe("1 / 14");

    // A slide never crosses a `---` boundary: each holds exactly one section.
    for (let index = 0; index < 14; index++) {
      if (index === 0) {
        await waitFor(() =>
          expect(slideText(rendered.container)).toContain("Intro"),
        );
      } else if (index === 13) {
        await waitFor(() =>
          expect(slideText(rendered.container)).toContain("Outro"),
        );
      } else {
        await waitFor(() =>
          expect(slideText(rendered.container)).toContain(
            `Paragraph ${2 * (index - 1)} line 0`,
          ),
        );
      }
      const text = slideText(rendered.container);
      const sectionCount =
        (text.includes("Intro") ? 1 : 0) +
        (text.includes("Outro") ? 1 : 0) +
        (text.includes("Paragraph ") ? 1 : 0);
      expect(sectionCount, `slide ${index + 1}`).toBe(1);
      fireEvent.click(root);
    }
  });

  it("paginates a leading over-tall manual section before a short one", async () => {
    const markdown =
      Array.from({ length: 24 }, (_, i) => paragraphBlock(i)).join("\n\n") +
      "\n\n---\n\nTail";
    const rendered = renderOverlay({ markdown });
    const root = overlayRoot(rendered.container);

    expect(counterOf(rendered.container)).toBe("1 / 13");

    for (let index = 0; index < 13; index++) {
      if (index === 12) {
        await waitFor(() =>
          expect(slideText(rendered.container)).toContain("Tail"),
        );
        expect(slideText(rendered.container)).not.toContain("Paragraph");
      } else {
        await waitFor(() =>
          expect(slideText(rendered.container)).toContain(
            `Paragraph ${2 * index} line 0`,
          ),
        );
        expect(slideText(rendered.container)).not.toContain("Tail");
      }
      fireEvent.click(root);
    }
  });

  it("navigates with arrow keys and clamps at the boundaries", () => {
    const markdown = ["One", "Two", "Three", "Four"]
      .map((label) => `${label} slide`)
      .join("\n\n---\n\n");
    const rendered = renderOverlay({ markdown });
    const root = overlayRoot(rendered.container);
    const counter = () => counterOf(rendered.container);

    expect(counter()).toBe("1 / 4");

    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(counter()).toBe("2 / 4");

    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(counter()).toBe("3 / 4");

    fireEvent.keyDown(root, { key: "ArrowLeft" });
    expect(counter()).toBe("2 / 4");

    fireEvent.keyDown(root, { key: "ArrowUp" });
    expect(counter()).toBe("1 / 4");

    // Boundary no-ops: neither the first nor the last slide wraps around.
    fireEvent.keyDown(root, { key: "ArrowUp" });
    expect(counter()).toBe("1 / 4");

    fireEvent.keyDown(root, { key: "ArrowRight" });
    fireEvent.keyDown(root, { key: "ArrowRight" });
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(counter()).toBe("4 / 4");

    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(counter()).toBe("4 / 4");
  });

  it("lets Space, PageDown, PageUp, Home, End, and meta shortcuts pass through", () => {
    const markdown = ["One", "Two", "Three", "Four"]
      .map((label) => `${label} slide`)
      .join("\n\n---\n\n");
    const rendered = renderOverlay({ markdown });
    const root = overlayRoot(rendered.container);
    const counter = () => counterOf(rendered.container);

    expect(counter()).toBe("1 / 4");

    // Sanity check that native dispatch reaches the overlay's keydown
    // handler: an arrow key is handled and prevented.
    expect(dispatchKey(root, "ArrowRight").defaultPrevented).toBe(true);
    expect(counter()).toBe("2 / 4");

    // The other keys navigate nothing and are not prevented, so app-level
    // shortcuts like Cmd+S keep working.
    for (const key of [" ", "PageDown", "PageUp", "Home", "End"]) {
      const event = dispatchKey(root, key);
      expect(event.defaultPrevented, `${key} is not prevented`).toBe(false);
      expect(counter(), `${key} does not navigate`).toBe("2 / 4");
    }

    const save = dispatchKey(root, "s", { metaKey: true });
    expect(save.defaultPrevented).toBe(false);
    expect(counter()).toBe("2 / 4");
  });

  it("does not change the slide on wheel input", async () => {
    // One tall paragraph forms a single vertically scrollable slide.
    const rendered = renderOverlay({ markdown: paragraphBlock(0) });
    const root = overlayRoot(rendered.container);
    await waitFor(() =>
      expect(slideText(rendered.container)).toContain("Paragraph 0 line 0"),
    );
    expect(counterOf(rendered.container)).toBe("1 / 1");

    // The wheel is never intercepted, so a scrollable slide scrolls
    // natively; the deck itself stays put in both directions.
    for (const deltaY of [-120, 120, 40, -40]) {
      const event = dispatchWheel(root, deltaY);
      expect(event.defaultPrevented, `deltaY=${deltaY}`).toBe(false);
      expect(counterOf(rendered.container), `deltaY=${deltaY}`).toBe("1 / 1");
    }
  });
});