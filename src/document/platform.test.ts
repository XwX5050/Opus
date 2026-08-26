import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPathPlatform } from "./platform";

const stubUserAgent = (userAgent: string): void => {
  vi.stubGlobal("navigator", { userAgent });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectPathPlatform", () => {
  it("detects Windows from a WebView2 user agent", () => {
    stubUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    );
    expect(detectPathPlatform()).toBe("windows");
  });

  it("detects Linux from a WebKitGTK user agent", () => {
    stubUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    );
    expect(detectPathPlatform()).toBe("linux");
  });

  it("detects macOS from a WKWebView user agent", () => {
    stubUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    );
    expect(detectPathPlatform()).toBe("macos");
  });

  it("falls back to macOS when the user agent carries no platform marker", () => {
    stubUserAgent("jsdom");
    expect(detectPathPlatform()).toBe("macos");
  });
});