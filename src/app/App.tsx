import { useMemo, useState } from "react";
import { createTauriDocumentPort, subscribeToOpenPaths } from "../document/tauriDocumentPort";
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
      externalError={portError}
    />
  );
}
