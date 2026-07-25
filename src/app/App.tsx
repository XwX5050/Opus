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
 */
const createDemoPort = (params: URLSearchParams): DocumentPort => {
  const session: PersistedSession = {
    recent: [{ path: "/demo/欢迎.md", kind: "file" }],
    openPaths: ["/demo/欢迎.md"],
    activePath: "/demo/欢迎.md",
    workspacePath: null,
    theme: normalizeThemePreference(params.get("theme") ?? undefined),
  };
  return new MemoryDocumentPort(
    new Map([
      [
        "/demo/欢迎.md",
        {
          path: "/demo/欢迎.md",
          text: DEMO_MARKDOWN,
          hasUtf8Bom: false,
          newline: "lf",
          modifiedUnixMs: 1,
          version: "demo-v1",
        },
      ],
    ]),
    { session },
  );
};

export default function App() {
  const [portError, setPortError] = useState<string | null>(null);
  const demo = useMemo(
    () =>
      import.meta.env.DEV &&
      new URLSearchParams(window.location.search).has("demo"),
    [],
  );
  const port = useMemo(
    () =>
      demo
        ? createDemoPort(new URLSearchParams(window.location.search))
        : createTauriDocumentPort((error) => setPortError(error.message)),
    [demo],
  );
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
  return (
    <AppShell
      port={port}
      subscribeToEvents={demo ? null : subscribeToOpenPaths}
      subscribeToImageDrops={demo ? null : subscribeToImageDrops}
      externalError={portError}
      onDismissExternalError={() => setPortError(null)}
    />
  );
}
