import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODE_REEVALUATION_DEBOUNCE_MS,
  useAutomaticPerformanceMode,
} from "./usePerformanceMode";

// In-band fixtures: length ≥ 50,000 UTF-16 units, so only the real
// encode/line scan can decide the mode.
const bandFullText = "ab".repeat(25_000); // 50,000 chars, 1 line → full
const bandLightText = `${bandFullText}${"\n".repeat(50_000)}`; // 50,001 lines → light

describe("useAutomaticPerformanceMode", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("classifies out-of-band documents immediately", () => {
    const small = renderHook(() => useAutomaticPerformanceMode("tab-1", "hello"));
    expect(small.result.current).toBe("full");
    const huge = renderHook(() =>
      useAutomaticPerformanceMode("tab-2", "x".repeat(2 * 1024 * 1024 + 1)),
    );
    expect(huge.result.current).toBe("light");
  });

  it("scans in-band documents synchronously on tab switch (never a full-mode frame)", () => {
    const { result } = renderHook(() =>
      useAutomaticPerformanceMode("tab-1", bandLightText),
    );
    expect(result.current).toBe("light");
  });

  it("defers in-band re-evaluation while typing, then applies it after the debounce", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ text }) => useAutomaticPerformanceMode("tab-1", text),
      { initialProps: { text: bandFullText } },
    );
    expect(result.current).toBe("full");

    // Crossing the line threshold mid-edit keeps the last known mode…
    rerender({ text: bandLightText });
    expect(result.current).toBe("full");
    act(() => vi.advanceTimersByTime(MODE_REEVALUATION_DEBOUNCE_MS - 50));
    expect(result.current).toBe("full");

    // …and flips once typing has paused for the debounce window.
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe("light");
  });

  it("resets the debounce on every in-band keystroke", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ text }) => useAutomaticPerformanceMode("tab-1", text),
      { initialProps: { text: bandFullText } },
    );
    rerender({ text: bandLightText });
    act(() => vi.advanceTimersByTime(MODE_REEVALUATION_DEBOUNCE_MS - 50));
    rerender({ text: `${bandLightText}y` });
    act(() => vi.advanceTimersByTime(MODE_REEVALUATION_DEBOUNCE_MS - 50));
    expect(result.current).toBe("full"); // starved debounce never fired
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe("light");
  });

  it("returns to O(1) classification when an edit leaves the band", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ text }) => useAutomaticPerformanceMode("tab-1", text),
      { initialProps: { text: bandLightText } },
    );
    expect(result.current).toBe("light");
    rerender({ text: "tiny" });
    expect(result.current).toBe("full"); // no debounce wait
  });

  it("evaluates a newly activated tab synchronously even with a stale cache", () => {
    const { result, rerender } = renderHook(
      ({ tabId, text }) => useAutomaticPerformanceMode(tabId, text),
      { initialProps: { tabId: "tab-1", text: bandFullText } },
    );
    expect(result.current).toBe("full");
    rerender({ tabId: "tab-2", text: bandLightText });
    expect(result.current).toBe("light"); // tab switch: synchronous scan
  });
});
