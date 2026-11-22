# Activity Rail and Welcome Screen Design

Date: 2026-11-21

## Approved direction

Use VS Code's navigation structure without copying developer-specific features:

- A narrow, always-visible activity rail sits at the far left of the application
  body. It contains a resource-manager toggle at the top and settings at the
  bottom. It never collapses with the file explorer and contains no Git,
  repository, or project actions.
- The existing file explorer remains independently collapsible and resizable.
- The welcome screen has one launch/recent column and no decorative side area.
  Closing the last document returns to this screen.

## Alternatives considered

- Reproduce the full VS Code activity bar and welcome page, including Git and
  developer tools: rejected because it contradicts Opus's Markdown-only scope.
- Keep a single-column welcome screen with large action buttons: rejected by the
  supplied reference images; compact text actions are easier to scan.
- Add a decorative watermark and duplicate shortcut reference: rejected by the
  follow-up annotations; the launch actions already expose the real shortcuts.
- Implement only CSS changes in `AppShell`: rejected because the welcome screen
  now has meaningful recent-list behavior and benefits from a dedicated,
  independently testable component.

## Activity rail

The rail is a semantic navigation landmark. The resource-manager button uses the
existing sidebar preference and ARIA controls, so keyboard behavior and saved
collapsed state are unchanged. The settings button uses the existing dialog.
The titlebar's old sidebar toggle and the explorer's old footer gear are removed;
there is exactly one resource-manager toggle and one settings entry.

The rail is fixed-width (44 px), full height, and visible whether the explorer is
open, closed, or collapsed. The existing outline stays on the right.

## Welcome screen

A dedicated `WelcomeScreen` component renders:

- `Opus` as the page title and a 启动 section with 新建文件…, 打开文件…, and
  打开文件夹…. These use the existing controller actions and current shortcuts.
- A 最近 section containing up to five items from the existing recent session
  list. Each row is an accessible button without a file icon: the file/folder
  name is highlighted with the accent color and followed by its parent
  directory in secondary text. File paths do not repeat the basename, and the
  standard macOS/Linux/Windows home prefix is displayed as `~`. The full path
  remains in the accessible button name and native tooltip. Long display text
  truncates only visually with CSS.
- If more than five items exist, a native `<details>` disclosure labeled 更多…
  contains the remaining items (up to the existing ten-item session limit).

Recent-file and recent-folder activation goes through
`controller.openRecent` and preserves the existing reveal-sidebar behavior:
opening a recent folder reveals a collapsed explorer, while session restores
keep their persisted collapse state. The welcome page is mounted directly in
the empty editor area, which keeps the `空白状态` region name without the old
`empty-hero` wrapper.

## Styling and accessibility

Use existing tokens, flat surfaces, and native `<details>`. The launch links use
text and icons rather than large cards; recent rows omit icons. Section headings
and recent names use the accent color. Native buttons and disclosure provide
keyboard behavior without new custom key handlers. The short display path is
hidden from assistive technology because the button's accessible name already
contains the complete path; a native tooltip supplements rather than replaces
that name. Reduced-motion rules and both themes remain supported.

## Verification

- Component tests cover five-item limiting, remaining-item disclosure, compact
  POSIX/Windows paths, full accessible paths, absent decorative content and
  recent icons, file/folder activation, and shortcut labels.
- Shell tests cover rail persistence during explorer collapse, one settings
  entry, welcome rendering after closing the final tab, five-item limiting and
  更多… in the real shell, recent-file activation, and recent-folder reveal.
- Browser E2E covers startup, closing `欢迎.md`, five recent items, 更多…,
  opening recent files, the 44 px rail while the explorer is collapsed, and
  1280/1080/680 widths.
- Run the complete frontend/Rust checks and browser suite, then inspect the
  rendered welcome screen in both themes.
