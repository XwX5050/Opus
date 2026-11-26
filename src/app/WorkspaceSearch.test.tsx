import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentPort, WorkspaceSearchResult } from "../document/DocumentPort";
import WorkspaceSearch from "./WorkspaceSearch";

const workspace = { path: "/ws", title: "ws" };
const result: WorkspaceSearchResult = {
  matches: [
    { path: "/ws/a.md", line: 2, column: 0, text: "Hello 世界", matchLength: 5 },
    { path: "/ws/a.md", line: 4, column: 2, text: "再 Hello 一次", matchLength: 5 },
  ],
  truncated: false,
};

const portWith = (searchWorkspace: ReturnType<typeof vi.fn>) =>
  ({ searchWorkspace }) as unknown as DocumentPort;
const input = () => screen.getByRole("combobox", { name: "工作区全文搜索" });
const setQuery = (value: string) => fireEvent.change(input(), { target: { value } });
const finishDebounce = async () => act(async () => {
  vi.advanceTimersByTime(250);
  await Promise.resolve();
});

describe("WorkspaceSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("disables workspace search until a folder is open", () => {
    render(<WorkspaceSearch port={portWith(vi.fn())} workspace={null} onOpenResult={vi.fn()} />);
    expect(input()).toBeDisabled();
    expect(screen.getByPlaceholderText("打开文件夹后搜索全文")).toBeInTheDocument();
  });

  it("debounces queries and renders matching lines", async () => {
    const search = vi.fn().mockResolvedValue(result);
    render(<WorkspaceSearch port={portWith(search)} workspace={workspace} onOpenResult={vi.fn()} />);

    setQuery("Hello");
    expect(search).not.toHaveBeenCalled();
    await finishDebounce();

    expect(search).toHaveBeenCalledWith("/ws", "Hello");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getAllByText("Hello")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("2 处匹配");
  });

  it("labels results with their file, line and text and marks the hit", async () => {
    const search = vi.fn().mockResolvedValue(result);
    render(<WorkspaceSearch port={portWith(search)} workspace={workspace} onOpenResult={vi.fn()} />);

    setQuery("Hello");
    await finishDebounce();

    const option = screen.getByRole("option", { name: "a.md 第 2 行：Hello 世界" });
    expect(option.querySelector("mark.workspace-search-hit")).toHaveTextContent("Hello");
    expect(screen.getByRole("group", { name: "a.md" })).toContainElement(option);

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    const active = screen.getAllByRole("option")[1];
    expect(active).toHaveAttribute("aria-selected", "true");
    expect(active.querySelector("mark.workspace-search-hit")).toHaveTextContent("Hello");
  });

  it("rejects stale responses after a newer query", async () => {
    let resolveFirst!: (value: WorkspaceSearchResult) => void;
    const search = vi.fn()
      .mockImplementationOnce(() => new Promise<WorkspaceSearchResult>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ matches: [], truncated: false });
    render(<WorkspaceSearch port={portWith(search)} workspace={workspace} onOpenResult={vi.fn()} />);

    setQuery("old");
    await finishDebounce();
    setQuery("new");
    await finishDebounce();
    await act(async () => resolveFirst(result));

    expect(screen.queryByText("Hello")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("没有找到匹配内容");
  });

  it("supports keyboard selection, opens a result, and closes with Escape", async () => {
    const search = vi.fn().mockResolvedValue(result);
    const onOpenResult = vi.fn();
    render(<WorkspaceSearch port={portWith(search)} workspace={workspace} onOpenResult={onOpenResult} />);

    input().focus();
    setQuery("Hello");
    await finishDebounce();
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onOpenResult).toHaveBeenCalledWith(result.matches[1]);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input()).toHaveFocus();
  });

  it("reports search errors without replacing the query", async () => {
    const search = vi.fn().mockRejectedValue(new Error("read failed"));
    render(<WorkspaceSearch port={portWith(search)} workspace={workspace} onOpenResult={vi.fn()} />);

    setQuery("failure");
    await finishDebounce();

    expect(screen.getByRole("alert")).toHaveTextContent("read failed");
    expect(input()).toHaveValue("failure");
  });

  it("does not open results while an IME composition is being confirmed", async () => {
    const search = vi.fn().mockResolvedValue(result);
    const onOpenResult = vi.fn();
    render(<WorkspaceSearch port={portWith(search)} workspace={workspace} onOpenResult={onOpenResult} />);

    setQuery("Hello");
    await finishDebounce();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    Object.defineProperty(event, "isComposing", { value: true });
    fireEvent(input(), event);

    expect(onOpenResult).not.toHaveBeenCalled();
  });
});
