# Titlebar Horizontal Insets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match the supplied macOS reference by moving the traffic lights and both titlebar controls 2–6px inward without changing their vertical alignment or hit targets.

**Architecture:** Keep native traffic-light placement in Tauri configuration and web titlebar placement in the Tauri-only CSS override. Cover each layout system with its existing regression-test layer, then rebuild and verify the macOS bundle.

**Tech Stack:** Tauri 2 JSON configuration, React/TypeScript, CSS, Vitest, Rust integration tests, macOS codesign.

---

### Task 1: Add failing horizontal-inset regression tests

**Files:**
- Modify: `src-tauri/tests/asset_scope.rs`
- Modify: `src/app/accessibility.test.tsx`

- [ ] **Step 1: Require the reference traffic-light inset**

Change the existing assertion to:

```rust
assert_eq!(window["trafficLightPosition"]["x"], 16);
assert_eq!(
    window["trafficLightPosition"]["y"], 24,
    "traffic lights should be vertically centered in the 44px titlebar"
);
```

- [ ] **Step 2: Require the Tauri-only button insets**

Add this test beside the existing titlebar-control assertions:

```tsx
it("matches native macOS horizontal titlebar insets", () => {
  expect(appCss).toMatch(
    /\.tauri \.app-header\s*\{[^}]*padding:\s*var\(--space-1\)\s+14px\s+var\(--space-1\)\s+86px;/s,
  );
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test asset_scope tauri_product_identity
npm test -- src/app/accessibility.test.tsx
```

Expected: Rust reports `left: Number(10), right: 16`; Vitest reports that the Tauri header still has only `padding-left: 84px`.

### Task 2: Apply the measured native and CSS insets

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src/theme/app.css`

- [ ] **Step 1: Move the native traffic lights inward**

Set:

```json
"trafficLightPosition": { "x": 16, "y": 24 },
```

- [ ] **Step 2: Move both web titlebar controls inward**

Replace the Tauri override with:

```css
.tauri .app-header {
  padding: var(--space-1) 14px var(--space-1) 86px;
}
```

This moves the left sidebar control right 2px and the right view-mode control left 2px while preserving the 4px vertical padding.

- [ ] **Step 3: Run the focused tests and verify GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test asset_scope tauri_product_identity
npm test -- src/app/accessibility.test.tsx
```

Expected: both commands pass.

### Task 3: Run repository validation

**Files:**
- Verify only

- [ ] **Step 1: Run formatting and diff checks**

```bash
git diff --check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Expected: both commands exit successfully without output.

- [ ] **Step 2: Run frontend checks**

```bash
npm test
npm run build
npm run test:e2e
```

Expected: all Vitest and Playwright tests pass and Vite produces `dist/`.

- [ ] **Step 3: Run Rust checks**

```bash
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: Clippy reports no warnings and all Rust tests pass.

### Task 4: Build, install, and commit the update

**Files:**
- Build output: `src-tauri/target/release/bundle/macos/Opus.app`
- Install target: `/Applications/Opus.app`

- [ ] **Step 1: Build and sign the ARM64 app**

```bash
npm run tauri build -- --bundles app
codesign --force --deep --sign - --entitlements src-tauri/entitlements.plist src-tauri/target/release/bundle/macos/Opus.app
./scripts/verify-macos-bundle.sh src-tauri/target/release/bundle/macos/Opus.app
```

Expected: an ARM64 `Opus.app` is produced and strict codesign verification passes with the documented local ad-hoc-signature notice.

- [ ] **Step 2: Back up and replace the installed app**

Confirm Opus is not running, create a unique `/private/tmp/opus-before-horizontal-insets.XXXXXX` directory, move the installed app into it, and copy the verified bundle to `/Applications/Opus.app`. Do not launch the app automatically.

- [ ] **Step 3: Verify the installed bundle**

```bash
./scripts/verify-macos-bundle.sh /Applications/Opus.app
file /Applications/Opus.app/Contents/MacOS/app
```

Expected: signature verification passes and the executable reports `Mach-O 64-bit executable arm64`.

- [ ] **Step 4: Commit the focused implementation**

```bash
git add src-tauri/tauri.conf.json src-tauri/tests/asset_scope.rs src/theme/app.css src/app/accessibility.test.tsx
git commit -m "fix: refine titlebar horizontal insets"
git status --short
```

Expected: the commit succeeds and the final status is clean.
