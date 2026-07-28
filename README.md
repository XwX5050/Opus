# Opus

Opus is a lightweight, macOS-first Markdown editor built for direct file editing, fast live preview, and distraction-free reading. It opens ordinary Markdown files in place—there is no library import, proprietary format, or cloud account.

## Features

- Multiple document tabs with unsaved-change protection and session restore
- Optional folder sidebar with lazy file-tree loading
- Editing and read-only reading modes in one CodeMirror editor
- Live Markdown rendering, `==highlight==`, syntax-highlighted code, images, and KaTeX formulas
- Finder open/drag support, external-change detection, conflict handling, and crash-draft recovery
- Light, dark, and system appearance
- Lossless UTF-8 BOM and LF/CRLF preservation with atomic saves

## Technology

Opus uses React, TypeScript, CodeMirror 6, and Vite for the interface. Tauri 2 and Rust provide native macOS integration, scoped filesystem access, watching, recovery, and document I/O.

## Requirements

- macOS 12 or later
- Node.js 22 and npm
- A stable Rust toolchain
- Xcode Command Line Tools

## Development

```sh
npm ci
npm run tauri dev
```

Use `npm run dev` when working on the Vite frontend without the native shell.

## Testing

```sh
npm run check
npm run test:e2e
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Native dialogs, Finder workflows, Chinese IME, and real filesystem events require the manual checks in [`docs/testing.md`](docs/testing.md).

## Build the macOS App

```sh
npm run tauri build -- --bundles app
```

The bundle is written to `src-tauri/target/release/bundle/macos/Opus.app`. An unsigned or ad-hoc-signed build is suitable only for local testing. Developer ID signing, notarization, DMG creation, and verification are documented in [`docs/releasing.md`](docs/releasing.md).

## Project Status

Opus is under active development and currently targets Apple Silicon macOS. Automated coverage includes frontend, Rust, and browser-shell E2E tests; native acceptance remains a separate release gate.

## License

Opus is available under the [MIT License](LICENSE).
