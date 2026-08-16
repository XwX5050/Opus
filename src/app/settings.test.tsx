import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import type { Update } from "@tauri-apps/plugin-updater";
import { check as pluginCheck } from "@tauri-apps/plugin-updater";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { DocumentPort } from "../document/DocumentPort";
import type { PersistedSession } from "../document/types";
import { DEFAULT_EDITOR_PREFERENCES } from "../theme/preferences";
import {
  DEFAULT_TRANSLATION_SETTINGS,
  type TranslationSettings,
} from "../translate/types";
import AppShell from "./AppShell";
import SettingsDialog from "./SettingsDialog";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));

const stubTauriBridge = () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
};

const unstubTauriBridge = () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
};

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
    unstubTauriBridge();
    tauriMocks.invoke.mockReset();
  });

  it("falls back to a plain text input outside the Tauri webview", async () => {
    // jsdom has no `__TAURI_INTERNALS__`, so the dialog must never call the
    // native command and keeps the manual-entry input without a list.
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    await user.selectOptions(within(dialog).getByLabelText("字体"), "custom");

    const input = within(dialog).getByLabelText("自定义字体");
    expect(input).not.toHaveAttribute("list");
    expect(input).not.toHaveAttribute("role");
    await user.type(input, "Ping");
    expect(within(dialog).queryByRole("listbox")).not.toBeInTheDocument();
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("lists installed fonts in a drawn, filterable list inside the webview", async () => {
    // Out of order on purpose: the dialog must sort the names for display.
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "list_installed_fonts") {
        return Promise.resolve(["Songti SC", "PingFang SC", "LXGW WenKai"]);
      }
      return Promise.reject(new Error(`unmocked command: ${command}`));
    });
    stubTauriBridge();

    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    await user.selectOptions(within(dialog).getByLabelText("字体"), "custom");

    const input = within(dialog).getByLabelText("自定义字体");
    expect(tauriMocks.invoke).toHaveBeenCalledWith("list_installed_fonts");
    // The placeholder switches only once the font list is loaded.
    await waitFor(() =>
      expect(input).toHaveAttribute("placeholder", "搜索已安装字体…"),
    );

    // Focusing the field opens the full, sorted list.
    await user.click(input);
    let listbox = within(dialog).getByRole("listbox", { name: "已安装字体" });
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["LXGW WenKai", "PingFang SC", "Songti SC"]);

    // Typing filters in real time.
    await user.type(input, "wen");
    listbox = within(dialog).getByRole("listbox", { name: "已安装字体" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(1);
    expect(
      within(listbox).getByRole("option", { name: "LXGW WenKai" }),
    ).toBeInTheDocument();

    // Choosing the option commits the font and closes the list.
    await user.click(
      within(listbox).getByRole("option", { name: "LXGW WenKai" }),
    );
    await waitFor(() =>
      expect(port.session?.editorPreferences?.fontFamily).toBe("LXGW WenKai"),
    );
    expect(within(dialog).queryByRole("listbox")).not.toBeInTheDocument();
    expect(
      document.documentElement.style.getPropertyValue("--editor-body-font"),
    ).toContain("LXGW WenKai");
  });

  it("navigates the font list with the keyboard and keeps the value editable", async () => {
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "list_installed_fonts") {
        return Promise.resolve(["Songti SC", "PingFang SC", "LXGW WenKai"]);
      }
      return Promise.reject(new Error(`unmocked command: ${command}`));
    });
    stubTauriBridge();

    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    await user.selectOptions(within(dialog).getByLabelText("字体"), "custom");

    const input = within(dialog).getByLabelText("自定义字体");
    await waitFor(() =>
      expect(input).toHaveAttribute("placeholder", "搜索已安装字体…"),
    );
    await user.click(input);
    expect(
      within(dialog).getByRole("listbox", { name: "已安装字体" }),
    ).toBeInTheDocument();

    // ArrowDown highlights the second font; Enter commits it.
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(port.session?.editorPreferences?.fontFamily).toBe("PingFang SC"),
    );
    expect(within(dialog).queryByRole("listbox")).not.toBeInTheDocument();

    // The field stays a plain text input: the picked value is still
    // editable by hand.
    await user.type(input, "x");
    expect(input).toHaveValue("PingFang SCx");
  });

  it("closes the font list with Escape without closing the dialog", async () => {
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "list_installed_fonts") {
        return Promise.resolve(["PingFang SC"]);
      }
      return Promise.reject(new Error(`unmocked command: ${command}`));
    });
    stubTauriBridge();

    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    await user.selectOptions(within(dialog).getByLabelText("字体"), "custom");

    const input = within(dialog).getByLabelText("自定义字体");
    await waitFor(() =>
      expect(input).toHaveAttribute("placeholder", "搜索已安装字体…"),
    );
    await user.click(input);
    expect(
      within(dialog).getByRole("listbox", { name: "已安装字体" }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(within(dialog).queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
  });
});

describe("settings: manual update check", () => {
  beforeEach(() => {
    // The settings dialog probes the native font command on open; give the
    // mock a promise-shaped default so it fails quietly instead of crashing
    // the render when a Tauri bridge is stubbed.
    tauriMocks.invoke.mockImplementation(() =>
      Promise.reject(new Error("unmocked command")),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    unstubTauriBridge();
    tauriMocks.invoke.mockReset();
  });

  it("shows the version and an update entry in the about section", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    expect(within(dialog).getByText(/v\d+\.\d+\.\d+/)).toBeInTheDocument();
    // Presence, not visibility: the rows are mid intro animation.
    expect(
      within(dialog).getByRole("button", { name: "检查更新" }),
    ).toBeInTheDocument();
  });

  it("reports unsupported outside the Tauri updater environment", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    await user.click(
      within(dialog).getByRole("button", { name: "检查更新" }),
    );
    expect(
      within(dialog).getByText("当前环境不支持检查更新"),
    ).toBeInTheDocument();
  });

  it("reports checking then up-to-date on a successful manual check", async () => {
    vi.stubEnv("DEV", false);
    stubTauriBridge();
    let resolveManual!: (update: Update | null) => void;
    let call = 0;
    vi.mocked(pluginCheck).mockImplementation(
      () =>
        new Promise<Update | null>((resolve) => {
          // The first call is the startup check; only the manual check is
          // deferred so the "checking" state can be observed.
          if (call++ === 0) {
            resolve(null);
            return;
          }
          resolveManual = resolve;
        }),
    );

    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    const checkButton = within(dialog).getByRole("button", {
      name: "检查更新",
    });
    await user.click(checkButton);
    expect(checkButton).toBeDisabled();
    expect(within(dialog).getByText("正在检查…")).toBeInTheDocument();

    await act(async () => {
      resolveManual(null);
    });
    await waitFor(() =>
      expect(within(dialog).getByText("当前已是最新版本")).toBeInTheDocument(),
    );
    expect(checkButton).toBeEnabled();
  });

  it("reports a failed manual check", async () => {
    vi.stubEnv("DEV", false);
    stubTauriBridge();
    let call = 0;
    vi.mocked(pluginCheck).mockImplementation(() => {
      // First call is the startup check; the manual check fails.
      call += 1;
      return call === 1
        ? Promise.resolve(null)
        : Promise.reject(new Error("offline"));
    });

    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    await user.click(
      within(dialog).getByRole("button", { name: "检查更新" }),
    );
    await waitFor(() =>
      expect(within(dialog).getByText("检查失败，请稍后重试")).toBeInTheDocument(),
    );
  });

  it("hands a found update to the update dialog after settings closes", async () => {
    vi.stubEnv("DEV", false);
    stubTauriBridge();
    let resolveManual!: (update: Update | null) => void;
    let call = 0;
    vi.mocked(pluginCheck).mockImplementation(
      () =>
        new Promise<Update | null>((resolve) => {
          if (call++ === 0) {
            resolve(null); // startup check: nothing new
            return;
          }
          resolveManual = resolve;
        }),
    );

    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    await user.click(
      within(dialog).getByRole("button", { name: "检查更新" }),
    );
    await act(async () => {
      resolveManual({
        version: "2.0.0",
        downloadAndInstall: vi.fn(async () => {}),
      } as unknown as Update);
    });

    // The update prompt yields to the open settings dialog...
    expect(
      screen.queryByRole("dialog", { name: "发现新版本 v2.0.0" }),
    ).not.toBeInTheDocument();

    // ...and appears once settings closes.
    await user.click(within(dialog).getByRole("button", { name: "完成" }));
    expect(
      await screen.findByRole("dialog", { name: "发现新版本 v2.0.0" }),
    ).toBeVisible();
  });
});

describe("settings: translation", () => {
  const renderTranslationDialog = (
    translationSettings: TranslationSettings = DEFAULT_TRANSLATION_SETTINGS,
    onTranslationSettingsChange = vi.fn(),
    port: DocumentPort = new MemoryDocumentPort(new Map()),
  ) => {
    render(
      <SettingsDialog
        theme="dark"
        editorPreferences={DEFAULT_EDITOR_PREFERENCES}
        onThemeChange={vi.fn()}
        onEditorPreferencesChange={vi.fn()}
        onClose={vi.fn()}
        onCheckForUpdates={vi.fn()}
        updateCheckState="idle"
        translationSettings={translationSettings}
        onTranslationSettingsChange={onTranslationSettingsChange}
        port={port}
      />,
    );
    return {
      dialog: screen.getByRole("dialog", { name: "设置" }),
      onTranslationSettingsChange,
      port,
    };
  };

  /**
   * Renders the dialog with live translation-settings state, mirroring how
   * AppShell owns the setting: the model combobox (like the custom-font
   * field) is controlled live, so typing accumulates, filters the drawn
   * list, and commits through a recording spy.
   */
  const renderLiveTranslationDialog = (
    initialSettings: TranslationSettings = DEFAULT_TRANSLATION_SETTINGS,
    port: DocumentPort = new MemoryDocumentPort(new Map()),
  ) => {
    const onTranslationSettingsChange = vi.fn();
    const Wrapper = () => {
      const [settings, setSettings] = useState(initialSettings);
      return (
        <SettingsDialog
          theme="dark"
          editorPreferences={DEFAULT_EDITOR_PREFERENCES}
          onThemeChange={vi.fn()}
          onEditorPreferencesChange={vi.fn()}
          onClose={vi.fn()}
          onCheckForUpdates={vi.fn()}
          updateCheckState="idle"
          translationSettings={settings}
          onTranslationSettingsChange={(next) => {
            onTranslationSettingsChange(next);
            setSettings(next);
          }}
          port={port}
        />
      );
    };
    render(<Wrapper />);
    return {
      dialog: screen.getByRole("dialog", { name: "设置" }),
      onTranslationSettingsChange,
      port,
    };
  };

  it("renders the translation section between editor and about", () => {
    const { dialog } = renderTranslationDialog();
    expect(
      within(dialog)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["设置", "外观", "编辑器", "翻译", "关于"]);
    expect(within(dialog).getByLabelText("API 端点")).toHaveValue(
      DEFAULT_TRANSLATION_SETTINGS.endpoint,
    );
    const apiKey = within(dialog).getByLabelText("API Key");
    expect(apiKey).toHaveValue(DEFAULT_TRANSLATION_SETTINGS.apiKey);
    expect(apiKey).toHaveAttribute("type", "password");
    expect(apiKey).toHaveAttribute("placeholder", "sk-...");
    expect(within(dialog).getByLabelText("模型")).toHaveValue(
      DEFAULT_TRANSLATION_SETTINGS.model,
    );
    expect(within(dialog).getByLabelText("目标语言")).toHaveValue(
      DEFAULT_TRANSLATION_SETTINGS.targetLanguage,
    );
    expect(
      within(dialog).getByText("翻译结果会缓存在本机，原文不变时不重复调用 API。"),
    ).toBeInTheDocument();
  });

  it("commits endpoint, API key and model edits as settings patches", async () => {
    const user = userEvent.setup();
    const { dialog, onTranslationSettingsChange } =
      renderLiveTranslationDialog();

    const endpoint = within(dialog).getByLabelText("API 端点");
    await user.clear(endpoint);
    await user.type(endpoint, "https://example.com/v1");
    // Nothing commits mid-typing; Enter commits the draft.
    expect(onTranslationSettingsChange).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onTranslationSettingsChange).toHaveBeenLastCalledWith({
      ...DEFAULT_TRANSLATION_SETTINGS,
      endpoint: "https://example.com/v1",
    });

    const apiKey = within(dialog).getByLabelText("API Key");
    await user.type(apiKey, "sk-live-000");
    fireEvent.blur(apiKey);
    expect(onTranslationSettingsChange).toHaveBeenLastCalledWith({
      ...DEFAULT_TRANSLATION_SETTINGS,
      endpoint: "https://example.com/v1",
      apiKey: "sk-live-000",
    });

    // The model combobox commits live (like the custom-font field), so the
    // last patch carries every edit made so far.
    const model = within(dialog).getByLabelText("模型");
    await user.clear(model);
    await user.type(model, "gpt-4o");
    expect(onTranslationSettingsChange).toHaveBeenLastCalledWith({
      ...DEFAULT_TRANSLATION_SETTINGS,
      endpoint: "https://example.com/v1",
      apiKey: "sk-live-000",
      model: "gpt-4o",
    });
  });

  it("commits the selected target language", async () => {
    const user = userEvent.setup();
    const { dialog, onTranslationSettingsChange } = renderTranslationDialog();
    await user.selectOptions(
      within(dialog).getByLabelText("目标语言"),
      "日本語",
    );
    expect(onTranslationSettingsChange).toHaveBeenCalledWith({
      ...DEFAULT_TRANSLATION_SETTINGS,
      targetLanguage: "日本語",
    });
  });

  it("offers the full target-language list", () => {
    const { dialog } = renderTranslationDialog();
    const select = within(dialog).getByLabelText("目标语言");
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "中文",
      "English",
      "日本語",
      "한국어",
      "Français",
      "Deutsch",
      "Español",
      "Русский",
    ]);
  });

  it("shows persisted settings and keeps untouched fields in patches", async () => {
    const user = userEvent.setup();
    const persisted: TranslationSettings = {
      endpoint: "https://custom.example.com/v1",
      apiKey: "sk-persisted",
      model: "custom-model",
      targetLanguage: "Français",
    };
    const { dialog, onTranslationSettingsChange } =
      renderLiveTranslationDialog(persisted);

    expect(within(dialog).getByLabelText("API 端点")).toHaveValue(
      persisted.endpoint,
    );
    expect(within(dialog).getByLabelText("API Key")).toHaveValue(
      persisted.apiKey,
    );
    expect(within(dialog).getByLabelText("模型")).toHaveValue(persisted.model);
    expect(within(dialog).getByLabelText("目标语言")).toHaveValue(
      persisted.targetLanguage,
    );

    const model = within(dialog).getByLabelText("模型");
    await user.clear(model);
    await user.type(model, "new-model");
    expect(onTranslationSettingsChange).toHaveBeenCalledWith({
      ...persisted,
      model: "new-model",
    });
  });

  it("renders the model fetch and connection buttons", () => {
    const { dialog } = renderTranslationDialog();
    expect(
      within(dialog).getByRole("button", { name: "获取模型列表" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "测试连接" }),
    ).toBeInTheDocument();
  });

  it("disables the translation buttons without a port", () => {
    // Both actions need the app's DocumentPort; without it the buttons stay
    // disabled so a click never silently no-ops.
    render(
      <SettingsDialog
        theme="dark"
        editorPreferences={DEFAULT_EDITOR_PREFERENCES}
        onThemeChange={vi.fn()}
        onEditorPreferencesChange={vi.fn()}
        onClose={vi.fn()}
        onCheckForUpdates={vi.fn()}
        updateCheckState="idle"
        translationSettings={DEFAULT_TRANSLATION_SETTINGS}
        onTranslationSettingsChange={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "设置" });
    expect(
      within(dialog).getByRole("button", { name: "获取模型列表" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "测试连接" }),
    ).toBeDisabled();
  });

  it("populates the model picker from the port and commits a selection", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    const { dialog, onTranslationSettingsChange } = renderLiveTranslationDialog(
      DEFAULT_TRANSLATION_SETTINGS,
      port,
    );

    await user.click(
      within(dialog).getByRole("button", { name: "获取模型列表" }),
    );

    const input = within(dialog).getByLabelText("模型");
    await waitFor(() => expect(input).toHaveAttribute("role", "combobox"));
    expect(
      within(dialog).getByText("已加载 2 个模型"),
    ).toBeInTheDocument();
    expect(port.translationModelCalls).toEqual([
      {
        endpoint: DEFAULT_TRANSLATION_SETTINGS.endpoint,
        apiKey: DEFAULT_TRANSLATION_SETTINGS.apiKey,
      },
    ]);

    // Clearing the field (as a user searching from scratch would) opens the
    // full, sorted list.
    await user.clear(input);
    const listbox = within(dialog).getByRole("listbox", { name: "可用模型" });
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["gpt-4o", "gpt-4o-mini"]);

    await user.click(
      within(listbox).getByRole("option", { name: "gpt-4o" }),
    );
    expect(onTranslationSettingsChange).toHaveBeenCalledWith({
      ...DEFAULT_TRANSLATION_SETTINGS,
      model: "gpt-4o",
    });
    expect(
      within(dialog).queryByRole("listbox", { name: "可用模型" }),
    ).not.toBeInTheDocument();
  });

  it("filters the loaded model list as the user types", async () => {
    const user = userEvent.setup();
    const { dialog } = renderLiveTranslationDialog(
      DEFAULT_TRANSLATION_SETTINGS,
      new MemoryDocumentPort(new Map()),
    );

    await user.click(
      within(dialog).getByRole("button", { name: "获取模型列表" }),
    );
    const input = within(dialog).getByLabelText("模型");
    await waitFor(() => expect(input).toHaveAttribute("role", "combobox"));
    await user.clear(input);
    await user.type(input, "mini");

    const listbox = within(dialog).getByRole("listbox", { name: "可用模型" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(1);
    expect(
      within(listbox).getByRole("option", { name: "gpt-4o-mini" }),
    ).toBeInTheDocument();
  });

  it("reports a failed model fetch inline", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    vi.spyOn(port, "listTranslationModels").mockRejectedValue(
      new Error("network down"),
    );
    const { dialog } = renderTranslationDialog(
      DEFAULT_TRANSLATION_SETTINGS,
      vi.fn(),
      port,
    );

    await user.click(
      within(dialog).getByRole("button", { name: "获取模型列表" }),
    );
    expect(
      await within(dialog).findByText("获取模型失败：network down"),
    ).toBeInTheDocument();
  });

  it("keeps the fetch button disabled while a request is in flight", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    let resolveModels!: (models: string[]) => void;
    vi.spyOn(port, "listTranslationModels").mockReturnValue(
      new Promise<string[]>((resolve) => {
        resolveModels = resolve;
      }),
    );
    const { dialog } = renderTranslationDialog(
      DEFAULT_TRANSLATION_SETTINGS,
      vi.fn(),
      port,
    );

    const fetchButton = within(dialog).getByRole("button", {
      name: "获取模型列表",
    });
    await user.click(fetchButton);
    expect(fetchButton).toBeDisabled();
    expect(
      within(dialog).getByText("正在获取模型…"),
    ).toBeInTheDocument();

    await act(async () => {
      resolveModels(["gpt-4o"]);
    });
    await waitFor(() => expect(fetchButton).toBeEnabled());
    expect(
      within(dialog).getByText("已加载 1 个模型"),
    ).toBeInTheDocument();
  });

  it("reports a successful connection test with the model count", async () => {
    const user = userEvent.setup();
    const { dialog } = renderTranslationDialog(
      DEFAULT_TRANSLATION_SETTINGS,
      vi.fn(),
      new MemoryDocumentPort(new Map()),
    );

    await user.click(
      within(dialog).getByRole("button", { name: "测试连接" }),
    );
    expect(
      await within(dialog).findByText("连接成功（共 2 个模型）"),
    ).toBeInTheDocument();
    // The check only reports; the model picker list is left untouched.
    expect(within(dialog).getByLabelText("模型")).not.toHaveAttribute(
      "role",
    );
  });

  it("shows the testing hint and disables the button while the check runs", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    let resolveModels!: (models: string[]) => void;
    vi.spyOn(port, "listTranslationModels").mockReturnValue(
      new Promise<string[]>((resolve) => {
        resolveModels = resolve;
      }),
    );
    const { dialog } = renderTranslationDialog(
      DEFAULT_TRANSLATION_SETTINGS,
      vi.fn(),
      port,
    );

    const testButton = within(dialog).getByRole("button", {
      name: "测试连接",
    });
    await user.click(testButton);
    expect(testButton).toBeDisabled();
    expect(within(dialog).getByText("正在测试…")).toBeInTheDocument();

    await act(async () => {
      resolveModels(["gpt-4o", "gpt-4o-mini"]);
    });
    await waitFor(() => expect(testButton).toBeEnabled());
    expect(
      await within(dialog).findByText("连接成功（共 2 个模型）"),
    ).toBeInTheDocument();
  });

  it("reports a failed connection test with the reason", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    vi.spyOn(port, "listTranslationModels").mockRejectedValue(
      new Error("401 Unauthorized"),
    );
    const { dialog } = renderTranslationDialog(
      DEFAULT_TRANSLATION_SETTINGS,
      vi.fn(),
      port,
    );

    await user.click(
      within(dialog).getByRole("button", { name: "测试连接" }),
    );
    expect(
      await within(dialog).findByText("连接失败：401 Unauthorized"),
    ).toBeInTheDocument();
  });
});
