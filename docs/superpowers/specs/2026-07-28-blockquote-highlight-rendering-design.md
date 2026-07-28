# Blockquote Highlight Rendering Design

## Goal

Match the supplied Obsidian references for a blockquote containing `==highlighted text with \`inline code\`==` while preserving Opus’s existing editing and reading interactions.

## Interaction

The blockquote card remains visible in both modes. In editing mode, focusing any nested content reveals the quote mark, highlight delimiters, and inline-code backticks through the existing live-preview selection behavior. The revealed `==` delimiters remain inside the yellow highlight. Moving focus outside the structure hides its source markers again.

Reading mode remains read-only and always hides `>`, `==`, and backticks. No Markdown text is changed by rendering.

## Visual Design

Render blockquotes as full-width line-level cards using existing surface, divider, spacing, and radius tokens. A single-line quote has all corners rounded. Multi-line quotes use first, middle, and last line classes so the background and left rail form one continuous card.

Highlighted inline code keeps its monospace font, border, and small radius, but uses the highlight background instead of the normal dark code background. The pin or other unhighlighted prefix remains outside the yellow area.

## Architecture

Extend the live-preview plan with blockquote line decorations rather than relying on `:has()` or replacing the block with a widget. The planner derives line ranges and first/middle/last positions from each `Blockquote` syntax node. CodeMirror applies them with `Decoration.line`, while existing mark and replace decorations continue to control source visibility.

Use the complete `Highlight` node as the mark range. Hidden delimiter replacements make only the content visible when unfocused; revealed delimiters therefore inherit the same yellow background when focused.

## Verification

Tests cover single- and multi-line quote line plans, reading-mode marker hiding, editing-mode marker reveal, highlighted delimiters, nested inline-code styling, and unchanged plain blockquotes. Run the focused frontend tests, full frontend and Rust suites, E2E tests, and macOS bundle verification before installing the updated ARM64 `Opus.app` without launching it.
