import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import { DEFAULT_EDITOR_PREFERENCES } from "../theme/preferences";
import AppShell from "./AppShell";

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

    await waitFor(() =>
      expect(port.session?.editorPreferences?.bodySizePx).toBe(20),
    );
    expect(document.documentElement.style.getPropertyValue("--editor-body-size"))
      .toBe("20px");
  });

  it("clamps out-of-range edits instead of persisting them", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    const bodySize = within(dialog).getByLabelText("正文字号");
    fireEvent.change(bodySize, { target: { value: "99" } });

    await waitFor(() =>
      expect(port.session?.editorPreferences?.bodySizePx).toBe(24),
    );
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
