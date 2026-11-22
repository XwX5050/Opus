import { createRoot } from "react-dom/client";
import { createApp } from "../app/createApp";
import { createDemoPort } from "../app/demoPort";
import "../theme/tokens.css";
import "../theme/app.css";

/**
 * Production performance entry (perf.html → dist-perf/).
 *
 * This is deliberately separate from index.html: the normal production
 * bundle must never expose the demo/MemoryDocumentPort path. `createApp`
 * runs as a browser shell with the same fixture-seeded in-memory port the
 * development demo uses, but under React's production runtime.
 */
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("perf.html is missing #root");

const root = createRoot(rootElement);
void createDemoPort(new URLSearchParams(window.location.search))
  .then((port) => {
    root.render(createApp(port, { browserShell: true }));
  })
  .catch((error: unknown) => {
    root.render(
      <p role="alert">
        {error instanceof Error ? error.message : String(error)}
      </p>,
    );
  });
