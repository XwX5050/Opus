import { useEffect, useLayoutEffect, useState } from "react";
import {
  fontFamilyStack,
  resolveTheme,
  type EditorPreferences,
  type ResolvedTheme,
  type ThemePreference,
} from "./preferences";

const query = (media: string): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(media)
    : null;

const systemDark = () => query("(prefers-color-scheme: dark)");

/**
 * Applies the chosen theme and editor preferences to the document root:
 * `data-theme` drives the token cascade and the editor preferences are
 * published as CSS custom properties. Preferences are applied as root
 * variables only — they are never written into Markdown documents.
 *
 * First-paint behavior: the persisted theme arrives asynchronously with the
 * session, so the first frame always uses the dark default (the document
 * background is consistent — nothing partially themed is painted). The DOM
 * mutation runs in `useLayoutEffect`, i.e. synchronously before the browser
 * paints the frame in which React learned the theme, so the dark→light
 * transition is a single full flip bounded by the session-read latency
 * rather than a progressive repaint.
 *
 * Reduced motion needs no JS: app.css disables nonessential transitions via
 * `@media (prefers-reduced-motion: reduce)`.
 *
 * Without `matchMedia` (older WebViews, jsdom) the hook degrades to dark,
 * matching the app default.
 */
export function useTheme(
  preference: ThemePreference,
  editorPreferences: EditorPreferences,
): ResolvedTheme {
  // Dark-by-default initial state matches the app default so the first paint
  // is consistent even before the media query is read.
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => systemDark()?.matches ?? true,
  );
  const resolved = resolveTheme(preference, systemPrefersDark);

  useEffect(() => {
    const media = systemDark();
    if (!media) return;
    const onChange = (event: MediaQueryListEvent) =>
      setSystemPrefersDark(event.matches);
    setSystemPrefersDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.setProperty(
      "--editor-body-size",
      `${editorPreferences.bodySizePx}px`,
    );
    root.style.setProperty(
      "--editor-line-height",
      String(editorPreferences.lineHeight),
    );
    root.style.setProperty(
      "--editor-content-width",
      `${editorPreferences.contentWidthPx}px`,
    );
    root.style.setProperty(
      "--editor-body-font",
      fontFamilyStack(editorPreferences.fontFamily),
    );
  }, [resolved, editorPreferences]);

  return resolved;
}
