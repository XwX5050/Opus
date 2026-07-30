# Outline Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a resizable, accessible right-hand outline that reflects the active Markdown document, preserves per-tab branch state during the current run, navigates correctly in both view modes, and always starts closed after an app restart.

**Architecture:** CodeMirror owns heading extraction through its existing Lezer Markdown tree and publishes immutable outline trees to `AppShell`. The shell owns runtime panel state, per-tab outline/branch caches, navigation sequencing, and persisted width. A recursive `OutlinePanel` renders the tree; `MarkdownEditor` consumes navigation requests without changing document text or undo history.

**Tech Stack:** React 19, strict TypeScript, CodeMirror 6, Lezer Markdown, CSS design tokens, Vitest/Testing Library, Playwright, Tauri 2, Rust verification, macOS codesign.

---

## File Structure

**Create**

- `src/editor/outline.ts` — outline data types, Lezer extraction, stable hierarchy IDs, parent-ID helpers.
- `src/editor/outline.test.ts` — ATX/Setext, hierarchy, duplicate, empty, and code-block regression tests.
- `src/editor/outlineExtension.ts` — debounced and generation-safe CodeMirror publisher.
- `src/editor/outlineExtension.test.ts` — real `EditorView` publication and stale-work tests.
- `src/editor/OutlinePanel.tsx` — toolbar, nested tree, disclosure controls, loading/empty states.
- `src/editor/OutlinePanel.test.tsx` — component interaction and accessibility tests.

**Modify**

- `src/document/types.ts` — persisted outline width type, defaults, clamp/normalization.
- `src/document/memoryDocumentPort.ts` — clone outline preferences.
- `src/document/memoryDocumentPort.test.ts` — persistence clone coverage.
- `src/document/tauriDocumentPort.ts` — sanitize outline preferences.
- `src/document/tauriDocumentPort.test.ts` — malformed/default/clamp coverage.
- `src/app/useAppController.ts` — restore and persist width only.
- `src/app/useAppController.test.tsx` — startup/session persistence coverage.
- `src/editor/MarkdownEditor.tsx` — install publisher and consume navigation requests.
- `src/editor/MarkdownEditor.test.tsx` — real-editor navigation coverage.
- `src/app/icons.tsx` — approved tree, collapse-all, right-panel, and disclosure icons.
- `src/app/AppShell.tsx` — titlebar toggle, per-tab state, right rail, and mirrored resizer.
- `src/app/AppShell.test.tsx` — shell behavior, tab state, resize, and launch-collapse coverage.
- `src/theme/app.css` — right panel, tree, animation, focus, and icon styles.
- `src/app/accessibility.test.tsx` — titlebar order, hit targets, inert rail, and motion rules.
- `tests/e2e/notepad.spec.ts` — browser workflow across hierarchy, tabs, modes, and resizing.

## Task 1: Persist Only the Outline Width

- [ ] **Step 1: Add failing type/port tests**

In `src/document/tauriDocumentPort.test.ts`, extend the session round-trip and add:

```ts
it("normalizes the persisted outline width without accepting open state", async () => {
  const base = {
    recent: [],
    openPaths: [],
    activePath: null,
    workspacePath: null,
  };
  storeMocks.values.set("session", {
    ...base,
    outline: { width: 40, open: true },
  });
  await expect(createTauriDocumentPort().loadSession()).resolves.toEqual({
    ...base,
    outline: { width: 200 },
  });

  storeMocks.values.set("session", {
    ...base,
    outline: { width: 9999 },
  });
  await expect(createTauriDocumentPort().loadSession()).resolves.toEqual({
    ...base,
    outline: { width: 480 },
  });
});
```

In `src/document/memoryDocumentPort.test.ts`, persist `{ outline: { width: 336 } }` and assert `loaded?.outline` is equal but not the same object.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```sh
npm test -- src/document/tauriDocumentPort.test.ts src/document/memoryDocumentPort.test.ts
```

Expected: TypeScript or assertions fail because `PersistedSession` and the ports do not yet support `outline`.

- [ ] **Step 3: Add the preference model and serialization**

In `src/document/types.ts`, add:

```ts
export interface OutlinePreferences {
  readonly width: number;
}

export const DEFAULT_OUTLINE_PREFERENCES: OutlinePreferences = { width: 300 };

export const normalizeOutlinePreferences = (
  value: unknown,
): OutlinePreferences => {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_OUTLINE_PREFERENCES };
  }
  const width = (value as Record<string, unknown>).width;
  return {
    width:
      typeof width === "number" && Number.isFinite(width)
        ? clampSidebarWidth(width)
        : DEFAULT_OUTLINE_PREFERENCES.width,
  };
};
```

Add `readonly outline?: OutlinePreferences` to `PersistedSession`. Do not add an `open` or `collapsed` field.

In `src/document/tauriDocumentPort.ts`, import `normalizeOutlinePreferences` and append:

```ts
...(record.outline !== undefined
  ? { outline: normalizeOutlinePreferences(record.outline) }
  : {}),
```

In `src/document/memoryDocumentPort.ts`, append:

```ts
...(session.outline !== undefined
  ? { outline: { ...session.outline } }
  : {}),
```

- [ ] **Step 4: Restore and save width in the controller**

In `src/app/useAppController.ts`, initialize:

```ts
const [outlinePreferences, setOutlinePreferences] =
  useState<OutlinePreferences>(DEFAULT_OUTLINE_PREFERENCES);
```

Normalize `session.outline` after loading, include `outline: outlinePreferences` in `saveSession`, add it to the persistence effect dependencies, and return both values. Add a controller test that seeds width `348`, expects restoration, changes it to `372`, and waits for `port.session?.outline` to equal `{ width: 372 }`.

- [ ] **Step 5: Run focused tests and commit**

Run:

```sh
npm test -- src/document/tauriDocumentPort.test.ts src/document/memoryDocumentPort.test.ts src/app/useAppController.test.tsx
git add src/document/types.ts src/document/tauriDocumentPort.ts src/document/tauriDocumentPort.test.ts src/document/memoryDocumentPort.ts src/document/memoryDocumentPort.test.ts src/app/useAppController.ts src/app/useAppController.test.tsx
git commit -m "feat: persist outline sidebar width"
```

Expected: focused tests pass; the stored object contains width only.

## Task 2: Extract a Stable Hierarchical Outline from Lezer

- [ ] **Step 1: Write parser regression tests**

Create `src/editor/outline.test.ts` with an `EditorState` using `markdown()` and assertions covering:

```ts
const source = [
  "# Alpha *one*",
  "## Child",
  "#### Skipped",
  "## Child",
  "#",
  "Setext title",
  "-------------",
  "```md",
  "# fenced fake",
  "```",
  "    # indented fake",
].join("\n");
```

Assert:

- root labels are `["Alpha *one*", "无标题", "Setext title"]`;
- `Child` is nested under `Alpha *one*`;
- `Skipped` is nested under the first `Child`;
- duplicate `Child` rows have distinct IDs;
- all `from` values point to real heading starts;
- `textFrom` for `Alpha` points at `A`;
- fenced and indented fake headings are absent;
- inserting plain text before the headings leaves their IDs unchanged.

- [ ] **Step 2: Confirm the test fails**

Run:

```sh
npm test -- src/editor/outline.test.ts
```

Expected: module resolution fails for `./outline`.

- [ ] **Step 3: Implement extraction and hierarchy**

Create `src/editor/outline.ts` with these public contracts:

```ts
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface OutlineHeading {
  readonly id: string;
  readonly level: HeadingLevel;
  readonly text: string;
  readonly from: number;
  readonly textFrom: number;
  readonly children: ReadonlyArray<OutlineHeading>;
}

export function extractOutline(state: EditorState): ReadonlyArray<OutlineHeading>;
export function collectOutlineParentIds(
  headings: ReadonlyArray<OutlineHeading>,
): ReadonlySet<string>;
export function collectOutlineIds(
  headings: ReadonlyArray<OutlineHeading>,
): ReadonlySet<string>;
```

Walk `syntaxTree(state)` and accept only node names matching `/^(ATX|Setext)Heading([1-6])$/`. Inspect direct `HeaderMark` children:

- ATX: label starts after the opening mark and following spaces; it ends before an optional closing mark and preceding spaces.
- Setext: label starts at the heading node start and ends before the underline mark/newline.
- blank trimmed labels become `无标题`;
- `from` is the heading node start and `textFrom` is the first label character, or the end of the opening marker for an empty ATX heading.

Build the tree with a stack. Pop while the previous heading level is greater than or equal to the incoming level. Generate IDs from the normalized ancestor text path plus a document-order occurrence count:

```ts
const pathKey = [...stack.map((entry) => entry.text), text]
  .map((part) => part.normalize("NFKC").trim().toLocaleLowerCase())
  .join("\u001f");
const occurrence = (occurrences.get(pathKey) ?? 0) + 1;
occurrences.set(pathKey, occurrence);
const id = `${encodeURIComponent(pathKey)}:${occurrence}`;
```

Do not include source offsets in IDs.

- [ ] **Step 4: Run and commit**

Run:

```sh
npm test -- src/editor/outline.test.ts
git add src/editor/outline.ts src/editor/outline.test.ts
git commit -m "feat: derive outline from markdown syntax tree"
```

Expected: all extraction cases pass.

## Task 3: Publish Outline Updates Without Blocking Typing

- [ ] **Step 1: Write real-editor timing tests**

Create `src/editor/outlineExtension.test.ts` using `vi.useFakeTimers()` and a real `EditorView`. Verify:

1. initial `# One` publishes once;
2. three rapid document changes within 120ms publish only the last outline;
3. destroying the view before the timer/idle callback prevents publication;
4. a change that removes a heading publishes an empty array.

The test should install:

```ts
outlinePublisherExtension((headings) => published.push(headings), {
  debounceMs: 120,
  parseSliceMs: 20,
})
```

- [ ] **Step 2: Confirm failure**

Run:

```sh
npm test -- src/editor/outlineExtension.test.ts
```

Expected: module resolution fails for `./outlineExtension`.

- [ ] **Step 3: Implement the generation-safe publisher**

Create `src/editor/outlineExtension.ts` with:

```ts
export interface OutlinePublisherOptions {
  readonly debounceMs?: number;
  readonly parseSliceMs?: number;
}

export const outlinePublisherExtension = (
  publish: (headings: ReadonlyArray<OutlineHeading>) => void,
  options: OutlinePublisherOptions = {},
): Extension => ViewPlugin.define((view) =>
  new OutlinePublisher(view, publish, options),
);
```

`OutlinePublisher` must:

- schedule the initial parse immediately;
- reschedule with a 120ms timeout only on `update.docChanged`;
- increment a generation on every reschedule and on destroy;
- call `forceParsing(view, view.state.doc.length, 20)`;
- if parsing is incomplete, continue in `requestIdleCallback`, with a `setTimeout(..., 0)` fallback;
- compare the captured generation before every parse/publish;
- cancel both timeout and idle handles in `destroy`;
- publish `extractOutline(view.state)` only after parsing reaches the document end.

- [ ] **Step 4: Run and commit**

Run:

```sh
npm test -- src/editor/outlineExtension.test.ts src/editor/outline.test.ts
git add src/editor/outlineExtension.ts src/editor/outlineExtension.test.ts
git commit -m "feat: publish live document outlines"
```

Expected: debouncing and stale-generation tests pass.

## Task 4: Add Mode-Specific Editor Navigation

- [ ] **Step 1: Add failing `MarkdownEditor` tests**

In `src/editor/MarkdownEditor.test.tsx`, add a heading-rich fixture and a helper that captures the real view. Test this request:

```ts
const navigation = {
  sequence: 1,
  from: 0,
  textFrom: 2,
};
```

Editing-mode expectations:

- selection head becomes `2`;
- `document.activeElement` is the CodeMirror content element;
- document text and undo history are unchanged.

Reading-mode expectations:

- previous selection and focus remain unchanged;
- `EditorView.scrollIntoView` is dispatched for `from`;
- document text is unchanged.

Also assert that repeating sequence `1` is ignored and sequence `2` is consumed.

- [ ] **Step 2: Run and confirm failure**

Run:

```sh
npm test -- src/editor/MarkdownEditor.test.tsx
```

Expected: the component does not accept outline callbacks or navigation.

- [ ] **Step 3: Wire publication and navigation**

Add:

```ts
export interface OutlineNavigationRequest {
  readonly sequence: number;
  readonly from: number;
  readonly textFrom: number;
}
```

Extend `MarkdownEditorProps` with:

```ts
onOutlineChange?(headings: ReadonlyArray<OutlineHeading>): void;
outlineNavigation?: OutlineNavigationRequest | null;
```

Keep `onOutlineChange` in the existing live callbacks ref and install:

```ts
outlinePublisherExtension((headings) =>
  callbacksRef.current.onOutlineChange?.(headings),
)
```

Consume a newer request in an effect:

```ts
const position =
  viewMode === "reading" ? outlineNavigation.from : outlineNavigation.textFrom;
view.dispatch({
  ...(viewMode === "editing" ? { selection: { anchor: position } } : {}),
  effects: EditorView.scrollIntoView(position, {
    y: "start",
    yMargin: 24,
  }),
});
if (viewMode === "editing") view.focus();
```

Track the last consumed sequence in a ref. Do not add history annotations or text changes.

- [ ] **Step 4: Run and commit**

Run:

```sh
npm test -- src/editor/MarkdownEditor.test.tsx src/editor/outlineExtension.test.ts
git add src/editor/MarkdownEditor.tsx src/editor/MarkdownEditor.test.tsx
git commit -m "feat: navigate from outline headings"
```

Expected: editing moves/focuses; reading scrolls without changing selection/focus.

## Task 5: Build the Recursive Panel and Approved Icons

- [ ] **Step 1: Write component tests**

Create `src/editor/OutlinePanel.test.tsx` with a three-level tree. Verify:

- `null` headings shows `正在生成大纲…`;
- `[]` shows `当前文档没有标题`;
- root uses `role="tree"` and accessible name `文档大纲`;
- parent disclosures have `aria-expanded`;
- clicking only a disclosure calls `onToggle(id)` and not `onNavigate`;
- clicking only a label calls `onNavigate(heading)`;
- collapsed parents hide descendants;
- `全部折叠` calls `onCollapseAll` and is disabled with no parents or when all parents are collapsed;
- `收起右侧栏` calls `onClose`;
- all icon-only buttons have accessible labels.

- [ ] **Step 2: Confirm failure**

Run:

```sh
npm test -- src/editor/OutlinePanel.test.tsx
```

Expected: module resolution fails for `./OutlinePanel`.

- [ ] **Step 3: Add icons without changing existing titlebar icons**

In `src/app/icons.tsx`, add separate outline SVG defaults:

```ts
const outlineIconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
```

Add:

- `ListTreeIcon`: three quiet hierarchy/list strokes matching the Obsidian titlebar reference.
- `PanelRightIcon`: rounded rectangle with a vertical divider near the right edge.
- `CollapseAllIcon`: upper `M6 8l6 6 6-6` and lower `M6 16l6-6 6 6`, positioned so the tips have an approximately 6px vertical gap rather than forming an X.
- `DisclosureChevronIcon`: a smaller single chevron that rotates through CSS.

Keep the existing `iconProps` at 20px/2px unchanged.

- [ ] **Step 4: Implement the panel**

Create `src/editor/OutlinePanel.tsx` with:

```ts
interface OutlinePanelProps {
  readonly headings: ReadonlyArray<OutlineHeading> | null;
  readonly collapsedIds: ReadonlySet<string>;
  onToggle(id: string): void;
  onCollapseAll(): void;
  onNavigate(heading: OutlineHeading): void;
  onClose(): void;
}
```

Render toolbar order `大纲`, `全部折叠`, `收起右侧栏`. Render nested `<ul>` elements with root `role="tree" aria-label="文档大纲"` and nested `role="group"`. Put disclosure and label in separate buttons. Add `aria-level`, visible `:focus-visible`, title tooltips, and text ellipsis.

- [ ] **Step 5: Run and commit**

Run:

```sh
npm test -- src/editor/OutlinePanel.test.tsx src/app/accessibility.test.tsx
git add src/app/icons.tsx src/editor/OutlinePanel.tsx src/editor/OutlinePanel.test.tsx
git commit -m "feat: add accessible outline panel"
```

Expected: panel states and separate disclosure/label actions pass.

## Task 6: Integrate Per-Tab State, Titlebar Toggle, and Right Resizing

- [ ] **Step 1: Add failing shell tests**

In `src/app/AppShell.test.tsx`, add tests that:

1. place the outline button immediately after the view-mode button;
2. verify it is absent in the empty state;
3. open it and assert `aria-expanded="true"` and `aria-controls="app-outline"`;
4. close with the toolbar right-panel button;
5. keep `.outline-rail` mounted, inert, hidden, and width `0px` while closed;
6. restore width `340px` from a session but still start closed;
7. resize from the left edge: dragging left expands; dragging right shrinks; clamp to 200–480px;
8. preserve the open panel across tab switches;
9. preserve distinct collapsed branch sets per tab;
10. prune removed heading IDs after live edits;
11. remove cached state when a tab closes;
12. issue editing/reading navigation requests without changing modes.

- [ ] **Step 2: Confirm shell tests fail**

Run:

```sh
npm test -- src/app/AppShell.test.tsx
```

Expected: no outline toggle, rail, resizer, or per-tab state exists.

- [ ] **Step 3: Add runtime state in `AppShell`**

Initialize:

```ts
const [outlineOpen, setOutlineOpen] = useState(false);
const [outlinesByTab, setOutlinesByTab] =
  useState(new Map<string, ReadonlyArray<OutlineHeading> | null>());
const [collapsedOutlineIdsByTab, setCollapsedOutlineIdsByTab] =
  useState(new Map<string, ReadonlySet<string>>());
const [outlineNavigation, setOutlineNavigation] =
  useState<(OutlineNavigationRequest & { readonly tabId: string }) | null>(null);
const outlineSequenceRef = useRef(0);
```

On publication:

- store the active tab's tree;
- default a new tab to an empty collapsed set;
- intersect an existing set with `collectOutlineIds(headings)`.

On tab list changes, delete cache entries whose tab IDs no longer exist. Do not reset `outlineOpen` when the active tab changes. Pass a navigation request only when its `tabId` equals the mounted active tab.

- [ ] **Step 4: Add the titlebar and right rail**

Immediately after `.view-mode-toggle`, render:

```tsx
<button
  type="button"
  className="icon-button outline-toggle"
  aria-label={outlineOpen ? "收起大纲" : "展开大纲"}
  aria-expanded={outlineOpen}
  aria-controls="app-outline"
  onClick={() => setOutlineOpen((open) => !open)}
>
  <ListTreeIcon />
</button>
```

After `.editor-area`, render a mirrored separator and:

```tsx
<div
  className="outline-rail"
  data-collapsed={!outlineOpen}
  style={{ width: outlineOpen ? outlineDragWidth ?? outline.width : 0 }}
>
  <aside
    id="app-outline"
    aria-label="大纲侧栏"
    aria-hidden={!outlineOpen || undefined}
    inert={!outlineOpen || undefined}
    className="outline-sidebar"
    style={{ width: outlineDragWidth ?? outline.width }}
  >
    <OutlinePanel ... />
  </aside>
</div>
```

Use `startWidth + startX - event.clientX` for pointer resizing. For keyboard resizing, ArrowLeft increases width by 16px and ArrowRight decreases it. Commit width only on pointer-up.

- [ ] **Step 5: Run and commit**

Run:

```sh
npm test -- src/app/AppShell.test.tsx src/editor/MarkdownEditor.test.tsx
git add src/app/AppShell.tsx src/app/AppShell.test.tsx
git commit -m "feat: integrate right outline sidebar"
```

Expected: runtime state remains per tab, startup remains closed, and width persists.

## Task 7: Match the Approved Obsidian-Like Visual Treatment

- [ ] **Step 1: Add CSS contract tests**

In `src/app/accessibility.test.tsx`, assert:

- `.outline-rail` uses `width var(--transition-sidebar)` and opacity transition;
- collapsed rail has `opacity: 0`, `visibility: hidden`, and no pointer events;
- `.outline-sidebar` fills height and uses a left divider;
- `.outline-icon-button` is 36×36px;
- `.outline-collapse-all svg` is 18×18px;
- disclosure chevrons rotate without changing layout;
- `.outline-resizer` has the same 6px hit area as the left resizer;
- `prefers-reduced-motion` disables rail and chevron transitions.

- [ ] **Step 2: Confirm style assertions fail**

Run:

```sh
npm test -- src/app/accessibility.test.tsx
```

Expected: the new selectors and reduced-motion rules are absent.

- [ ] **Step 3: Add token-driven styles**

In `src/theme/app.css`:

- mirror `.sidebar-rail` as `.outline-rail`;
- make `.outline-sidebar` a full-height flex column with `border-left`;
- place `.outline-resizer` before the rail and mirror hover/accent behavior;
- use 36px ghost buttons, 18px icons, muted gray, rounded stroke endpoints;
- use compact nested rows, subdued 12–14px text, increasing logical `padding-inline-start`, ellipsis, and visible keyboard focus;
- rotate one disclosure chevron 90 degrees when expanded;
- keep the two collapse-all chevrons separated by the approved gap;
- disable nonessential transitions in the existing reduced-motion media query.

- [ ] **Step 4: Run component/accessibility suites and commit**

Run:

```sh
npm test -- src/app/accessibility.test.tsx src/editor/OutlinePanel.test.tsx src/app/AppShell.test.tsx
git add src/theme/app.css src/app/accessibility.test.tsx
git commit -m "style: refine outline sidebar controls"
```

Expected: layout contracts and interaction suites pass.

## Task 8: Cover the Complete Browser Workflow

- [ ] **Step 1: Add the E2E fixture shape**

In `tests/e2e/notepad.spec.ts`, extend the session fixture with:

```ts
outline?: { width: number };
```

Seed two documents with nested, duplicate, skipped-level, and empty headings.

- [ ] **Step 2: Add one end-to-end outline workflow**

The Playwright test must:

1. verify the outline is initially closed despite persisted width;
2. open it from the titlebar and verify nested labels;
3. fold one branch with its disclosure without navigating;
4. use `全部折叠`;
5. click a label in editing mode and assert editor focus/cursor position;
6. switch to reading mode, click another label, and assert mode remains reading;
7. switch tabs and verify the panel stays open while branch state is independent;
8. drag the right separator and inspect the new width;
9. close and reopen the panel, retaining width and current-run branch state.

- [ ] **Step 3: Run E2E and commit**

Run:

```sh
npm run test:e2e
git add tests/e2e/notepad.spec.ts
git commit -m "test: cover outline sidebar workflow"
```

Expected: all browser-shell tests pass, including the new outline workflow.

## Task 9: Full Verification, Native Acceptance, and App Update

- [ ] **Step 1: Run repository-wide automated checks**

Run:

```sh
npm run check
npm run test:e2e
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Expected: Vitest, TypeScript/Vite build, Rust tests, Playwright, formatting, and Clippy all pass.

- [ ] **Step 2: Run the native visual/interaction checklist**

Run `npm run tauri dev` and check in both dark and light themes:

- titlebar order and 36px hit targets;
- approved 18px collapse-all icon with a clear gap between chevrons;
- full-height right panel and mirrored 160ms animation;
- 200/300/480px widths and separator cursor;
- long Chinese headings, duplicate headings, empty headings, and ellipsis;
- pointer and keyboard disclosure/navigation;
- editing cursor placement and reading scroll-only behavior;
- tab switching, close/reopen, and launch-time collapsed state;
- no Chinese IME regression while the outline refreshes.

- [ ] **Step 3: Build, sign, and verify the local app**

Run:

```sh
npm run tauri build -- --bundles app
codesign --force --deep --sign - --entitlements src-tauri/entitlements.plist \
  src-tauri/target/release/bundle/macos/Opus.app
./scripts/verify-macos-bundle.sh \
  src-tauri/target/release/bundle/macos/Opus.app
file src-tauri/target/release/bundle/macos/Opus.app/Contents/MacOS/app
```

Expected: an ARM64 `Opus.app` is built and strict local bundle verification passes with the documented ad-hoc-signature notice.

- [ ] **Step 4: Review, integrate, and update `/Applications/Opus.app`**

Use `superpowers:requesting-code-review`, resolve findings, and rerun affected tests. Then use `superpowers:finishing-a-development-branch`.

After the user-approved merge, confirm Opus is not running, move the installed app into a unique `/private/tmp/opus-before-outline.XXXXXX` backup directory, install the verified bundle with `ditto`, compare built/installed executable SHA-256 hashes, and verify the installed bundle. Do not auto-launch it and do not touch user documents, preferences, or recovery drafts.

- [ ] **Step 5: Final repository checks**

Run:

```sh
git status --short
git log --oneline --decorate -8
```

Expected: only the user's pre-existing untracked `.DS_Store` remains in the main workspace; all feature changes are committed and traceable.

## Plan Self-Review

- [ ] Every behavior in `docs/superpowers/specs/2026-07-30-outline-sidebar-design.md` maps to a task and automated or native verification.
- [ ] Run an unresolved-marker scan; it must return no implementation gaps.
- [ ] Confirm `OutlineHeading`, `OutlineNavigationRequest`, and `OutlinePreferences` have one canonical definition each and all imports are type-only where appropriate.
- [ ] Confirm no Rust command, Markdown source mutation, filename root node, active-heading scroll spy, or persisted open/branch state was introduced.
