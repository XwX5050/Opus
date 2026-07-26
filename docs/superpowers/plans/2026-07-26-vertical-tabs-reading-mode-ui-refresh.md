# 垂直标签栏、阅读模式与视觉焕新实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把水平标签条改为可折叠的垂直标签侧栏，新增三态（阅读/编辑/源码）阅读模式，修复「打开文件夹」原生对话框卡死，并参考 Obsidian 做视觉全面焕新。

**Architecture:** 沿用现有 React ↔ `DocumentPort` ↔ Tauri 分层。阅读模式通过 CodeMirror Compartment 在同一 EditorView 上重配置实现（只读 + 选区感知的装饰规划可关闭），不引入第二个 Markdown 渲染器。视觉焕新只改 token 与样式表，DOM 结构大体稳定。

**Tech Stack:** Tauri 2, React, TypeScript, CodeMirror 6, Vitest, Playwright, cargo。

**Spec:** `docs/superpowers/specs/2026-07-26-vertical-tabs-reading-mode-ui-refresh-design.md`

**Boundary rules（评审会检查）:**
- React 组件不得 import `@tauri-apps/api/*`；只有 `src/document/tauriDocumentPort.ts` 可以。
- Rust 命令处理器只做校验与 DTO 转换。
- 编辑器三态语义：阅读 = 只读 + 全渲染；编辑 = 可改 + 实时渲染（默认）；源码 = 可改 + 不渲染。

---

## File map

- `src/document/tauriDocumentPort.ts`：chooseWorkspace 改用 plugin-dialog。
- `src-tauri/src/document_commands.rs`、`src-tauri/src/lib.rs`：删除 `choose_workspace` 命令。
- `src/app/TabList.tsx`（新建）：垂直标签列表组件。
- `src/app/AppShell.tsx`：移除水平标签条；侧栏两区（标签 + 文件树）；三态分段控件。
- `src/editor/viewMode.ts`（新建）：`EditorViewMode` 类型。
- `src/editor/livePreview.ts`：装饰规划支持关闭选区感知。
- `src/editor/MarkdownEditor.tsx`：`sourceMode` prop 改为 `viewMode`，增加只读 Compartment。
- `src/editor/editorExtensions.ts`：⌘E / ⌘⇧E 键位。
- `src/app/useAppController.ts`：每标签 viewMode 记忆。
- `src/theme/tokens.css`、`src/theme/app.css`：视觉焕新。
- `tests/e2e/notepad.spec.ts`：增补垂直标签与三态流程。
- `docs/screenshots/`、`docs/testing.md`：截图与手动清单更新。

---

### Task 1: 修复「打开文件夹」卡死

**Files:**
- Modify: `src/document/tauriDocumentPort.ts`
- Modify: `src/document/tauriDocumentPort.test.ts`
- Modify: `src-tauri/src/document_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tests/document_commands.rs`

背景：`choose_workspace`（`src-tauri/src/document_commands.rs:297-307`）用 `blocking_pick_folder()`，Tauri 2 同步命令在 async runtime 线程池执行，macOS 模态 NSOpenPanel 在非主线程呈现会冻结应用。

- [ ] **Step 1: 写失败的 adapter 测试**

在 `src/document/tauriDocumentPort.test.ts` 中（该文件已 mock `@tauri-apps/plugin-dialog` 的 `open`/`save`，沿用同一 mock）：

```ts
it("chooseWorkspace picks a directory through the dialog plugin and validates via open_workspace", async () => {
  dialogOpen.mockResolvedValue("/notes");
  invoke.mockImplementation(async (command: string) => {
    if (command === "open_workspace") return { path: "/notes", title: "notes" };
    throw new Error(`unexpected ${command}`);
  });
  const root = await port.chooseWorkspace();
  expect(dialogOpen).toHaveBeenCalledWith({ directory: true, multiple: false });
  expect(invoke).toHaveBeenCalledWith("open_workspace", { root: "/notes" });
  expect(root).toEqual({ path: "/notes", title: "notes" });
});

it("chooseWorkspace returns null on cancel without invoking the backend", async () => {
  dialogOpen.mockResolvedValue(null);
  await expect(port.chooseWorkspace()).resolves.toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("choose_workspace", expect.anything());
});
```

（mock 变量名以该测试文件现有命名为准。）

- [ ] **Step 2: 运行测试确认红**

Run: `npm test -- src/document/tauriDocumentPort.test.ts`
Expected: FAIL（当前实现 invoke `choose_workspace` 而非调 dialogOpen）。

- [ ] **Step 3: 实现 JS 侧文件夹选择**

`src/document/tauriDocumentPort.ts` 的 `chooseWorkspace` 改为（文件顶部已 `import { open, save } from "@tauri-apps/plugin-dialog"`）：

```ts
async chooseWorkspace(): Promise<WorkspaceRoot | null> {
  try {
    // The native panel must come from the JS dialog plugin (presented on
    // the main thread); a blocking_pick_folder in a sync Rust command
    // freezes the app on macOS.
    const selected = await open({ directory: true, multiple: false });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return null;
    const dto = await invoke<WorkspaceRootDto>("open_workspace", { root: path });
    return workspaceRoot(dto);
  } catch (error) { throw failure(error); }
},
```

- [ ] **Step 4: 删除 Rust `choose_workspace` 命令**

- 从 `src-tauri/src/document_commands.rs` 删除 `choose_workspace` 函数；
- 从 `src-tauri/src/lib.rs` 的 `tauri::generate_handler![...]` 删除 `document_commands::choose_workspace,`；
- 在 `src-tauri/tests/document_commands.rs` 中 grep `choose_workspace` 并删除/改写相关用例（保留 `open_workspace` 校验用例）；
- 若 lib.rs 中 `tauri_plugin_dialog` 相关 import 因此未使用，一并清理（`tauri_plugin_dialog` 的 `init()` 注册保留——JS 侧插件仍需要它）。

- [ ] **Step 5: 跑全部门禁并提交**

```bash
npm test && npm run build && cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
git add src/document src-tauri
git commit -m "fix: pick workspace folders through the main-thread dialog plugin"
```

- [ ] **Step 6: 手动验证（记入报告）**

`npm run tauri dev`，点击「打开文件夹」，系统选择框可正常选择/取消且不卡死。同时在 `docs/testing.md` 的「打开文件夹」手动项补一句「原生选择框正常弹出，不冻结」。

---

### Task 2: 垂直标签侧栏

**Files:**
- Create: `src/app/TabList.tsx`
- Create: `src/app/TabList.test.tsx`
- Modify: `src/app/AppShell.tsx`
- Modify: `src/app/AppShell.test.tsx`
- Modify: `src/app/accessibility.test.tsx`
- Modify: `src/theme/app.css`

- [ ] **Step 1: 写 TabList 组件测试（红）**

`src/app/TabList.test.tsx` 覆盖：渲染每个标签的标题与状态点；点击激活回调；关闭按钮回调（pendingSave 时禁用）；`role="tablist"` + `aria-orientation="vertical"`；ArrowUp/ArrowDown/Home/End 循环移动焦点并激活（垂直 tablist 的 W3C 方向键是 Up/Down，不是 Left/Right）；`aria-selected` 与 roving tabindex。

- [ ] **Step 2: 实现 `src/app/TabList.tsx`**

纯展示组件，props：

```ts
export interface TabListProps {
  tabs: ReadonlyArray<DocumentSnapshot>;
  activeId: string | null;
  onActivate(id: string): void;
  onClose(id: string): void;
}
```

结构沿用现有水平标签的 ARIA：`role="tablist"` `aria-orientation="vertical"` `aria-label="打开的文档"`，每个 `role="tab"`（id 保持 `document-tab-${tab.id}`，`aria-controls="document-panel-${tab.id}"`，roving tabindex），状态点复用 `tab-dirty` 语义（dirty/conflict/missing 的视觉差异留给 Task 4 的样式），关闭按钮 `aria-label={`关闭 ${tab.title}`}`。方向键处理从 AppShell 现有 `onTabKeyDown` 迁移并改为 Up/Down。

- [ ] **Step 3: 改造 AppShell**

- 删除 `.tab-strip` 块（现 `src/app/AppShell.tsx:303-338`）。
- 侧栏可见性：`tabs.length > 0 || workspace` 时可用；`sidebarCollapsed` 默认 false；空状态（无标签无 workspace）不渲染侧栏。`展开侧栏` 按钮条件从 `controller.workspace && sidebarCollapsed` 改为 `(tabs.length > 0 || controller.workspace) && sidebarCollapsed`。
- 侧栏结构（两区，各自可折叠；`workspace` 不存在时不渲染文件树区）：

```tsx
<aside aria-label="侧栏" className="sidebar">
  <div className="sidebar-actions">
    <button type="button" onClick={() => setSidebarCollapsed(true)}>收起侧栏</button>
  </div>
  {controller.state.tabs.length > 0 && (
    <section aria-label="打开的标签" className="sidebar-section">
      <button type="button" className="sidebar-section-header"
        aria-expanded={!tabsSectionCollapsed}
        onClick={() => setTabsSectionCollapsed((c) => !c)}>
        打开的标签
      </button>
      {!tabsSectionCollapsed && (
        <TabList tabs={controller.state.tabs} activeId={controller.state.activeId}
          onActivate={controller.activate} onClose={closeTab} />
      )}
    </section>
  )}
  {controller.workspace && (
    <section aria-label="文件夹" className="sidebar-section">
      {/* 同 pattern 的可折叠头 + 现有 FileSidebar */}
    </section>
  )}
</aside>
```

- `tabpanel` 的 `aria-labelledby` 仍指向 `document-tab-${id}`（TabList 保持相同 id，DOM 顺序变化不影响）。
- 现有行为不变：关闭确认流程、⌘⇧T、pendingTabFocusRef 焦点恢复（id 未变）。
- 折叠偏好持久化：`sidebarCollapsed` 与两个分区折叠状态纳入 `PersistedSession`（`src/document/types.ts`，仿照 theme/editorPreferences 的可选字段 pattern），经 controller 的 session 保存机制写入；加载时缺省为展开。

- [ ] **Step 4: 迁移/更新 AppShell 与 a11y 测试**

AppShell.test.tsx 中 tab strip 相关断言改到侧栏 TabList；Left/Right 方向键用例改 Up/Down；新增：只有标签没有 workspace 时侧栏显示且无文件树区；空状态无侧栏；两区独立折叠；整栏折叠/展开。accessibility.test.tsx 的角色断言同步更新。

- [ ] **Step 5: 基础样式 + 门禁 + 提交**

`src/theme/app.css`：删 `.tab-strip` 样式，新增 `.sidebar-section`/`.sidebar-section-header`/垂直 `.tab` 行布局（功能向即可，Task 4 统一美化）。

```bash
npm test && npm run build
git add src/app src/theme/app.css
git commit -m "feat: replace tab strip with collapsible vertical tab sidebar"
```

---

### Task 3: 阅读模式（三态视图）

**Files:**
- Create: `src/editor/viewMode.ts`
- Modify: `src/editor/livePreview.ts`
- Modify: `src/editor/livePreview.test.ts`
- Modify: `src/editor/MarkdownEditor.tsx`
- Modify: `src/editor/MarkdownEditor.test.tsx`
- Modify: `src/editor/editorExtensions.ts`
- Modify: `src/app/useAppController.ts`
- Modify: `src/app/useAppController.test.tsx`
- Modify: `src/app/AppShell.tsx`
- Modify: `src/app/AppShell.test.tsx`
- Modify: `tests/e2e/notepad.spec.ts`
- Modify: `src/theme/app.css`

- [ ] **Step 1: 定义类型 + livePreview 选区感知开关（红）**

`src/editor/viewMode.ts`：

```ts
export type EditorViewMode = "reading" | "editing" | "source";
```

`src/editor/livePreview.test.ts` 新增：`planLivePreview(state, undefined, undefined, { revealSelection: false })` 时，光标在 `**world**` 内也照样隐藏标记（对比现有 reveal 用例）。

- [ ] **Step 2: 实现 livePreview 开关**

`planLivePreview` 增加第 4 参 `options?: { readonly revealSelection?: boolean }`（默认 true），`directlySelected` 计算改为：

```ts
const directlySelected = (options?.revealSelection ?? true)
  ? structures.filter(({ node }) => selectionIntersects(state, node))
  : [];
```

`livePreviewExtension` 改为 `livePreviewExtension(options?: { revealSelection?: boolean })`，经插件闭包透传到 `decorationSetsFor` → `planLivePreview`（沿现有参数链下钻，不改动其他行为）。

- [ ] **Step 3: MarkdownEditor 三态（先写测试）**

MarkdownEditor.test.tsx 新增：`viewMode="reading"` 时 contenteditable 为 false、键入字符不改变文档、`**` 标记不可见（无选区 reveal）、math/image widget 渲染；三态间切换撤销历史保留；`sourceMode` prop 用例改为 `viewMode` 等价语义。

实现：prop `sourceMode: boolean` 改为 `viewMode: EditorViewMode`（所有调用点/测试机械更新）。`previewCompartment` 重配置逻辑改为：

```ts
const previewExtensionsFor = (mode: EditorViewMode, perf: PerformanceMode) => {
  if (mode === "source") return [];
  const readOnly = mode === "reading"
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [];
  return [
    ...readOnly,
    livePreviewExtension({ revealSelection: mode !== "reading" }),
    ...(perf === "light"
      ? []
      : [
          mathWidgetsExtension(),
          imageWidgetsExtension({
            getDocumentPath: () => documentPathRef.current,
            resolveLocalUrl: (path) => imageSupportRef.current.resolveImageUrl(path),
          }),
        ]),
  ];
};
```

宿主 div 的 `data-source-mode` 改为 `data-view-mode={viewMode}`（E2E 与 CSS 同步）。阅读模式隐藏光标：`.markdown-editor[data-view-mode="reading"] .cm-cursor { display: none; }`（app.css）。E2E 选择器中用到 `data-source-mode` 的改为 `data-view-mode`。

- [ ] **Step 4: 键位 + controller 每标签记忆**

`editorExtensions.ts` 的 `EditorCommands` 增加 `onToggleReading(): void`、`onToggleSource(): void`；keymap 头部增加：

```ts
{ key: "Mod-e", preventDefault: true, run: () => { commands.onToggleReading(); return true; } },
{ key: "Mod-Shift-e", preventDefault: true, run: () => { commands.onToggleSource(); return true; } },
```

`useAppController`：`viewModes: Map<string, EditorViewMode>`（ref/state），默认 `"editing"`，标签关闭时清理；暴露 `viewModeOf(id)`、`setViewMode(id, mode)`、`toggleReading(id)`（reading↔editing）、`toggleSource(id)`（source↔上一个非 source 模式）。controller 测试：每标签独立记忆、关闭清理、两个 toggle 语义。

- [ ] **Step 5: AppShell 三态分段控件**

替换标题栏的「实时预览/源码模式」单按钮为分段控件：

```tsx
<div role="group" aria-label="视图模式" className="view-mode-switch">
  {(["reading", "editing", "source"] as const).map((mode) => (
    <button key={mode} type="button" aria-pressed={viewMode === mode}
      onClick={() => controller.setViewMode(active.id, mode)}>
      {{ reading: "阅读", editing: "编辑", source: "源码" }[mode]}
    </button>
  ))}
</div>
```

`onShellKeyDown` 增加编辑器外焦点时的 ⌘E/⌘⇧E（与现有 ⌘⇧T shell 绑定同 pattern）。MarkdownEditor 调用点传 `viewMode={viewMode}`。AppShell 测试更新（分段控件切换、⌘E/⌘⇧E、按标签记忆）。

- [ ] **Step 6: E2E 增补 + 全门禁 + 提交**

`tests/e2e/notepad.spec.ts` 新增：编辑→阅读（标记消失、只读拒绝输入、公式渲染）、阅读→源码（纯文本可编辑）、切回编辑（撤销历史保留）。

```bash
npm test && npm run build && npm run test:e2e
git add src tests/e2e
git commit -m "feat: add reading mode with three-state view switch"
```

---

### Task 4: 视觉全面焕新（参考 Obsidian）

**Files:**
- Modify: `src/theme/tokens.css`
- Modify: `src/theme/app.css`
- Modify: `src/theme/app.css` 相关组件 class（少量结构，如需要）
- Modify: `docs/screenshots/dark.png`、`docs/screenshots/light.png`（重新截取）
- Modify: `src/app/accessibility.test.tsx`（如 class 变更）
- Modify: `docs/testing.md`

**实施时必须先用 Skill 工具加载 `ui-ux-pro-max` 技能**，参考其配色/字体/间距规范与 Obsidian 的界面质感。

- [ ] **Step 1: 重做 `tokens.css`**

目标质感（Obsidian 暗色为参照，给出起始值，实施时可微调但明暗 parity 与「app.css 无裸色值」不变量必须保持）：
- 暗色：canvas `#1e1f24` 系、elevated `#26272e` 系、hover `#2e3038` 系、divider 低对比 `rgba(255,255,255,0.06)` 系、text-primary `#e6e6ea`、text-secondary `#a8aab3`、text-muted `#6f7079`、accent `#7f6df2` 系（Obsidian 紫）、danger `#e5534b` 系。
- 亮色：canvas `#ffffff`、elevated `#f5f5f7`、hover `#ececf0`、divider `rgba(0,0,0,0.08)`、accent `#6c56d9`。
- radius 三档（4/8/12）、shadow 两档（popover/dialog）、focus-ring 用 accent 40% 透明度。
- syntax 色板随 accent 协调（keyword/string/comment/number/type/meta 明暗各一套）。

- [ ] **Step 2: 重做 `app.css` 组件质感**

逐项：标题栏（更紧凑、按钮幽灵化、悬停 surface）、垂直标签行（圆角行、悬停/激活 surface、状态点着色：dirty=accent、conflict=danger、missing=muted）、侧栏分区头（小字号 muted、悬停态）、文件树行（行高、缩进线、悬停）、三态分段控件（胶囊形容器 + 激活段 accent 底）、对话框与遮罩（圆角 12、shadow、遮罩透明度）、设置表单控件、perf 横幅、空状态与最近列表、滚动条（细、hover 显形）、焦点可见态。布局结构与 class 名尽量不变。

- [ ] **Step 3: 跑测试并重截截图**

```bash
npm test && npm run build
npm run dev  # 另开终端
node scripts/capture-screenshots.mjs
```

人工查看 `docs/screenshots/dark.png`/`light.png` 确认质感；a11y 与样式不变量测试全绿。

- [ ] **Step 4: 更新文档 + E2E 回归 + 提交**

`docs/testing.md` 视觉走查项更新（垂直标签、三态控件、明暗两主题）。`npm run test:e2e` 回归。

```bash
git add src/theme src/app docs/screenshots docs/testing.md
git commit -m "feat: refresh visual system with Obsidian-inspired styling"
```

> 实施记录（2026-07-26）：文件树缩进线放弃——文件树是扁平 `<ul>` + 行内 `paddingLeft`，纯 CSS 无法按深度绘制贯穿参考线，需嵌套结构或占位元素，违反「布局结构尽量不变」约束；行高/缩进/悬停已覆盖。后续树组件重写时再补。

---

## 最终验证

```bash
npm test && npm run build && npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
npm run tauri dev  # 手动：打开文件夹不卡死；垂直标签/三态/视觉走查
```

## Spec coverage

| 设计 spec 章节 | 实施任务 |
|---|---|
| A. 打开文件夹卡死 | Task 1 |
| B. 垂直标签侧栏 | Task 2 |
| C. 阅读模式三态 | Task 3 |
| D. 视觉焕新 | Task 4 |
| 错误处理/测试策略 | 各任务 Steps + 最终验证 |
