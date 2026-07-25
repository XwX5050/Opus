import { useEffect, useMemo, useState } from "react";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { DocumentPort } from "../document/DocumentPort";
import { createTauriDocumentPort, restoreWindowGeometry, subscribeToImageDrops, subscribeToOpenPaths } from "../document/tauriDocumentPort";
import type { PersistedSession } from "../document/types";
import { normalizeThemePreference } from "../theme/preferences";
import AppShell from "./AppShell";

const DEMO_MARKDOWN = `# Markdown Edit

一个轻量的 macOS Markdown 编辑器,支持**实时预览**与源码模式。

## 功能一览

- 多标签编辑,自动保存会话
- 文件夹侧栏与磁盘监听
- 数学公式与图片预览

> 设计遵循 Baseline 视觉系统:低对比边框、克制的圆角与细腻的过渡。

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

/**
 * Dev-only demo mode (`?demo=1`, optionally `&theme=light|dark|system`):
 * drives the shell with the in-memory port so the full UI can be previewed
 * and screenshotted from a plain browser, without the Tauri runtime. The
 * branch is dead code in production builds (import.meta.env.DEV is false).
 *
 * Extra perf-harness parameters (scripts/measure-editor.mjs):
 *   &fixture=<name>  loads tests/perf/generated/<name> (served by the dev
 *                    server) as the open document instead of DEMO_MARKDOWN
 *   &workspace=1     also opens the /demo folder in the sidebar
 */
const createDemoPort = async (params: URLSearchParams): Promise<DocumentPort> => {
  const fixture = params.get("fixture");
  let text = DEMO_MARKDOWN;
  let documentPath = "/demo/欢迎.md";
  if (fixture) {
    // Basename only: fixtures never leave tests/perf/generated/.
    const name = fixture.split("/").pop() ?? fixture;
    const response = await fetch(`/tests/perf/generated/${name}`);
    if (!response.ok) {
      throw new Error(
        `性能测试文件不存在：${name}（先运行 npm run perf:fixtures）`,
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
  return new MemoryDocumentPort(files, { session });
};

export default function App() {
  const [portError, setPortError] = useState<string | null>(null);
  const demo = useMemo(
    () =>
      import.meta.env.DEV &&
      new URLSearchParams(window.location.search).has("demo"),
    [],
  );
  // The demo port may need to fetch a perf fixture first, so it arrives
  // asynchronously; the production port is created synchronously.
  const [demoPort, setDemoPort] = useState<DocumentPort | null>(null);
  useEffect(() => {
    if (!demo) return;
    let disposed = false;
    createDemoPort(new URLSearchParams(window.location.search))
      .then((port) => {
        if (!disposed) setDemoPort(port);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setPortError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      disposed = true;
    };
  }, [demo]);
  const port = useMemo(
    () =>
      demo
        ? null
        : createTauriDocumentPort((error) => setPortError(error.message)),
    [demo],
  );
  const activePort = demo ? demoPort : port;
  useEffect(() => {
    if (demo) return;
    let stop: (() => void) | null = null;
    let disposed = false;
    void restoreWindowGeometry().then((created) => {
      if (disposed) created();
      else stop = created;
    }).catch(() => {
      // Window geometry persistence is best-effort.
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [demo]);
  if (!activePort) {
    return portError ? <p role="alert">{portError}</p> : null;
  }
  return (
    <AppShell
      port={activePort}
      subscribeToEvents={demo ? null : subscribeToOpenPaths}
      subscribeToImageDrops={demo ? null : subscribeToImageDrops}
      externalError={portError}
      onDismissExternalError={() => setPortError(null)}
    />
  );
}
