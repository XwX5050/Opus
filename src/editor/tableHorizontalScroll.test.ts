import { afterEach, describe, expect, it, vi } from "vitest";
import { attachTableHorizontalScroll } from "./tableHorizontalScroll";

const widths = (scroll: HTMLElement, scrollWidth: number, clientWidth: number) => {
  Object.defineProperties(scroll, {
    scrollWidth: { configurable: true, value: scrollWidth },
    clientWidth: { configurable: true, value: clientWidth },
  });
};

const setup = (scrollWidth: number, clientWidth: number) => {
  const scroll = document.createElement("div");
  scroll.append(document.createElement("table"));
  const slider = document.createElement("input");
  slider.type = "range";
  document.body.append(scroll, slider);
  widths(scroll, scrollWidth, clientWidth);
  return { scroll, slider };
};

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("attachTableHorizontalScroll", () => {
  it("hides the slider when the table fits", () => {
    const { scroll, slider } = setup(400, 400);

    attachTableHorizontalScroll(scroll, slider);

    expect(slider.hidden).toBe(true);
    expect(slider.max).toBe("0");
    expect(slider.value).toBe("0");
  });

  it("synchronizes slider input and native scrolling in both directions", () => {
    const { scroll, slider } = setup(600, 200);
    attachTableHorizontalScroll(scroll, slider);

    expect(slider.hidden).toBe(false);
    expect(slider.max).toBe("400");
    slider.value = "160";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(scroll.scrollLeft).toBe(160);

    scroll.scrollLeft = 240;
    scroll.dispatchEvent(new Event("scroll"));
    expect(slider.value).toBe("240");
  });

  it("remeasures on demand and clamps a stale scroll position", () => {
    const { scroll, slider } = setup(300, 100);
    const controller = attachTableHorizontalScroll(scroll, slider);
    scroll.scrollLeft = 200;

    widths(scroll, 150, 100);
    controller.sync();

    expect(slider.max).toBe("50");
    expect(slider.value).toBe("50");
    widths(scroll, 100, 100);
    controller.sync();
    expect(slider.hidden).toBe(true);
    expect(slider.value).toBe("0");
  });

  it("disconnects observers and listeners on destroy", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    class Observer {
      constructor(_callback: ResizeObserverCallback) {}
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", Observer);
    const { scroll, slider } = setup(600, 200);
    const controller = attachTableHorizontalScroll(scroll, slider);

    expect(observe).toHaveBeenCalledWith(scroll);
    expect(observe).toHaveBeenCalledWith(scroll.firstElementChild);
    controller.destroy();
    slider.value = "120";
    slider.dispatchEvent(new Event("input", { bubbles: true }));

    expect(disconnect).toHaveBeenCalledOnce();
    expect(scroll.scrollLeft).toBe(0);
  });
});
