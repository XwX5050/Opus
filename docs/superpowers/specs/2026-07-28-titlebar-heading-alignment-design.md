# Titlebar and Heading Alignment Design

## Goal

Align Opus’s native macOS traffic lights with the custom titlebar controls, and make rendered ATX headings (`#` through `######`) share the same left edge as ordinary paragraphs.

## Current Behavior and Root Causes

The custom titlebar is 44 logical pixels tall because it contains 36px controls plus 4px vertical padding. macOS currently chooses the traffic-light inset, leaving their visual center about 6px above the sidebar toggle, application name, and reading-mode button.

Live preview replaces only Lezer’s `HeaderMark` range. The required whitespace after an ATX marker is outside that range, so rendered headings retain an invisible-source gap before their first visible character. Paragraphs do not have that gap.

## Design

Set `trafficLightPosition` to `{ "x": 10, "y": 24 }` in the Tauri window configuration. A Retina screenshot showed the controls about 8 logical pixels above the custom 44px titlebar’s center; the corrected inset preserves the existing horizontal position while balancing the space above and below the native controls. Header height and web content remain unchanged.

When live preview hides an ATX `HeaderMark`, extend the replacement range through adjacent spaces or tabs on the same line. Do not cross the line ending, do not alter Setext headings, and do not modify the document. When a heading is selected in editing mode, the existing reveal behavior continues to show the complete source prefix.

## Testing and Release

Add a Rust configuration regression that checks the exact traffic-light coordinates. Add real `EditorView` coverage for all six ATX levels, verifying that rendered heading text has no leading whitespace while selected source still reappears.

Run focused tests first, then the complete frontend and Rust suites, TypeScript production build, Rust formatting and Clippy, and Playwright E2E tests. Rebuild and locally sign the ARM64 app, verify the bundle, replace `/Applications/Opus.app`, and do not launch it automatically.
