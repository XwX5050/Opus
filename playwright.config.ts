import { defineConfig } from "@playwright/test";

/**
 * Browser-shell end-to-end tests (tests/e2e/).
 *
 * The app runs against the Vite dev server with VITE_E2E=1, which switches
 * the composition root (src/app/App.tsx) to an in-memory DocumentPort seeded
 * from window.__E2E_FIXTURE__ — see src/app/e2e.ts. Production builds never
 * set VITE_E2E and always use the Tauri port.
 *
 * A dedicated port (1421) keeps the E2E server apart from any interactive
 * `npm run dev` session on 1420, and reuseExistingServer stays off so the
 * VITE_E2E=1 environment is guaranteed to be ours.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:1421",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 1421 --strictPort",
    url: "http://localhost:1421",
    reuseExistingServer: false,
    env: { VITE_E2E: "1" },
    timeout: 60_000,
  },
});
