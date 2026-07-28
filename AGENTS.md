# Repository Guidelines

## Project Structure & Module Organization

`src/` is the React/TypeScript frontend. Application orchestration belongs in `src/app/`, document state and storage ports in `src/document/`, CodeMirror extensions in `src/editor/`, the file drawer in `src/workspace/`, and design tokens/styles in `src/theme/`. Keep conflict and recovery UI in their existing feature folders.

`src-tauri/src/` contains the Rust backend for lossless file I/O, filesystem watching, recovery, workspace operations, native menus, and Tauri commands. Rust integration tests live in `src-tauri/tests/`. Browser workflows are in `tests/e2e/`; performance fixtures and reports are in `tests/perf/`. Release and manual macOS procedures live under `docs/`.

## Build, Test, and Development Commands

- `npm ci`: install locked dependencies.
- `npm run dev`: start Vite on port 1420.
- `npm run tauri dev`: launch the native development app.
- `npm test`: run Vitest unit and component tests.
- `npm run test:e2e`: run Playwright browser-shell workflows.
- `npm run build`: type-check and build the frontend.
- `npm run check`: run frontend tests/build plus Rust tests.
- `npm run tauri build -- --bundles app`: build `Opus.app`.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: check Rust formatting.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`: reject Rust warnings.

## Coding Style & Naming Conventions

Use two-space indentation in TypeScript, TSX, CSS, and JSON. Keep TypeScript strict and prefer small typed modules. React components use `PascalCase`, hooks use `useCamelCase`, and other symbols use `camelCase`. Rust follows `rustfmt`; use `snake_case` for modules/functions and `PascalCase` for types.

Keep filesystem access behind `DocumentPort`. Preserve UTF-8 BOMs, newline style, conflict tokens, atomic saves, and recovery guarantees.

## Testing Guidelines

Place frontend tests beside implementations as `*.test.ts` or `*.test.tsx`; name Rust integration tests after their subsystem. Add regression coverage for every behavior change and real `EditorView` tests for CodeMirror decorations. Before a pull request, run `npm run check`, E2E, formatting, and Clippy. Complete `docs/testing.md` for native dialogs, Finder integration, file watching, and Chinese IME changes.

## Commit, Pull Request & Release Guidelines

Use focused Conventional Commits such as `feat:`, `fix:`, `test:`, `docs:`, `perf:`, and `release:`. Pull requests must describe user-visible behavior, list verification, link relevant designs/issues, and include before/after screenshots for UI changes.

Never commit credentials, `.env` files, signing certificates, build outputs, or personal documents. Ad-hoc signatures are for local testing only; distributable builds require Developer ID signing and notarization per `docs/releasing.md`.
