# Repository Guidelines

This document is the single source of truth for AI agents working on Opus, a
macOS-first Markdown editor. Read it before making changes.

## Project overview

Opus is a lightweight native Markdown editor. It opens ordinary `.md` files in
place—there is no import step, proprietary format, or cloud account. The UI is
a React/TypeScript frontend; native file I/O, watching, recovery, workspace
operations, and menus are provided by a Rust/Tauri backend.

- Product name: **Opus**
- Bundle identifier: `com.xiongweini.markdown-edit`
- Version: `0.1.0`
- Target platform: macOS 12+ (Apple Silicon first)
- UI language: Chinese (`zh-CN`)
- License: MIT

## Technology stack

- **Frontend**: React 19, TypeScript (strict), Vite 8, CodeMirror 6, KaTeX.
- **Native shell**: Tauri 2 with a Rust backend.
- **Node toolchain**: Node.js 22 + npm.
- **Rust toolchain**: Stable Rust (minimum `1.77.2`).
- **Test runners**: Vitest (jsdom) for unit/component tests, Playwright for
  browser-shell E2E, Cargo for Rust tests and integration tests.
- **Key npm packages**: `@codemirror/*`, `@tauri-apps/api`,
  `@tauri-apps/plugin-dialog/fs/opener/store`, `katex`, `react`, `react-dom`.
- **Key Rust crates**: `tauri` 2.11, `notify` 8.2, `trash` 5.2, `sha2`, `serde`,
  `tempfile`.

## Project structure

```
.
├── src/                    # React/TypeScript frontend
│   ├── app/                # Application orchestration
│   ├── document/           # Document state and storage ports
│   ├── editor/             # CodeMirror editor and extensions
│   ├── workspace/          # File drawer / folder sidebar
│   ├── theme/              # Design tokens, CSS, preferences
│   ├── conflict/           # External-change conflict dialog
│   └── recovery/           # Crash-recovery drafts and UI
├── src-tauri/src/          # Rust backend
│   ├── document_io.rs      # Lossless atomic file reads/writes
│   ├── document_commands.rs# Tauri commands for documents/images/scopes
│   ├── workspace.rs        # Directory listing and workspace mutations
│   ├── watch.rs            # Debounced filesystem watcher
│   ├── recovery.rs         # Recovery draft storage
│   ├── asset_scope.rs      # Webview asset-scope registry
│   ├── open_events.rs      # Deep-link / drag-drop / argv normalization
│   ├── menu.rs             # Native macOS menu bar
│   └── perf_mark.rs        # Startup instrumentation hook
├── src-tauri/tests/        # Rust integration tests
├── tests/e2e/              # Playwright browser-shell workflows
├── tests/perf/             # Performance fixtures, reports, samples
├── scripts/                # Performance, screenshot, and bundle scripts
├── docs/                   # Testing, releasing, performance docs
├── package.json            # Frontend scripts and dependencies
├── src-tauri/Cargo.toml    # Rust package manifest
└── src-tauri/tauri.conf.json # Tauri bundle/window/security config
```

## Module divisions

- `src/app/`: composition root (`App.tsx`, `createApp.tsx`), top-level shell
  (`AppShell.tsx`), state controller hook (`useAppController.ts`), settings,
  tabs, and the E2E fixture bridge (`e2e.ts`).
- `src/document/`: the `DocumentPort` contract (`DocumentPort.ts`), pure
  document reducer (`documentReducer.ts`), shared types (`types.ts`), and two
  implementations:
  - `tauriDocumentPort.ts` — production backend via Tauri invoke/events.
  - `memoryDocumentPort.ts` — in-memory port used by unit tests, the dev demo,
    and Playwright E2E fixtures.
- `src/editor/`: `MarkdownEditor.tsx` plus CodeMirror extensions for live
  preview, Markdown tables, math rendering, image widgets, image paste/drop,
  outline publishing, search, frontmatter, highlight markers, and performance
  (light) mode.
- `src/workspace/`: folder sidebar tree state (`treeReducer.ts`) and UI
  (`FileSidebar.tsx`).
- `src/theme/`: CSS tokens, app styles, theme hook, and editor/theme
  preferences.
- `src/conflict/` and `src/recovery/`: dialogs and helpers for external
  conflicts and crash recovery.
- `src-tauri/src/document_io.rs`: reads files while preserving UTF-8 BOM and
  newline style; writes atomically via sibling temp file + `fsync` + rename.
- `src-tauri/src/document_commands.rs`: Tauri command handlers for open, save,
  clipboard images, asset scopes, workspace operations, watches, and recovery.

## Port selection and runtime modes

All filesystem access goes through `DocumentPort`. The production app always
uses `TauriDocumentPort`. Two browser-only modes exist for development and
 testing:

- **Dev demo**: `?demo=1` (optionally `&fixture=<name>` / `&workspace=1`) uses
  `MemoryDocumentPort` seeded with demo content so the UI can run in a plain
  browser.
- **E2E**: `VITE_E2E=1` plus a `window.__E2E_FIXTURE__` JSON fixture installs a
  `MemoryDocumentPort`; tests can drive it via `window.__E2E_PORT__`.

`src/app/App.tsx` is the only place that decides which port to create.
Production builds never define `VITE_E2E` and `import.meta.env.DEV` is false, so
 they always use the Tauri port.

## Build, development, and test commands

Install dependencies:

```sh
npm ci
```

Development:

```sh
npm run dev              # Vite dev server on http://localhost:1420
npm run tauri dev        # Build and launch the native macOS app
```

Frontend build:

```sh
npm run build            # tsc -b && vite build -> dist/
```

Native app build:

```sh
npm run tauri build -- --bundles app         # -> src-tauri/target/release/bundle/macos/Opus.app
npm run tauri build -- --bundles app,dmg     # also produce a DMG
```

Automated testing:

```sh
npm test                 # Vitest unit/component tests (jsdom)
npm run test:e2e         # Playwright browser-shell tests on port 1421
npm run check            # npm test + npm run build + cargo test
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Performance:

```sh
npm run perf:fixtures    # generate tests/perf/generated/*.md (gitignored)
npm run perf             # browser + hot-start benchmarks -> tests/perf/report.json
npm run perf:startup     # alias for measure-startup hot starts
```

## Code style guidelines

- Use **two-space indentation** for TypeScript, TSX, CSS, JSON, and Markdown.
- Keep TypeScript strict; prefer small, typed modules.
- React components: `PascalCase`. Hooks: `useCamelCase`. Other symbols:
  `camelCase`.
- Rust: follow `rustfmt`; modules/functions `snake_case`, types `PascalCase`.
- Keep filesystem access behind `DocumentPort`.
- Preserve UTF-8 BOMs, newline style (`lf`/`cr_lf`), conflict tokens, atomic
  saves, and recovery guarantees.
- Use focused [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `test:`, `docs:`, `perf:`, `release:`.

## Testing strategy

Automated gates:

- Frontend unit/component tests live beside implementations as
  `*.test.ts` / `*.test.tsx` and run in jsdom via Vitest.
- Rust integration tests live in `src-tauri/tests/` and cover document I/O,
  commands, workspace operations, asset scopes, recovery, open events, and
  clipboard images.
- E2E tests in `tests/e2e/` run against a real Vite dev server with
  `VITE_E2E=1`; they exercise the UI through DOM/CodeMirror interactions using
  the in-memory port.
- `npm run perf` enforces performance budgets and writes
  `tests/perf/report.json`.

Manual macOS acceptance checklist:

- Native behavior (Finder open/drag, file/folder dialogs, Chinese IME,
  CRLF/BOM preservation, close protection, image paste/drop, external changes,
  crash recovery, session restore, appearance, reduced motion, and large-file
  performance) is verified manually per `docs/testing.md`.

CI:

- `.github/workflows/ci.yml` runs on `macos-latest` and executes `npm ci`,
  `npm test`, `npm run build`, Rust formatting/clippy/tests, and `npm run
  test:e2e`.

## Security considerations

- **No App Sandbox in v1**: `src-tauri/entitlements.plist` is deliberately
  empty and must not contain `com.apple.security.app-sandbox`. The release
  verification script rejects it if present.
- **Release signing**: Distributable builds require Developer ID signing,
  Hardened Runtime, notarization, and stapling. See `docs/releasing.md`.
- **Never commit**: credentials, `.env` files, signing certificates, build
  outputs, or personal documents.
- **Atomic saves**: document writes use a sibling temporary file, `fsync`, and
  an atomic rename to avoid data loss.
- **Asset scopes**: runtime Tauri scopes are additive-only; the Rust
  `AssetScopeRegistry` is the authoritative record of which consumer holds
  which directory. Workspace mutations enforce root-boundary checks against
  canonical paths.
- **Path validation**: backend commands require absolute paths and Markdown
  extensions; symlinked paths are canonicalized.
- **Recovery drafts**: dirty snapshots are stored as JSON in the app data
  directory using the same atomic-write discipline; drafts are discarded once
  the document is safely saved or closed.
- **Close handling**: the window close event is held until recovery drafts are
  flushed; closing proceeds even if flush fails so the user is never trapped.

## Release and deployment

Release procedures are documented in `docs/releasing.md`. High-level steps:

1. From a clean checkout on the release machine, run the release candidate
   gate:

   ```sh
   npm ci
   npm run check
   npm run test:e2e
   npm run perf
   npm run tauri build -- --bundles app,dmg
   ./scripts/verify-macos-bundle.sh "src-tauri/target/release/bundle/macos/Opus.app"
   ```

2. Sign, notarize, staple, and verify the `.app` and `.dmg`.
3. Publish the stapled DMG to GitHub Releases.

## Useful references

- `README.md` — quick start and project status.
- `docs/testing.md` — full automated and manual testing instructions.
- `docs/releasing.md` — signing, notarization, and release gate.
- `docs/performance.md` — performance budgets and measurement protocol.
- `vite.config.ts` — Vite and Vitest configuration.
- `playwright.config.ts` — E2E server and test settings.
- `src-tauri/tauri.conf.json` — Tauri window, security, and bundle config.
