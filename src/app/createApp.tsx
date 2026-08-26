import type { ReactElement } from "react";
import type { DocumentPort } from "../document/DocumentPort";
import { detectPathPlatform } from "../document/platform";
import { subscribeToImageDrops, subscribeToMenuActions, subscribeToOpenPaths } from "../document/tauriDocumentPort";
import AppShell from "./AppShell";

export interface CreateAppOptions {
  /**
   * Browser shells (E2E fixtures, the ?demo=1 preview) have no Tauri runtime:
   * native event/image-drop/menu subscriptions and window geometry stay off.
   */
  readonly browserShell?: boolean;
  readonly externalError?: string | null;
  readonly onDismissExternalError?: () => void;
}

/**
 * Composition root: mounts the shell against an injected DocumentPort. The
 * caller decides which port implementation to use — production always passes
 * the Tauri port; tests and demos pass the in-memory port.
 */
export function createApp(
  port: DocumentPort,
  options: CreateAppOptions = {},
): ReactElement {
  const browserShell = options.browserShell ?? false;
  // Linux native builds drop the native menu bar and window decorations: the
  // header carries a compact file menu and window-level shortcuts instead.
  const linuxNativeHeader =
    !browserShell &&
    "__TAURI_INTERNALS__" in window &&
    detectPathPlatform() === "linux";
  return (
    <AppShell
      port={port}
      subscribeToEvents={browserShell ? null : subscribeToOpenPaths}
      subscribeToImageDrops={browserShell ? null : subscribeToImageDrops}
      subscribeToMenuActions={browserShell ? null : subscribeToMenuActions}
      // Browser shells have no native menu bar, so they keep the file actions
      // in the header; production moves them into the macOS menu instead.
      fileActionsInHeader={browserShell}
      linuxNativeHeader={linuxNativeHeader}
      externalError={options.externalError ?? null}
      onDismissExternalError={options.onDismissExternalError}
    />
  );
}
