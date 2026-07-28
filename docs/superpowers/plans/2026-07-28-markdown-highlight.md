# Markdown Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse and render `==text==` as an Obsidian-style highlight with source-marker reveal in editing mode and marker hiding in reading mode.

**Architecture:** Add one focused Lezer inline extension to the production Markdown tree, then teach the existing live-preview planner to style the content range and replace only the two delimiter nodes. Keep colors in theme tokens and reuse the current selection, reading-mode, viewport, and IME composition machinery.

**Tech Stack:** TypeScript, Lezer Markdown, CodeMirror 6, React, CSS custom properties, Vitest, Playwright, Tauri 2.

---

### Task 1: Add the highlight syntax node

**Files:**
- Create: `src/editor/highlightExtension.ts`
- Create: `src/editor/highlightExtension.test.ts`
- Modify: `src/editor/editorExtensions.ts`
- Modify: `src/editor/editorExtensions.test.ts`

- [ ] **Step 1: Write a failing production-tree test**

Extend the existing production parser test:

```ts
const state = EditorState.create({
  doc: "~~done~~ and $x^2$ and ==重点==",
  extensions: [
    editorExtensions({
      onSave: vi.fn(),
      onReopenClosed: vi.fn(),
      onToggleReading: vi.fn(),
    }),
  ],
});

const tree = syntaxTree(state).toString();
expect(tree).toContain("Strikethrough");
expect(tree).toContain("InlineMath");
expect(tree).toContain("Highlight(HighlightMark");
```

- [ ] **Step 2: Run the production-tree test and verify RED**

Run:

```bash
npm test -- src/editor/editorExtensions.test.ts
```

Expected: FAIL because the tree does not contain `Highlight`.

- [ ] **Step 3: Add the minimal Lezer extension and register it**

Create `highlightExtension.ts` with exported `Highlight`, `HighlightMark`, and `highlightMarkdownExtension`. Its inline parser starts on exactly two `=` characters, finds a same-line closing pair, creates explicit mark children, and parses the interior through `cx.parser.parseInline`:

```ts
import { tags } from "@lezer/highlight";
import type { MarkdownExtension } from "@lezer/markdown";

export const Highlight = "Highlight";
export const HighlightMark = "HighlightMark";

const equals = 61;
const backslash = 92;
const isWhitespace = (character: number) =>
  character === 9 || character === 10 || character === 13 || character === 32;

export const highlightMarkdownExtension: MarkdownExtension = {
  defineNodes: [
    Highlight,
    { name: HighlightMark, style: tags.processingInstruction },
  ],
  parseInline: [{
    name: Highlight,
    after: "Emphasis",
    parse(cx, next, pos) {
      if (
        next !== equals ||
        cx.char(pos + 1) !== equals ||
        cx.char(pos + 2) === equals ||
        isWhitespace(cx.char(pos + 2))
      ) return -1;

      for (let cursor = pos + 2; cursor < cx.end - 1; cursor += 1) {
        const character = cx.char(cursor);
        if (character === 10 || character === 13) return -1;
        if (character === backslash) {
          cursor += 1;
          continue;
        }
        if (
          character === equals &&
          cx.char(cursor + 1) === equals &&
          cx.char(cursor + 2) !== equals &&
          !isWhitespace(cx.char(cursor - 1))
        ) {
          return cx.addElement(cx.elt(Highlight, pos, cursor + 2, [
            cx.elt(HighlightMark, pos, pos + 2),
            ...cx.parser.parseInline(cx.slice(pos + 2, cursor), pos + 2),
            cx.elt(HighlightMark, cursor, cursor + 2),
          ]));
        }
      }
      return -1;
    },
  }],
};
```

Import it in `editorExtensions.ts` and add it after `GFM` in the `markdown({ extensions: [...] })` list.

- [ ] **Step 4: Run the production-tree test and verify GREEN**

Run:

```bash
npm test -- src/editor/editorExtensions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add focused parser coverage**

Create `highlightExtension.test.ts` using a real `EditorState` and syntax tree. Assert:

```ts
expect(nodesNamed(parse("中文 ==重点==，==相邻=="), Highlight)).toEqual([
  { from: 3, to: 9, source: "==重点==" },
  { from: 10, to: 16, source: "==相邻==" },
]);
```

Table-test escaped opening/closing delimiters, empty `====`, triples, whitespace after the opener, whitespace before the closer, unmatched pairs, and multiline pairs as producing no `Highlight`. Assert that `` `==code==` ``, fenced code, and `\\==escaped==` remain outside highlight nodes. Assert `==**bold** and [link](url)==` contains nested `StrongEmphasis` and `Link` nodes.

- [ ] **Step 6: Run parser tests**

Run:

```bash
npm test -- src/editor/highlightExtension.test.ts src/editor/editorExtensions.test.ts
```

Expected: PASS.

### Task 2: Integrate highlight with live preview

**Files:**
- Modify: `src/editor/livePreview.ts`
- Modify: `src/editor/livePreview.test.ts`

- [ ] **Step 1: Write failing live-preview tests**

Configure the test Markdown tree with `highlightMarkdownExtension`. Add tests asserting:

```ts
const state = createState("==重点== outside", [{ anchor: 10 }]);
const plan = planLivePreview(state);
expect(hiddenSource(state, plan)).toEqual(["==", "=="]);
expect(markedAs(plan, "cm-live-preview-highlight")).toEqual([
  { from: 2, to: 4, kind: "mark", className: "cm-live-preview-highlight" },
]);
```

Also assert a cursor inside the content reveals both markers while retaining the mark, and `revealSelection: false` hides markers even when the cursor is inside.

- [ ] **Step 2: Run live-preview tests and verify RED**

Run:

```bash
npm test -- src/editor/livePreview.test.ts
```

Expected: FAIL because `Highlight` is not a recognized preview structure.

- [ ] **Step 3: Add highlight planning**

In `livePreview.ts`:

```ts
import { Highlight, HighlightMark } from "./highlightExtension";
```

Add `Highlight` to `structureNames`, map it to `cm-live-preview-highlight`, and replace only `HighlightMark`. When planning the mark decoration, trim two code units from each side:

```ts
const markFrom =
  structure.node.name === Highlight ? structure.node.from + 2 : structure.node.from;
const markTo =
  structure.node.name === Highlight ? structure.node.to - 2 : structure.node.to;
```

Use `markFrom` and `markTo` for the mark plan while keeping the owner’s full range for selection intersection and marker reveal.

- [ ] **Step 4: Verify live-preview behavior**

Run:

```bash
npm test -- src/editor/livePreview.test.ts src/editor/MarkdownEditor.test.tsx
```

Expected: PASS, including reading mode, composition, and atomic-range tests.

### Task 3: Add theme styling

**Files:**
- Modify: `src/theme/tokens.css`
- Modify: `src/theme/app.css`
- Modify: `src/app/accessibility.test.tsx`

- [ ] **Step 1: Write failing token and style tests**

Add assertions requiring one dark token, one light token, and token-driven component CSS:

```ts
expect(tokensCss).toContain("--highlight: #796a32;");
expect(tokensCss).toContain("--highlight: #ffec99;");
expect(appCss).toMatch(
  /\.cm-live-preview-highlight\s*\{[^}]*background:\s*var\(--highlight\);[^}]*border-radius:\s*var\(--radius-small\);[^}]*padding-inline:\s*var\(--space-0-5\);/s,
);
```

- [ ] **Step 2: Run the stylesheet test and verify RED**

Run:

```bash
npm test -- src/app/accessibility.test.tsx
```

Expected: FAIL because `--highlight` and `.cm-live-preview-highlight` are absent.

- [ ] **Step 3: Add the theme token and component style**

Add `--highlight: #796a32;` to the dark token block and `--highlight: #ffec99;` to the light token block. Add:

```css
.cm-live-preview-highlight {
  background: var(--highlight);
  border-radius: var(--radius-small);
  padding-inline: var(--space-0-5);
}
```

- [ ] **Step 4: Verify theme styling**

Run:

```bash
npm test -- src/app/accessibility.test.tsx src/editor/livePreview.test.ts
```

Expected: PASS.

### Task 4: Validate, build, install, and commit

**Files:**
- Verify: all modified source and test files
- Build: `src-tauri/target/release/bundle/macos/Opus.app`
- Install: `/Applications/Opus.app`

- [ ] **Step 1: Run repository checks**

```bash
git diff --check
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:e2e
```

Expected: all frontend, Rust, and E2E tests pass; build, formatting, and Clippy succeed.

- [ ] **Step 2: Build and verify the app**

```bash
npm run tauri build -- --bundles app
codesign --force --deep --sign - --entitlements src-tauri/entitlements.plist src-tauri/target/release/bundle/macos/Opus.app
./scripts/verify-macos-bundle.sh src-tauri/target/release/bundle/macos/Opus.app
```

Expected: strict verification passes with the documented local ad-hoc-signature notice.

- [ ] **Step 3: Install without launching**

Confirm Opus is not running, move `/Applications/Opus.app` into a unique `/private/tmp/opus-before-highlight.XXXXXX` directory, copy the verified bundle into `/Applications`, and verify its signature, ARM64 architecture, display name, and binary hash.

- [ ] **Step 4: Commit the focused feature**

```bash
git add src/editor/highlightExtension.ts src/editor/highlightExtension.test.ts src/editor/editorExtensions.ts src/editor/editorExtensions.test.ts src/editor/livePreview.ts src/editor/livePreview.test.ts src/theme/tokens.css src/theme/app.css src/app/accessibility.test.tsx
git commit -m "feat: render markdown highlights"
git status --short
```

Expected: the feature commit succeeds and the final working tree is clean.
