# Opus

Opus is a lightweight Markdown editor for macOS, Windows, and Linux, built for direct file editing, fast live preview, and distraction-free reading. It opens ordinary Markdown files in place—there is no library import, proprietary format, or cloud account.

## Features

- Multiple document tabs with unsaved-change protection and session restore
- Optional folder sidebar with lazy file-tree loading
- Editing and read-only reading modes in one CodeMirror editor
- Live Markdown rendering, `==highlight==`, syntax-highlighted code, images, and KaTeX formulas
- Open-with and drag-and-drop from the system file manager, external-change detection, conflict handling, and crash-draft recovery
- Light, dark, and system appearance
- Lossless UTF-8 BOM and LF/CRLF preservation with atomic saves

## Technology

Opus uses React, TypeScript, CodeMirror 6, and Vite for the interface. Tauri 2 and Rust provide the native shell for each platform (AppKit/WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux), plus scoped filesystem access, watching, recovery, and document I/O.

## Requirements

- macOS 12 or later
- Windows 10 or 11 with the WebView2 Runtime (preinstalled on Windows 11)
- Linux with WebKitGTK 4.1 (e.g. `webkit2gtk-4.1` on Arch, `libwebkit2gtk-4.1-dev` on Debian/Ubuntu)
- Node.js 22 and npm
- A stable Rust toolchain
- Xcode Command Line Tools (macOS only)

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

Native dialogs, file-manager workflows, Chinese IME, and real filesystem events require the manual checks in [`docs/testing.md`](docs/testing.md).

## Build the Native App

macOS:

```sh
npm run tauri build -- --bundles app
```

The bundle is written to `src-tauri/target/release/bundle/macos/Opus.app`. An unsigned or ad-hoc-signed build is suitable only for local testing. Developer ID signing, notarization, DMG creation, and verification are documented in [`docs/releasing.md`](docs/releasing.md).

Windows:

```sh
npm run tauri build -- --bundles nsis
```

The installer is written to `src-tauri/target/release/bundle/nsis/`.

Linux:

```sh
npm run tauri build -- --bundles appimage   # or deb / rpm
```

Linux bundles are written under `src-tauri/target/release/bundle/`.

## Project Status

Opus is under active development and targets macOS (Apple Silicon), Windows, and Linux. Automated coverage includes frontend, Rust, and browser-shell E2E tests on all three platforms; native acceptance remains a separate release gate.

## License

Opus is available under the [MIT License](LICENSE).
