import { useEffect, useMemo, useState } from "react";
import { createTauriDocumentPort, restoreWindowGeometry, subscribeToImageDrops, subscribeToOpenPaths } from "../document/tauriDocumentPort";
import AppShell from "./AppShell";

export default function App() {
  const [portError, setPortError] = useState<string | null>(null);
  const port = useMemo(
    () => createTauriDocumentPort((error) => setPortError(error.message)),
    [],
  );
  useEffect(() => {
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
  }, []);
  return (
    <AppShell
      port={port}
      subscribeToEvents={subscribeToOpenPaths}
      subscribeToImageDrops={subscribeToImageDrops}
      externalError={portError}
      onDismissExternalError={() => setPortError(null)}
    />
  );
}
