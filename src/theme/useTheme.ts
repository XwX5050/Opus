import { useEffect, useState } from "react";
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
const reducedMotion = () => query("(prefers-reduced-motion: reduce)");

/**
 * Applies the chosen theme and editor preferences to the document root:
 * `data-theme` drives the token cascade, the `reduced-motion` class mirrors
 * the OS setting for JS consumers, and the editor preferences are published
 * as CSS custom properties. Preferences are applied as root variables only —
 * they are never written into Markdown documents.
 *
 * Without `matchMedia` (older WebViews, jsdom) the hook degrades to dark with
 * full motion, matching the app default.
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
  const [motionReduced, setMotionReduced] = useState(
    () => reducedMotion()?.matches ?? false,
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

  useEffect(() => {
    const media = reducedMotion();
    if (!media) return;
    const onChange = (event: MediaQueryListEvent) =>
      setMotionReduced(event.matches);
    setMotionReduced(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.classList.toggle("reduced-motion", motionReduced);
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
  }, [resolved, motionReduced, editorPreferences]);

  return resolved;
}
