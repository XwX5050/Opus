# 垂直标签栏、阅读模式与视觉焕新设计

> 来源：2026-07-26 用户试用反馈的四项改进。实施计划由 writing-plans 技能另行产出。

## 背景与问题

当前应用（master，13 个任务已完成）使用水平标签条 + 可选文件夹抽屉。用户反馈：

1. 标签栏应改为可折叠/展开的**垂直侧面标签栏**。
2. 缺少**阅读模式**（只读完整渲染视图）。
3. 点击「打开文件夹」在系统选择框出现后即卡死，只能强制退出。
4. 整体 UI 观感差，要求参考 Obsidian 做视觉焕新。

## 卡死根因（已确认）

`src-tauri/src/document_commands.rs` 的 `choose_workspace` 命令使用
`app.dialog().file().blocking_pick_folder()`。Tauri 2 的同步命令运行在 async runtime
线程池上，macOS AppKit 的模态 NSOpenPanel 在非主线程呈现会冻结整个应用。
打开文件不受影响，因为它走前端 `@tauri-apps/plugin-dialog` 的异步 API
（插件内部在主线程呈现面板）。

## 设计决策（已与用户确认）

- 垂直标签栏与文件树**同栏分区**：上部「打开的标签」，下部文件树。
- 阅读模式 = **完整渲染只读视图**（类 Obsidian 阅读视图）。
- 阅读模式实现 = **只读编辑器复用**（不引入第二渲染器、不写 Lezer→DOM 渲染器）。
- UI 改版 = **视觉全面焕新**，布局结构保持，参考 Obsidian。

## 编辑器三态语义

| 模式 | 可编辑 | 渲染 |
|---|---|---|
| 阅读 | 否 | 全部渲染（标记永不显示，公式/图片渲染） |
| 编辑（默认） | 是 | 实时渲染（光标/选区进入处临时显示标记） |
| 源码 | 是 | 不渲染（纯文本） |

## A. 修复「打开文件夹」卡死

- `tauriDocumentPort.chooseWorkspace` 改用 `@tauri-apps/plugin-dialog` 的
  `open({ directory: true })`，取消返回 `null`；随后调用 Rust
  `open_workspace(path)` 做校验并返回 `WorkspaceRootInfo`。
- 删除 Rust `choose_workspace` 命令及其 `blocking_pick_folder` 调用。
- 测试：adapter 契约测试（mock dialog：选择/取消/校验失败）。原生对话框路径记入
  `docs/testing.md` 手动清单。

## B. 垂直标签侧栏

- 移除 `AppShell` 的水平标签条。侧栏两区：
  - **打开的标签**：每行显示文件名、dirty/conflict/missing 状态点、关闭按钮；
    点击激活；行顺序与 `state.tabs` 一致。
  - **文件树**：现有 `FileSidebar`，仅在存在 workspace 时显示。
- 两区各自可折叠；整个侧栏也可折叠（折叠后完全隐藏，标题栏保留展开按钮）。
- 可见性规则：存在打开的标签或 workspace 时侧栏可用并默认展开；空状态
  （无标签无 workspace）不显示侧栏。折叠偏好存会话。
- 快捷键不变：⌘⇧T 重开、既有标签切换快捷键；关闭标签的确认流程
  （保存/放弃/取消）不变。
- 新组件 `src/app/TabList.tsx`（纯展示 + 回调），`AppShell` 组装；
  reducer/controller 文档逻辑不改。

## C. 阅读模式

- `MarkdownEditor` 增加只读 `Compartment`（`EditorState.readOnly.of(true)` +
  `EditorView.editable.of(false)`）。阅读模式下 decoration 规划忽略选区
  （`planLivePreview` 增加参数或 reading 变体），标记永不替换显示；
  数学/图片 widget 照常渲染。撤销历史在模式切换间保留（同一 EditorView，
  仅 reconfigure）。
- 每标签模式状态存 controller 层（按标签 id 的 Map），默认「编辑」；
  标签关闭时清理。
- UI：标题栏右侧三态分段控件（阅读/编辑/源码）。快捷键：⌘E 在阅读↔编辑间
  切换；⌘⇧E 在源码与上一个非源码模式间切换。
- 交互约束：阅读模式下只读自然阻止编辑与图片粘贴；搜索面板可用；
  dirty/conflict/missing 状态与保存/冲突流程不受影响。
- 与 light 性能模式正交：light 模式禁用 widget 的规则在阅读模式同样生效。
- 测试：三态切换、只读拒绝输入（事务被过滤）、阅读模式标记全隐藏、
  widget 渲染、切换保留撤销历史、与 sourceMode/light 模式的组合。

## D. 视觉全面焕新（参考 Obsidian）

- 实现时加载 ui-ux-pro-max 技能获取设计指导。
- 重做 `src/theme/tokens.css`：色阶（canvas/elevated/hover 层级更细腻）、
  低对比边框、圆角与阴影体系、字体栈（UI 用系统/Inter 类，编辑器正文字体
  保持用户偏好机制）、焦点环。
- 重做 `src/theme/app.css` 组件质感：侧栏分区头、标签列表行（悬停/激活态）、
  文件树行、对话框与背景遮罩、按钮/输入框/分段控件、横幅、滚动条。
- 编辑器 syntax 配色（`--syntax-*`）随 token 体系同步调优，明暗两主题 parity
  保持不变量（app.css 无裸色值的现有测试继续通过）。
- DOM 结构与 class 名大体稳定；B/C 两部分的新组件直接采用新视觉。
- 产出：更新 `docs/screenshots/` 明暗截图；现有 a11y 测试按需更新。

## 实施顺序与验证

A → B → C → D 四个任务顺序执行，每任务独立可验证、独立提交。
全局门禁：`npm test`、`npm run build`、`npm run test:e2e`、
`cargo test`、`cargo clippy -- -D warnings`、`cargo fmt --check`。

## 错误处理

- 文件夹选择取消 → `null`，无状态变化；`open_workspace` 校验失败 →
  非阻塞错误提示（沿用现有 `setError` 机制）。
- 阅读模式下外部变更/冲突流程不变；恢复草稿打开的标签默认进入编辑模式。
- 视觉焕新不改变任何行为语义；a11y 角色/名称断言必须继续通过。

## 测试策略

- 单元/组件测试沿用 Vitest + MemoryDocumentPort；新组件（TabList、分段控件）
  配组件测试；阅读模式配 MarkdownEditor 级测试。
- E2E 增补：垂直标签的打开/切换/关闭流程、三态切换流程。
- 手动验收（`docs/testing.md` 增补）：原生文件夹选择框不再卡死、
  阅读模式中文 IME 区域无输入、视觉走查明暗两主题。
