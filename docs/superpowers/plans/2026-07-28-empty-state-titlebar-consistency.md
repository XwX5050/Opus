# Empty-State Titlebar Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Opus titlebar 44px tall in both the empty state and document state while omitting unavailable controls.

**Architecture:** Preserve the existing shared `AppShell` header and conditional controls. Add one CSS layout invariant to the shared header, prove it with a stylesheet regression test, and use a production-style browser harness to compare the rendered empty and populated states.

**Tech Stack:** React, TypeScript, CSS, Vitest, Testing Library, Playwright, Tauri 2

---

### Task 1: Lock the shared titlebar height

**Files:**
- Modify: `src/app/accessibility.test.tsx`
- Modify: `src/theme/app.css`

- [ ] **Step 1: Add the failing stylesheet regression**

Extend the existing “keeps the titlebar fixed” test with:

```ts
expect(appCss).toMatch(
  /\.app-header\s*\{[^}]*min-height:\s*44px;/s,
);
```

This targets the shared header rather than an empty-state-only selector.

- [ ] **Step 2: Verify the test fails for the missing invariant**

Run:

```bash
npm test -- src/app/accessibility.test.tsx
```

Expected: FAIL because `.app-header` does not define `min-height: 44px`.

- [ ] **Step 3: Implement the minimal CSS fix**

Add the invariant beside the header’s flex alignment:

```css
.app-header {
  display: flex;
  align-items: center;
  min-height: 44px;
  gap: var(--space-1);
  /* existing declarations remain unchanged */
}
```

Do not add placeholders, disabled buttons, state-specific classes, or alternate padding.

- [ ] **Step 4: Verify the focused test passes**

Run:

```bash
npm test -- src/app/accessibility.test.tsx
```

Expected: PASS.

### Task 2: Verify behavior and visual geometry

**Files:**
- Verify: `src/app/AppShell.tsx`
- Verify: `tests/e2e/notepad.spec.ts`

- [ ] **Step 1: Run frontend and browser coverage**

Run:

```bash
npm test
npm run build
npm run test:e2e
```

Expected: 521 or more frontend tests pass, the production build succeeds, and all eight browser-shell workflows pass.

- [ ] **Step 2: Measure the production-style titlebar**

Start Vite with `VITE_E2E=1`, render `AppShell` with `fileActionsInHeader={false}`, and use Playwright to record the titlebar bounding box before and after opening a fixture document.

Expected:

```text
emptyHeight=44
documentHeight=44
emptySidebarToggle=false
emptyViewToggle=false
documentSidebarToggle=true
documentViewToggle=true
```

- [ ] **Step 3: Run Rust and static checks**

Run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: all commands pass.

### Task 3: Integrate and update Opus

**Files:**
- Commit: `src/app/accessibility.test.tsx`
- Commit: `src/theme/app.css`
- Commit: `docs/superpowers/plans/2026-07-28-empty-state-titlebar-consistency.md`

- [ ] **Step 1: Commit the verified fix**

```bash
git add src/app/accessibility.test.tsx src/theme/app.css \
  docs/superpowers/plans/2026-07-28-empty-state-titlebar-consistency.md
git commit -m "fix: unify empty-state titlebar height"
```

- [ ] **Step 2: Merge and retest**

Fast-forward `codex/empty-titlebar-consistency` into `master`, run `npm test`, then remove the clean worktree and delete the merged branch.

- [ ] **Step 3: Build and install the app**

Run:

```bash
npm run tauri build -- --bundles app
codesign --force --deep --sign - --entitlements src-tauri/entitlements.plist \
  "src-tauri/target/release/bundle/macos/Opus.app"
./scripts/verify-macos-bundle.sh \
  "src-tauri/target/release/bundle/macos/Opus.app"
```

Confirm Opus is not running, back up `/Applications/Opus.app` under `/private/tmp`, install the verified bundle, and compare built/installed executable hashes. Do not auto-launch the app.

- [ ] **Step 4: Push and verify GitHub**

Push `master`, confirm local and remote heads match, then wait for the triggered GitHub Actions run to finish successfully.
