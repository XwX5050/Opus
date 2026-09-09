# Opus 0.1.15 未修复 Bug / 安全审计报告

审计日期：2026-09-09  
审计基线：`16dd51fc368cf09e653ef9e216c86a9d785cb34f`  
范围：React/TypeScript 前端、Rust/Tauri 后端、跨平台路径/监视/恢复逻辑、依赖漏洞、浏览器壳 E2E。  
原则：本次只扫描和留存证据，没有修改产品代码。

## 结论

当前没有发现 P0 级“启动即崩溃”或已确认的远程代码执行问题；但有 9 个 P1 数据完整性/核心交互问题，4 个 P2 行为或跨平台问题，以及两组依赖安全债务。另有 2 个需要产品决定的安全设计风险。用户报告的表格复制问题是 P1，已在真实 Chromium 交互中复现。

优先修复顺序建议为：

1. F01 表格单元格剪贴板；
2. F02–F04 恢复草稿删除/丢失窗口；
3. F05 翻译批次错位；
4. F06 翻译出错后编辑锁死；
5. F08、F10、F11 外部文件监视和路径竞态；
6. F07、F09、F12、F13 以及依赖升级。

## 发现清单

严重度含义：P1 会造成用户数据误写、丢失或核心编辑操作失效；P2 是明显的功能错误、跨平台错误或安全边界问题，但通常需要特定流程；P3 是维护或隐私风险。

### F01 — 表格单元格的复制、剪切、粘贴作用于错误的 CodeMirror 选择（P1，运行时已复现）

**现象**

- 在表格单元格中选中 `Ada` 后按 `⌘C`，剪贴板得到 `Before untouched`。
- 右键打开菜单会清掉单元格 DOM 选区；点击“复制”仍得到 `Before untouched`。
- 右键“粘贴”不会把剪贴板文本写入单元格。
- 选中单元格后按 `⌘X`，剪贴操作删除了文档开头的 `Before untouched`，而不是单元格内容。
- 普通 CodeMirror 全文 `⌘A` / `⌘C` 控制流程正常。

**证据**

- 浏览器结果：[browser-probes.json](evidence/browser-probes.json)
- 可重复脚本：[browser-probes.mjs](repro/browser-probes.mjs)
- 运行时 DOM 单元格是独立的 `contenteditable`：`src/editor/tableWidgets.ts:863-885, 938-1006`。
- 菜单命令先强制聚焦 CodeMirror 再调用 `document.execCommand`：`src/app/AppShell.tsx:1116-1121`。
- 菜单打开时把焦点移到菜单项，只恢复焦点，不恢复 DOM `Range`：`src/app/ContextMenu.tsx:90-98`。
- 表格委托监听没有 `copy` / `cut`，因此事件会落入 CodeMirror 的编辑器级剪贴板处理：`src/editor/tableWidgets.ts:863-885`。

**根因**

表格显示内容位于 CodeMirror widget 内部的原生 `contenteditable` 单元格；CodeMirror 的剪贴板处理读取的是编辑器状态选择，而不是单元格 DOM `Range`。菜单再额外调用 `focus()`，会把单元格选区丢掉。`execCommand('paste')` 也不能可靠地从浏览器/WKWebView读取剪贴板文本，当前调用结果未被处理。

**修复验收**

单元格部分选区、全选、键盘快捷键和菜单命令都必须读写该单元格的 DOM 选区；剪切只能改变该单元格并提交回 Markdown；粘贴必须支持纯文本和 IME 后的普通文本；菜单打开/关闭不能丢失选区；全文复制和阅读模式复制必须继续通过。

### F02 — 恢复无路径草稿时可能“写入后立即删除同一份草稿”（P1，源码和探针确认）

`restoreDraft` 为恢复出来的 tab 写入 `draftIdForTab(added.id)`，随后无条件删除原 `info.draftId`：`src/app/useAppController.ts:1362-1404`。tab ID 从 `document-1` 开始，而草稿 ID 也是 `draft-document-1`：`src/app/useAppController.ts:144-147`、`src/recovery/drafts.ts:8,24-32`。当两者相同时，刚写入的恢复副本就是随后被删除的原文件，恢复后的 tab 在下一个 2 秒 debounce 前没有磁盘保护；进程此时崩溃会丢失恢复内容。

可重复的 opt-in 探针是 `repro/behavior.audit.ts` 中的 F04（故意以期望行为断言，当前版本失败）。

### F03 — 恢复草稿合并到已打开 tab 时，旧草稿会在新副本落盘前被删除（P1，源码确认）

`documentRestored` 发现同路径 tab 时直接合并草稿并返回，`added` 为 false：`src/document/documentReducer.ts:470-505`。`restoreDraft` 只在 `added` 为 true 时立即写入副本，合并分支不会立即写入，之后却把原草稿丢弃：`src/app/useAppController.ts:1375-1404`。恢复后的脏内容要等普通 debounce 才写回；应用在这个窗口内崩溃会丢失唯一的恢复副本。

修复应先保证目标 tab 的新草稿成功落盘，再删除原草稿；合并分支也要走同一事务顺序。

### F04 — 空文本恢复草稿被标记为 clean，可能被静默丢弃（P1，源码确认）

恢复新 tab 时用 `draft.text === "" ? "clean" : "dirty"` 决定状态：`src/document/documentReducer.ts:511-523`。一个用户把文件内容全部删除后产生的空文本草稿，会被视为“没有未保存修改”，不会触发恢复保护、关闭确认或后续草稿写入。草稿同时保存了 `savedTextHash`，但该字段在这里没有参与判断：`src/recovery/drafts.ts:20-32`。

验收：空文本但 `savedTextHash` 对应非空已保存版本时必须保持 dirty；真正全新且从未有内容的空白文档才可以 clean。

### F05 — 翻译跳过目标语言段落时，后续段落结果会错位（P1，纯函数探针确认）

批次构造阶段跳过目标语言 unit，但把其前后 unit 放进同一个批次：`src/translate/translate.ts:238-263`。`applyBatchResults` 又用 `firstUnitIndex + offset` 假定批次 unit 在原数组中连续：`src/translate/translate.ts:395-407`。因此中间跳过一个中文段落时，最后一段翻译会写入中文段落的位置，而真正的最后一段回退为原文。

探针输入：英文段落、中文段落、英文段落；当前结果为“第一段译文、最后一段译文、Last English paragraph”，中文原文消失。探针位置：`repro/behavior.audit.ts:F03`。

### F06 — 翻译请求失败后仍保持 visible，编辑和保存持续被拦截（P1，源码和探针确认）

错误处理把状态设为 `phase: "error", visible: true`：`src/app/useAppController.ts:523-535`。保存和文本修改只要 `visible` 就直接返回：`src/app/useAppController.ts:774-795`。所以 HTTP 401、网络失败或 provider 响应错误后，用户看到错误状态却不能继续编辑，也不能保存原文；只能再次切换翻译触发重试。

建议错误态自动隐藏翻译，或至少允许原文编辑/保存，并保留“重试”按钮。

### F07 — 翻译设置改变后，隐藏的旧结果仍会被复用（P2，源码和探针确认）

`setTranslationSettings` 只更新全局设置：`src/app/useAppController.ts:356-359`。ready 结果再次显示时直接复用内存缓存，不检查 endpoint、model、targetLanguage 或 concurrency：`src/app/useAppController.ts:539-560`。因此切换目标语言后，旧目标语言的翻译仍可能显示，且不会发起新请求。

建议给缓存绑定设置签名；endpoint/model/targetLanguage 改变时丢弃或标记旧结果。

### F08 — 文件重命名后 watcher 仍匹配旧路径（P1，源码和探针确认）

`renameDocument` 只调用后端重命名并 dispatch 新路径，没有释放并重新注册 document watch：`src/app/useAppController.ts:882-906`。watch registry 对普通文档使用精确路径 key：`src-tauri/src/watch.rs:223-250, 339-350`。同目录重命名后，后续新路径的外部修改无法匹配旧 key，可能不触发 reload/conflict。

修复应在 rename 成功后以同一 consumer ID 原子地 unwatch old key、watch new key，并处理 watcher 事件与 rename 回调的竞态。

### F09 — “最近关闭”重新打开的是旧快照，不会读取磁盘最新内容（P2，源码确认）

`reopenLastClosed` 直接 clone `recentlyClosed` 中保存的 `DocumentSnapshot`：`src/document/documentReducer.ts:577-617`；`useAppController.reopenClosed` 只重新 acquire scope/watch，没有调用 `port.openPath`：`src/app/useAppController.ts:854-871`。文件在关闭期间被其他程序修改时，⌘⇧T 仍显示旧文本，直到后续事件触发才可能发现变化。

需要明确产品语义：对 clean 快照重新打开时读取磁盘；对 dirty 快照保留本地草稿并做版本冲突检查。

### F10 — 外部变更异步读取可能在 Save As/重命名后覆盖新路径内容（P1，控制流确认）

`reloadFromDisk` 在 await 前捕获旧 `tab.path`，完成后只按 tab ID dispatch：`src/app/useAppController.ts:1001-1013`。如果旧路径的读取尚未完成，用户先 Save As 或重命名同一 tab，旧读取结果仍会进入 `externalChanged`；clean tab 会被替换为旧文件内容，而 tab 的 path 已经是新路径。`src/document/documentReducer.ts:414-430` 没有校验请求路径、版本代或 tab path。

修复应为每次异步读分配 tab/path generation，提交前验证 generation、path 和 expected version 均未改变。

### F11 — Windows 扩展路径与普通路径比较不等，Save As 可能绕过已打开文件冲突（P1，纯 reducer 探针确认）

`normalizeWindowsPath` 对 `\\?\` / `\\.\` 路径只做小写，不把它们折叠为普通 DOS 路径：`src/document/documentReducer.ts:109-127`。因此 `\\?\C:\docs\target.md` 与 `C:\docs\target.md` 产生不同 key，`saveRequested` 的 tab collision 检查会放行：`src/document/documentReducer.ts:303-315`。Windows 上可因此把一个 tab Save As 到另一个已打开文件的别名路径。

修复应统一 extended/device path 的语义，或在后端使用文件 identity（volume serial + file index）做最终冲突保护。

### F12 — Markdown 围栏关闭行错误接受额外后缀（P2，纯函数探针确认）

`FENCE_RE = /^[ \\t]*(`{3,}|~{3,})/` 只匹配前缀，关闭状态没有要求剩余内容为空白：`src/translate/segments.ts:20-22,82-92`。合法代码中的 `~~~not-a-closing-fence` 会被当作关闭行，后面的代码被送去翻译。演示分页器复制了相同逻辑：`src/present/presentationPlan.ts:22-23,122-130,243-250`。

关闭围栏应只允许相同字符、长度不少于 opening、后面只有空格或制表符。

### F13 — blockquote 内的 fenced code 没有被保护（P2，纯函数探针确认）

扫描器只接受行首空格后紧跟围栏：`src/translate/segments.ts:20-22,124-140`；`> ~~~` 不会进入 fence 状态，代码内容会作为可翻译段落。演示分页器同样受影响：`src/present/presentationPlan.ts:22-23,171-177,275-282`。

如果编辑器支持 CommonMark blockquote 中的 fenced code，扫描器必须消费可选的 blockquote 前缀并保持原文拼接完全无损；否则应在产品规则中明确不支持并避免把内容误翻译。

## 依赖安全审计

### D01 — npm 依赖存在 5 个漏洞（2 high，3 moderate）

`npm audit` 结果留存在 [npm-audit.json](evidence/npm-audit.json)，当前安装树为 `npm ls --depth=3`：

- `vitest@4.1.10` / `@vitest/mocker@4.1.10`：路径穿越和任意文件读取（[GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)），修复版本为 `4.1.11`。这是测试/开发服务器依赖，不在生产 bundle 中，但不要把 Vite HMR 暴露到不可信网络。
- `nanoid@3.3.16`（经 `vite@8.1.5 -> postcss@8.5.22`）：自定义 generator 在 size=0 时可能无限循环（[GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8)，high）。
- `postcss@8.5.22`：`sourceMappingURL` 在 `from` 未设置时可能读取任意 `.map` 文件（[GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp)）。
- `undici@7.28.0`（经 `jsdom@29.1.1`）：5 个 response desync/cache/header 相关公告，其中一个 high 级跨用户信息泄露/解析崩溃（[GHSA-4cwx-7wf7-3272](https://github.com/advisories/GHSA-4cwx-7wf7-3272) 等）。这是测试依赖路径。

建议由后续修复任务更新 lockfile 到 audit 提供的修复版本，再跑完整 `npm test`、`npm run build` 和 E2E；不要只用 `npm audit fix --force` 后跳过行为验证。

### D02 — Cargo.lock 命中 8 个包、9 条 OSV/RustSec 公告

只上传了 crate 名称和版本的 OSV 扫描结果：[cargo-osv.json](evidence/cargo-osv.json)。命中项：

- `event-listener 5.4.1`：[RUSTSEC-2026-0221](https://rustsec.org/advisories/RUSTSEC-2026-0221.html)，`!Send` tag 跨线程，修复 `5.4.2`。
- `glib 0.18.5`：[GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) / [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)，`VariantStrIter` iterator unsoundness，修复 `0.20.0`。
- `proc-macro-error 1.0.4`：[RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html)，unmaintained。
- `unic-char-property`、`unic-char-range`、`unic-common`、`unic-ucd-ident`、`unic-ucd-version` 均为 `0.9.0`，对应 [RUSTSEC-2025-0075](https://rustsec.org/advisories/RUSTSEC-2025-0075.html)、RUSTSEC-2025-0080/0081/0098/0100，均为 unmaintained。

`unic-ucd-ident` 的依赖链已确认是 `urlpattern -> tauri-utils -> tauri`；`glib` 和 `event-listener` 的实际平台可达性需要在 Linux/Windows target 上分别确认，当前不能把它们直接等同为生产可利用漏洞。建议后续升级 Tauri 依赖链或用 `[patch.crates-io]` 评估替代版本，并在三平台 CI 上重跑 Cargo 测试。

## 安全设计风险（不等同于已利用漏洞）

### S01 — 翻译 API key 以明文写入 session store（P2，已知 v1 设计债务）

`TranslationSettings.apiKey` 和 `presetApiKeys` 会随 session 写入 plugin-store 的 `session.json`：`src/document/tauriDocumentPort.ts:252-269,411-425`、`src/translate/types.ts:10-19,72-90`。拥有本机用户数据目录读取权限的进程、备份或诊断收集都可能读取 key。仓库安全说明已经承认这是 v1 取舍，但它仍应进入修复队列：优先使用 macOS Keychain / Windows Credential Manager，session 只保存 provider 槽位和非秘密配置。

### S02 — Markdown 中的 HTTP 图片会在打开文档时主动发出网络请求（P3，隐私/威胁模型风险）

图片解析明确允许 `http://` / `https://`，CSP 也允许两者：`src/editor/imageWidgets.ts:44-86`、`src-tauri/tauri.conf.json:28`。打开不可信 Markdown 会把用户 IP、访问时间和可能的 Referer/资源路径暴露给远端站点。若产品要求离线或不向第三方发送请求，应默认阻止 HTTP，或提供“允许远程资源”的显式设置；这不是本次确认的代码执行漏洞。

## 验证结果与边界

已执行的自动化检查：

- `npm test`：53 个文件、1212 个测试通过。
- `npm run build`：通过；Vite 提示主 chunk 约 990 kB（gzip 约 323 kB），属于性能债务而非功能修复结果。
- `npm run test:e2e`：22 个测试通过。
- `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml`：所有 Rust 单元/集成测试通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `cargo clippy --locked --offline --manifest-path src-tauri/Cargo.toml -- -D warnings`：通过。
- `npm audit`：5 个 npm 漏洞；Cargo OSV：8 个包、9 条公告。

Vitest 仍输出 `vi.hoisted` / `vi.mock` 不在模块顶层的未来兼容警告（见 [vitest.log](evidence/vitest.log)）；目前不失败，但升级 Vitest 后可能变成错误。

边界：本次没有启动打包后的 macOS WKWebView，也没有在 Windows/Linux 原生窗口上做人工交互验收；表格复制是 Chromium 壳中的真实 DOM/剪贴板复现，原生 WKWebView 的事件细节还应作为 F01 修复后的验收项。依赖扫描识别的是锁文件中的公开公告，未证明每个传递依赖在每个平台都能到达或可被外部输入触发。

## 后续修复建议

先处理所有 P1，并为每个 P1 增加回归测试；特别是 F01 应加入“表格单元格选区 + 键盘/菜单 copy/cut/paste + 原文提交”的浏览器和原生手工双路径测试。恢复逻辑需要用“新副本成功写入后再删除旧副本”的事务顺序覆盖无路径、同路径合并和空文本三种情况。完成后再升级 npm/Cargo 依赖，最后在 macOS、Windows、Linux 三套原生构建上重复外部变更、恢复、重命名和剪贴板验收。

本报告目录中的 `repro/` 脚本是 opt-in 审计探针，`behavior.audit.ts` 会对当前已确认/怀疑的问题故意失败，不能把它加入默认 `npm test` 门禁；修复后应逐项把断言转为正式回归测试。
