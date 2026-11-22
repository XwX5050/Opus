import { useEffect, useMemo, useState } from "react";
import type { DocumentPort } from "../document/DocumentPort";
import { createTauriDocumentPort, restoreWindowGeometry } from "../document/tauriDocumentPort";
import { createApp } from "./createApp";
import { createDemoPort } from "./demoPort";
import { createE2ePort, isE2eMode } from "./e2e";

/**
 * Port selection happens here and nowhere else:
 *   - E2E (VITE_E2E=1 + window.__E2E_FIXTURE__): fixture-seeded memory port;
 *   - dev demo (?demo=1): demo memory port;
 *   - otherwise: the real Tauri port (always, in production builds).
 */
export default function App() {
  const [portError, setPortError] = useState<string | null>(null);
  const e2e = useMemo(isE2eMode, []);
  const demo = useMemo(
    () =>
      !e2e &&
      import.meta.env.DEV &&
      new URLSearchParams(window.location.search).has("demo"),
    [e2e],
  );
  const browserShell = e2e || demo;
  // The E2E port is synchronous (fixture already on window); the demo port
  // may need to fetch a perf fixture first, so it arrives asynchronously;
  // the production port is created synchronously.
  const [e2ePort] = useState<DocumentPort | null>(() =>
    e2e ? createE2ePort() : null,
  );
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
      browserShell
        ? null
        : createTauriDocumentPort((error) => setPortError(error.message)),
    [browserShell],
  );
  const activePort = browserShell ? (e2ePort ?? demoPort) : port;
  useEffect(() => {
    if (browserShell) return;
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
  }, [browserShell]);
  if (!activePort) {
    return portError ? <p role="alert">{portError}</p> : null;
  }
  return createApp(activePort, {
    browserShell,
    externalError: portError,
    onDismissExternalError: () => setPortError(null),
  });
}
