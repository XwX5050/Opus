import type { DocumentPort } from "../document/DocumentPort";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import { detectPathPlatform } from "../document/platform";
import type { PersistedSession } from "../document/types";
import { normalizeThemePreference } from "../theme/preferences";

const DEMO_MARKDOWN = `# Opus

一个轻量的 macOS Markdown 编辑器,支持**实时预览**与阅读模式。

## 功能一览

- 多标签编辑,自动保存会话
- 文件夹侧栏与磁盘监听
- 数学公式与图片预览

> 设计遵循 Obsidian 风格的视觉系统:低对比边框、克制的圆角与紫色 accent。

\`\`\`rust
fn main() {
    println!("你好,世界");
}
\`\`\`

行内公式 $E = mc^2$,以及块级公式:

$$
\\int_a^b f(x)\\,dx = F(b) - F(a)
$$
`;

export interface DemoResponse {
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type DemoFetch = (url: string) => Promise<DemoResponse>;

const defaultDemoFetch: DemoFetch = (url) => fetch(url);

/**
 * Dev-only demo mode (`?demo=1`, optionally `&theme=light|dark|system`):
 * drives the shell with the in-memory port so the full UI can be previewed
 * and screenshotted from a plain browser, without the Tauri runtime. The
 * branch is dead code in production builds (import.meta.env.DEV is false).
 *
 * The dedicated production perf entry (`perf.html`) reuses this constructor
 * directly with the generated fixtures.
 *
 * Extra perf-harness parameters (scripts/measure-editor.mjs):
 *   &fixture=<name>  loads tests/perf/generated/<name> (served by the dev
 *                    server or the perf preview middleware) as the open
 *                    document instead of DEMO_MARKDOWN
 *   &workspace=1     also opens the /demo folder in the sidebar
 */
export const createDemoPort = async (
  params: URLSearchParams,
  fetchImpl: DemoFetch = defaultDemoFetch,
): Promise<DocumentPort> => {
  const fixture = params.get("fixture");
  let text = DEMO_MARKDOWN;
  let documentPath = "/demo/欢迎.md";
  if (fixture !== null) {
    // Basename only: fixtures never leave tests/perf/generated/, whether the
    // caller used POSIX or Windows separators.
    const name = fixture.split(/[\\/]/).pop() ?? fixture;
    // Reject before fetching: a name such as ".." would otherwise be
    // normalized by the URL parser to the SPA route and its HTML shell would
    // be loaded as document text.
    if (
      name.length === 0 ||
      name === "." ||
      name === ".." ||
      !name.endsWith(".md")
    ) {
      throw new Error(
        `性能测试文件无效：${fixture}（只接受 tests/perf/generated 下以 .md 结尾的文件名，且不能为空、"." 或 ".."）`,
      );
    }
    const response = await fetchImpl(
      `/tests/perf/generated/${encodeURIComponent(name)}`,
    );
    if (!response.ok) {
      throw new Error(
        `性能测试文件不存在：${name}（先运行 npm run perf:fixtures）`,
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/html")) {
      throw new Error(
        `性能测试文件请求返回了 HTML 页面：${name}（fixture 请求被 SPA fallback 接管，请检查 preview fixture 中间件）`,
      );
    }
    text = await response.text();
    documentPath = `/demo/${name}`;
  }
  const files = new Map([
    [
      documentPath,
      {
        path: documentPath,
        text,
        hasUtf8Bom: false,
        newline: "lf" as const,
        modifiedUnixMs: 1,
        version: "demo-v1",
      },
    ],
  ]);
  const withWorkspace = params.has("workspace");
  if (withWorkspace) {
    // A small subdirectory so the sidebar has an expandable folder.
    for (const extra of ["/demo/notes/a.md", "/demo/notes/b.md"]) {
      files.set(extra, {
        path: extra,
        text: `# ${extra}\n`,
        hasUtf8Bom: false,
        newline: "lf" as const,
        modifiedUnixMs: 1,
        version: `demo-${extra}`,
      });
    }
  }
  const session: PersistedSession = {
    recent: [{ path: documentPath, kind: "file" }],
    openPaths: [documentPath],
    activePath: documentPath,
    workspacePath: withWorkspace ? "/demo" : null,
    theme: normalizeThemePreference(params.get("theme") ?? undefined),
  };
  return new MemoryDocumentPort(files, {
    session,
    pathPlatform: detectPathPlatform(),
  });
};
