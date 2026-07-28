# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the React/TypeScript frontend. Keep application shell code in `src/app/`, document state and ports in `src/document/`, CodeMirror extensions in `src/editor/`, and filesystem sidebar behavior in `src/workspace/`. Themes live in `src/theme/`; conflict and recovery dialogs have dedicated folders.

`src-tauri/src/` contains the Rust backend for lossless document I/O, file watching, workspace operations, recovery, native menus, and Tauri commands. Rust integration tests are under `src-tauri/tests/`. Browser-shell E2E tests live in `tests/e2e/`; performance reports and fixtures belong in `tests/perf/`. Release procedures and manual macOS checks are documented in `docs/releasing.md` and `docs/testing.md`.

## Build, Test, and Development Commands

- `npm ci` installs the locked Node dependencies.
- `npm run dev` starts the Vite frontend on port 1420.
- `npm run tauri dev` launches the native development app.
- `npm test` runs Vitest unit and component tests.
- `npm run test:e2e` runs Playwright browser-shell workflows.
- `npm run build` performs strict TypeScript checking and a production Vite build.
- `npm run check` runs frontend tests, the production build, and Rust tests.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` checks Rust formatting.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` treats Rust lints as failures.

## Coding Style & Naming Conventions

Use two-space indentation in TypeScript, TSX, CSS, and JSON. TypeScript is strict; prefer explicit domain types and small modules over untyped objects. React components use `PascalCase`, hooks use `useCamelCase`, and other symbols use `camelCase`. Rust follows `rustfmt`, with modules and functions in `snake_case` and types in `PascalCase`.

Keep filesystem access behind the `DocumentPort` boundary. Preserve BOM, newline style, conflict tokens, and file-safety guarantees when changing save behavior.

## Testing Guidelines

Place frontend tests beside their implementation as `*.test.ts` or `*.test.tsx`. Name Rust integration files after the subsystem, such as `document_io.rs`. Add regression coverage for every behavior change; use real `EditorView` tests for CodeMirror decorations and widgets. Before a pull request, run `npm run check`, `npm run test:e2e`, formatting, and Clippy. Native Finder, file-dialog, disk-watch, and Chinese IME behavior still require the checklist in `docs/testing.md`.

## Commit & Pull Request Guidelines

Follow the repository’s Conventional Commit style: `feat:`, `fix:`, `test:`, `docs:`, `perf:`, `ci:`, or `release:` followed by an imperative summary. Keep commits focused.

Pull requests should explain user-visible behavior, list verification performed, and link the relevant issue or design document. Include before/after screenshots for UI changes and call out any skipped native macOS or release checks.
