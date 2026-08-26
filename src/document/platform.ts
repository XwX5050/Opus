import type { PathPlatform } from "./types";

/**
 * Resolves the platform whose path-key normalization rules the reducer and
 * ports should apply, detected from the user agent. Every supported runtime
 * carries a platform marker in its user agent: the Tauri webview and all
 * major browsers include "Windows" or "Linux" in the OS token ("Macintosh"
 * on macOS, which contains neither). Anything unrecognized falls back to
 * macOS to preserve the original default behavior.
 */
export const detectPathPlatform = (): PathPlatform => {
  const agent = navigator.userAgent;
  if (agent.includes("Windows")) return "windows";
  if (agent.includes("Linux")) return "linux";
  return "macos";
};