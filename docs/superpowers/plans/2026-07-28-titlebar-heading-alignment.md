# Titlebar and Heading Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vertically align the native macOS traffic lights with Opus’s custom titlebar and align rendered ATX headings with paragraph text.

**Architecture:** Keep window-chrome positioning in Tauri configuration. Keep Markdown presentation behavior in the CodeMirror live-preview planner by widening only hidden ATX marker ranges; document bytes and source-mode behavior remain unchanged.

**Tech Stack:** Tauri 2 configuration, Rust integration tests, TypeScript, CodeMirror 6, Lezer Markdown, Vitest, Playwright.

---

### Task 1: Pin the macOS Traffic-Light Position

**Files:**
- Modify: `src-tauri/tests/asset_scope.rs`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Write the failing configuration test**

Extend `tauri_product_identity_is_opus_without_changing_the_bundle_identifier`:

```rust
let window = &json["app"]["windows"][0];
assert_eq!(window["trafficLightPosition"]["x"], 10);
assert_eq!(window["trafficLightPosition"]["y"], 16);
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test asset_scope tauri_product_identity
```

Expected: FAIL because `trafficLightPosition` is absent.

- [ ] **Step 3: Add the minimal Tauri configuration**

Add beside `titleBarStyle`:

```json
"trafficLightPosition": { "x": 10, "y": 16 },
```

- [ ] **Step 4: Run the test and verify GREEN**

Run the focused command from Step 2. Expected: one passing test.

### Task 2: Remove the Rendered ATX Prefix Gap

**Files:**
- Modify: `src/editor/livePreview.test.ts`
- Modify: `src/editor/livePreview.ts`

- [ ] **Step 1: Write failing rendered-DOM tests**

Create a parameterized test for `#` through `######`:

```ts
it.each(["#", "##", "###", "####", "#####", "######"])(
  "aligns rendered %s headings with paragraph text",
  (marker) => {
    const view = createView(`${marker} Heading\n\nParagraph`);
    const lines = view.contentDOM.querySelectorAll<HTMLElement>(".cm-line");
    expect(lines[0]?.textContent).toBe("Heading");
    expect(lines[1]?.textContent).toBe("Paragraph");
    view.destroy();
  },
);
```

Also select the heading and assert that its source marker and separating whitespace return.

```ts
const selected = createView("### Heading\n\nParagraph");
selected.dispatch({ selection: { anchor: 0 } });
expect(
  selected.contentDOM.querySelector<HTMLElement>(".cm-line")?.textContent,
).toBe("### Heading");
selected.destroy();
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- src/editor/livePreview.test.ts
```

Expected: the rendered heading begins with a space.

- [ ] **Step 3: Extend only hidden ATX marker ranges**

Add a helper that returns the original marker for non-ATX structures, but advances an ATX `HeaderMark`’s `to` position through spaces and tabs up to the same line’s end:

```ts
const markerRangeForPreview = (
  state: EditorState,
  owner: Structure,
  node: MarkerNode,
): MarkerNode => {
  if (!owner.node.name.startsWith("ATXHeading") || node.name !== "HeaderMark") {
    return node;
  }
  const line = state.doc.lineAt(node.to);
  let to = node.to;
  while (to < line.to && /[ \t]/.test(state.sliceDoc(to, to + 1))) to += 1;
  return { ...node, to };
};
```

Use `markerRangeForPreview(state, owner, node)` for the replacement source and range in the final marker loop. Leave the existing `revealed(owner)` branch unchanged so selected headings still expose their complete source.

- [ ] **Step 4: Run the test and verify GREEN**

Run the focused Vitest command. Expected: all live-preview tests pass.

### Task 3: Verify, Package, and Install

**Files:**
- Verify all changed source and test files.
- Replace: `/Applications/Opus.app`

- [ ] **Step 1: Run the complete checks**

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
npm run test:e2e
```

Expected: all tests and static checks pass.

- [ ] **Step 2: Build and verify the app**

```bash
npm run tauri build -- --bundles app
codesign --force --deep --sign - --entitlements src-tauri/entitlements.plist src-tauri/target/release/bundle/macos/Opus.app
./scripts/verify-macos-bundle.sh src-tauri/target/release/bundle/macos/Opus.app
```

Expected: an ARM64 `Opus.app` with a valid local ad-hoc signature.

- [ ] **Step 3: Replace the installed application**

Confirm Opus is not running, move the existing bundle to a unique temporary backup, copy in the verified bundle, and verify `/Applications/Opus.app`. Do not modify user documents, preferences, or recovery drafts.

```bash
pgrep -ifl '/Applications/Opus.app'
backup_dir=$(mktemp -d /private/tmp/opus-before-alignment.XXXXXX)
mv /Applications/Opus.app "$backup_dir/Opus.app"
ditto src-tauri/target/release/bundle/macos/Opus.app /Applications/Opus.app
./scripts/verify-macos-bundle.sh /Applications/Opus.app
```

- [ ] **Step 4: Commit the focused change**

```bash
git add docs/superpowers/specs/2026-07-28-titlebar-heading-alignment-design.md docs/superpowers/plans/2026-07-28-titlebar-heading-alignment.md src-tauri/tests/asset_scope.rs src-tauri/tauri.conf.json src/editor/livePreview.test.ts src/editor/livePreview.ts
git commit -m "fix: align titlebar controls and markdown headings"
```
