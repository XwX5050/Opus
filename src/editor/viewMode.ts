/**
 * The three per-tab view modes:
 * - "reading": read-only, fully rendered — markers are never revealed.
 * - "editing": the default live-preview behavior (selection reveals source).
 * - "source": raw Markdown, no preview decorations or widgets.
 */
export type EditorViewMode = "reading" | "editing" | "source";
