# Testing

How Opus is verified: automated gates, browser-shell E2E, the
performance benchmark, and the manual acceptance checklists (macOS and
Windows). Run every
applicable section before a release; the release candidate gate is
`docs/releasing.md` §Release candidate gate.

## Automated gates

```sh
npm test                # vitest unit/component tests (jsdom)
npm run test:node       # node --test for scripts/*.node-test.mjs
npm run build           # tsc -b + vite production build
npm run perf:build      # production perf entry → dist-perf/ (build-rot gate)
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --features native-e2e --lib native_e2e
npm run test:e2e        # Playwright browser-shell flows (below)
npm run test:native -- --build   # real Tauri process, default smoke scenario (below)
npm run perf            # production-bundle + packaged-app budgets → tests/perf/report.json
```

CI runs every push (`.github/workflows/ci.yml`): on `macos-latest` a `check`
job (`npm test`, `npm run test:node`, `npm run build`, `npm run perf:build`,
Rust fmt, clippy with and without the `native-e2e` feature, Rust tests with
and without it) and an `e2e` job; `check-linux` on `ubuntu-latest` (frontend
build plus Rust fmt/clippy/tests for the Linux toolchain); a `native-e2e` job
on `ubuntu-latest` configured to run
`xvfb-run --auto-servernum npm run test:native -- --build --scenario all` and
to upload `test-results/native-e2e/` on failure; and `check-windows` on
`windows-latest` (frontend tests/build plus Rust fmt/clippy/tests, both
feature sets).

## Browser-shell E2E (tests/e2e/)

`npm run test:e2e` starts the Vite dev server on port 1421 with `VITE_E2E=1`
and drives the real shell in headless Chromium. The composition root
(`src/app/App.tsx`) selects the port: with `VITE_E2E=1` and a
`window.__E2E_FIXTURE__` JSON fixture installed via `page.addInitScript`,
`src/app/e2e.ts` builds a `MemoryDocumentPort` and publishes it as
`window.__E2E_PORT__` for scripting (disk events, write inspection).
Production builds never define `VITE_E2E` and always use the Tauri port.
This suite deliberately stays on the in-memory port: it covers UI behavior,
not the native seam. The native suite below covers the real Tauri backend for
a smaller, workflow-shaped set of scenarios.

Covered flows (real CodeMirror interactions, no reducer calls):

- open two files, switch tabs, edit, save with ⌘S;
- dirty close → cancel keeps the tab and edits;
- reading ↔ editing view toggle (marker hiding; reading is read-only);
- interactive Markdown tables: native cell typing, plain-text paste,
  Tab navigation/row append, isolated undo/redo, exact save fidelity, and
  reading-mode click-to-edit handoff;
- LaTeX success renders KaTeX, invalid formula shows a non-blocking error
  and never blocks editing;
- find/replace (⌘F panel, replace all) in the current document;
- welcome page: single-column launch/recent layout at startup and after closing `欢迎.md`, five-item recent limit, native 更多… disclosure, accent section headings and recent names with compact parent paths, recent-file activation, the persistent 44 px activity rail while the explorer is collapsed, and 1280/1080/680 px layouts without horizontal overflow;
- folder explorer: open folder, expand tree, open a file, collapse/expand;
- external conflict: dirty tab + disk change → dialog → 保留当前版本;
- crash recovery: launch draft → 查看源码 → 恢复.

## Native E2E (real Tauri process)

```sh
npm run test:native -- --build --scenario smoke   # build + one scenario
npm run test:native -- --build --scenario all     # build + all four scenarios
node scripts/native-e2e.mjs --release --scenario all   # optimized test build
node scripts/native-e2e.mjs --app <path>          # reuse a built test binary
```

`scripts/native-e2e.mjs` builds and launches a dedicated Tauri application;
`--help` lists every option. It is the only automated suite that exercises
the real `TauriDocumentPort`, the Rust file I/O, the watcher, and the real
recovery store in a native webview.

### Dedicated build and isolation

- **Feature-gated commands**: `src-tauri/src/native_e2e.rs` is compiled only
  with the `native-e2e` Cargo feature and registers three commands
  (`native_e2e_context`, `native_e2e_marker`, `native_e2e_report`). Normal
  dev, production, and release builds never include them.
- **Dedicated identifier**: `src-tauri/tauri.native-e2e.conf.json` sets
  product name `Opus Native E2E` and identifier
  `com.xiongweini.markdown-edit.native-e2e`. The Rust side refuses to start
  the test webview under the production identifier or any identifier without
  the `.native-e2e` suffix, so a feature-enabled binary built without the
  config override fails fast instead of writing into a user installation.
- **Environment-only configuration**: the scenario and the marker/report
  paths come from `OPUS_NATIVE_E2E_SCENARIO`, `OPUS_NATIVE_E2E_MARKER`, and
  `OPUS_NATIVE_E2E_REPORT` in the child process environment. The webview can
  only request a context, write a phase marker, or submit a report body; it
  can never name an output path. Reports are JSON objects, capped at 1 MiB,
  stamped server-side with the scenario and identifier, and written with the
  sibling-temp-file + `fsync` + rename discipline so a polling orchestrator
  never sees a partial document.
- **Frontend runner**: `src/app/nativeE2e.ts` is imported dynamically from
  `AppShell` only when `import.meta.env.MODE === "native-e2e"` (the
  `native-e2e` Vite mode); normal builds tree-shake it. Update checks
  short-circuit to `unsupported` in this mode.

### Scenarios

Synchronization is marker-file based; there are no fixed sleeps. The runner
writes a phase only after observing the corresponding state, and the
orchestrator performs an external write only after reading the phase that
requests it.

| Scenario | What is driven | External verification |
| --- | --- | --- |
| `smoke` | argv open → editor mounted | report path is canonical; text and BOM/CRLF match the fixture; fixture bytes unchanged |
| `edit-save` | CodeMirror edit → controller save → Rust write | saved bytes keep `EF BB BF`, every newline stays CRLF, the edit token occurs exactly once |
| `external-change` | external rewrite of a clean tab → watcher reload; dirty tab → conflict dialog → 载入磁盘版本 | reloaded text matches the external write; dirty buffer survives; resolved text equals final disk bytes |
| `recovery` | edit → poll `listDrafts()` until the draft is durable → `draft-ready` → **SIGKILL** → relaunch → restore | the persisted draft (read by its real id) survives the kill unchanged; restored tab is dirty and its text/hash match the archived draft |

The recovery scenario never guesses a draft file name: draft IDs now carry a
per-launch namespace (`draft-<uuid>-<tab id>`, `src/recovery/drafts.ts`), so
the runner reports the id it actually listed and the orchestrator reads
`recovery/<id>.json` through `listDrafts()`' result. Legacy
`draft-document-N` leftovers remain readable and are migrated by
`restoreDraft` into a namespaced owner copy before being discarded.

Diagnostics land in `test-results/native-e2e/run-<timestamp>/`:
`summary.json` (status, markers, launches, fixture/app hashes, cleanup
record), per-launch `app-launch-*.log`, `report*.json`,
`marker-launch-1.json`, and the archived `draft-launch-1.json`. A scenario
failure exits non-zero; a runner-side timeout first writes a precise failure
report and a `failed` marker (the orchestrator waits 90 s runner deadline +
30 s startup grace). Child processes, fixtures in the OS temp directory, and
test data are cleaned in `finally`.

### Test-data boundary (platform-specific)

- **macOS / Linux**: the child runs with an isolated `HOME` plus
  `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME` (and `TMPDIR`), so
  session and recovery data stay inside the scenario directory.
- **Windows**: Rust resolves app data through the shell known folder
  (`FOLDERID_RoamingAppData`), **not** the child's `APPDATA`, so `HOME` or
  `APPDATA` overrides do not relocate real data. Isolation there is the
  dedicated `.native-e2e` identifier under the real per-user app-data root.
  Cleanup revalidates that the directory basename equals the test identifier
  and refuses to touch the production identifier; because that path is fixed
  by the identifier, Windows native runs must not execute concurrently.

### Platform status

- macOS: the suite runs locally (there is no macOS native CI job); a release
  gate must record its actual result. Latest recorded local all-scenario run:
  `run-2026-11-20T22-38-07-511Z` (`smoke`, `edit-save`, `external-change`,
  `recovery` all passed). Do not infer a macOS native pass from the unit
  tests or from the Linux job.
- Linux: the `native-e2e` CI job is configured to run all four scenarios
  under `xvfb-run`; it is the automated native gate, but no Linux pass is
  recorded here — treat it as pending CI until the job result is confirmed.
- Windows: the Rust feature and commands compile in the Windows CI check, but
  the native scenarios have not been executed on Windows; treat them as
  unverified there until a real run is recorded.
- Still manual everywhere: native file/folder panels, Finder/Explorer file
  associations, macOS/Windows IME behavior, drag-in from the OS file manager,
  and signed-installer/Gatekeeper acceptance. The native suite does not
  replace the checklists below.

## Manual macOS acceptance checklist

Requires a release build on an Apple Silicon Mac
(`npm run tauri build -- --bundles app,dmg`; install the `.app` from the DMG
into `/Applications` or run it in place). Check each item and record the
build SHA, chip, and macOS version with the results.

### Open paths

1. **Finder 打开方式**: right-click a `.md` file in Finder → 打开方式 →
   Opus. The file opens in a tab showing its content. Repeat with
   the app already running: the file opens as a new tab in the same window.
2. **File drag**: drag a `.md` file from Finder onto the window. It opens in
   a tab; content matches the original (no copy/import).
3. **Folder drag**: drag a folder onto the window. The sidebar opens with the
   folder as root; clicking files in the tree opens them.
4. **In-app panels**: 打开文件… and 打开文件夹… buttons in the empty state
   open the system pickers and open the selection. For 打开文件夹… the
   native folder picker must appear and respond normally — selecting and
   cancelling both work and the app does not freeze (native panels come
   from the JS dialog plugin, presented on the main thread). The same
   actions are available from the native File menu (打开文件… ⌘O,
   打开文件夹… ⌘⇧O).

### Editing

5. **Chinese IME**: switch to a Chinese input method (e.g. 拼音), type a
   sentence mid-document. Composition underlines appear during input and
   commit correctly; no dropped or duplicated characters; the dirty
   indicator appears only after committed text changes.
6. **New / save / save-as**: 新建 (File menu, ⌘N) creates an untitled tab;
   ⌘S on it opens the save panel (另存为); after saving, the tab title
   shows the file name and ⌘S writes back in place. 另存为… (File menu,
   ⌘⇧S) on an existing file saves a copy to the chosen path and retargets
   the tab. 设置 lives in the App menu (⌘,) and opens the settings dialog;
   the production header has no text buttons for these actions.
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

### Markdown tables

- **Native click-to-edit lifecycle (WKWebView)**: run this in the packaged
  Opus app, not the Chromium E2E shell. In 阅读模式, left-click a header cell,
  then return to 阅读模式 and left-click a populated body cell. Each click must
  immediately return to 编辑模式 with a visible caret in the clicked cell at
  the pointer position. In 编辑模式, click the first character, the middle,
  and the end of populated cell text and type a different marker at each
  position; all three markers must land at their clicked positions, with no
  change to adjacent cells or surrounding Markdown. Repeat a header and body
  edit with the macOS Chinese IME, use Tab and Shift+Tab to move between
  cells, undo and redo each edit, then ⌘S. Fully quit with ⌘Q, reopen the
  same file in Opus, and verify the saved Markdown contains exactly those
  edits and no transient click/selection changes.
- **Cell editing**: edit header cells, body cells, and empty cells. Enter
  Chinese text and a literal `|`; the visible cell shows the pipe while the
  saved Markdown escapes it as `\|`. Adjacent cells and surrounding text do
  not change.
- **Keyboard navigation**: press Tab and Shift+Tab across header/body
  boundaries. Tab from the final cell appends exactly one correctly indented
  row and focuses its first cell; Shift+Tab from the first cell stays safely
  within the table.
- **History**: undo/redo a direct cell edit, then separately undo/redo a row
  appended by final-cell Tab. One undo of the append removes only that row;
  the preceding cell edit remains until its own undo.
- **Chinese system IME**: with the macOS Chinese input method, compose in a
  header, populated body cell, and empty body cell. Candidate selection must
  remain focused in that cell, intermediate composition text must not commit
  to Markdown, and the final candidate must commit exactly once.
- **Nested tables**: repeat final-cell Tab for a table inside a blockquote and
  inside a list. The new row keeps the original quote/list prefix and the
  surrounding block structure remains intact.
- **Layout and focus**: in a narrow window, verify wide tables scroll
  horizontally without clipping or moving borders. In both Light and Dark
  themes, header/body borders, alignment, rounded corners, and the keyboard
  focus ring remain clearly visible without shifting cell layout.
- **Large-document light mode**: in a document that triggers the performance
  banner, tables of at most 1,000 cells remain semantic and interactive. A
  table over 1,000 cells stays as editable raw Markdown without an atomic
  range; nearby smaller tables still render. 继续完整渲染 restores the
  oversized semantic table without changing text or undo history.
- **Save/reopen fidelity**: save and reopen a table containing empty cells,
  Chinese text, and escaped pipes; source spelling and outside text remain
  exact. Repeat with a CRLF file through the native backend and verify its
  original newline style is preserved.
- **Reading mode**: switch while a table cell is focused. The semantic table
  remains visible with native table/header/cell semantics, no cell is a tab
  stop or editing host, typing/paste cannot dirty or change the document, and
  switching back restores cell editing.

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
    relaunch. Tabs, order, active tab, and sidebar reopen. Closing the last
    document returns to the same welcome page; its 最近 section lists the
    first five recent files/folders with the rest behind 更多… (the session
    keeps up to 10), names and section headings use the accent color, and the
    secondary text shows a compact parent directory with the home prefix
    shortened to `~` where recognized. The button tooltip and accessible name
    retain the full path. A missing recent entry is removed only after a failed
    open attempt. Opening a recent folder reveals the explorer even when it
    was collapsed.

### Appearance

19. **Light / dark / system**: 设置 → theme. Light and Dark apply
    immediately and persist across relaunch; 跟随系统 tracks the macOS
    appearance (toggle it in System Settings while the app runs). Then do a
    visual pass in **both** themes against `docs/screenshots/`:
    - **欢迎页与活动栏**: the welcome page is a single launch/recent column
      with `Opus`, accent-colored section headings, and no watermark or
      duplicate shortcut panel. Launch actions retain the real keyboard
      shortcuts; recent rows have no file icons and show compact parent
      directories. The 44 px activity rail stays at the far left when the
      explorer is expanded, collapsed, or animating; collapsing the explorer
      never removes the rail or its settings button. Check the launch/recent
      column at wide and narrow window sizes.
    - **顶部文件标签与资源管理器**: document tabs share the unified top bar,
      aligned to the editor column without covering the activity rail or file
      explorer. The top bar and left panels share the same surface color; there
      is no global search field. The selected file tab shares the editor canvas
      color and joins
      it through inverse radial shoulders on both sides, with no accent
      underline or hover wash; Left/Right switches tabs and the selected tab
      scrolls into view. Close buttons reveal on hover/focus; only the last tab
      springs a create button out to its right. Blank top-bar regions drag the
      native window without capturing tab controls. The persistent left explorer shows
      资源管理器, only directories and `.md`/`.markdown` files, and an
      打开文件夹 entry when empty. Dirty status is violet, conflict red, and
      missing muted; rows have no inline action buttons, with rename/trash in
      their right-click menu. The filter begins as a plain option and expands
      on click; it collapses on blur only when empty.
    - **头部图标按钮**: the activity rail owns the explorer toggle
      (panel-left icon) and settings entry; view mode, translation, and
      presentation actions live in the outline toolbar. Hovering each icon button shows
      its tooltip (title); both show the accent-tinted focus ring.
    - **两态视图切换**: 阅读/编辑 toggle via the header icon or ⌘E (there
      is no source mode); 阅读 renders fully and rejects typing, 编辑
      restores live preview with marker hiding.
    - **侧栏拖拽调宽**: dragging the divider between sidebar and editor
      (role=separator) resizes the sidebar within 200–480 px; the handle
      also responds to arrow keys; the width persists.
    - **行距与公式间距**: body text uses the tightened line height
      (`--editor-line-height` 1.5) and block formulas sit closer to their
      surrounding paragraphs (`.katex-display` margin 0.25 em) — no large
      gaps above/below display math.
    - **滚动隔离**: scrolling the sidebar to its end does not scroll the
      editor and vice versa (overscroll-behavior: contain on both).
    - **整体质感**: dividers are low-contrast; dialogs use the large radius
      with a soft shadow over a dimmed backdrop; scrollbars are thin and
      only darken on hover; keyboard focus shows the accent-tinted ring on
      every interactive control.
20. **Reduced motion**: enable System Settings → Accessibility → Display →
    Reduce Motion. Sidebar/dialog/state transitions lose nonessential
    animation; the app remains fully usable.
21. **GSAP motion interaction**: rapidly switch tabs, expand/collapse both
    sidebars, open/close dialogs, and toggle reading mode. Motion may use
    transform/scale feedback, but focused controls remain focused, CodeMirror
    typing and selection remain stable, and no animation waits before the
    action is accepted. In editing mode, the CodeMirror DOM must not receive
    content transforms; reading-mode content entrances are limited to the
    visible range.

### Performance cases (§9 of the design spec)

21. Generate fixtures with `npm run perf:fixtures`, then open each from
    `tests/perf/generated/` in the release build:
    - **1 MiB regular** (`regular-1mb.md`): full rendering; opens ≤ 1 s;
      sustained typing stays fluid (p95 input-to-paint ≤ 32 ms per
      `npm run perf`).
    - **2 MiB boundary** (`light-2mb.md`): opens in light mode with the
      banner, but keeps the **full** Markdown grammar (strikethrough, tables,
      math, highlight markers, fenced-code language highlighting); 继续完整渲染
      also stays full; closing and reopening returns to automatic light mode.
      Tables over 1,000 cells use editable raw-source fallback until full
      rendering is chosen; text is never altered.
    - **10 MiB pressure** (`pressure-10mb.md`): opens ≤ 3 s in light mode and
      triggers the **core** grammar (8 MiB UTF-16 enter threshold; the
      banner says 精简 Markdown 语法). Headings/lists/quotes/code/emphasis/
      links and frontmatter remain; GFM tables/strikethrough, `==` highlight,
      `$…$` math, and nested code-language highlighting are absent. Because
      core removes GFM, it also produces no table widgets; tables and the
      independent 1,000-cell rule apply only with the full grammar (2 MiB
      light documents or after 继续完整渲染). Typing p95
      ≤ 50 ms; ⌘S saves ≤ 1 s. Press 继续完整渲染 and confirm the full grammar
      returns with the same selection and undo history. Force-full is
      tab-scoped: close and reopen the tab to return to automatic light mode,
      then reduce the text to 7.5 MiB or less (for example with a smaller
      scratch body) and confirm core exits. The banner is dismissible.
22. `npm run perf` (headless Chromium against the production perf bundle,
    `docs/performance.md`) must report PASS for every measured budgeted
    metric; packaged-app metrics that cannot be collected are reported as
    skipped with a reason, never faked. Hot-start samples come from the
    packaged build (quit all running instances first). Browser numbers are
    Chromium-engine numbers, not WKWebView numbers. The committed baseline
    table is refreshed only by a complete successful run.

## Manual Windows acceptance checklist

Requires a release build on Windows
(`npm run tauri build -- --bundles nsis`; install from the NSIS setup
executable or run the built binary in place). Check each item and record the
build SHA, Windows version, and WebView2 runtime version with the results.

### Open paths

1. **资源管理器打开方式**: right-click a `.md` file in Explorer → 打开方式 →
   Opus (the NSIS installer registers the association). The file opens in a
   tab showing its content. Repeat with the app already running: the file
   opens as a new tab in the same window.
2. **Double-click open**: double-click an associated `.md` file. With the app
   not running it launches and opens the file; with it already running the
   path is forwarded to the existing instance (`tauri-plugin-single-instance`)
   — the file opens as a new tab in the same window, which is raised and
   unminimized; no second process is started.
3. **File drag**: drag a `.md` file from Explorer onto the window. It opens
   in a tab; content matches the original (no copy/import).
4. **File dropdown menu**: Windows has no native menu bar, so the file
   dropdown in the header (same as Linux) offers 新建, 打开文件,
   打开文件夹, 另存为…, and 设置. The pickers open and respond normally —
   selecting and cancelling both work and the app does not freeze. The
   dropdown is keyboard-accessible and offers the same actions as the
   welcome page's launch actions.

### Editing

5. **Shortcuts**: with the window focused, Ctrl+N creates an untitled tab,
   Ctrl+O opens the file picker, Ctrl+Shift+O the folder picker, Ctrl+S saves
   (save panel on an untitled tab), Ctrl+Shift+S saves a copy as, Ctrl+W
   closes the active tab, and Ctrl+, opens 设置. Shortcuts are gated while a
   modal dialog is open.
6. **Chinese IME (微软拼音)**: switch to Microsoft Pinyin, type a sentence
   mid-document. Composition underlines appear during input and commit
   correctly; no dropped or duplicated characters; the dirty indicator
   appears only after committed text changes.
7. **CRLF/BOM preservation**: prepare a UTF-8-with-BOM, CRLF file (e.g.
   `printf '\xef\xbb\xbfline1\r\nline2\r\n' > bom-crlf.md`). Open, edit,
   Ctrl+S. Verify with `xxd bom-crlf.md | head` that the BOM survives and
   `file`/`xxd` shows CRLF line endings unchanged. Repeat for an LF, no-BOM
   file: it must not gain a BOM or CRLF.
8. **Close protection**: dirty a tab, click its ×. The dialog offers
   保存 / 放弃 / 取消; 取消 returns to the dirty tab unchanged, 放弃 closes
   without writing, 保存 writes and closes. Repeat for the window close
   button (×) with unsaved changes.

### Images

9. **Paste cancel / save**: copy an image (e.g. screenshot region), paste
   into a saved document, then cancel the save panel. No file is created and
   the document is unchanged. Paste again and confirm: the image file appears
   on disk and a relative `![](…)` reference renders inline. In an untitled
   document the panel defaults to the system recent location and an absolute
   path is inserted.
10. **Image drop**: drag an existing image file from Explorer into the
    editor. No copy is made; a path to the original file is inserted
    (relative when expressible from the document directory).

### External changes

11. **External edit / delete / move**: with a clean tab, editing the file in
    another editor reloads the tab without prompting. With a dirty tab the
    conflict dialog offers 载入磁盘版本 / 保留当前版本 / 另存为…; each choice
    behaves as labeled and none loses data silently. Deleting the open file
    retains the buffer and offers 另存为; moving it follows the new path (when
    inside the watched root) or keeps the buffer with a prompt.

### Recovery and session

12. **Crash recovery**: dirty a tab, wait ~3 s (draft debounce is 2 s), then
    end the process (Task Manager → End task, or
    `taskkill /F /IM Opus.exe`). Relaunch: the recovery dialog lists the
    draft; 查看源码 shows the draft text; 恢复 opens it as a dirty tab;
    丢弃 removes it. A clean relaunch shows no dialog.
13. **Session restore**: open several tabs and a folder, close the window,
    relaunch. Tabs, order, active tab, and sidebar reopen. Recent files and
    folders appear in the empty state (max 10).

### Appearance

14. **Light / dark / system**: 设置 → theme. Light and Dark apply
    immediately and persist across relaunch; 跟随系统 tracks the Windows
    appearance mode (toggle in Settings → Personalization → Colors while the
    app runs). Do a visual pass in both themes against `docs/screenshots/`
    with the same expectations as the macOS checklist §Appearance: tab row
    states and status dots, icon buttons with tooltips, 阅读/编辑 toggle,
    sidebar drag-resize, thin scrollbars, and accent-tinted focus rings.

## Intentional environment-only limitations

- **Browser-shell E2E and browser perf metrics run in headless Chromium**,
  not the packaged native builds (WKWebView on macOS, WebView2 on Windows).
  Browser E2E verifies the React/CodeMirror layer; perf now measures a
  production React bundle but still in Chromium, so its numbers are
  Chromium-engine numbers. Native behavior not covered by the native suite
  (Finder/Explorer integration, file dialogs, IME, drag-in from the OS file
  manager) stays in the manual checklists above. Perf numbers are recorded
  separately from, and never mixed with, the M1/8 GB release baseline (see
  `docs/performance.md`).
- **WebView2 vs WKWebView rendering differences are expected**: the packaged
  Windows build renders with WebView2 (Chromium) while the macOS build uses
  WKWebView. Minor engine differences — font metrics, scrollbar styling, IME
  composition details — are expected and are not regressions. The
  browser-shell E2E and perf harnesses run Chromium, so their numbers track
  the Windows engine more closely than the macOS one.
- **The native suite covers a fixed scenario set, not the whole product.** It
  drives argv open, edit/save, external clean reload and dirty conflict, and
  crash recovery through the real backend. Playwright remains the broad UI
  suite and still uses the in-memory port; unit/component tests cover the
  remaining port-contract behavior. Native save dialogs, OS file
  associations, IME, and signed-installer acceptance are not automated.
- **Extreme-document core grammar is an intentional rendering trade-off.**
  At ≥8 MiB UTF-16 in light mode, advanced Markdown syntax (GFM tables,
  strikethrough/task lists, `==` highlight, `$…$` math, nested code-language
  highlighting) is not parsed; frontmatter and base Markdown/outline remain.
  The banner says 精简 Markdown 语法, document text is unchanged, and
  继续完整渲染 restores the full grammar with selection and undo intact.
- **Native E2E platform coverage is uneven.** macOS runs the suite locally;
  Linux CI is configured to run it under Xvfb (pending a recorded CI result);
  Windows compiles the feature but has not executed the scenarios — no
  Windows native pass is claimed. On Windows
  the test-data boundary is the dedicated `.native-e2e` identifier under the
  real per-user app-data root, because Rust resolves the shell known folder
  instead of `APPDATA`; concurrent Windows native runs are unsupported.
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
| 5 | Markdown + LaTeX source editing and live typesetting | vitest live-preview/math suites; E2E reading/editing toggle + LaTeX success/error; manual §5, §7 |
| 6 | No unsaved-content loss on save failure, external change, or crash | vitest conflict/recovery/save-failure suites; E2E conflict + recovery; manual §13–§17 |
| 7 | Light / Dark / System with consistent Baseline styling | vitest theme suites; `docs/screenshots/`; manual §19, §20 |
| 8 | Case/whole-word/regex find-replace in the current document | vitest search suite; E2E find/replace; (manual ad hoc during §Editing) |
| 9 | Quantified performance within budgets | `npm run perf` budgets + `tests/perf/report.json`; manual §21, §22 |

Every design-spec section also maps to an implementation task in
`docs/superpowers/plans/2026-07-22-lightweight-markdown-editor.md` (spec
coverage matrix). No requirement is dropped; the environment-only
limitations above are the intentional ones.
