import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateOffer {
  readonly version: string;
  readonly downloadAndInstall: () => Promise<void>;
}

/** Manual update-check states surfaced in the settings dialog. */
export type UpdateCheckState =
  | "idle"
  | "checking"
  | "up-to-date"
  | "error"
  | "unsupported";

/**
 * Result of an update check, as a discriminated union:
 * - `update` — a newer version exists; the offer drives the update dialog.
 * - `up-to-date` — the channel was reachable and has nothing newer.
 * - `unsupported` — this environment cannot run the updater (dev builds, E2E
 *   runs, plain browsers without the Tauri bridge).
 * - `error` — the check itself failed (offline, channel unreachable); the
 *   `reason` keeps the underlying failure for logs/state, while the UI shows
 *   a generic hint.
 */
export type UpdateCheckResult =
  | { readonly status: "update"; readonly offer: UpdateOffer }
  | { readonly status: "up-to-date" }
  | { readonly status: "unsupported" }
  | { readonly status: "error"; readonly reason: string };

// Concurrent checks share one plugin call instead of hammering the channel;
// the first caller owns the promise and clears it once it settles.
let inFlight: Promise<UpdateCheckResult> | null = null;

/**
 * Checks the GitHub Releases channel for a newer version. An update check
 * must never affect startup: unsupported environments short-circuit before
 * touching the plugin, and check failures surface as `error` instead of
 * throwing. Concurrent calls while a check is in flight are deduplicated.
 */
export const checkUpdate = async (): Promise<UpdateCheckResult> => {
  if (import.meta.env.DEV || import.meta.env.VITE_E2E === "1") {
    return { status: "unsupported" };
  }
  if (!("__TAURI_INTERNALS__" in window)) {
    return { status: "unsupported" };
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const update = await check();
      if (update === null) return { status: "up-to-date" };
      return {
        status: "update",
        offer: {
          version: update.version,
          downloadAndInstall: () => update.downloadAndInstall(),
        },
      };
    } catch (error) {
      // Keep the real failure reason rather than swallowing it; the settings
      // dialog still shows the generic hint.
      console.error("update check failed:", error);
      return {
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
};

/** Restarts the app so a downloaded update is applied. */
export const relaunchApp = (): Promise<void> => relaunch();
