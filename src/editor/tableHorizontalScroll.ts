export interface TableHorizontalScrollController {
  readonly sync: () => void;
  readonly destroy: () => void;
}

export const attachTableHorizontalScroll = (
  scroll: HTMLElement,
  slider: HTMLInputElement,
): TableHorizontalScrollController => {
  let destroyed = false;

  const sync = () => {
    if (destroyed) return;
    const maximum = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
    const value = Math.min(maximum, Math.max(0, scroll.scrollLeft));
    slider.max = String(maximum);
    slider.value = String(value);
    slider.hidden = maximum === 0;
    if (scroll.scrollLeft !== value) scroll.scrollLeft = value;
  };
  const onInput = () => {
    scroll.scrollLeft = Number(slider.value);
    sync();
  };

  slider.addEventListener("input", onInput);
  scroll.addEventListener("scroll", sync, { passive: true });
  const observer = typeof ResizeObserver === "function"
    ? new ResizeObserver(sync)
    : null;
  observer?.observe(scroll);
  if (scroll.firstElementChild) observer?.observe(scroll.firstElementChild);
  sync();

  return {
    sync,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      observer?.disconnect();
      slider.removeEventListener("input", onInput);
      scroll.removeEventListener("scroll", sync);
    },
  };
};
