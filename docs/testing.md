# Testing

How Markdown Edit is verified: automated gates, browser-shell E2E, the
performance benchmark, and the manual macOS acceptance checklist. Run every
applicable section before a release; the release candidate gate is
`docs/releasing.md` §Release candidate gate.

## Automated gates

```sh
npm test                # vitest unit/component tests (jsdom)
npm run build           # tsc -b + vite production build
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:e2e        # Playwright browser-shell flows (below)
npm run perf            # performance budgets → tests/perf/report.json
```

CI runs `npm test`, `npm run build`, `cargo fmt --check`, `cargo clippy`,
`cargo test`, and `npm run test:e2e` on every push (`.github/workflows/ci.yml`).

## Browser-shell E2E (tests/e2e/)

`npm run test:e2e` starts the Vite dev server on port 1421 with `VITE_E2E=1`
and drives the real shell in headless Chromium. The composition root
(`src/app/App.tsx`) selects the port: with `VITE_E2E=1` and a
`window.__E2E_FIXTURE__` JSON fixture installed via `page.addInitScript`,
`src/app/e2e.ts` builds a `MemoryDocumentPort` and publishes it as
`window.__E2E_PORT__` for scripting (disk events, write inspection).
Production builds never define `VITE_E2E` and always use the Tauri port.

Covered flows (real CodeMirror interactions, no reducer calls):

- open two files, switch tabs, edit, save with ⌘S;
- dirty close → cancel keeps the tab and edits;
- live preview ↔ source mode toggle (marker hiding);
- LaTeX success renders KaTeX, invalid formula shows a non-blocking error
  and never blocks editing;
- find/replace (⌘F panel, replace all) in the current document;
- folder drawer: open folder, expand tree, open a file, collapse/expand;
- external conflict: dirty tab + disk change → dialog → 保留当前版本;
- crash recovery: launch draft → 查看源码 → 恢复.

## Manual macOS acceptance checklist

Requires a release build on an Apple Silicon Mac
(`npm run tauri build -- --bundles app,dmg`; install the `.app` from the DMG
into `/Applications` or run it in place). Check each item and record the
build SHA, chip, and macOS version with the results.

### Open paths

1. **Finder 打开方式**: right-click a `.md` file in Finder → 打开方式 →
   Markdown Edit. The file opens in a tab showing its content. Repeat with
   the app already running: the file opens as a new tab in the same window.
2. **File drag**: drag a `.md` file from Finder onto the window. It opens in
   a tab; content matches the original (no copy/import).
3. **Folder drag**: drag a folder onto the window. The sidebar opens with the
   folder as root; clicking files in the tree opens them.
4. **In-app panels**: 打开文件… and 打开文件夹… buttons in the empty state
   open the system pickers and open the selection. For 打开文件夹… the
   native folder picker must appear and respond normally — selecting and
   cancelling both work and the app does not freeze (native panels come
   from the JS dialog plugin, presented on the main thread).

### Editing

5. **Chinese IME**: switch to a Chinese input method (e.g. 拼音), type a
   sentence mid-document. Composition underlines appear during input and
   commit correctly; no dropped or duplicated characters; the dirty
   indicator appears only after committed text changes.
6. **New / save / save-as**: 新建 creates an untitled tab; ⌘S on it opens
   the save panel (另存为); after saving, the tab title shows the file name
   and ⌘S writes back in place. 另存为… on an existing file saves a copy to
   the chosen path and retargets the tab.
7. **CRLF/BOM preservation**: prepare a UTF-8-with-BOM, CRLF file (e.g.
   `printf '\xef\xbb\xbfline1\r\nline2\r\n' > bom-crlf.md`). Open, edit,
   ⌘S. Verify with `xxd bom-crlf.md | head` that the BOM survives and
   `file`/`xxd` shows CRLF line endings unchanged. Repeat for an LF,
   no-BOM file: it must not gain a BOM or CRLF.
8. **Close protection**: dirty a tab, click its ×. The dialog offers
   保存 / 放弃 / 取消; 取消 returns to the dirty tab unchanged, 放弃 closes
   without writing, 保存 writes and closes. Repeat for the window close
   button with unsaved changes.
9. **Recently closed**: close a tab, press ⌘⇧T; the tab reopens with its
   content.

### Images

10. **Paste cancel**: copy an image (e.g. screenshot region), paste into a
    saved document, then cancel the save panel. No file is created and the
    document is unchanged.
11. **Paste save**: paste again and confirm the save panel (default directory
    is the document's directory). The image file appears on disk and a
    relative `![](…)` reference renders inline. Repeat in an untitled
    document: the panel defaults to the system recent location; after
    saving, an absolute path is inserted.
12. **Image drop**: drag an existing image file from Finder into the editor.
    No copy is made; a path to the original file is inserted (relative when
    expressible from the document directory).

### External changes

13. **External edit, clean tab**: with the file open and unmodified, edit it
    in another editor and save. The tab reloads the new content without
    prompting.
14. **External edit, dirty tab**: dirty the tab, then modify the file
    externally. The conflict dialog offers 载入磁盘版本 / 保留当前版本 /
    另存为…; each choice behaves as labeled and none loses data silently.
15. **External delete**: delete the open file in Finder. The buffer is
    retained and marked; saving offers 另存为.
16. **External move/rename**: move the open file to another folder. The tab
    follows the new path (when inside the watched root) or retains the
    buffer with a prompt; ⌘S writes to the resolved location.

### Recovery and session

17. **Crash recovery**: dirty a tab, wait ~3 s (draft debounce is 2 s), then
    `kill -9` the app process. Relaunch: the recovery dialog lists the
    draft; 查看源码 shows the draft text; 恢复 opens it as a dirty tab;
    丢弃 removes it. A clean relaunch shows no dialog.
18. **Session restore**: open several tabs and a folder, quit normally,
    relaunch. Tabs, order, active tab, and sidebar reopen. Recent files and
    folders appear in the empty state (max 10) and a missing recent entry is
    removed only after a failed open attempt.

### Appearance

19. **Light / dark / system**: 设置 → theme. Light and Dark apply
    immediately and persist across relaunch; 跟随系统 tracks the macOS
    appearance (toggle it in System Settings while the app runs). Then do a
    visual pass in **both** themes against `docs/screenshots/`:
    - **垂直标签侧栏**: tab rows have rounded corners; hover raises a
      subtle surface, the active tab sits on a stronger surface; the status
      dot is violet (accent) for dirty, red (danger) for conflict, and
      muted for a missing file. Section headers (打开的标签 / 文件夹) are
      small, muted, and highlight on hover; collapse/expand works.
    - **三态视图控件**: 阅读/编辑/源码 renders as a capsule (inset
      container, pill radius); the active segment has a solid accent fill
      with white text, inactive segments only brighten on hover.
    - **整体质感**: dividers are low-contrast; dialogs use the large radius
      with a soft shadow over a dimmed backdrop; scrollbars are thin and
      only darken on hover; keyboard focus shows the accent-tinted ring on
      every interactive control.
20. **Reduced motion**: enable System Settings → Accessibility → Display →
    Reduce Motion. Sidebar/dialog/state transitions lose nonessential
    animation; the app remains fully usable.

### Performance cases (§9 of the design spec)

21. Generate fixtures with `npm run perf:fixtures`, then open each from
    `tests/perf/generated/` in the release build:
    - **1 MiB regular** (`regular-1mb.md`): full rendering; opens ≤ 1 s;
      sustained typing stays fluid (p95 input-to-paint ≤ 32 ms per
      `npm run perf`).
    - **2 MiB boundary** (`light-2mb.md`): opens in light mode with the
      banner; 继续完整渲染 restores full rendering for that tab; closing and
      reopening returns to automatic light mode; text is never altered.
    - **10 MiB pressure** (`pressure-10mb.md`): opens ≤ 3 s in light mode;
      typing p95 ≤ 50 ms; ⌘S saves ≤ 1 s. The banner is dismissible.
22. `npm run perf` (headless Chromium harness, `docs/performance.md`) must
    report PASS for every budgeted metric; process-level hot-start samples
    come from the packaged build (quit all running instances first).

## Intentional environment-only limitations

- **Browser-shell E2E and perf metrics run in headless Chromium**, not the
  packaged WKWebView build. They verify the React/CodeMirror layer and the
  port contract; native behavior (Finder integration, file dialogs, IME,
  real disk watching, drag-in from Finder) is covered by the manual
  checklist above. Numbers are recorded separately from, and never mixed
  with, the M1/8 GB release baseline (see `docs/performance.md`).
- **E2E uses the in-memory port**, so native save dialogs, asset scopes, and
  the Rust watcher are exercised by unit/component tests
  (`MemoryDocumentPort` shares the same `DocumentPort` contract) plus the
  manual checklist — not by Playwright.
- **Cold start and Gatekeeper first launch** cannot be measured in a single
  session: cold samples require one launch per reboot cycle and the
  Gatekeeper sample requires installing the signed/notarized build. They
  accumulate via `scripts/measure-startup.mjs --cold|--gatekeeper` and are
  reported as skipped (never faked) until collected.
- **Signing and notarization are release-machine-only**: they need Apple
  Developer credentials in the keychain/environment (see
  `docs/releasing.md`). Local ad-hoc builds are labeled non-release by
  `scripts/verify-macos-bundle.sh` and skip Gatekeeper assessment.
- **Runtime asset scopes are additive-only**: the Rust registry is the
  authoritative record, but webview-level filesystem grants acquired for a
  document or workspace persist for the app's lifetime — closing a tab or
  folder releases the registry reference, not the runtime grant. Accepted
  because grants only ever widen within a session the user explicitly
  opened.
- **FSEvents move detection is best-effort**: a rename on macOS often
  arrives as a `missing` event for the old path plus a `changed` event for
  the new one rather than a single `moved` event. Tabs handle both shapes
  (buffer retained on `missing`, clean tabs follow `moved`), so the
  worst case is a transient missing marker — never lost text.
- **Live-instance detection matches the absolute binary path**: the
  process harness (`scripts/measure-startup.mjs`) finds running instances
  with `pgrep -f` on the packaged binary's absolute path, so it cannot
  confuse the app with another process — but it also only detects that
  exact build location.
- **No checked-in Markdown fixture corpus**: the plan's
  `tests/fixtures/markdown/*.md` files were intentionally replaced by
  printf-based steps in the manual checklist above plus the seeded,
  generated performance fixtures (`npm run perf:fixtures`,
  `tests/perf/generated/`, git-ignored), which are deterministic without
  committing large binaries.

## Spec coverage audit (design spec §12, nine completion criteria)

| # | Completion criterion | Evidence |
| --- | --- | --- |
| 1 | Install and launch on macOS | Release packaging + notarization (`docs/releasing.md`); bundle verification (`scripts/verify-macos-bundle.sh`); manual checklist preamble |
| 2 | Open/drag/create/save Markdown from anywhere | vitest document/save suites; E2E open-two-files + edit/save; manual §Open paths, §6, §7 |
| 3 | Multiple tabs in one window | vitest tab suites; E2E tab open/switch/close-cancel; manual §8, §9 |
| 4 | Optional folder with collapsible sidebar | vitest workspace/tree suites; E2E folder-drawer flow; manual §3, §18 |
| 5 | Markdown + LaTeX source editing and live typesetting | vitest live-preview/math suites; E2E source/live toggle + LaTeX success/error; manual §5, §7 |
| 6 | No unsaved-content loss on save failure, external change, or crash | vitest conflict/recovery/save-failure suites; E2E conflict + recovery; manual §13–§17 |
| 7 | Light / Dark / System with consistent Baseline styling | vitest theme suites; `docs/screenshots/`; manual §19, §20 |
| 8 | Case/whole-word/regex find-replace in the current document | vitest search suite; E2E find/replace; (manual ad hoc during §Editing) |
| 9 | Quantified performance within budgets | `npm run perf` budgets + `tests/perf/report.json`; manual §21, §22 |

Every design-spec section also maps to an implementation task in
`docs/superpowers/plans/2026-07-22-lightweight-markdown-editor.md` (spec
coverage matrix). No requirement is dropped; the environment-only
limitations above are the intentional ones.
