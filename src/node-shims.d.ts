/**
 * Minimal Node.js typings for tests. The project intentionally has no
 * @types/node dependency; the only Node API the test suite needs is
 * `readFileSync` (to assert stylesheet invariants such as "no hardcoded
 * colors outside tokens.css"). Vite's `?raw` imports return empty strings
 * for CSS under vitest, so tests read the files directly.
 */
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}
