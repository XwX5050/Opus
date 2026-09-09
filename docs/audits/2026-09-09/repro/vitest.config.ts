import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../../../vite.config";

// Opt-in audit probes. These assert the desired behavior and intentionally
// fail on the audited revision; normal npm test does not select *.audit.ts.
export default mergeConfig(base, defineConfig({
  test: { include: ["docs/audits/2026-09-09/repro/*.audit.ts"] },
}));
