# Activity Rail and Welcome Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent activity rail and a single-column welcome screen with bounded recent-file display.

**Architecture:** Keep navigation in `AppShell` and welcome presentation in a new focused component. Reuse existing controller/sidebar/session state and document-port behavior; add no backend or dependency.

**Tech Stack:** React 19, strict TypeScript, existing CSS tokens, Vitest, Playwright.

---

### Task 1: Persistent activity rail

**Files:** `src/app/AppShell.tsx`, `src/theme/app.css`, related shell tests.

- [x] Write failing tests for rail presence when the explorer is collapsed and for one settings entry.
- [x] Add a 44 px navigation rail before the explorer. Put the existing sidebar toggle at its top and settings at its bottom.
- [x] Remove the titlebar toggle, explorer footer gear, and empty-state floating gear without changing preference persistence or dialog behavior.
- [x] Verify collapsed, expanded, restored-session, and custom Windows/Linux header behavior.

### Task 2: Welcome component

**Files:** create `src/app/WelcomeScreen.tsx`, `src/app/welcome.css`, `src/app/WelcomeScreen.test.tsx`; modify `src/app/AppShell.tsx`.

- [x] Write failing tests for title/actions, first-five items, remaining-item disclosure, compact display paths with full accessible paths, activation, and shortcut labels.
- [x] Implement props without controller coupling.

```ts
interface WelcomeScreenProps {
  recent: ReadonlyArray<RecentItem>;
  onNewDocument(): void;
  onOpenFiles(): void;
  onOpenWorkspace(): void;
  onOpenRecent(item: RecentItem): void;
}
```

- [x] Render title/startup actions and five highlighted recent names with compact parent paths plus a native 更多… disclosure for the remainder. Omit decorative content and repeat no file basename in the path.
- [x] Replace the current empty-state hero with this component. Restore `openRecent` in the shell with the existing folder-reveal behavior.
- [x] Verify close-last-tab behavior and both themes.

### Task 3: End-to-end and documentation

**Files:** `tests/e2e/workspaceSearch.spec.ts`, `AGENTS.md`, `docs/testing.md`, current design/plan documents.

- [x] Add E2E for startup and closing `欢迎.md`, five recent items, 更多…, and opening recent files.
- [x] Check 1280/1080/680 widths and both themes, including rail persistence.
- [x] Update module and testing documentation for the rail and welcome screen.
- [x] Run `npm run check`, both Rust clippy variants, and `npm run test:e2e`.
- [x] Do not commit unless explicitly requested.
