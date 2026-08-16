import type {
  EditorPreferences,
  ThemePreference,
} from "../theme/preferences";
import type { TranslationSettings } from "../translate/types";

export type Newline = "lf" | "cr_lf";
export type PathPlatform = "linux" | "macos" | "windows";

export interface SaveTarget {
  readonly path: string;
  readonly expectedVersion: string | null;
}

export interface PendingWriteRequest {
  readonly requestId: string;
  readonly documentId: string;
  readonly targetPath: string;
  readonly text: string;
  readonly hasUtf8Bom: boolean;
  readonly newline: Newline;
  readonly expectedVersion: string | null;
  readonly pathPlatform: PathPlatform;
}

export interface DocumentSnapshot {
  readonly id: string;
  readonly path: string | null;
  readonly title: string;
  readonly text: string;
  readonly savedText: string;
  readonly hasUtf8Bom: boolean;
  readonly newline: Newline;
  readonly modifiedUnixMs: number | null;
  readonly version: string | null;
  readonly status: "clean" | "dirty" | "conflict" | "missing";
  readonly pendingSave?: PendingWriteRequest;
}

export interface ClosedTab {
  readonly document: DocumentSnapshot;
  readonly closedIndex: number;
}

export interface DocumentState {
  readonly tabs: ReadonlyArray<DocumentSnapshot>;
  readonly activeId: string | null;
  readonly recentlyClosed: ReadonlyArray<ClosedTab>;
  readonly nextSaveSequence: number;
}

export interface OpenedFile {
  readonly path: string;
  readonly text: string;
  readonly hasUtf8Bom: boolean;
  readonly newline: Newline;
  readonly modifiedUnixMs: number;
  readonly version: string;
}

/**
 * Normalized disk-change event emitted by the Rust watcher service
 * (`document-disk-event`). `version` on a change is the opaque document
 * version recomputed from disk at flush time, so the controller can
 * suppress events produced by its own saves; `modifiedUnixMs` is display
 * metadata only.
 */
export type DiskEvent =
  | {
      readonly kind: "changed";
      readonly path: string;
      readonly modifiedUnixMs: number;
      readonly version: string;
    }
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "moved"; readonly from: string; readonly to: string };

/**
 * A dirty-document snapshot stored for crash recovery. `savedTextHash` and
 * `savedVersion` are opaque tokens derived from the last clean document
 * version; Rust stores and returns them without interpreting them.
 */
export interface RecoveryDraft {
  readonly draftId: string;
  readonly originalPath: string | null;
  readonly title: string;
  readonly text: string;
  readonly hasUtf8Bom: boolean;
  readonly newline: Newline;
  readonly savedTextHash: string;
  readonly savedVersion: string | null;
}

/** Draft metadata for restart listings; excludes the (potentially large) text. */
export interface RecoveryDraftInfo {
  readonly draftId: string;
  readonly originalPath: string | null;
  readonly title: string;
  readonly savedTextHash: string;
  readonly savedVersion: string | null;
  readonly updatedUnixMs: number;
}

export interface RecentItem {
  readonly path: string;
  readonly kind: "file" | "folder";
}

/** Drag-resize bounds for the sidebar, in pixels. */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;

/**
 * Share of the window width a single panel may occupy at most once the
 * clamp is aware of the viewport. Two open panels at this cap together leave
 * the editor roughly a fifth of the window, even at the macOS minimum window
 * width (680px), so a narrow window cannot squeeze it to nothing.
 */
export const SIDEBAR_WINDOW_WIDTH_FRACTION = 0.4;

export const clampSidebarWidth = (width: number): number =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));

/**
 * Window-aware variant of `clampSidebarWidth` used at drag/keyboard resize
 * time: the fixed upper bound additionally shrinks with the current window
 * width (never below the fixed minimum), so the resizers cannot push both
 * panels past the editor. Restored/preferences widths keep the plain clamp.
 */
export const clampSidebarWidthToWindow = (
  width: number,
  windowWidth: number,
): number =>
  clampSidebarWidth(
    Math.min(
      width,
      Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.round(windowWidth * SIDEBAR_WINDOW_WIDTH_FRACTION),
      ),
    ),
  );

/**
 * Sidebar collapse and width preferences persisted with the session. Collapse
 * flags default to expanded/visible so sessions written by older versions load
 * unchanged; a missing or invalid width falls back to the default.
 */
export interface SidebarPreferences {
  readonly collapsed: boolean;
  readonly tabsSectionCollapsed: boolean;
  readonly filesSectionCollapsed: boolean;
  readonly width: number;
}

export const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  collapsed: false,
  tabsSectionCollapsed: false,
  filesSectionCollapsed: false,
  width: 260,
};

/** Repair data read from the persisted session; invalid fields get defaults. */
export const normalizeSidebarPreferences = (value: unknown): SidebarPreferences => {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_SIDEBAR_PREFERENCES };
  }
  const record = value as Record<string, unknown>;
  return {
    collapsed:
      typeof record.collapsed === "boolean"
        ? record.collapsed
        : DEFAULT_SIDEBAR_PREFERENCES.collapsed,
    tabsSectionCollapsed:
      typeof record.tabsSectionCollapsed === "boolean"
        ? record.tabsSectionCollapsed
        : DEFAULT_SIDEBAR_PREFERENCES.tabsSectionCollapsed,
    filesSectionCollapsed:
      typeof record.filesSectionCollapsed === "boolean"
        ? record.filesSectionCollapsed
        : DEFAULT_SIDEBAR_PREFERENCES.filesSectionCollapsed,
    width:
      typeof record.width === "number" && Number.isFinite(record.width)
        ? clampSidebarWidth(record.width)
        : DEFAULT_SIDEBAR_PREFERENCES.width,
  };
};

/** Only the outline width survives a restart; visibility remains runtime-only. */
export interface OutlinePreferences {
  readonly width: number;
}

export const DEFAULT_OUTLINE_PREFERENCES: OutlinePreferences = {
  width: 300,
};

export const normalizeOutlinePreferences = (
  value: unknown,
): OutlinePreferences => {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_OUTLINE_PREFERENCES };
  }
  const width = (value as Record<string, unknown>).width;
  return {
    width:
      typeof width === "number" && Number.isFinite(width)
        ? clampSidebarWidth(width)
        : DEFAULT_OUTLINE_PREFERENCES.width,
  };
};

/**
 * Session metadata persisted separately from recovery drafts: only paths,
 * ordering and UI preferences live here, never document content (dirty
 * content lives in drafts). Theme/editor/sidebar/outline/translation
 * preferences are optional so sessions persisted by older versions still
 * load.
 */
export interface PersistedSession {
  readonly recent: ReadonlyArray<RecentItem>;
  readonly openPaths: ReadonlyArray<string>;
  readonly activePath: string | null;
  readonly workspacePath: string | null;
  readonly theme?: ThemePreference;
  readonly editorPreferences?: EditorPreferences;
  readonly sidebar?: SidebarPreferences;
  readonly outline?: OutlinePreferences;
  readonly translationSettings?: TranslationSettings;
}
