# Opus GitHub Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare Opus for a safe first push to the private GitHub repository `XwX5050/Opus`.

**Architecture:** Keep repository guidance in `AGENTS.md`, user-facing project information in `README.md`, and legal terms in a standard root `LICENSE`. Audit the tracked tree and every reachable commit before creating the remote; publication stops if credentials or private keys are detected.

**Tech Stack:** Markdown, Git, ripgrep, GitHub CLI, npm/Vitest/Vite, Cargo

---

### Task 1: Refresh contributor and project documentation

**Files:**
- Modify: `AGENTS.md`
- Create: `README.md`
- Create: `LICENSE`

- [ ] **Step 1: Update `AGENTS.md`**

Keep the guide between 200 and 400 words. Document `src/`, `src-tauri/`, `tests/e2e/`, `tests/perf/`, `docs/`, `npm run check`, `npm run test:e2e`, Rust formatting and Clippy, adjacent test naming, Conventional Commits, pull-request screenshots, lossless file I/O, and the distinction between local ad-hoc signing and distributable signing.

- [ ] **Step 2: Add the user-facing README**

Use these sections:

```markdown
# Opus

Opus is a lightweight, macOS-first Markdown editor built for direct file editing, fast live preview, and distraction-free reading.

## Features
## Technology
## Requirements
## Development
## Testing
## Build the macOS App
## Project Status
## License
```

Include only commands that exist in `package.json` or repository scripts. Do not embed the existing screenshots because they show the obsolete “Markdown Edit” product name.

- [ ] **Step 3: Add the MIT License**

Use the unmodified MIT License text with:

```text
Copyright (c) 2026 XwX5050
```

- [ ] **Step 4: Validate documentation**

Run:

```bash
wc -w AGENTS.md
rg -n '^## ' README.md AGENTS.md
git diff --check
```

Expected: `AGENTS.md` contains 200–400 words, required headings exist, and no whitespace errors are reported.

### Task 2: Audit the publishable repository

**Files:**
- Inspect: all tracked files and reachable Git objects
- Inspect: `docs/screenshots/light.png`
- Inspect: `docs/screenshots/dark.png`

- [ ] **Step 1: Scan tracked text for credentials and private keys**

Run case-insensitive searches for AWS keys, GitHub tokens, generic API keys or secrets, passwords, bearer tokens, and PEM private-key headers. Exclude dependency lockfiles only from high-entropy generic-value matches, not from explicit token signatures.

Expected: no real credential values or private keys.

- [ ] **Step 2: Scan all reachable history**

Run the same explicit-signature scan over:

```bash
git log --all -p --full-history
```

Also inspect `git rev-list --objects --all` for `.env`, `.pem`, `.key`, `.p12`, application bundles, archives, logs, and local configuration files.

Expected: no credentials, private keys, environment files, or generated app bundles in reachable history.

- [ ] **Step 3: Check machine-specific paths and screenshots**

Search the current tree and history for `/Users/`, `/home/`, `file://`, and user-profile names. Review both tracked screenshots visually and inspect their metadata with `sips`.

Expected: screenshots contain no private information. Historical planning documents may mention repository-local absolute paths; record these as non-secret residue and do not rewrite history without approval.

- [ ] **Step 4: Verify ignore coverage**

Confirm `.gitignore` excludes dependencies, build outputs, worktrees, Playwright output, generated performance fixtures, and TypeScript build metadata.

### Task 3: Validate, commit, and integrate

**Files:**
- Modify: `AGENTS.md`
- Create: `README.md`
- Create: `LICENSE`
- Create: `docs/superpowers/plans/2026-07-28-github-publication.md`

- [ ] **Step 1: Run repository checks**

Run:

```bash
npm run check
npm run test:e2e
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Expected: all commands pass. Existing non-fatal Vitest hoisting and Vite chunk-size warnings may remain.

- [ ] **Step 2: Commit publication files**

Run:

```bash
git add AGENTS.md README.md LICENSE docs/superpowers/plans/2026-07-28-github-publication.md
git commit -m "docs: prepare Opus for GitHub"
```

- [ ] **Step 3: Merge into `master`**

Fast-forward `codex/github-publication` into `master`, rerun `npm test`, then remove the clean worktree and delete the merged branch.

### Task 4: Create and verify the private GitHub repository

**Files:**
- Modify: local Git remote configuration

- [ ] **Step 1: Create the private remote**

Run:

```bash
gh repo create XwX5050/Opus --private --source=. --remote=origin
```

Expected: GitHub creates `XwX5050/Opus` with private visibility and configures `origin`.

- [ ] **Step 2: Push `master`**

Run:

```bash
git push -u origin master
```

Expected: local `master` tracks `origin/master`.

- [ ] **Step 3: Verify publication**

Run:

```bash
gh repo view XwX5050/Opus --json nameWithOwner,visibility,defaultBranchRef,url
git status --short --branch
git ls-remote --heads origin master
```

Expected: repository is `PRIVATE`, its default branch is `master`, the remote head matches local `HEAD`, and the worktree is clean.
