import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { PersistedSession } from "../document/types";
import { DEFAULT_EDITOR_PREFERENCES } from "../theme/preferences";
import AppShell from "./AppShell";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});

describe("settings: theme and editor preferences", () => {
  it("applies a persisted theme from the session on startup", async () => {
    const port = new MemoryDocumentPort(new Map(), {
      session: {
        recent: [],
        openPaths: [],
        activePath: null,
        workspacePath: null,
        theme: "light",
      },
    });
    render(<AppShell port={port} />);

    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("light"),
    );
  });

  it("defaults to dark without a persisted preference", async () => {
    render(<AppShell port={new MemoryDocumentPort(new Map())} />);
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );
  });

  it("applies the persisted theme in a single flip after the session resolves", async () => {
    // The persisted theme arrives asynchronously, so the first paint is the
    // dark default; once loadSession resolves, useTheme swaps data-theme in
    // a layout effect (before the next paint) — one full flip, no
    // progressive re-theming.
    const port = new MemoryDocumentPort(new Map());
    let resolveSession!: (session: PersistedSession | null) => void;
    vi.spyOn(port, "loadSession").mockImplementation(
      () =>
        new Promise<PersistedSession | null>((resolve) => {
          resolveSession = resolve;
        }),
    );
    render(<AppShell port={port} />);
    expect(document.documentElement.dataset.theme).toBe("dark");

    await act(async () => {
      resolveSession({
        recent: [],
        openPaths: [],
        activePath: null,
        workspacePath: null,
        theme: "light",
      });
    });

    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("applies persisted editor preferences as root CSS custom properties", async () => {
    const port = new MemoryDocumentPort(new Map(), {
      session: {
        recent: [],
        openPaths: [],
        activePath: null,
        workspacePath: null,
        editorPreferences: {
          bodySizePx: 20,
          lineHeight: 2,
          contentWidthPx: 900,
          fontFamily: "serif",
        },
      },
    });
    render(<AppShell port={port} />);

    await waitFor(() => {
      const style = document.documentElement.style;
      expect(style.getPropertyValue("--editor-body-size")).toBe("20px");
      expect(style.getPropertyValue("--editor-line-height")).toBe("2");
      expect(style.getPropertyValue("--editor-content-width")).toBe("900px");
    });
  });

  it("falls back to defaults for invalid persisted values", async () => {
    const port = new MemoryDocumentPort(new Map(), {
      session: {
        recent: [],
        openPaths: [],
        activePath: null,
        workspacePath: null,
        theme: "solarized" as never,
        editorPreferences: {
          bodySizePx: 99,
          lineHeight: 0.1,
          contentWidthPx: 10,
          fontFamily: "",
        },
      },
    });
    render(<AppShell port={port} />);

    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--editor-body-size")).toBe(
      `${DEFAULT_EDITOR_PREFERENCES.bodySizePx}px`,
    );
    expect(style.getPropertyValue("--editor-content-width")).toBe(
      `${DEFAULT_EDITOR_PREFERENCES.contentWidthPx}px`,
    );
  });

  it("persists theme changes through the session store", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    await user.selectOptions(within(dialog).getByLabelText("主题"), "light");

    expect(document.documentElement.dataset.theme).toBe("light");
    await waitFor(() => expect(port.session?.theme).toBe("light"));
  });

  it("persists editor preference changes through the session store", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    const bodySize = within(dialog).getByLabelText("正文字号");
    fireEvent.change(bodySize, { target: { value: "20" } });
    fireEvent.blur(bodySize);

    await waitFor(() =>
      expect(port.session?.editorPreferences?.bodySizePx).toBe(20),
    );
    expect(document.documentElement.style.getPropertyValue("--editor-body-size"))
      .toBe("20px");
  });

  it("lets the user type a multi-digit size without mid-typing clamping", async () => {
    // Regression: committing (and clamping) on every keystroke turned typing
    // "18" into 13→138→24. The draft must survive until blur/Enter.
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    const bodySize = within(dialog).getByLabelText("正文字号");
    await user.clear(bodySize);
    await user.type(bodySize, "18");
    // Nothing committed yet: the field shows the raw draft.
    expect(bodySize).toHaveValue(18);
    expect(port.session?.editorPreferences?.bodySizePx ?? 16).toBe(16);

    await user.tab();
    await waitFor(() =>
      expect(port.session?.editorPreferences?.bodySizePx).toBe(18),
    );
    expect(bodySize).toHaveValue(18);
  });

  it("commits a number field on Enter", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    const width = within(dialog).getByLabelText("内容宽度");
    await user.clear(width);
    await user.type(width, "640");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(port.session?.editorPreferences?.contentWidthPx).toBe(640),
    );
    expect(width).toHaveValue(640);
  });

  it("snaps an invalid draft back to the committed value on blur", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    const bodySize = within(dialog).getByLabelText("正文字号");
    await user.clear(bodySize);
    await user.tab();

    expect(bodySize).toHaveValue(16);
  });

  it("clamps out-of-range edits instead of persisting them", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    const bodySize = within(dialog).getByLabelText("正文字号");
    fireEvent.change(bodySize, { target: { value: "99" } });
    fireEvent.blur(bodySize);

    await waitFor(() =>
      expect(port.session?.editorPreferences?.bodySizePx).toBe(24),
    );
    expect(bodySize).toHaveValue(24);
  });

  it("stores a custom font name chosen in the dialog", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    await user.selectOptions(within(dialog).getByLabelText("字体"), "custom");
    fireEvent.change(within(dialog).getByLabelText("自定义字体"), {
      target: { value: "LXGW WenKai" },
    });

    await waitFor(() =>
      expect(port.session?.editorPreferences?.fontFamily).toBe("LXGW WenKai"),
    );
    expect(
      document.documentElement.style.getPropertyValue("--editor-body-font"),
    ).toContain("LXGW WenKai");
  });
});

describe("settings: installed font enumeration", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    tauriMocks.invoke.mockReset();
  });

  it("falls back to a plain text input outside the Tauri webview", async () => {
    // jsdom has no `__TAURI_INTERNALS__`, so the dialog must never call the
    // native command and keeps the manual-entry input.
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    await user.selectOptions(within(dialog).getByLabelText("字体"), "custom");

    const input = within(dialog).getByLabelText("自定义字体");
    expect(input).not.toHaveAttribute("list");
    expect(document.getElementById("settings-font-datalist")).toBeNull();
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("lists installed fonts in a searchable datalist inside the webview", async () => {
    // Out of order on purpose: the dialog must sort the names for display.
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "list_installed_fonts") {
        return Promise.resolve(["Songti SC", "PingFang SC", "LXGW WenKai"]);
      }
      return Promise.reject(new Error(`unmocked command: ${command}`));
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });

    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    await user.selectOptions(within(dialog).getByLabelText("字体"), "custom");

    const input = within(dialog).getByLabelText("自定义字体");
    await waitFor(() =>
      expect(input).toHaveAttribute("list", "settings-font-datalist"),
    );
    expect(tauriMocks.invoke).toHaveBeenCalledWith("list_installed_fonts");

    const datalist = document.getElementById("settings-font-datalist");
    expect(datalist).not.toBeNull();
    const options = Array.from(datalist!.querySelectorAll("option"));
    expect(options.map((option) => option.getAttribute("value"))).toEqual([
      "LXGW WenKai",
      "PingFang SC",
      "Songti SC",
    ]);

    // jsdom has no datalist picker, so a choice is entered as text; the
    // single change event also avoids the keystroke-by-keystroke race
    // between userEvent and React's controlled-value commits.
    fireEvent.change(input, { target: { value: "LXGW WenKai" } });
    await waitFor(() =>
      expect(port.session?.editorPreferences?.fontFamily).toBe("LXGW WenKai"),
    );
  });
});
