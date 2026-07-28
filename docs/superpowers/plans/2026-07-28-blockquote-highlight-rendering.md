# Blockquote Highlight Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render blockquotes as continuous Obsidian-style cards in both modes and keep nested highlight and inline-code backgrounds correct as source markers hide or reveal.

**Architecture:** Extend the existing live-preview plan with line decorations derived from `Blockquote` syntax nodes. Preserve the current selection-driven marker replacement system, but mark the complete `Highlight` node so revealed delimiters inherit the highlight color. Keep all presentation in the existing theme CSS.

**Tech Stack:** TypeScript, CodeMirror 6, Lezer Markdown, CSS custom properties, Vitest, Playwright, Tauri 2.

---

### Task 1: Plan blockquote line decorations

**Files:**
- Modify: `src/editor/livePreview.ts`
- Modify: `src/editor/livePreview.test.ts`

- [ ] **Step 1: Write failing planner tests**

Add a helper that filters line decorations and tests for single- and multi-line quotes:

```ts
const linesMarkedAs = (plan: readonly PlannedDecoration[], className: string) =>
  plan.filter(
    (item) => item.kind === "line" && item.className?.includes(className),
  );

it("plans a single card line for a one-line blockquote", () => {
  const state = createState("> quote", [{ anchor: 7 }]);
  expect(
    linesMarkedAs(planLivePreview(state), "cm-live-preview-quote-line-single"),
  ).toEqual([
    {
      from: 0,
      to: 7,
      kind: "line",
      className:
        "cm-live-preview-quote-line cm-live-preview-quote-line-single",
    },
  ]);
});

it("plans continuous first, middle, and last card lines", () => {
  const state = createState("> first\n> middle\n> last", [{ anchor: 24 }]);
  const classes = planLivePreview(state)
    .filter(({ kind }) => kind === "line")
    .map(({ className }) => className);
  expect(classes).toEqual([
    "cm-live-preview-quote-line cm-live-preview-quote-line-first",
    "cm-live-preview-quote-line cm-live-preview-quote-line-middle",
    "cm-live-preview-quote-line cm-live-preview-quote-line-last",
  ]);
});
```

Update `hiddenSource` so line decorations are not treated as hidden source:

```ts
.filter(({ kind }) => kind !== "mark" && kind !== "line")
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npm test -- src/editor/livePreview.test.ts
```

Expected: FAIL because `"line"` is not a `PlannedDecorationKind` and the planner emits no quote-line items.

- [ ] **Step 3: Add the minimal line plan**

Add `"line"` to `PlannedDecorationKind`. For each `Blockquote` structure, derive the first and last document lines from `node.from` and `node.to - 1`, then emit:

```ts
const quoteLines = (
  state: EditorState,
  structure: Structure,
): PlannedDecoration[] => {
  const first = state.doc.lineAt(structure.node.from);
  const last = state.doc.lineAt(
    Math.max(structure.node.from, structure.node.to - 1),
  );
  const plans: PlannedDecoration[] = [];
  for (let number = first.number; number <= last.number; number += 1) {
    const line = state.doc.line(number);
    const position =
      first.number === last.number
        ? "single"
        : number === first.number
          ? "first"
          : number === last.number
            ? "last"
            : "middle";
    plans.push({
      from: line.from,
      to: line.to,
      kind: "line",
      className:
        `cm-live-preview-quote-line cm-live-preview-quote-line-${position}`,
    });
  }
  return plans;
};
```

Append these plans while visiting `Blockquote` structures. In `decorationSetsFor`, translate line items without adding atomic ranges:

```ts
if (item.kind === "line") {
  decorations.push(
    Decoration.line({
      attributes: { class: item.className ?? "" },
    }).range(item.from),
  );
  continue;
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npm test -- src/editor/livePreview.test.ts
```

Expected: PASS.

### Task 2: Keep revealed delimiters inside the highlight

**Files:**
- Modify: `src/editor/livePreview.ts`
- Modify: `src/editor/livePreview.test.ts`

- [ ] **Step 1: Write failing range and mode tests**

Change the focused highlight expectation to require the complete node range:

```ts
it("highlights revealed delimiters while editing nested content", () => {
  const doc = "> 📌 ==text `D = -D`==";
  const state = createState(doc, [{ anchor: doc.indexOf("D = -D") + 2 }]);
  const plan = planLivePreview(state);
  expect(markedAs(plan, "cm-live-preview-highlight")).toEqual([
    {
      from: doc.indexOf("=="),
      to: doc.lastIndexOf("==") + 2,
      kind: "mark",
      className: "cm-live-preview-highlight",
    },
  ]);
  expect(hiddenSource(state, plan)).not.toContain("==");
  expect(hiddenSource(state, plan)).not.toContain("`");
  expect(hiddenSource(state, plan)).not.toContain(">");
});
```

Add the equivalent `revealSelection: false` assertion requiring `>`, both `==` pairs, and both backticks to be hidden while the same full highlight range remains marked.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npm test -- src/editor/livePreview.test.ts
```

Expected: FAIL because the highlight mark currently excludes two characters at each end.

- [ ] **Step 3: Mark the complete Highlight node**

Remove the `markFrom`/`markTo` trimming branch and use:

```ts
planned.push({
  from: structure.node.from,
  to: structure.node.to,
  kind: "mark",
  className,
});
```

Keep `HighlightMark` replacement and selection propagation unchanged.

- [ ] **Step 4: Run live-preview and editor tests**

Run:

```bash
npm test -- src/editor/livePreview.test.ts src/editor/MarkdownEditor.test.tsx
```

Expected: PASS, including editing, reading, composition, and atomic-range coverage.

### Task 3: Style quote cards and highlighted inline code

**Files:**
- Modify: `src/theme/app.css`
- Modify: `src/app/accessibility.test.tsx`
- Modify: `src/editor/livePreview.ts`

- [ ] **Step 1: Write failing stylesheet tests**

Require the full card and nested-code rules:

```ts
expect(appCss).toMatch(
  /\.cm-live-preview-quote-line\s*\{[^}]*background:\s*var\(--surface\);[^}]*border-left:\s*2px solid var\(--divider\);[^}]*padding-inline:/s,
);
expect(appCss).toMatch(
  /\.cm-live-preview-quote-line-single\s*\{[^}]*border-radius:\s*var\(--radius-medium\);[^}]*padding-block:/s,
);
expect(appCss).toMatch(
  /\.cm-live-preview-highlight \.cm-live-preview-inline-code,[^{]*\{[^}]*background:\s*var\(--highlight\);/s,
);
```

- [ ] **Step 2: Run the stylesheet test and verify RED**

Run:

```bash
npm test -- src/app/accessibility.test.tsx
```

Expected: FAIL because quote-line and nested highlighted-code rules do not exist.

- [ ] **Step 3: Add token-driven card styling**

Replace fragment-only quote spacing with line-level presentation:

```css
.cm-live-preview-quote {
  color: var(--text-secondary);
}

.cm-live-preview-quote-line {
  box-sizing: border-box;
  width: 100%;
  background: var(--surface);
  border-left: 2px solid var(--divider);
  padding-inline: var(--space-5);
}

.cm-live-preview-quote-line-single {
  border-radius: var(--radius-medium);
  padding-block: var(--space-3);
}

.cm-live-preview-quote-line-first {
  border-radius: var(--radius-medium) var(--radius-medium) 0 0;
  padding-top: var(--space-3);
}

.cm-live-preview-quote-line-last {
  border-radius: 0 0 var(--radius-medium) var(--radius-medium);
  padding-bottom: var(--space-3);
}

.cm-live-preview-highlight .cm-live-preview-inline-code,
.cm-live-preview-inline-code.cm-live-preview-highlight {
  background: var(--highlight);
  border-color: var(--divider);
}
```

Remove the duplicate `borderLeft` rule for `.cm-live-preview-quote` from `livePreviewTheme`; line decorations now own the rail.

- [ ] **Step 4: Run focused style and DOM tests**

Run:

```bash
npm test -- src/app/accessibility.test.tsx src/editor/livePreview.test.ts src/editor/MarkdownEditor.test.tsx
```

Expected: PASS.

### Task 4: Validate, build, install, and commit

**Files:**
- Verify: `src/editor/livePreview.ts`
- Verify: `src/editor/livePreview.test.ts`
- Verify: `src/theme/app.css`
- Verify: `src/app/accessibility.test.tsx`

- [ ] **Step 1: Run complete frontend validation**

Run:

```bash
npm test
npm run build
npm run test:e2e
```

Expected: all Vitest and 8 Playwright tests pass; Vite production build succeeds.

- [ ] **Step 2: Run Rust validation**

Run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: formatting and Clippy pass; all Rust tests pass.

- [ ] **Step 3: Build and verify the macOS app**

Run:

```bash
npm run tauri build -- --bundles app
codesign --force --deep --sign - --entitlements src-tauri/entitlements.plist src-tauri/target/release/bundle/macos/Opus.app
./scripts/verify-macos-bundle.sh src-tauri/target/release/bundle/macos/Opus.app
```

Expected: ARM64 `Opus.app` builds and passes strict local signature and bundle checks.

- [ ] **Step 4: Back up and install without launching**

Confirm `/Applications/Opus.app` is not running. Move it to a uniquely named directory under `/private/tmp`, install the verified bundle with `ditto`, and run `verify-macos-bundle.sh` against the installed app. Compare SHA-256 hashes of the built and installed executables.

- [ ] **Step 5: Commit the implementation**

```bash
git add src/editor/livePreview.ts src/editor/livePreview.test.ts \
  src/theme/app.css src/app/accessibility.test.tsx
git commit -m "fix: match blockquote highlight rendering"
```

Expected: commit succeeds and `git status --short` is empty.
