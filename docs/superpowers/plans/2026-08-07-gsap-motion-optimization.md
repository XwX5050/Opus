# GSAP 动效优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Opus 增加鲜明但可中断的 GSAP 动效，覆盖应用外壳、文档切换与当前编辑内容，同时保持输入性能、可访问性和 reduced-motion 行为。

**Architecture:** 新增 `src/motion/` 作为 GSAP 参数和生命周期边界；React 壳层通过 `useGSAP` 控制面板、标签、弹窗和状态提示，CodeMirror 由 `MarkdownEditor` 在自身挂载/更新生命周期中调用受限的 DOM 动效适配器。CSS 继续负责布局、颜色和简单悬停，业务状态不由动画回调驱动。

**Tech Stack:** React 19, TypeScript strict, GSAP 3, `@gsap/react`, CodeMirror 6, Vitest/jsdom, Playwright, npm lockfile。

---

## 文件地图

- Create: `src/motion/motionConfig.ts` — 时长、缓动、错峰间隔和目标上限。
- Create: `src/motion/motionRuntime.ts` — GSAP 注册、reduced-motion 查询、作用域动画辅助函数。
- Create: `src/motion/editorMotion.ts` — CodeMirror 宿主和当前可见节点的有限入场动画。
- Create: `src/motion/motionRuntime.test.ts` — 参数、目标上限、reduced-motion 和清理契约测试。
- Modify: `package.json`, `package-lock.json` — 添加 `gsap` 与 `@gsap/react`。
- Modify: `src/app/AppShell.tsx` — 应用壳、侧栏、标签/文档切换、弹窗和提示条挂载 motion hooks。
- Modify: `src/app/TabList.tsx` — 为新增/切换标签提供稳定的动效数据属性。
- Modify: `src/workspace/FileSidebar.tsx`, `src/editor/OutlinePanel.tsx` — 为文件树和大纲项提供错峰目标属性。
- Modify: `src/editor/MarkdownEditor.tsx` — 在 EditorView 创建、文档切换和 widget DOM 更新后调用 editor motion adapter。
- Modify: `src/theme/app.css`, `src/theme/tokens.css` — 只保留与 GSAP 不冲突的 CSS 微交互和公共变量，维持 reduced-motion 覆盖。
- Modify: `src/app/accessibility.test.tsx` — 更新/补充 CSS 动效和 reduced-motion 断言。
- Create: `src/app/motion.integration.test.tsx` — 验证壳层状态变化带有正确 motion hook/data contract，且不改变 ARIA 行为。

### Task 1: 安装 GSAP 并建立参数契约

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/motion/motionConfig.ts`
- Create: `src/motion/motionRuntime.ts`
- Create: `src/motion/motionRuntime.test.ts`

- [ ] **Step 1: 写参数失败测试**

在 `src/motion/motionRuntime.test.ts` 中先写以下断言，锁定公共契约：

```ts
import { describe, expect, it } from "vitest";
import { MAX_EDITOR_MOTION_TARGETS, MOTION } from "./motionConfig";
import { clampMotionTargets, prefersReducedMotion } from "./motionRuntime";

describe("motion runtime", () => {
  it("exports bounded motion constants", () => {
    expect(MOTION.panel.duration).toBe(0.42);
    expect(MOTION.list.stagger).toBeGreaterThan(0);
    expect(MAX_EDITOR_MOTION_TARGETS).toBe(16);
  });

  it("caps editor targets without mutating the source array", () => {
    const source = Array.from({ length: 20 }, (_, index) => index);
    expect(clampMotionTargets(source)).toEqual(source.slice(0, 16));
    expect(source).toHaveLength(20);
  });

  it("reads prefers-reduced-motion from matchMedia", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true, media: "(prefers-reduced-motion: reduce)" }),
    });
    expect(prefersReducedMotion()).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行 `npm test -- src/motion/motionRuntime.test.ts`。预期失败为找不到 `./motionConfig` 或 `./motionRuntime`。

- [ ] **Step 3: 安装依赖并实现参数与 runtime**

运行 `npm install gsap @gsap/react`，让 npm 同步 `package-lock.json`。创建 `motionConfig.ts`，导出以下参数对象和 `MAX_EDITOR_MOTION_TARGETS = 16`：

```ts
export const MOTION = {
  easing: "power3.out",
  panel: { duration: 0.42 },
  dialog: { duration: 0.36 },
  switch: { exit: 0.12, enter: 0.36 },
  list: { stagger: 0.04 },
  content: { duration: 0.28, stagger: 0.035, overlap: 0.18 },
} as const;
```

在 `motionRuntime.ts` 中注册 `useGSAP`，导出：

```ts
export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const clampMotionTargets = <T>(targets: readonly T[]): T[] =>
  targets.slice(0, MAX_EDITOR_MOTION_TARGETS);
```

同时导出 `animatePanelIntro`, `animateDialogIntro` 和 `animateListIntro`；这些函数接收真实 Element/NodeList，reduced-motion 时使用 `gsap.set`，正常模式只写 `autoAlpha`, `x`, `y`, `scale`，并使用 `overwrite: "auto"`。所有函数返回 `gsap.core.Tween | gsap.core.Timeline`，不保存全局 DOM 引用。

- [ ] **Step 4: 运行测试确认通过**

运行 `npm test -- src/motion/motionRuntime.test.ts`。预期全部通过；再运行 `npm run build`，确认 GSAP 类型与 Vite 构建可用。

- [ ] **Step 5: 提交基础层**

```sh
git add package.json package-lock.json src/motion/motionConfig.ts src/motion/motionRuntime.ts src/motion/motionRuntime.test.ts
git commit -m "feat: add GSAP motion runtime"
```

### Task 2: 添加编辑内容 motion adapter

**Files:**
- Create: `src/motion/editorMotion.ts`
- Modify: `src/editor/MarkdownEditor.tsx`
- Modify: `src/motion/motionRuntime.test.ts`

- [ ] **Step 1: 写 editor target 筛选失败测试**

向 `motionRuntime.test.ts` 添加纯函数断言：从 `.cm-line`, `.md-image-widget`, `.md-table`, `.katex` 节点中按 DOM 顺序选取最多 16 个目标；`performanceMode === "light"` 时只保留编辑器宿主，不返回内容目标。

- [ ] **Step 2: 运行测试确认失败**

运行 `npm test -- src/motion/motionRuntime.test.ts`，预期失败为 editor target helper 尚未导出。

- [ ] **Step 3: 实现 adapter**

在 `editorMotion.ts` 导出：

```ts
export const EDITOR_MOTION_SELECTOR =
  ".cm-line, .md-image-widget, .md-table, .katex";

export const collectEditorMotionTargets = (
  host: HTMLElement,
  performanceMode: PerformanceMode,
): HTMLElement[] => {
  if (performanceMode === "light") return [];
  return clampMotionTargets(
    [...host.querySelectorAll<HTMLElement>(EDITOR_MOTION_SELECTOR)],
  );
};

export const playEditorIntro = (
  host: HTMLElement,
  performanceMode: PerformanceMode,
): gsap.core.Timeline => {
  const timeline = gsap.timeline({ defaults: { overwrite: "auto" } });
  if (prefersReducedMotion()) {
    timeline.set(host, { autoAlpha: 1, clearProps: "transform" });
    return timeline;
  }
  const targets = collectEditorMotionTargets(host, performanceMode);
  timeline.fromTo(
    host,
    { autoAlpha: 0, y: 10, scale: 0.985 },
    { autoAlpha: 1, y: 0, scale: 1, duration: MOTION.panel.duration, ease: MOTION.easing },
  );
  if (targets.length > 0) {
    timeline.fromTo(
      targets,
      { autoAlpha: 0, y: 12 },
      { autoAlpha: 1, y: 0, duration: MOTION.content.duration, ease: MOTION.easing, stagger: MOTION.content.stagger },
      `-=${MOTION.content.overlap}`,
    );
  }
  return timeline;
};
```

`playEditorIntro` 在 `viewMode === "editing"` 时返回空 timeline，绝不改写 CodeMirror 宿主或 `.cm-line`；在阅读模式对收集目标做有限 stagger，且只使用 transform，避免阻塞焦点与输入。缺少目标时仍返回可安全 kill 的 timeline。仅在阅读模式安装 `MutationObserver` 监听 `.md-image-widget`, `.md-table`, `.katex` 新增节点，WeakSet 防止同一节点重复播放；observer 在清理函数中 disconnect。

在 `MarkdownEditor` 的 EditorView 创建完成后用 `requestAnimationFrame` 调用 adapter；普通编辑模式受控值同步和 `docChanged` 不调用内容 adapter。组件 cleanup 必须 kill timeline、disconnect observer，再 destroy EditorView。

- [ ] **Step 4: 运行相关测试**

运行 `npm test -- src/motion/motionRuntime.test.ts src/editor/MarkdownEditor.test.tsx`，预期编辑器原有用例与新增目标筛选用例均通过。

- [ ] **Step 5: 提交编辑器 motion**

```sh
git add src/motion/editorMotion.ts src/motion/motionRuntime.test.ts src/editor/MarkdownEditor.tsx
git commit -m "feat: animate editor content entrances"
```

### Task 3: 为壳层和列表接入 GSAP

**Files:**
- Modify: `src/app/AppShell.tsx`
- Modify: `src/app/TabList.tsx`
- Modify: `src/workspace/FileSidebar.tsx`
- Modify: `src/editor/OutlinePanel.tsx`
- Create: `src/app/motion.integration.test.tsx`

- [ ] **Step 1: 写壳层数据契约测试**

在 `motion.integration.test.tsx` 渲染现有 AppShell fixture，断言：`.app-shell`、`.sidebar-rail`、`.outline-rail`、`.tab-list` 和 tree rows 存在稳定的 `data-motion-*` 属性；折叠侧栏仍保持 `aria-hidden`/`inert` 语义；标签键盘导航行为不改变。

- [ ] **Step 2: 运行测试确认失败**

运行 `npm test -- src/app/motion.integration.test.tsx`，预期失败为缺少新增 motion data contract。

- [ ] **Step 3: 接入 scoped `useGSAP`**

在 `AppShell` 添加 `motionShellRef`，以 `useGSAP` scope 绑定壳层入口；依赖 `active?.id`, `sidebar.collapsed`, `outlineOpen`, `settingsOpen`, `closing`, `saveErrorOpen`, `recoveryOpen`, `conflictTab`，每次依赖变化使用 `revertOnUpdate: true`，不在动画中提交 controller 状态。

为列表项添加 `data-motion-item`，并在 TabList/FileSidebar/OutlinePanel 的外层使用 `data-motion-list`。标签 ID 变化时只动画新增或当前项，文件树和大纲只动画首次挂载/展开后的当前列表，不在每次文件状态更新时重播整棵树。

弹窗继续由 AppShell 控制挂载，`animateDialogIntro` 作用域限定到当前 `.dialog-overlay`；提示条使用 `animatePanelIntro`。侧栏关闭时保留现有 `data-collapsed`, `inert`, `aria-hidden` 的立即语义，展开后再播放内容入口。

- [ ] **Step 4: 保留并去重 CSS 微交互**

在 `src/theme/app.css` 中确认 GSAP 接管的节点不再同时由 CSS 控制相同的 `transform`/`opacity`；保留按钮按压、颜色、边框、focus ring 和 reduced-motion 规则。若需要调整 `panelIn` 等现有 keyframes，只删除重复入口，不删除用户已有的 token 或可访问性断言。

- [ ] **Step 5: 运行组件测试**

运行 `npm test -- src/app/motion.integration.test.tsx src/app/AppShell.test.tsx src/app/TabList.test.tsx`，预期通过且没有 `act` 或未清理 timer 警告。

- [ ] **Step 6: 提交壳层 motion**

```sh
git add src/app/AppShell.tsx src/app/TabList.tsx src/workspace/FileSidebar.tsx src/editor/OutlinePanel.tsx src/app/motion.integration.test.tsx src/theme/app.css
git commit -m "feat: orchestrate GSAP shell motion"
```

### Task 4: 完成动画可访问性与 reduced-motion 覆盖

**Files:**
- Modify: `src/motion/motionRuntime.ts`
- Modify: `src/motion/editorMotion.ts`
- Modify: `src/theme/app.css`, `src/theme/tokens.css`
- Modify: `src/app/accessibility.test.tsx`
- Modify: `src/motion/motionRuntime.test.ts`

- [ ] **Step 1: 写 reduced-motion 和 cleanup 失败测试**

断言 reduced-motion 时所有入口函数不设置非零 `x/y/scale`；正常模式 timeline 可被 `kill()`；editor observer 的 cleanup 会停止后续新增节点动画。

- [ ] **Step 2: 实现媒体查询与清理**

使用 `gsap.matchMedia()` 或 `useGSAP` context 管理 `(prefers-reduced-motion: reduce)`；禁止在模块顶层读取 `window`。每个 hook 返回的 cleanup 调用 `ctx.revert()`/`timeline.kill()`，observer 调用 `disconnect()`。

- [ ] **Step 3: 补充 CSS 静态断言**

保留现有动效 token、entry keyframes 和 `@media (prefers-reduced-motion: reduce)` 断言；追加断言确认不会把 `transition-duration` 或 `animation-duration` 从 0.01ms 覆盖回正常时长。

- [ ] **Step 4: 运行测试**

运行 `npm test -- src/motion/motionRuntime.test.ts src/app/accessibility.test.tsx`，预期全部通过。

- [ ] **Step 5: 提交可访问性修正**

```sh
git add src/motion/motionRuntime.ts src/motion/editorMotion.ts src/theme/app.css src/theme/tokens.css src/app/accessibility.test.tsx
git commit -m "fix: respect reduced motion in GSAP effects"
```

### Task 5: 集成验证与性能验收

**Files:**
- Modify: `docs/testing.md` — 增加 GSAP 动效手工验收条目（如当前文档已有对应章节则追加到现有 Motion/Accessibility 小节）。
- Modify: `tests/e2e/notepad.spec.ts` — 在现有标签、侧栏、弹窗和性能流程中加入稳定的 motion 状态断言，不等待固定动画时长。

- [ ] **Step 1: 运行完整前端测试**

运行 `npm test`，预期所有 Vitest 用例通过。

- [ ] **Step 2: 运行类型检查和生产构建**

运行 `npm run build`，预期 `tsc -b` 和 Vite 构建成功，无 GSAP 导入或浏览器 API 类型错误。

- [ ] **Step 3: 运行 Rust 回归测试**

运行 `cargo test --manifest-path src-tauri/Cargo.toml`，确认前端 motion 改动没有影响 Tauri 集成。

- [ ] **Step 4: 运行关键 E2E**

运行 `npm run test:e2e -- --grep "tab|sidebar|dialog|performance"`；断言使用 DOM 状态和 ARIA，不依赖 `setTimeout(动画时长)`。

- [ ] **Step 5: 做性能与 reduced-motion 手工检查**

启动 E2E shell，连续快速切换标签、展开/收起左右侧栏、打开/关闭弹窗、输入长文档并滚动；确认没有控制台错误、动画排队、光标抖动或滚动掉帧。用浏览器 DevTools 将 `prefers-reduced-motion` 设为 `reduce`，确认内容直接出现且没有明显位移/缩放。

- [ ] **Step 6: 检查工作树并提交验证记录**

运行 `git status --short` 与 `git diff --check`，确认原有用户改动仍可区分；按实际运行结果更新 `docs/testing.md`，然后提交：

```sh
git add docs/testing.md tests/e2e
git commit -m "test: verify GSAP motion integration"
```

## Self-review

- Spec coverage: 参数和 runtime 对应设计中的统一动效层；Task 2 对应 CodeMirror 当前视口与 widget 入口；Task 3 对应壳层、标签、树、侧栏、弹窗和状态提示；Task 4 对应 reduced-motion、清理和 CSS 去重；Task 5 对应自动化与手工验收。
- Placeholder scan: 计划没有未定义的占位步骤；每个代码变更步骤列出实际文件、命令和预期结果。
- Type consistency: `PerformanceMode` 使用现有 `src/editor/performanceMode.ts` 类型；`playEditorIntro` 返回 GSAP timeline；所有 runtime helper 都以 `HTMLElement`/数组为输入，不依赖业务控制器。
