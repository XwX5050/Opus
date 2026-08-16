import { act, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EDITOR_PREFERENCES } from "./preferences";
import { useTheme } from "./useTheme";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));

type MediaListener = (event: { matches: boolean }) => void;

class MockMediaQueryList {
  readonly media: string;
  matches: boolean;
  #listeners = new Set<MediaListener>();

  constructor(query: string, matches: boolean) {
    this.media = query;
    this.matches = matches;
  }

  addEventListener(_type: string, listener: MediaListener) {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: string, listener: MediaListener) {
    this.#listeners.delete(listener);
  }

  setMatches(matches: boolean) {
    this.matches = matches;
    for (const listener of [...this.#listeners]) listener({ matches });
  }
}

const queries = new Map<string, MockMediaQueryList>();

const installMatchMedia = (systemDark: boolean, reducedMotion: boolean) => {
  queries.clear();
  queries.set(
    "(prefers-color-scheme: dark)",
    new MockMediaQueryList("(prefers-color-scheme: dark)", systemDark),
  );
  queries.set(
    "(prefers-reduced-motion: reduce)",
    new MockMediaQueryList("(prefers-reduced-motion: reduce)", reducedMotion),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const existing = queries.get(query);
      if (existing) return existing;
      const created = new MockMediaQueryList(query, false);
      queries.set(query, created);
      return created;
    }),
  );
};

const systemQuery = () => queries.get("(prefers-color-scheme: dark)")!;

const Probe = ({
  preference,
  editorPreferences = DEFAULT_EDITOR_PREFERENCES,
}: {
  preference: "system" | "light" | "dark";
  editorPreferences?: typeof DEFAULT_EDITOR_PREFERENCES;
}) => {
  const resolved = useTheme(preference, editorPreferences);
  return createElement("output", { "data-testid": "resolved" }, resolved);
};

const renderProbe = (
  preference: "system" | "light" | "dark",
  editorPreferences?: typeof DEFAULT_EDITOR_PREFERENCES,
) => render(createElement(Probe, { preference, editorPreferences }));

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  tauriMocks.invoke.mockReset();
  tauriMocks.invoke.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTheme", () => {
  it("resolves an explicit dark preference without consulting the system", () => {
    installMatchMedia(false, false);
    const { getByTestId } = renderProbe("dark");
    expect(getByTestId("resolved").textContent).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("resolves an explicit light preference without consulting the system", () => {
    installMatchMedia(true, false);
    const { getByTestId } = renderProbe("light");
    expect(getByTestId("resolved").textContent).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("follows the system color scheme when set to system", () => {
    installMatchMedia(true, false);
    const darkSystem = renderProbe("system");
    expect(darkSystem.getByTestId("resolved").textContent).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    darkSystem.unmount();

    installMatchMedia(false, false);
    const lightSystem = renderProbe("system");
    expect(lightSystem.getByTestId("resolved").textContent).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("reacts to system media-query changes", () => {
    installMatchMedia(true, false);
    const { getByTestId } = renderProbe("system");
    expect(document.documentElement.dataset.theme).toBe("dark");

    act(() => systemQuery().setMatches(false));

    expect(getByTestId("resolved").textContent).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("ignores system changes while an explicit theme is chosen", () => {
    installMatchMedia(true, false);
    const { getByTestId } = renderProbe("light");
    act(() => systemQuery().setMatches(false));
    expect(getByTestId("resolved").textContent).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to dark when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { getByTestId } = renderProbe("system");
    expect(getByTestId("resolved").textContent).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("publishes editor preferences as root CSS custom properties", () => {
    installMatchMedia(true, false);
    renderProbe("dark", {
      bodySizePx: 18,
      lineHeight: 1.75,
      contentWidthPx: 840,
      fontFamily: "serif",
    });
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--editor-body-size")).toBe("18px");
    expect(style.getPropertyValue("--editor-line-height")).toBe("1.75");
    expect(style.getPropertyValue("--editor-content-width")).toBe("840px");
    expect(style.getPropertyValue("--editor-body-font")).toContain("serif");
  });

  it("updates the CSS custom properties when preferences change", () => {
    installMatchMedia(true, false);
    const { rerender } = renderProbe("dark");
    rerender(
      createElement(Probe, {
        preference: "dark",
        editorPreferences: {
          bodySizePx: 20,
          lineHeight: 1.5,
          contentWidthPx: 640,
          fontFamily: "monospace",
        },
      }),
    );
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--editor-body-size")).toBe("20px");
    expect(style.getPropertyValue("--editor-content-width")).toBe("640px");
  });

  it("syncs the native window background only when the resolved theme changes", () => {
    installMatchMedia(true, false);
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    // `--canvas` normally comes from app.css (not loaded in jsdom); pin a
    // value so the background-sync IPC is observable.
    document.documentElement.style.setProperty("--canvas", "#101014");

    const { rerender } = renderProbe("dark");
    expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
    expect(tauriMocks.invoke).toHaveBeenCalledWith("set_window_background", {
      color: "#101014",
    });

    // An editor-preferences-only change must not trigger the sync.
    rerender(
      createElement(Probe, {
        preference: "dark",
        editorPreferences: {
          bodySizePx: 20,
          lineHeight: 1.5,
          contentWidthPx: 640,
          fontFamily: "monospace",
        },
      }),
    );
    expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);

    // A resolved-theme change re-syncs.
    rerender(createElement(Probe, { preference: "light" }));
    expect(tauriMocks.invoke).toHaveBeenCalledTimes(2);
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith(
      "set_window_background",
      { color: "#101014" },
    );
  });
});
