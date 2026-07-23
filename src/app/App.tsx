import { useMemo, useState } from "react";
import { createTauriDocumentPort, subscribeToImageDrops, subscribeToOpenPaths } from "../document/tauriDocumentPort";
import AppShell from "./AppShell";

export default function App() {
  const [portError, setPortError] = useState<string | null>(null);
  const port = useMemo(
    () => createTauriDocumentPort((error) => setPortError(error.message)),
    [],
  );
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
