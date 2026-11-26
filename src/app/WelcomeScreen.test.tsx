import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecentItem } from "../document/types";
import WelcomeScreen from "./WelcomeScreen";

const originalUserAgent = navigator.userAgent;

const stubUserAgent = (value: string) => {
  Object.defineProperty(window.navigator, "userAgent", {
    value,
    configurable: true,
  });
};

afterEach(() => {
  stubUserAgent(originalUserAgent);
});

const macUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const windowsUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const linuxUserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)";

const renderWelcome = (recent: ReadonlyArray<RecentItem> = []) => {
  const onNewDocument = vi.fn();
  const onOpenFiles = vi.fn();
  const onOpenWorkspace = vi.fn();
  const onOpenRecent = vi.fn();
  render(
    <WelcomeScreen
      recent={recent}
      onNewDocument={onNewDocument}
      onOpenFiles={onOpenFiles}
      onOpenWorkspace={onOpenWorkspace}
      onOpenRecent={onOpenRecent}
    />,
  );
  return { onNewDocument, onOpenFiles, onOpenWorkspace, onOpenRecent };
};

const recentFiles = (count: number): ReadonlyArray<RecentItem> =>
  Array.from({ length: count }, (_, index) => ({
    path: `/notes/note-${index + 1}.md`,
    kind: "file" as const,
  }));

describe("WelcomeScreen", () => {
  it("renders the Opus title and launch actions with the real macOS shortcuts", async () => {
    stubUserAgent(macUserAgent);
    const handlers = renderWelcome();
    const user = userEvent.setup();

    const title = screen.getByRole("heading", { level: 1, name: "Opus" });
    expect(title).toBeVisible();
    expect(title).toHaveClass("welcome-title", "welcome-title-script");
    expect(screen.queryByText("本地 Markdown 编辑器")).not.toBeInTheDocument();

    const launch = screen.getByRole("region", { name: "启动" });
    const newFile = within(launch).getByRole("button", { name: "新建" });
    const openFiles = within(launch).getByRole("button", { name: "打开文件" });
    const openFolder = within(launch).getByRole("button", {
      name: "打开文件夹",
    });

    expect(within(newFile).getByText("新建文件")).toBeVisible();
    expect(within(newFile).queryByText("新建文件…")).not.toBeInTheDocument();
    expect(within(openFiles).getByText("打开文件…")).toBeVisible();
    expect(within(openFolder).getByText("打开文件夹…")).toBeVisible();
    expect(newFile).toHaveAttribute("aria-keyshortcuts", "Meta+N Control+N");
    expect(openFiles).toHaveAttribute("aria-keyshortcuts", "Meta+O Control+O");
    expect(openFolder).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+Shift+O Control+Shift+O",
    );
    expect(within(newFile).getByText("⌘N")).toBeInTheDocument();
    expect(within(openFiles).getByText("⌘O")).toBeInTheDocument();
    expect(within(openFolder).getByText("⇧⌘O")).toBeInTheDocument();

    await user.click(newFile);
    await user.click(openFiles);
    await user.click(openFolder);

    expect(handlers.onNewDocument).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenFiles).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenWorkspace).toHaveBeenCalledTimes(1);
  });

  it("shows five recent items and hides the rest behind a native 更多… disclosure", async () => {
    stubUserAgent(macUserAgent);
    renderWelcome(recentFiles(7));
    const user = userEvent.setup();

    const recent = screen.getByRole("region", { name: "最近" });
    const lists = recent.querySelectorAll(".welcome-recent-list");
    expect(lists).toHaveLength(2);
    const primary = lists[0] as HTMLElement;
    const more = lists[1] as HTMLElement;
    expect(primary.querySelectorAll("button")).toHaveLength(5);
    expect(more.querySelectorAll("button")).toHaveLength(2);

    const details = recent.querySelector("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    const summary = details?.querySelector("summary");
    expect(summary).toHaveTextContent("更多…");

    await user.click(summary as HTMLElement);
    expect(details).toHaveAttribute("open");
    expect(
      within(more).getByRole("button", { name: /note-6\.md/ }),
    ).toBeVisible();
  });

  it("shows a compact parent path while preserving the complete accessible path", () => {
    const path =
      "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/写作/2026年第四季度产品路线图与团队协作总结-最终审阅版本.md";
    renderWelcome([{ path, kind: "file" }]);

    const name =
      "2026年第四季度产品路线图与团队协作总结-最终审阅版本.md";
    const item = screen.getByRole("button", {
      name: `打开文件 ${name}：${path}`,
    });
    const location = screen.getByText(
      "~/Library/Mobile Documents/com~apple~CloudDocs/写作",
    );

    expect(within(item).getByText(name)).toHaveClass("welcome-recent-name");
    expect(within(item).getByText("文件")).toHaveClass("welcome-recent-kind");
    expect(location).toHaveClass("welcome-recent-path");
    expect(location).toHaveAttribute("aria-hidden", "true");
    expect(item).toHaveAttribute("title", path);
    expect(screen.queryByText(path)).not.toBeInTheDocument();
  });

  it("compacts Windows paths and does not repeat folder names", () => {
    stubUserAgent(windowsUserAgent);
    renderWelcome([
      { path: "C:\\Users\\me\\notes\\a.md", kind: "file" },
      { path: "C:\\Users\\me\\notes", kind: "folder" },
      { path: "D:\\notes\\b.md", kind: "file" },
    ]);

    // The folder row shows its parent directory, not its own name again.
    expect(screen.getAllByText("~\\notes")).toHaveLength(1);
    expect(screen.getByText("D:\\notes")).toBeVisible();

    const folder = screen.getByRole("button", {
      name: "打开文件夹 notes：C:\\Users\\me\\notes",
    });
    expect(within(folder).getByText("notes")).toHaveClass(
      "welcome-recent-name",
    );
    expect(within(folder).getByText("文件夹")).toHaveClass(
      "welcome-recent-kind",
    );
    expect(within(folder).getByText("~")).toHaveClass("welcome-recent-path");

    const file = screen.getByRole("button", {
      name: "打开文件 a.md：C:\\Users\\me\\notes\\a.md",
    });
    expect(within(file).getByText("文件")).toHaveClass("welcome-recent-kind");
  });

  it("uses only the launch and recent column without decorative content", () => {
    renderWelcome([{ path: "/notes/a.md", kind: "file" }]);

    expect(screen.getByRole("heading", { name: "启动" })).toHaveClass(
      "welcome-section-title",
    );
    expect(screen.getByRole("heading", { name: "最近" })).toHaveClass(
      "welcome-section-title",
    );
    expect(
      screen.queryByRole("region", { name: "快捷键" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".welcome-aside")).toBeNull();
    expect(document.querySelector(".welcome-recent-icon")).toBeNull();
    expect(document.querySelector(".welcome-recent-kind")).not.toBeNull();
  });

  it("activates recent files and folders through accessible buttons", async () => {
    stubUserAgent(macUserAgent);
    const file: RecentItem = { path: "/Users/me/notes/a.md", kind: "file" };
    const folder: RecentItem = { path: "/Users/me/notes", kind: "folder" };
    const { onOpenRecent } = renderWelcome([file, folder]);
    const user = userEvent.setup();

    const fileButton = screen.getByRole("button", {
      name: "打开文件 a.md：/Users/me/notes/a.md",
    });
    const folderButton = screen.getByRole("button", {
      name: "打开文件夹 notes：/Users/me/notes",
    });

    expect(fileButton.tagName).toBe("BUTTON");
    expect(folderButton.tagName).toBe("BUTTON");
    expect(fileButton).toHaveAttribute("type", "button");
    expect(folderButton).toHaveAttribute("type", "button");

    await user.click(folderButton);
    await user.click(fileButton);

    expect(onOpenRecent).toHaveBeenNthCalledWith(1, folder);
    expect(onOpenRecent).toHaveBeenNthCalledWith(2, file);
  });

  it("uses the platform shortcut labels and exposes native button semantics", () => {
    stubUserAgent(windowsUserAgent);
    renderWelcome([{ path: "/notes/a.md", kind: "file" }]);

    const title = screen.getByRole("heading", { level: 1, name: "Opus" });
    expect(title).toHaveClass("welcome-title");
    expect(title).not.toHaveClass("welcome-title-script");

    const launch = screen.getByRole("region", { name: "启动" });
    const newFile = within(launch).getByRole("button", { name: "新建" });
    const openFiles = within(launch).getByRole("button", { name: "打开文件" });
    const openFolder = within(launch).getByRole("button", {
      name: "打开文件夹",
    });
    expect(within(newFile).getByText("新建文件")).toBeVisible();
    expect(within(openFiles).getByText("打开文件…")).toBeVisible();
    expect(within(openFolder).getByText("打开文件夹…")).toBeVisible();
    expect(within(newFile).getByText("Ctrl+N")).toBeInTheDocument();
    expect(within(openFiles).getByText("Ctrl+O")).toBeInTheDocument();
    expect(within(openFolder).getByText("Ctrl+Shift+O")).toBeInTheDocument();

    expect(
      screen.queryByRole("region", { name: "快捷键" }),
    ).not.toBeInTheDocument();

    const recentButton = screen.getByRole("button", { name: /a\.md/ });
    expect(recentButton.tagName).toBe("BUTTON");
    expect(recentButton).toHaveAttribute("type", "button");
    expect(recentButton).toHaveAccessibleName(
      "打开文件 a.md：/notes/a.md",
    );
  });

  it("uses the Ctrl shortcut family and a plain wordmark on Linux", () => {
    stubUserAgent(linuxUserAgent);
    renderWelcome();

    const title = screen.getByRole("heading", { level: 1, name: "Opus" });
    expect(title).not.toHaveClass("welcome-title-script");

    const launch = screen.getByRole("region", { name: "启动" });
    const newFile = within(launch).getByRole("button", { name: "新建" });
    const openFolder = within(launch).getByRole("button", {
      name: "打开文件夹",
    });
    expect(within(newFile).getByText("Ctrl+N")).toBeInTheDocument();
    expect(within(openFolder).getByText("Ctrl+Shift+O")).toBeInTheDocument();
  });
});
