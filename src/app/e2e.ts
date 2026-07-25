import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { OpenedFile, PersistedSession, RecoveryDraft } from "../document/types";

/**
 * E2E-only composition root input (playwright.config.ts sets VITE_E2E=1).
 *
 * A Playwright test installs a JSON fixture on `window.__E2E_FIXTURE__` via
 * `page.addInitScript` before the app loads; the shell then builds a
 * MemoryDocumentPort from it and publishes the instance as
 * `window.__E2E_PORT__` so tests can drive the port's test hooks
 * (updateFile/emitDiskEvent) and inspect writes.
 *
 * `import.meta.env.VITE_E2E` is statically replaced at build time: production
 * builds never define it, so this branch is dead code there and production
 * always uses the Tauri document port.
 */

export interface E2eFileSpec {
  readonly path: string;
  readonly text: string;
  readonly hasUtf8Bom?: boolean;
  readonly newline?: "lf" | "cr_lf";
  readonly version?: string;
}

export interface E2eFixtureSpec {
  // NOTE: this interface is duplicated structurally in
  // tests/e2e/notepad.spec.ts (Playwright serializes the fixture as JSON, so
  // it cannot import app types); keep the two in sync when changing fields.
  readonly files?: ReadonlyArray<E2eFileSpec>;
  readonly session?: PersistedSession | null;
  readonly drafts?: ReadonlyArray<RecoveryDraft>;
  readonly workspace?: { path: string; title: string } | null;
  readonly directories?: ReadonlyArray<string>;
  readonly chosenPaths?: ReadonlyArray<string>;
  readonly savePath?: string | null;
}

declare global {
  interface Window {
    __E2E_FIXTURE__?: E2eFixtureSpec;
    __E2E_PORT__?: MemoryDocumentPort;
  }
}

export const isE2eMode = (): boolean =>
  import.meta.env.VITE_E2E === "1" &&
  typeof window !== "undefined" &&
  window.__E2E_FIXTURE__ !== undefined;

/**
 * Builds (once) the fixture-seeded memory port. Idempotent so React
 * StrictMode's double render never swaps the published instance.
 */
export const createE2ePort = (): MemoryDocumentPort => {
  if (window.__E2E_PORT__) return window.__E2E_PORT__;
  const spec = window.__E2E_FIXTURE__ ?? {};
  const files = new Map<string, OpenedFile>();
  for (const file of spec.files ?? []) {
    files.set(file.path, {
      path: file.path,
      text: file.text,
      hasUtf8Bom: file.hasUtf8Bom ?? false,
      newline: file.newline ?? "lf",
      modifiedUnixMs: 1,
      version: file.version ?? `e2e-${file.path}`,
    });
  }
  const port = new MemoryDocumentPort(files, {
    session: spec.session ?? null,
    drafts: spec.drafts,
    workspace: spec.workspace ?? null,
    directories: spec.directories,
    chosenPaths: spec.chosenPaths,
    savePath: spec.savePath ?? null,
  });
  window.__E2E_PORT__ = port;
  return port;
};
