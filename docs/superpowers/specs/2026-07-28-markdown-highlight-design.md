# Markdown Highlight Design

## Goal

Render `==text==` as an Obsidian-style highlight while preserving the original Markdown and the editor’s existing live-preview interaction.

## Syntax

Add a Lezer Markdown extension with `Highlight` and `HighlightMark` nodes, modeled on the existing GFM strikethrough delimiter parser. A valid highlight is single-line, non-empty, and has no whitespace immediately after the opening `==` or before the closing `==`.

Escaped delimiters, unmatched or empty pairs, inline code, and fenced code remain ordinary source text. Highlight parsing must compose with emphasis, strong text, links, and other inline Markdown rather than scanning the document independently.

## Live Preview

Only the content between the two delimiters receives the highlight decoration. When the cursor or selection intersects the `Highlight` node in editing mode, both `==` markers become visible while the content stays highlighted. When selection leaves the node, the markers are hidden again.

Reading mode always hides the markers. Composition temporarily reveals source using the existing IME-safe live-preview behavior. Highlight decorations are visual only and never modify document text or save output.

## Visual Design

Define a `--highlight` theme token. Dark mode uses the sampled screenshot color `#796a32` (`rgb(121, 106, 50)`). Light mode uses `#ffec99`, a readable equivalent on the light canvas. Highlighted content keeps the normal text color, uses the existing small radius, and receives 2px horizontal padding to match the reference’s rounded marker shape.

## Architecture

Create `src/editor/highlightExtension.ts` for syntax parsing and its focused parser tests. Register it in the single production Markdown tree in `editorExtensions.ts`. Extend `livePreview.ts` to recognize the syntax node, hide `HighlightMark` delimiters, and mark only the interior range. Theme styling remains in `tokens.css` and `app.css`.

## Verification

Tests cover valid Unicode and adjacent highlights, invalid delimiters, code exclusions, exact syntax ranges, delimiter hiding, selection reveal, reading mode, nested inline syntax, IME composition, and both theme tokens. Run all frontend, Rust, and E2E suites before rebuilding, signing, verifying, and installing the ARM64 `Opus.app` without launching it automatically.
