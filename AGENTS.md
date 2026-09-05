# Repository Guidelines

This document is the single source of truth for AI agents working on Opus, a
cross-platform Markdown editor. Read it before making changes.

## Project overview

Opus is a lightweight native Markdown editor. It opens ordinary `.md` files in
place—there is no import step, proprietary format, or cloud account. The UI is
a React/TypeScript frontend; native file I/O, watching, recovery, workspace
operations, menus, font enumeration, and the updater are provided by a
Rust/Tauri backend.

- Product name: **Opus**
- Bundle identifier: `com.xiongweini.markdown-edit`
- Version: `0.1.13` (kept in sync across `package.json`,
  `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`)
- Target platform: macOS 12+ (Apple Silicon first), Windows 10/11 (WebView2),
  and Linux (WebKitGTK)
- UI language: Chinese (`zh-CN`); code, comments, and docs are in English
- License: MIT

## Technology stack

- **Frontend**: React 19, TypeScript (strict), Vite 8, CodeMirror 6, KaTeX,
  GSAP (with `@gsap/react`).
- **Native shell**: Tauri 2 with a Rust backend (edition 2021).
- **Node toolchain**: Node.js 22 + npm.
- **Rust toolchain**: Stable Rust (minimum `1.77.2`).
- **Test runners**: Vitest 4 (jsdom) for unit/component tests, Playwright for
  browser-shell E2E, Cargo for Rust unit and integration tests.
- **Key npm packages**: `@codemirror/*`, `@tauri-apps/api`,
  `@tauri-apps/plugin-dialog/fs/opener/store/process/updater`, `katex`,
  `gsap`, `@gsap/react`, `react`, `react-dom`.
- **Key Rust crates**: `tauri` 2.11 (with `protocol-asset`),
  `tauri-plugin-dialog/fs/opener/process/store/updater/log`, `notify` 8.2,
  `trash` 5.2, `sha2`, `serde`, `tempfile`, `reqwest` 0.13 (rustls with the
  ring provider pinned); Windows-only `tauri-plugin-single-instance`
  (second-launch argv → open-with), `winreg` (installed-font registry
  enumeration), and `windows-sys` (file identity — volume serial + file index
  — via `BY_HANDLE_FILE_INFORMATION`, see `document_io.rs`); macOS-only
  `objc2-app-kit`/`objc2-foundation`/`objc2-web-kit`/`objc2-core-foundation`/
  `objc2-core-text` 0.3 (pinned to wry's locked versions so the types line up
  with the webview handles from `with_webview`).

## Project structure

```
.
├── src/                    # React/TypeScript frontend
│   ├── app/                # Application orchestration
│   ├── document/           # Document state and storage ports
│   ├── editor/             # CodeMirror editor and extensions
│   ├── motion/             # GSAP animation runtime and editor motion
│   ├── present/            # Presentation (slideshow) mode
│   ├── workspace/          # Folder sidebar
│   ├── theme/              # Design tokens, CSS, preferences
│   ├── translate/          # Document translation pipeline and settings
│   ├── conflict/           # External-change conflict dialog
│   └── recovery/           # Crash-recovery drafts and UI
├── src-tauri/src/          # Rust backend
│   ├── lib.rs              # Tauri builder: plugins, commands, macOS menu, open/drop events; Windows single-instance (tauri-plugin-single-instance) forwards second-launch argv as open-with
│   ├── document_io.rs      # Lossless atomic file reads/writes
│   ├── document_commands.rs# Tauri commands for documents/images/scopes
│   ├── workspace.rs        # Directory listing and workspace mutations
│   ├── watch.rs            # Debounced filesystem watcher
│   ├── recovery.rs         # Recovery draft storage
│   ├── translate.rs        # OpenAI-compatible translation + disk cache
│   ├── asset_scope.rs      # Webview asset-scope registry
│   ├── open_events.rs      # Deep-link / drag-drop / argv normalization
│   ├── menu.rs             # Native macOS menu bar
│   ├── fonts.rs            # Installed-font enumeration (Core Text on macOS, registry on Windows)
│   ├── linux_env.rs        # Linux-only pre-init env (Wayland backend, DMA-BUF)
│   ├── perf_mark.rs        # Startup instrumentation hook
│   └── window_background.rs# Native window/webview background sync
├── src-tauri/tests/        # Rust integration tests
├── tests/e2e/              # Playwright browser-shell workflows
├── tests/perf/             # Performance fixtures, reports, samples
├── scripts/                # Performance, screenshot, and bundle scripts
├── docs/                   # Testing, releasing, performance docs
│   └── superpowers/        # Design specs and implementation plans
├── package.json            # Frontend scripts and dependencies
├── src-tauri/Cargo.toml    # Rust package manifest
└── src-tauri/tauri.conf.json # Tauri bundle/window/security/updater config
```

## Module divisions

- `src/app/`: composition root (`App.tsx`, `createApp.tsx`), top-level shell
  (`AppShell.tsx`), state controller hook (`useAppController.ts`), settings
  dialog (`SettingsDialog.tsx`), tab bar (`TabList.tsx`), automatic
  performance-mode hook (`usePerformanceMode.ts`), in-app update checks
  (`updates.ts`), and the E2E fixture bridge (`e2e.ts`). The header is
  platform-specific: macOS keeps the native menu bar (so the header stays
  minimal) while Linux and Windows native builds get a file-icon dropdown
  next to the sidebar toggle plus frontend keybindings
  (Ctrl+N/O/Shift+O/S/Shift+S/W/,) replacing the native menu accelerators
  (see `AppShell.customFileHeader.test.tsx`). Windows, whose window is
  undecorated (`set_decorations(false)`), additionally draws its own caption
  buttons and window-edge resize handles (`WindowControls.tsx`). Settings open
  from a gear button pinned to the bottom of the left sidebar (a floating
  gear in the bottom-left corner covers the empty state where the sidebar is
  not rendered); the macOS native menu and Ctrl/Cmd+, remain. The translate
  and view-mode toggles live on the right side of the header and only render
  while the outline panel is open — hiding them never resets the per-tab
  translation or view-mode state. `ContextMenu.tsx`
  is the shared right-click menu (portal, keyboard navigation, edge flip)
  used by the editor area, the sidebar tab list, the file tree, and the
  shell-level fallback menu; selecting an item closes the menu itself, so
  item handlers must not close it again. The editable document title above
  the editor toolbar renames the underlying file through
  `controller.renameDocument` (backend `rename_document`, no workspace anchor
  required); for untitled documents — which have no file yet — the title and
  the tab menu's rename entry route to Save As instead.
  `InlineNameInput.tsx` is the shared inline rename input also
  used by the file tree.
- `src/present/`: presentation (演示模式) slide playback. The overlay at
  `PresentationOverlay.tsx` renders the active document's ORIGINAL text
  (never the translation) one slide at a time through the same reading-mode
  CodeMirror preview extensions as the editor, with images resolved via
  `tauriImagePreviewUrl`. `presentationPlan.ts` plans slides: explicit `---`
  separators win when present (`splitManualSlides`), otherwise natural blocks
  are greedily packed by measured rendered height (`splitNaturalBlocks` +
  `packBlocksByHeight`). Open state is per tab on the controller
  (`presentationTabs` Set with `presentationOpenOf`/`openPresentation`/
  `closePresentation`, mirroring viewModes and pruned on tab close); entry
  points are a header toggle button (next to the view-mode toggle) and the
  editor-area context menu. `AppShell.tsx` drives OS fullscreen while
  presenting (`core:window:allow-set-fullscreen` in Tauri builds, the
  Fullscreen API in browsers) and restores it on close or unmount.
- `src/document/`: the `DocumentPort` contract (`DocumentPort.ts`), pure
  document reducer (`documentReducer.ts`), shared types (`types.ts`), and two
  implementations:
  - `tauriDocumentPort.ts` — production backend via Tauri invoke/events; also
    owns session persistence (`session.json` via plugin-store) and window
    geometry restore.
  - `memoryDocumentPort.ts` — in-memory port used by unit tests, the dev demo,
    and Playwright E2E fixtures.
- `src/editor/`: `MarkdownEditor.tsx` plus CodeMirror extensions for live
  preview, Markdown tables (`markdownTable.ts`, `tableWidgets.ts`), math
  rendering (`mathExtension.ts`, `mathWidgets.ts`), image widgets, image
  paste/drop, outline publishing (`outline.ts`, `outlineExtension.ts`,
  `OutlinePanel.tsx`), search (wired in `editorExtensions.ts` via
  `@codemirror/search`), frontmatter, highlight markers, performance (light)
  mode (`performanceMode.ts`), and fenced-code-block typing assists
  (`codeBlockAutoClose.ts` — auto-closing fences plus bracket/quote pairing,
  stepping over, wrapping, and pair deletion, strictly gated on the syntax
  tree so prose and inline code are untouched). `viewMode.ts` defines the
  per-tab modes: `editing` (live preview, selection reveals source) and
  `reading` (read-only, fully rendered). On Linux (WebKitGTK), IME
  compositions are protected by a patch-package patch
  (`patches/@codemirror+view+*.patch`,
  applied via the `postinstall` script) that stops CodeMirror from rewriting
  the DOM selection mid-composition — without it, fcitx5's preedit caret gets
  pinned after the first letter. The platform also never renders a caret
  inside the marked text and reports a bogus selection offset during
  composition, so `imeCaret.ts` hides the drawn caret layer while composing
  and positions its own caret at the end of the preedit text node. Editor
  extensions must never dispatch transactions synchronously during
  composition (live preview/math decorations freeze instead and recompute at
  `compositionend`).
- `src/motion/`: GSAP-based animation. `motionConfig.ts` holds the shared
  timing/easing tokens; `motionRuntime.ts` provides panel/dialog/list intro
  helpers that honor `prefers-reduced-motion`; `editorMotion.ts` animates
  editor content on view-mode switches and is disabled in light performance
  mode. Target counts are clamped (`MAX_EDITOR_MOTION_TARGETS`,
  `MAX_LIST_MOTION_TARGETS`) to bound animation cost.
- `src/workspace/`: folder sidebar tree state (`treeReducer.ts`) and UI
  (`FileSidebar.tsx`). Tree rows have a right-click context menu (rename /
  move to trash; folders additionally offer creating a file inside) built on
  `src/app/ContextMenu.tsx`, reusing the same editing state machine as the
  inline row buttons.
- `src/translate/`: document translation pipeline. `types.ts` holds
  `TranslationSettings` (endpoint, API key, model, target language, concurrency
  — the number of chunk requests translated concurrently, configurable in
  settings within 1-32, default 10) and the per-tab `TranslationViewState`;
  `segments.ts` splits Markdown into
  translatable paragraph blocks and protected blocks (frontmatter, fenced
  code, display math, HTML comments) and subdivides over-long translatable
  segments into chunks under `MAX_TRANSLATABLE_CHUNK_LENGTH` (600 characters;
  line boundaries first, then sentence punctuation, then hard cuts that never
  split a placeholder token); `placeholders.ts` swaps inline code/math spans
  (`` `code` ``, `$math$`) for ⟪n⟫ tokens before subdivision so they survive
  translation verbatim and are validated and restored from each reply;
  `translate.ts` issues one
  `DocumentPort.translateSegments` call per chunk through a bounded
  concurrency pool, retries transiently failed chunk requests with a short
  backoff (never on abort), and surfaces each finished chunk via `onPartial`
  with the unfinished chunks still showing the original text. The
  backend `src-tauri/src/translate.rs` translates through an
  OpenAI-compatible chat completions endpoint via reqwest (rustls) and caches
  results per segment on disk.
- `src/theme/`: CSS tokens, app styles, theme hook, and editor/theme
  preferences. The reading column scales proportionally with the window
  (`min(clamp(--editor-content-width, 68%, 1.6x it), 100% - 48px)` on
  `.cm-content`); the preference is the column's minimum/base width, and the
  scroller runs edge to edge so the scrollbar rides the window edge. Syntax
  highlight colors are `--syntax-*` tokens mapped in
  `editor/editorExtensions.ts`. The canvas is a flat near-black:
  `--canvas` must stay a plain hex (the native window background in
  `window_background.rs` parses it as a solid color) and carries no glow or
  texture overlays; side panels use the flat `--surface-panel` tone, one step
  above the canvas.
- `src/conflict/` and `src/recovery/`: dialogs and helpers for external
  conflicts and crash recovery.
- `src-tauri/src/document_io.rs`: reads files while preserving UTF-8 BOM and
  newline style; writes atomically via sibling temp file + `fsync` + rename.
- `src-tauri/src/document_commands.rs`: Tauri command handlers for open, save,
  clipboard images, asset scopes, workspace operations, watches, and recovery.
  `rename_document` renames a Markdown file in place from a new base name
  (extension preserved) without requiring a workspace anchor, so the editable
  document title works for individually opened files too.
- `src-tauri/src/fonts.rs`: `list_installed_fonts` command backed by Core
  Text on macOS and by the `CurrentVersion\Fonts` registry keys on Windows;
  neither WKWebView nor WebView2 has `queryLocalFonts`, so the settings
  dialog's font picker gets family names from the native side.
- `src-tauri/src/window_background.rs`: paints the window background with the
  resolved `--canvas` color so live resizes never flash white — on macOS
  additionally the NSWindow background and the WKWebView under-page
  background; on Windows only the cross-platform window background (WebView2
  has no under-page layer). Seeded dark at startup, synced from `useTheme` on
  every theme change. Linux has no native chrome to theme: the window runs
  without decorations and no GTK menu bar is installed (both removed because
  the extra titlebar/menu layers were redundant under tiling compositors), so
  the module compiles away there.
- `src-tauri/src/linux_env.rs`: Linux-only, runs before any GTK/WebKit init in
  `run()`. The Tauri-generated AppImage launcher force-exports
  `GDK_BACKEND=x11` (linuxdeploy GTK hook), which strands the app on XWayland
  where pointer grabs mid-drag break and freeze the UI (observed under niri);
  it therefore resets `GDK_BACKEND` to `wayland,x11` on Wayland sessions
  (`OPUS_FORCE_X11` opts out) and defaults `WEBKIT_DISABLE_DMABUF_RENDERER=1`
  because the NVIDIA/GBM DMA-BUF path renders blank webviews there. On Linux,
  `src/main.tsx` also suppresses in-webview HTML5 `dragstart` entirely — every
  in-page native drag takes a WebKitGTK seat grab that can wedge the app;
  external file drops are unaffected. Panel drag-resize never uses
  `setPointerCapture` for the same reason (see `AppShell.tsx`).

## Port selection and runtime modes

All filesystem access goes through `DocumentPort`. The production app always
uses `TauriDocumentPort`. Two browser-only modes exist for development and
testing:

- **Dev demo**: `?demo=1` (optionally `&fixture=<name>` / `&workspace=1` /
  `&theme=light|dark|system`) uses `MemoryDocumentPort` seeded with demo
  content so the UI can run in a plain browser.
- **E2E**: `VITE_E2E=1` plus a `window.__E2E_FIXTURE__` JSON fixture installs a
  `MemoryDocumentPort`; tests can drive it via `window.__E2E_PORT__`.

`src/app/App.tsx` is the only place that decides which port to create.
Production builds never define `VITE_E2E` and `import.meta.env.DEV` is false, so
they always use the Tauri port. The update check in `src/app/updates.ts`
likewise short-circuits to `unsupported` in dev, E2E, and plain browsers.

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
npm run tauri build -- --bundles app         # macOS -> src-tauri/target/release/bundle/macos/Opus.app
npm run tauri build -- --bundles app,dmg     # also produce a DMG
NO_STRIP=1 npm run tauri build -- --bundles appimage    # Linux -> src-tauri/target/release/bundle/appimage/
# (NO_STRIP=1: linuxdeploy's bundled strip predates RELR and fails on
#  bleeding-edge distro libraries, e.g. CachyOS/.relr.dyn sections)
npm run tauri build -- --bundles nsis        # Windows -> src-tauri/target/release/bundle/nsis/
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
npm run perf             # browser editor benchmarks -> tests/perf/report.json
npm run perf:startup     # hot-start benchmarks -> tests/perf/startup-samples.json
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
- Animations must respect `prefers-reduced-motion` and stay within the clamped
  target counts in `src/motion/motionConfig.ts`.
- Use focused [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `test:`, `docs:`, `perf:`, `ci:`, `release:`.

## Testing strategy

Automated gates:

- Frontend unit/component tests live beside implementations as
  `*.test.ts` / `*.test.tsx` and run in jsdom via Vitest. The Vitest config
  (in `vite.config.ts`) excludes `tests/e2e/**` and `.worktrees/**`.
- Rust integration tests live in `src-tauri/tests/` and cover document I/O,
  commands, workspace operations, asset scopes, recovery, open events,
  clipboard images, document renaming, and the translation pipeline (cache
  and OpenAI-compatible client).
- E2E tests in `tests/e2e/` (`notepad`, `editorWidth`, `translation` specs)
  run against a real Vite dev server on port 1421
  with `VITE_E2E=1` (`reuseExistingServer` is off so the environment is
  guaranteed); they exercise the UI through DOM/CodeMirror interactions using
  the in-memory port (see `src/app/e2e.ts` and `playwright.config.ts`).
- `npm run perf` enforces performance budgets (see `docs/performance.md`) and
  writes `tests/perf/report.json`; the report and
  `tests/perf/startup-samples.json` are committed baselines, refreshed on
  every real run. Only `tests/perf/generated/` is gitignored.

Manual macOS acceptance checklist:

- Native behavior (Finder open/drag, file/folder dialogs, Chinese IME,
  CRLF/BOM preservation, close protection, image paste/drop, external changes,
  crash recovery, session restore, appearance, reduced motion, and large-file
  performance) is verified manually per `docs/testing.md`.

CI:

- `.github/workflows/ci.yml` runs on `macos-latest` with two jobs: `check`
  (`npm ci`, `npm test`, `npm run build`, Rust fmt/clippy/tests) and `e2e`
  (`npm run test:e2e` on Chromium, uploading `test-results/` traces on
  failure), plus `check-linux` on `ubuntu-latest` (frontend build and Rust
  fmt/clippy/tests against the Linux toolchain with the WebKitGTK dev
  packages installed — needed because the macOS job never compiles the
  `cfg(target_os = "linux")` branches) and `check-windows` on
  `windows-latest` (frontend tests/build and Rust fmt/clippy/tests against
  the Windows toolchain).

## Security considerations

- **No App Sandbox in v1**: `src-tauri/entitlements.plist` is deliberately
  empty and must not contain `com.apple.security.app-sandbox`. The release
  verification script (`scripts/verify-macos-bundle.sh`) rejects the build if
  it is present.
- **Webview CSP**: `tauri.conf.json` pins a strict CSP
  (`default-src 'self'`; images additionally allow `asset: http: https:
  data:`; styles allow `'unsafe-inline'`; fonts allow `data:`); the asset
  protocol is enabled with an empty static scope—scopes are granted only at
  runtime.
- **Release signing**: Distributable builds require Developer ID signing,
  Hardened Runtime, notarization, and stapling. See `docs/releasing.md`.
- **Update key**: the updater signing key (`~/.tauri/opus-updater.key`, a
  password-less minisign key) must never be committed; losing it permanently
  breaks the automatic update channel because clients verify every
  `latest.json` against the public key pinned in `tauri.conf.json`. See
  `docs/releasing.md`.
- **Never commit**: credentials, `.env` files, signing certificates, build
  outputs, or personal documents.
- **Atomic saves**: document writes use a sibling temporary file, `fsync`, and
  an atomic rename to avoid data loss.
- **Translation cache and API key**: translated segments are cached under the
  app data directory (`translation-cache/`, one sha256-named JSON file per
  segment, written with the same atomic discipline as recovery drafts); the
  provider API key is stored in plaintext in the local `session.json`
  (accepted for v1 — never commit or upload it).
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

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which has one
job per platform, all uploading into the same GitHub Release (same
`tagName`): the macOS job runs `npm run check` and builds the `app,dmg`
bundles via `tauri-action` (it also generates the release notes), the Linux
job builds the `appimage` bundle with `NO_STRIP=1`, and the Windows job
builds the `nsis` installer. Because `createUpdaterArtifacts` is enabled, the
merged release also carries the updater artifacts (`latest.json`,
`Opus.app.tar.gz`, `.sig`); the app checks
`https://github.com/XwX5050/Opus/releases/latest/download/latest.json`
silently on startup and from a manual check in the settings dialog
(`src/app/updates.ts`). The workflow reads the minisign private key from the
`TAURI_SIGNING_PRIVATE_KEY` secret and Apple signing/notarization credentials
from the `APPLE_*` secrets; without them it produces unsigned local builds.

## Useful references

- `README.md` — quick start and project status.
- `docs/testing.md` — full automated and manual testing instructions.
- `docs/releasing.md` — signing, notarization, updater channel, release gate.
- `docs/performance.md` — performance budgets and measurement protocol.
- `docs/superpowers/` — design specs and implementation plans.
- `vite.config.ts` — Vite and Vitest configuration.
- `playwright.config.ts` — E2E server and test settings.
- `src-tauri/tauri.conf.json` — Tauri window, security, updater, and bundle
  config.
