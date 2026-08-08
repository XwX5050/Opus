import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateOffer {
  readonly version: string;
  readonly downloadAndInstall: () => Promise<void>;
}

/**
 * Checks the GitHub Releases channel for a newer version. Returns null when
 * no update is available, when the environment cannot run the updater (dev
 * builds, E2E runs, plain browsers without the Tauri bridge), or when the
 * check itself fails — an update check must never affect startup.
 */
export const checkUpdate = async (): Promise<UpdateOffer | null> => {
  if (import.meta.env.DEV || import.meta.env.VITE_E2E === "1") return null;
  if (!("__TAURI_INTERNALS__" in window)) return null;
  try {
    const update = await check();
    if (update === null) return null;
    return {
      version: update.version,
      downloadAndInstall: () => update.downloadAndInstall(),
    };
  } catch {
    return null;
  }
};

/** Restarts the app so a downloaded update is applied. */
export const relaunchApp = (): Promise<void> => relaunch();
