import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WindowControls, { WindowResizeHandles } from "./WindowControls";

const windowMocks = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  isMaximized: vi.fn(),
  onResized: vi.fn(),
  startResizeDragging: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowMocks,
}));

// The controls only render in a Windows native build (see
// src/document/platform.ts + the __TAURI_INTERNALS__ probe in
// WindowControls.tsx); jsdom's UA reflects the host OS, so pin one per
// render to keep the tests platform-independent.
const originalUserAgent = navigator.userAgent;

const stubUserAgent = (value: string) =>
  Object.defineProperty(window.navigator, "userAgent", {
    value,
    configurable: true,
  });

const setWindowsNative = () => {
  stubUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
};

let resizedHandler: () => void = () => {};

beforeEach(() => {
  windowMocks.minimize.mockClear();
  windowMocks.toggleMaximize.mockClear();
  windowMocks.close.mockClear();
  windowMocks.startResizeDragging.mockClear();
  windowMocks.unlisten.mockClear();
  windowMocks.isMaximized.mockReset().mockResolvedValue(false);
  windowMocks.onResized.mockReset().mockImplementation((handler: () => void) => {
    resizedHandler = handler;
    return Promise.resolve(windowMocks.unlisten);
  });
});

afterEach(() => {
  stubUserAgent(originalUserAgent);
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("WindowControls", () => {
  it("renders the three caption buttons on a Windows native build", () => {
    setWindowsNative();
    render(<WindowControls />);

    expect(screen.getByRole("button", { name: "最小化" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "最大化" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
    expect(windowMocks.isMaximized).toHaveBeenCalled();
  });

  it("minimizes, toggles maximization, and closes on click", () => {
    setWindowsNative();
    render(<WindowControls />);

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    expect(windowMocks.minimize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    expect(windowMocks.toggleMaximize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(windowMocks.close).toHaveBeenCalledTimes(1);
  });

  it("switches to the restore icon once the window is maximized", async () => {
    setWindowsNative();
    render(<WindowControls />);

    expect(screen.getByRole("button", { name: "最大化" })).toBeInTheDocument();

    // The window maximizes: the next onResized event refreshes the state.
    windowMocks.isMaximized.mockResolvedValue(true);
    await act(async () => {
      resizedHandler();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "还原" })).toBeInTheDocument();
  });

  it("renders nothing off Windows", () => {
    stubUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    render(<WindowControls />);

    expect(screen.queryByRole("button", { name: "最小化" })).not.toBeInTheDocument();
    expect(windowMocks.isMaximized).not.toHaveBeenCalled();
  });

  it("renders nothing in a plain browser on Windows", () => {
    stubUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    render(<WindowControls />);

    expect(screen.queryByRole("button", { name: "最小化" })).not.toBeInTheDocument();
  });
});

describe("WindowResizeHandles", () => {
  it("renders eight edge hotzones and starts the matching edge resize", () => {
    setWindowsNative();
    const { container } = render(<WindowResizeHandles />);

    expect(container.querySelectorAll(".window-resize-hotzone")).toHaveLength(8);

    fireEvent.mouseDown(container.querySelector(".window-resize-hotzone-se")!, { button: 0 });
    expect(windowMocks.startResizeDragging).toHaveBeenCalledWith("SouthEast");

    fireEvent.mouseDown(container.querySelector(".window-resize-hotzone-n")!, { button: 0 });
    expect(windowMocks.startResizeDragging).toHaveBeenCalledWith("North");
  });

  it("hides the hotzones while the window is maximized", async () => {
    setWindowsNative();
    windowMocks.isMaximized.mockResolvedValue(true);
    const { container } = render(<WindowResizeHandles />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector(".window-resize-hotzone")).toBeNull();
  });
});
