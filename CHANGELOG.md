# Changelog

All notable changes to Opus are documented in this file.

## [0.2.7] - 2026-11-27

### Added

- The reading column can be resized by dragging the hover-revealed vertical
  handles at its sides: dragging (or editing 内容宽度 in Settings) pins a
  fixed width, and double-clicking a handle restores automatic proportional
  scaling. The supported width range is now 400–1600 px.
- Settings gain a 3-card visual theme selector (浅色/深色/跟随系统).

### Changed

- The settings dialog is redesigned with a minimal top header, a borderless
  left navigation rail with pill tabs, a unified dialog surface, and soft
  10 px rounded-rectangle 36 px controls: compact centered numeric fields
  with adjacent units, soft-filled selects, and a full-width stacked API
  endpoint.
- The dark theme uses a recessed `#141518` canvas with lighter charcoal
  `#222328` side panels and header, while dialogs and popovers step above
  both; the native window background matches the new canvas on startup.
- Fenced and inline code sit on the new quiet `--surface-code` tone, one step
  above the canvas.
- The file tree and search results mark the selected row with a neutral
  `--surface-active` pill instead of an accent wash, the outline toolbar
  groups its toggles beside an icon-only 大纲 header button, and focus rings
  use a solid neutral slate.

## [0.2.6] - 2026-11-27

### Changed

- Localized the find/replace panel to Chinese and applied the shared
  token-driven surface and match colors to its fields, buttons, and close
  control.
- Narrow windows now clamp panel widths and auto-hide panels without
  overwriting saved layout preferences; the document title folds on scroll,
  and the outline follows the active heading, including when it sits inside a
  collapsed branch.
- The explorer marks the open document separately from keyboard focus, the
  quick switcher keeps global indices across its 更多… disclosure, and the
  welcome screen uses platform-specific wordmarks and shortcuts, file/folder
  tags, and aligned rows.
- Settings use 34 px capsule controls with explicit units, a stable top
  anchor, compact short sections, and neutral borders; confirmation and
  recovery dialogs group actions behind filled primary and outline danger
  buttons.
- Fenced and inline code sit on the quiet panel surface, heading markers hang
  out of flow, and presentation slides share the editor's code, inline-code,
  and frontmatter styling.

### Fixed

- Muted text, primary/danger fills, and focus rings meet contrast targets in
  both themes, and focus outlines no longer alter control shape.
- Fenced code blocks no longer stand out as card-like surfaces, and inline
  code uses a monospace surface instead of the previous italic serif
  treatment.
- The search view groups matches by file with consistent row geometry,
  highlighted hits, and accessible labels; settings no longer jump vertically
  between sections.
- A missing translation key is presented as a setup notice with a direct
  settings action instead of a generic failure alert.

## [0.2.5] - 2026-11-22

### Changed

- Refined workspace navigation with a Markdown-only explorer, quick file
  switching, dedicated full-text search, compact titlebar controls, and a
  dual-pane settings dialog with transparent controls and descriptive labels.
- Updated macOS and Windows application icons, with matching raster assets for
  every bundled size.

### Fixed

- Improved tab creation, sidebar toggling, titlebar alignment and window
  dragging, panel spacing, narrow-window settings layout, and sidebar corner
  continuity.

## [0.2.0] - 2026-11-22

Workspace navigation overhaul, with a more reliable document lifecycle and a
production-based performance and native-testing foundation.

### Added

- A VS Code-inspired workspace shell: a persistent activity rail, a collapsible
  Markdown-only file explorer with filtering, horizontal document tabs, and a
  welcome screen with launch actions and recent files/folders.
- A dedicated horizontal slider below overflowing Markdown tables, synchronized
  with native scrolling and operable by pointer and keyboard without changing
  the document source.
- A dedicated native E2E build and scenario runner that exercises the real Tauri
  backend for editing/saving, external changes, and crash recovery.
- Production-browser performance fixtures and reports alongside packaged-app
  startup measurements.

### Changed

- Save/save-as, external-change handling, recovery-draft scheduling, and draft
  restoration now have independent, testable state modules while preserving the
  existing controller API and document-loss safeguards.
- Extreme documents retain selection and undo history while switching to a core
  Markdown grammar with boundary hysteresis, reducing parser work during typing.
- Document actions live in the right outline toolbar; the unified titlebar keeps
  native window dragging available outside its controls.

### Fixed

- Left and right sidebars animate independently instead of replaying each
  other's entrance animation.
- Tabs, panel connectors, and collapsed-rail corners align without shadows or
  gaps, and the last-tab create control no longer moves unrelated tabs.
- Long table content remains reachable in both editing and reading modes.

## [0.1.17] - 2026-09-23

### Fixed

- Task-list checkboxes now show the checkmark as soon as a click completes,
  in sync with the checked task's strikethrough. The strikethrough appears
  immediately, and the checkbox's scale feedback finishes in 100 ms.

### Release

- Release jobs now upload into one draft created before the macOS, Linux, and
  Windows builds start. The draft is published only after all three finish,
  so the updater cannot see incomplete platform artifacts.
- The macOS release job no longer blocks on Apple credentials: with no
  Developer ID certificate configured it builds and publishes an unsigned
  (ad-hoc) app and appends a first-launch Gatekeeper-bypass install note to
  the release notes; a partially configured credential set still fails the
  job. With all credentials configured it signs and notarizes as before.

## [0.1.16] - 2026-09-12

Bug-fix release: the findings of the 0.1.15 bug and security audit, the
cross-platform defects found by the follow-up scans, and the sidebar
performance regression that pushed large-document input latency over its
budget. Translation API keys also move out of the session file into the OS
credential store.

### Fixed

- Recovery drafts: restoring a draft whose recorded id names no tab of the
  running session, or whose target tab is dirty, no longer deletes the only
  copy of the user's unsaved work — the draft stays on disk and listed, and
  the refusal surfaces as an alert. A restore that does merge into an open
  tab writes the recovered text to that tab's own draft before the leftover
  is discarded, covering the case where a new tab reuses the crashed tab's
  id and the write replaces the leftover draft in place.
- Emptied documents keep their draft: restoring a draft whose text is empty
  but whose saved version was not restores it dirty, so clearing a whole
  document still has close confirmation and recovery protection.
- Recovery dialog: an entry whose draft is already gone from disk is
  removed on click instead of failing on every attempt.
- Save As: saving onto a path another open tab owns no longer marks the
  source tab as an external disk conflict — nothing on disk changed, so no
  conflict dialog is raised.
- Save As aliases (Windows): `\\?\C:\docs\a.md` and `C:\docs\a.md` now
  resolve to the same file, so an extended-path spelling can no longer
  bypass the open-tab collision check.
- Recently closed: reopening a document reads it from disk again; a clean
  snapshot follows the disk's current content, a dirty snapshot keeps its
  local draft and only reports a conflict when the saved version moved, and
  a vanished file marks the tab missing.
- Stale reads: a disk reload that outlives a Save As, rename, or save on
  the same tab can no longer overwrite the tab's newer content.
- Rename: case-only renames work on case-insensitive filesystems (macOS,
  Windows) instead of being rejected as an existing-file conflict.
- Watches: a rename retargets the document watch to the canonical new path
  so external edits still reload the tab, and a platform watch whose
  registration was lost is re-issued on the next acquire instead of leaving
  the file silently unwatched.
- New files: documents created by Save As, or by an untitled document's
  first save, use the umask default mode (0644 typically) instead of 0600;
  existing files keep their own mode.
- Table cells: copy, cut, paste, and select-all inside a rendered table
  cell now act on the cell's DOM selection — from the keyboard and from the
  context menu — instead of unrelated text at the document head; menu paste
  no longer gets dropped, and cut deletes only the selected cell text.
- Multi-cursor typing in fenced code blocks: auto-closing fences and
  bracket pairing stand down for multi-range edits, so no cursor loses its
  character and Backspace deletes only what it should.
- IME: math decorations freeze during composition and recompute at
  `compositionend`, so the composing caret is no longer reset mid-preedit
  (WebKitGTK, fcitx5).
- Images: protocol-relative destinations (`//cdn.example.com/x.png`) load
  over https instead of resolving into an unloadable asset URL.
- Windows image paste: clipboard paths are compared with normalized
  separators, so pasting an image inside the document's own directory
  writes a relative path instead of an absolute backslash path.
- Translation batches: results map back by unit identity, so a paragraph
  already in the target language no longer shifts later translations into
  its slot.
- Translation viewport priority: consecutive runs in the same tab keep
  translating the visible screen first — a finished run no longer
  unregisters the range provider the next run needs.
- Translation errors: a failed request no longer leaves the translation
  overlay up with editing and saving blocked; the error banner keeps its
  retry and gains a close button, and the original text stays saveable.
- Translation settings: in-memory results are bound to the endpoint, model,
  target language, and concurrency that produced them, so changed settings
  re-translate instead of showing the previous language's output.
- Translation cache: the cache key includes the endpoint, so the same model
  behind a different provider or proxy no longer serves the other
  endpoint's cached text.
- Markdown fidelity: the translation segmentation and presentation
  pagination scanners now share one CommonMark-faithful fence rule — a
  backtick fence whose info string contains a backtick is prose, a closing
  fence needs the same character at equal or greater length with only
  whitespace after it, and blockquote, list, and interleaved list-quote
  prefixes (a bullet holding a blockquote that holds the fence, and the
  other way round) are consumed at their own marker depth. Inline code
  closes only on an exactly equal backtick run, `$a$$b$` stays one math
  span, and list-item fences and four-column indented code are protected in
  slides — no longer translated, and no longer split on a `---` inside
  them.
- Sidebar performance: the tab list receives only the fields its rows
  render instead of every open document's text, so React's prop diffing no
  longer stringifies large documents per keystroke — pressure-document
  input latency p95 fell from 80 ms to 44 ms and the performance gate is
  green again.

### Security

- Translation API keys no longer travel through the frontend or
  `session.json`: settings name a key slot and the backend keeps the secret
  in the OS credential store (Keychain, Windows Credential Manager, or
  Secret Service), with an owner-only file as a fallback while no system
  store is reachable. Plaintext keys of an older session are migrated on
  first load and a failed migration never drops them. The settings dialog's
  API Key field is write-only: it shows a saved placeholder instead of the
  key, offers a clear button, and warns when the fallback file is in use.
- Dependency advisories from the audit were closed where a safe upgrade
  exists: `npm audit` reports zero vulnerabilities, and `event-listener`
  moved to its patched release. The remaining Cargo advisories (`glib`
  0.18, the `unic-*` crates, `proc-macro-error`) have no fixed release
  reachable from Tauri 2 and stay recorded in the audit report.

## [0.1.15] - 2026-09-05

Document translation overhaul: much faster, much cheaper, and free-tier
friendly.

### Added

- Provider presets in the settings dialog: 智谱 GLM-4.7-Flash (free tier),
  腾讯混元 Hy-MT2-Lite (translation-dedicated, ~¥0.3/M tokens), and DeepSeek
  V4 Flash (cheap, context caching). A preset fills the verified endpoint,
  model, and a sane concurrency; every preset remembers its own API key, so
  switching providers never re-asks for one.
- Viewport-first translation: the screen you are reading is translated first,
  nearby content is prefetched, and the rest of the document finishes in the
  background; scrolling re-prioritizes live.

### Changed

- Batched provider requests: chunks are packed into a single chat completion
  (up to 8 chunks / 4000 characters) behind numbered delimiter lines with
  strict reply validation and per-segment fallback — an order of magnitude
  fewer round trips, and the system prompt is no longer re-sent per chunk.
- Chunks already written in the target language are skipped via a
  conservative script-ratio heuristic and never hit the provider.
- Slimmer system prompt, `temperature: 0`, and one asynchronous retry that
  honors a 429 `Retry-After` header.
- Reasoning is turned off where providers enable it by default (智谱 and
  DeepSeek get `thinking: disabled`; OpenAI reasoning models get
  `reasoning_effort: low`) — thinking tokens are billed as output and add
  seconds of latency per request.

### Fixed

- 智谱 GLM translations returning empty text: glm-4.7-flash reasons by
  default and could exhaust the whole completion budget on reasoning tokens.
- Viewport priority no longer skews when a document contains tall protected
  blocks (code fences, display math); priority now maps the visible character
  range instead of the pixel scroll fraction.
