import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Update } from "@tauri-apps/plugin-updater";
import { check as pluginCheck } from "@tauri-apps/plugin-updater";
import { relaunch as pluginRelaunch } from "@tauri-apps/plugin-process";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import AppShell from "./AppShell";
import { checkUpdate, relaunchApp } from "./updates";

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));

const updateOffer = (
  version: string,
  downloadAndInstall: () => Promise<void> = vi.fn(async () => {}),
) => ({ version, downloadAndInstall }) as unknown as Update;

const stubTauriBridge = () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
};

const unstubTauriBridge = () => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
};

beforeEach(() => {
  vi.mocked(pluginCheck).mockReset();
  vi.mocked(pluginRelaunch).mockReset();
});

describe("checkUpdate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    unstubTauriBridge();
  });

  it("reports unsupported in dev builds without touching the plugin", async () => {
    expect(await checkUpdate()).toEqual({ status: "unsupported" });
    expect(pluginCheck).not.toHaveBeenCalled();
  });

  it("reports unsupported in E2E runs even with a Tauri bridge", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_E2E", "1");
    stubTauriBridge();
    expect(await checkUpdate()).toEqual({ status: "unsupported" });
    expect(pluginCheck).not.toHaveBeenCalled();
  });

  it("reports unsupported when the Tauri bridge is missing", async () => {
    vi.stubEnv("DEV", false);
    expect(await checkUpdate()).toEqual({ status: "unsupported" });
    expect(pluginCheck).not.toHaveBeenCalled();
  });

  it("surfaces check failures as error with the underlying reason", async () => {
    vi.stubEnv("DEV", false);
    stubTauriBridge();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(pluginCheck).mockRejectedValue(new Error("offline"));
    try {
      expect(await checkUpdate()).toEqual({ status: "error", reason: "offline" });
    } finally {
      errorSpy.mockRestore();
    }
    expect(pluginCheck).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent checks into a single plugin call", async () => {
    vi.stubEnv("DEV", false);
    stubTauriBridge();
    let resolveCheck!: (update: Update | null) => void;
    vi.mocked(pluginCheck).mockImplementation(
      () =>
        new Promise<Update | null>((resolve) => {
          resolveCheck = resolve;
        }),
    );

    const first = checkUpdate();
    const second = checkUpdate();
    await act(async () => {
      resolveCheck(null);
    });
    await expect(first).resolves.toEqual({ status: "up-to-date" });
    await expect(second).resolves.toEqual({ status: "up-to-date" });
    expect(pluginCheck).toHaveBeenCalledOnce();
  });

  it("reports up-to-date when no update is available", async () => {
    vi.stubEnv("DEV", false);
    stubTauriBridge();
    vi.mocked(pluginCheck).mockResolvedValue(null);
    expect(await checkUpdate()).toEqual({ status: "up-to-date" });
    expect(pluginCheck).toHaveBeenCalledOnce();
  });

  it("offers the new version with a download-and-install passthrough", async () => {
    vi.stubEnv("DEV", false);
    stubTauriBridge();
    const downloadAndInstall = vi.fn(async () => {});
    vi.mocked(pluginCheck).mockResolvedValue(
      updateOffer("0.2.0", downloadAndInstall),
    );
    const result = await checkUpdate();
    expect(result.status).toBe("update");
    if (result.status !== "update") return;
    expect(result.offer.version).toBe("0.2.0");
    await result.offer.downloadAndInstall();
    expect(downloadAndInstall).toHaveBeenCalledOnce();
  });

  it("relaunches through the process plugin", async () => {
    vi.mocked(pluginRelaunch).mockResolvedValue(undefined);
    await relaunchApp();
    expect(pluginRelaunch).toHaveBeenCalledOnce();
  });
});

describe("AppShell update dialog", () => {
  beforeEach(() => {
    vi.stubEnv("DEV", false);
    stubTauriBridge();
    vi.mocked(pluginRelaunch).mockResolvedValue(undefined);
    vi.mocked(pluginCheck).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    unstubTauriBridge();
  });

  it("shows the dialog when a newer version is available", async () => {
    vi.mocked(pluginCheck).mockResolvedValue(updateOffer("2.0.0"));
    await act(async () => {
      render(<AppShell port={new MemoryDocumentPort(new Map())} />);
    });
    const dialog = await screen.findByRole("dialog", {
      name: "发现新版本 v2.0.0",
    });
    expect(
      within(dialog).getByRole("button", { name: "立即更新" }),
    ).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "稍后" })).toBeVisible();
    expect(screen.getByTestId("app-background")).toHaveAttribute("inert");
  });

  it("closes on 稍后 and releases the inert background", async () => {
    const user = userEvent.setup();
    vi.mocked(pluginCheck).mockResolvedValue(updateOffer("2.0.0"));
    await act(async () => {
      render(<AppShell port={new MemoryDocumentPort(new Map())} />);
    });
    const dialog = await screen.findByRole("dialog", {
      name: "发现新版本 v2.0.0",
    });
    await user.click(within(dialog).getByRole("button", { name: "稍后" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("app-background")).not.toHaveAttribute("inert");
  });

  it("downloads and relaunches on 立即更新", async () => {
    const user = userEvent.setup();
    const downloadAndInstall = vi.fn(async () => {});
    vi.mocked(pluginCheck).mockResolvedValue(
      updateOffer("2.0.0", downloadAndInstall),
    );
    await act(async () => {
      render(<AppShell port={new MemoryDocumentPort(new Map())} />);
    });
    const dialog = await screen.findByRole("dialog", {
      name: "发现新版本 v2.0.0",
    });
    await user.click(within(dialog).getByRole("button", { name: "立即更新" }));
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    await waitFor(() => expect(pluginRelaunch).toHaveBeenCalledOnce());
  });

  it("shows the downloading state until the install finishes", async () => {
    const user = userEvent.setup();
    let finishDownload!: () => void;
    const downloadAndInstall = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve;
        }),
    );
    vi.mocked(pluginCheck).mockResolvedValue(
      updateOffer("2.0.0", downloadAndInstall),
    );
    await act(async () => {
      render(<AppShell port={new MemoryDocumentPort(new Map())} />);
    });
    const dialog = await screen.findByRole("dialog", {
      name: "发现新版本 v2.0.0",
    });
    await user.click(within(dialog).getByRole("button", { name: "立即更新" }));
    expect(
      within(dialog).getByRole("button", { name: "正在下载更新…" }),
    ).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "稍后" })).toBeDisabled();
    expect(pluginRelaunch).not.toHaveBeenCalled();
    await act(async () => {
      finishDownload();
    });
    await waitFor(() => expect(pluginRelaunch).toHaveBeenCalledOnce());
  });

  it("keeps the dialog open and re-enables install when the download fails", async () => {
    const user = userEvent.setup();
    const downloadAndInstall = vi.fn(async () => {
      throw new Error("download failed");
    });
    vi.mocked(pluginCheck).mockResolvedValue(
      updateOffer("2.0.0", downloadAndInstall),
    );
    await act(async () => {
      render(<AppShell port={new MemoryDocumentPort(new Map())} />);
    });
    const dialog = await screen.findByRole("dialog", {
      name: "发现新版本 v2.0.0",
    });
    await user.click(within(dialog).getByRole("button", { name: "立即更新" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "立即更新" })).toBeEnabled(),
    );
    expect(pluginRelaunch).not.toHaveBeenCalled();
  });

  it("stays hidden when no update is available", async () => {
    render(<AppShell port={new MemoryDocumentPort(new Map())} />);
    await waitFor(() => expect(pluginCheck).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("yields to an open settings dialog and appears after it closes", async () => {
    const user = userEvent.setup();
    let resolveCheck!: (update: Update | null) => void;
    vi.mocked(pluginCheck).mockImplementation(
      () =>
        new Promise<Update | null>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    await act(async () => {
      render(<AppShell port={new MemoryDocumentPort(new Map())} />);
    });
    await user.click(screen.getByRole("button", { name: "设置" }));
    const settingsDialog = screen.getByRole("dialog", { name: "设置" });
    await act(async () => {
      resolveCheck(updateOffer("2.0.0"));
    });
    expect(
      screen.queryByRole("dialog", { name: "发现新版本 v2.0.0" }),
    ).not.toBeInTheDocument();
    await user.click(
      within(settingsDialog).getByRole("button", { name: "完成" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "发现新版本 v2.0.0" }),
    ).toBeVisible();
  });
});
