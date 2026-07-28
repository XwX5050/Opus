# Empty-State Titlebar Consistency Design

## Problem

Opus uses one `.app-header` for both the empty state and an open document. Its row height is content-driven. With a document open, the 36px sidebar and view-mode controls make the titlebar approximately 44px tall; when no document or workspace exists, both controls are absent and the titlebar collapses around the text label. The empty state therefore looks tighter and vertically misaligned even though the same titlebar styles are applied.

## Design

Give the shared `.app-header` a token-compatible `min-height: 44px` and keep its existing padding, border, drag behavior, and macOS traffic-light inset. The minimum is derived from the existing 36px icon target plus 4px top and bottom padding.

The empty state continues to omit the sidebar toggle and reading/editing toggle because neither action is available without a document or workspace. Do not add hidden placeholders or disabled controls. The `Opus` title naturally occupies the first available content position; only the vertical geometry is fixed.

## Verification

Add a stylesheet regression test proving the shared header owns the 44px minimum height. Retain component coverage showing the empty titlebar is draggable and does not expose the two unavailable controls. Run the frontend suite, production build, Rust tests, Playwright E2E, formatting, and Clippy.

Perform a production-style browser visual check with `fileActionsInHeader={false}` in both states. The measured titlebar height must remain 44px before and after opening a document.

After verification, fast-forward the feature branch into `master`, rebuild and ad-hoc sign the ARM64 `Opus.app`, safely replace `/Applications/Opus.app`, then push `master` and confirm GitHub CI succeeds.
