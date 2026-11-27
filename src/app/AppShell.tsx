import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useGSAP } from "@gsap/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { ClipboardImageInput, DocumentPort } from "../document/DocumentPort";
import { detectPathPlatform } from "../document/platform";
import { tauriImagePreviewUrl, type ImageDrop } from "../document/tauriDocumentPort";
import {
  SIDEBAR_MIN_WIDTH,
  type DocumentSnapshot,
  type RecentItem,
} from "../document/types";
import ConflictDialog from "../conflict/ConflictDialog";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import InlineNameInput from "./InlineNameInput";
import FileQuickSwitcher from "./FileQuickSwitcher";
import MarkdownEditor, {
  type EditorImageDrop,
  type MarkdownEditorHandle,
  type OutlineNavigationRequest,
  type TableFocusRequest,
} from "../editor/MarkdownEditor";
import OutlinePanel from "../editor/OutlinePanel";
import {
  collectOutlineParentIds,
  type OutlineHeading,
} from "../editor/outline";
import { REDUCED_SYNTAX_MIN_LENGTH } from "../editor/performanceMode";
import { useAutomaticPerformanceMode } from "./usePerformanceMode";
import RecoveryDialog from "../recovery/RecoveryDialog";
import {
  DEFAULT_EDITOR_PREFERENCES,
  EDITOR_PREFERENCE_LIMITS,
} from "../theme/preferences";
import { useTheme } from "../theme/useTheme";
import FileSidebar from "../workspace/FileSidebar";
import {
  BookOpenIcon,
  FileTextIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PencilLineIcon,
  SearchIcon,
  SettingsIcon,
  TranslateIcon,
} from "./icons";
import SettingsDialog from "./SettingsDialog";
import TabList from "./TabList";
import WelcomeScreen from "./WelcomeScreen";
import WorkspaceSearch from "./WorkspaceSearch";
import WindowControls, {
  isWindowsNative,
  WindowResizeHandles,
} from "./WindowControls";
import {
  checkUpdate,
  relaunchApp,
  type UpdateCheckState,
  type UpdateOffer,
} from "./updates";
import { type EventSubscriber, useAppController } from "./useAppController";
import type { TranslationTextRange } from "../translate/translate";
import type { TableCellEditRequest } from "../editor/tableWidgets";
import {
  animateDialogIntro,
  animatePanelIntro,
  bindButtonHoverMotion,
  bindPanelDividerHover,
  bindTranslateHover,
  bindViewModeHover,
  setPanelDividerState,
} from "../motion/motionRuntime";
import PresentationOverlay from "../present/PresentationOverlay";
import {
  clampContentResizeWidth,
  clampPanelResizeWidth,
  contentWidthMax,
  editorColumnWidthOf,
  panelMaxWidth,
  resolvePanelDisplayWidths,
  SHELL_ACTIVITY_RAIL_WIDTH,
  useEditorScrollState,
  usePanelLayoutGuard,
  useWindowWidth,
} from "./shellLayout";
import "./shellRefinements.css";

export type ImageDropSubscriber = (
  onImages: (drop: ImageDrop) => void,
  signal?: AbortSignal,
) => Promise<() => void>;

// Live drag-resize state for the sidebar/outline handles. `frame` holds the
// pending rAF id that coalesces width writes (null when no flush is queued);
// `cleanup` detaches the window listeners, for unmount safety.
type PanelDragState = {
  pointerId: number;
  startX: number;
  startWidth: number;
  lastWidth: number;
  frame: number | null;
  cleanup: () => void;
};

// Live drag-resize state for the reading-column edge handles. Snapshots the
// previous root CSS state so cancelling a drag restores auto/fixed sizing cleanly.
type ContentWidthDragState = {
  pointerId: number;
  startX: number;
  startWidth: number;
  lastWidth: number;
  previousCssWidth: string;
  previousWidthMode: string | undefined;
  frame: number | null;
  cleanup: () => void;
};

export type MenuActionSubscriber = (
  onAction: (action: string) => void,
  signal?: AbortSignal,
) => Promise<() => void>;

export interface AppShellProps {
  port: DocumentPort;
  subscribeToEvents?: EventSubscriber | null;
  subscribeToImageDrops?: ImageDropSubscriber | null;
  subscribeToMenuActions?: MenuActionSubscriber | null;
  /**
   * Renders the file-action text buttons (新建/打开文件/打开文件夹/另存为)
   * in the header. Browser shells have no native menu bar and keep them;
   * production moves those actions into the macOS menu instead. Settings
   * never live here: the activity rail owns the shell's only entry.
   */
  fileActionsInHeader?: boolean;
  /**
   * Non-macOS native builds have no native menu bar: the header shows a
   * compact file-menu dropdown and owns the menu keyboard shortcuts at the
   * window level (routed through the same handler the macOS native menu
   * drives). Linux also drops the "Opus" title (its window is undecorated);
   * Windows keeps the title and draws its own caption buttons
   * (WindowControls) because its window is undecorated too.
   */
  customFileHeader?: boolean;
  externalError?: string | null;
  onDismissExternalError?: () => void;
}

const EMPTY_OUTLINE_IDS: ReadonlySet<string> = new Set();
const ACTIVITY_RAIL_WIDTH = SHELL_ACTIVITY_RAIL_WIDTH;
/**
 * Message the controller writes when the configured provider has no API key
 * in the credential store. The shell treats it as a configuration hint (not
 * a failure) and offers the settings action next to it.
 */
const TRANSLATION_KEY_MISSING_MESSAGE = "请先在设置中配置翻译 API";

interface PendingTableFocus extends TableFocusRequest {
  readonly tabId: string;
}

const pruneTabMap = <T,>(
  current: ReadonlyMap<string, T>,
  openIds: ReadonlySet<string>,
): ReadonlyMap<string, T> => {
  if ([...current.keys()].every((id) => openIds.has(id))) return current;
  return new Map([...current].filter(([id]) => openIds.has(id)));
};

/**
 * Computes the character range of an editor's visible viewport (offsets into
 * the text currently displayed) for viewport-priority translation scheduling.
 * Called on demand at every scheduler pick, so it always reflects the current
 * document and scroll position. A zero-sized scroller (jsdom, hidden editors)
 * or any coordinate failure yields null → the scheduler falls back to
 * document order.
 */
const visibleTextRangeOf = (
  view: EditorView,
): TranslationTextRange | null => {
  try {
    const scroller = view.scrollDOM;
    const rect = scroller.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const contentRect = view.contentDOM.getBoundingClientRect();
    const x =
      contentRect.width > 0
        ? contentRect.left + Math.min(4, contentRect.width / 2)
        : rect.left + 4;
    const from = view.posAtCoords({ x, y: rect.top + 1 });
    const to = view.posAtCoords({ x, y: rect.bottom - 1 });
    const start = from ?? 0;
    const end = to ?? view.state.doc.length;
    return start <= end ? { from: start, to: end } : { from: end, to: start };
  } catch {
    return null;
  }
};

/**
 * Resolves the on-disk location of a saved clipboard image. The save dialog
 * returns paths relative to the document's parent directory when the pick
 * stays inside it; the asset scope needs the absolute location.
 */
const resolveImageSavePath = (
  input: ClipboardImageInput,
  savedPath: string,
): string | null => {
  if (savedPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(savedPath)) {
    return savedPath;
  }
  if (input.documentPath === null) return null;
  const normalized = input.documentPath.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return null;
  const directory = normalized.slice(0, index);
  return directory === "" ? `/${savedPath}` : `${directory}/${savedPath}`;
};

/**
 * Wraps the clipboard-image save so the pasted image always lands inside an
 * asset scope held by the tab. The save dialog defaults to the document's
 * parent directory (already scoped non-recursively at open), but the pick
 * can land in a subdirectory or anywhere else; without a scope the webview's
 * asset protocol refuses the URL and the image breaks permanently. The
 * backend grants a non-recursive scope over the saved file's own parent
 * directory, and the tab's close flow releases every scope it holds.
 */
export const withAssetScopeForSavedImage = (
  port: Pick<DocumentPort, "saveClipboardImage" | "acquireDocumentScope">,
  consumerId: string,
): ((input: ClipboardImageInput) => Promise<string | null>) => {
  return async (input) => {
    const path = await port.saveClipboardImage(input);
    if (path === null) return null;
    const absolute = resolveImageSavePath(input, path);
    if (absolute !== null) {
      try {
        await port.acquireDocumentScope(consumerId, absolute);
      } catch {
        // Best-effort: a failed scope grant must not drop the pasted image.
      }
    }
    return path;
  };
};

// Presentation/projection-screen glyph for the 演示模式 toggle, matching the
// Lucide-style icon set in icons.tsx (24 viewBox, 2px strokes, round caps).
const PresentationIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={20}
    height={20}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2 3h20" />
    <path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3" />
    <path d="m7 21 5-5 5 5" />
  </svg>
);

export default function AppShell({
  port,
  subscribeToEvents = null,
  subscribeToImageDrops = null,
  subscribeToMenuActions = null,
  fileActionsInHeader = true,
  customFileHeader = false,
  externalError = null,
  onDismissExternalError,
}: AppShellProps) {
  const controller = useAppController(port, subscribeToEvents);
  // Latest controller for the native E2E runner: the runner reads through a
  // callback, so it always sees the current render's state instead of the
  // state captured when the runner effect started.
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  useTheme(controller.theme, controller.editorPreferences);
  const sidebar = controller.sidebarPreferences;
  const setSidebar = controller.setSidebarPreferences;
  const outline = controller.outlinePreferences;
  const setOutline = controller.setOutlinePreferences;
  const sidebarAvailable = true;
  // Horizontal tabs stay visible above the editor regardless of sidebar state.
  const activeTabVisible = true;
  // Sidebar tab rows render titles and status flags only. Handing them whole
  // document snapshots would push every open document's text through a React
  // prop on each keystroke, and React's development build then stringifies
  // changed string props in its per-commit component-performance track — an
  // O(document size) cost per keystroke (see docs/performance.md). The
  // signature covers every field the rows render, so the summary keeps a
  // stable identity while nothing visible changes.
  const tabItemsKey = controller.state.tabs
    .map(
      (tab) =>
        `${tab.id}\u0000${tab.title}\u0000${tab.status}\u0000${tab.pendingSave?.requestId ?? ""}`,
    )
    .join("\u0001");
  const tabItems = useMemo(
    () =>
      controller.state.tabs.map(({ id, title, status, pendingSave }) => ({
        id,
        title,
        status,
        pendingSave,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabItemsKey],
  );
  const fileSwitcherPaths = useMemo(
    () => [
      ...new Set([
        ...controller.state.tabs.flatMap((tab) => tab.path ? [tab.path] : []),
        ...controller.recent.filter((item) => item.kind === "file").map((item) => item.path),
      ]),
    ],
    [controller.state.tabs, controller.recent],
  );
  const [settingsRequested, setSettingsRequested] = useState(false);
  const [sidebarView, setSidebarView] = useState<"files" | "search">("files");
  const [fileSwitcherOpen, setFileSwitcherOpen] = useState(false);
  // The shared right-click context menu; at most one open at a time. Items
  // carry their own handlers, so the state only needs the position and the
  // item list. The menu itself is intentionally not part of anyDialogOpen:
  // the background stays interactive behind it.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ReadonlyArray<ContextMenuItem>;
  } | null>(null);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  // Document-title rename (Obsidian-style): the title opens an inline editor
  // on click; the tab menu's 重命名 routes through `titleEditRequest` so the
  // target tab is activated before the editor opens. `sequence` lets a second
  // request on the same tab re-trigger the effect after the first was consumed,
  // and keys the input so every request remounts it (remount re-runs the
  // focus/select effect — reusing a mounted editor would look like nothing
  // happened).
  const [titleEditing, setTitleEditing] = useState<{
    tabId: string;
    sequence: number;
  } | null>(null);
  const [titleEditRequest, setTitleEditRequest] = useState<{
    tabId: string;
    sequence: number;
  } | null>(null);
  const titleEditSequenceRef = useRef(0);
  // Rename failures surface through the same app-alert channel, dismissible
  // like external errors.
  const [renameError, setRenameError] = useState<string | null>(null);
  // Startup update check result; non-null only while the update prompt is
  // still pending or downloading.
  const [updateOffer, setUpdateOffer] = useState<UpdateOffer | null>(null);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  // Manual update-check state surfaced in the settings dialog; the startup
  // check does not touch it (a startup offer opens the update dialog).
  const [updateCheckState, setUpdateCheckState] =
    useState<UpdateCheckState>("idle");
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineResizing, setOutlineResizing] = useState(false);
  const [contentWidthResizing, setContentWidthResizing] = useState(false);
  // Runtime-only space hide for the explorer. It never writes the persisted
  // collapse preference, so a restart at a wide window shows the sidebar
  // again even if the previous session ended on a narrow window.
  const [sidebarAutoHidden, setSidebarAutoHidden] = useState(false);
  const windowWidth = useWindowWidth();
  const panelDisplay = resolvePanelDisplayWidths({
    windowWidth,
    sidebarWidth: sidebar.width,
    sidebarCollapsed: sidebar.collapsed,
    sidebarAutoHidden,
    outlineWidth: outline.width,
    outlineOpen,
  });
  const sidebarPanelVisible = panelDisplay.sidebarVisible;
  // Window-width guard: a narrow window reclaims the outline first and then
  // the explorer so the reading column never drops below a usable width.
  // Wide persisted panel preferences are displayed clamped by the resolver
  // above instead of being persisted back or crushing the editor.
  const panelLayoutGuard = usePanelLayoutGuard({
    windowWidth,
    sidebarWidth: sidebar.width,
    sidebarCollapsed: sidebar.collapsed,
    sidebarAutoHidden,
    outlineWidth: outline.width,
    outlineOpen,
    hideSidebar: () => setSidebarAutoHidden(true),
    showSidebar: () => setSidebarAutoHidden(false),
    openOutline: () => setOutlineOpen(true),
    closeOutline: () => setOutlineOpen(false),
  });
  // User-initiated panel changes respect the editor floor too: opening the
  // outline makes the explorer give way when both preferred widths no longer
  // fit. Expanding the explorer lets the guard close (and remember) the
  // outline through the same space rule.
  const openOutlinePanel = () => {
    panelLayoutGuard.noteManualOutlineToggle();
    if (
      panelDisplay.sidebarVisible &&
      sidebar.width + outline.width > panelDisplay.room
    ) {
      setSidebarAutoHidden(true);
    }
    setOutlineOpen(true);
  };
  const revealSidebarPanel = () => {
    setSidebarAutoHidden(false);
    setSidebar((current) =>
      current.collapsed ? { ...current, collapsed: false } : current,
    );
  };
  const toggleSidebarPanel = () => {
    if (sidebarPanelVisible) {
      setSidebarAutoHidden(false);
      setSidebar((current) => ({ ...current, collapsed: true }));
      return;
    }
    revealSidebarPanel();
  };
  const toggleOutlinePanel = () => {
    if (outlineOpen) {
      panelLayoutGuard.noteManualOutlineToggle();
      setOutlineOpen(false);
      return;
    }
    openOutlinePanel();
  };
  // Drag-resize writes the live width straight to the panel and header instead
  // of re-rendering the whole shell on every pointermove; the final width is
  // committed to the preferences (which persist the session) once, on
  // pointerup, and the committed width is restored on pointercancel.
  const headerRef = useRef<HTMLElement>(null);
  const sidebarRailRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarResizeRef = useRef<PanelDragState | null>(null);
  const outlineRailRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLElement>(null);
  const outlineResizeRef = useRef<PanelDragState | null>(null);
  const contentWidthResizeRef = useRef<ContentWidthDragState | null>(null);
  // Move/up/cancel are tracked on window listeners registered at pointerdown
  // rather than on the handle element: WebKitGTK under Wayland cannot be
  // relied on to keep pointer capture, and a lost capture must never strand
  // the resizing state (a stranded `*-resizing` body class freezes the UI).
  //
  // Width writes go straight to the rail/panel DOM (React stays out of the
  // per-frame path) and are coalesced into one animation frame so a high-rate
  // Wayland pointer cannot queue redundant layouts. Because the panel edge
  // itself follows the pointer, the drag reads as a real resize rather than a
  // detached divider floating over the editor.
  const beginPanelResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    options: {
      dragRef: RefObject<PanelDragState | null>;
      railRef: RefObject<HTMLDivElement | null>;
      panelRef: RefObject<HTMLElement | null>;
      startWidth: number;
      /** Widest this panel may become without breaking the editor floor. */
      maxWidth: number;
      direction: 1 | -1;
      setResizing: (resizing: boolean) => void;
      onLiveWidthChange?: (width: number) => void;
      commit: (width: number) => void;
    },
  ) => {
    if (event.button !== 0) return;
    if (options.maxWidth < SIDEBAR_MIN_WIDTH) return;
    // Without this the press can start a text-selection gesture in WebKit
    // before the resizing body class lands; selecting editor text mid-drag is
    // never desirable on a resize handle. (Focus still reaches the handle
    // via keyboard; pointer focus is unnecessary.)
    event.preventDefault();
    const applyWidth = (width: number) => {
      const rail = options.railRef.current;
      const panel = options.panelRef.current;
      if (rail !== null) rail.style.width = `${width}px`;
      if (panel !== null) panel.style.width = `${width}px`;
      options.onLiveWidthChange?.(width);
    };
    const drag: PanelDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: options.startWidth,
      lastWidth: options.startWidth,
      frame: null,
      cleanup: () => {},
    };
    const flush = () => {
      drag.frame = null;
      applyWidth(drag.lastWidth);
    };
    const scheduleFlush = () => {
      if (drag.frame !== null) return;
      if (typeof requestAnimationFrame === "function") {
        drag.frame = requestAnimationFrame(flush);
      } else {
        flush();
      }
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("lostpointercapture", onCancel);
      window.removeEventListener("blur", onBlur);
      if (drag.frame !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(drag.frame);
      }
      options.dragRef.current = null;
      options.setResizing(false);
      if (commit && drag.lastWidth !== drag.startWidth) {
        options.commit(drag.lastWidth);
      } else if (!commit) {
        // A cancelled drag puts the committed width back: the live writes
        // went straight to the DOM, so React never knew about them.
        applyWidth(drag.startWidth);
      }
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== drag.pointerId) return;
      // `buttons === 0` means the button was released but the matching
      // pointerup never arrived — a real failure mode where XWayland loses
      // the grab mid-drag and motion/up events vanish (the grab transfer
      // tears down the GTK seat, stranding the resizing state). Rather than
      // leave the app frozen, unstrand by committing the current width.
      if (move.buttons === 0) {
        finish(true);
        return;
      }
      drag.lastWidth = clampPanelResizeWidth(
        drag.startWidth + options.direction * (move.clientX - drag.startX),
        options.maxWidth,
      );
      scheduleFlush();
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== drag.pointerId) return;
      finish(true);
    };
    const onCancel = (cancel: Event) => {
      if (
        cancel instanceof PointerEvent &&
        cancel.pointerId !== drag.pointerId
      ) {
        return;
      }
      finish(false);
    };
    // Losing window focus mid-drag (Alt-Tab, an OS-level overlay, a Wayland
    // window that steals the seat) can swallow the remaining pointer events
    // too; cancel so the resizing state never strands the UI.
    const onBlur = () => {
      finish(false);
    };
    drag.cleanup = () => finish(false);
    options.dragRef.current = drag;
    // No setPointerCapture on purpose: WebKitGTK on wlroots compositors
    // (niri) wedges the GTK seat grab when the webview captures the pointer,
    // freezing all input. The window listeners above make capture redundant.
    options.setResizing(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("lostpointercapture", onCancel);
    window.addEventListener("blur", onBlur);
  };
  // If the shell unmounts mid-drag, release the listeners so nothing leaks.
  useEffect(() => {
    const sidebarDrag = sidebarResizeRef;
    const outlineDrag = outlineResizeRef;
    const contentWidthDrag = contentWidthResizeRef;
    return () => {
      sidebarDrag.current?.cleanup();
      outlineDrag.current?.cleanup();
      contentWidthDrag.current?.cleanup();
    };
  }, []);
  const sidebarResizeLimit = (): number =>
    panelMaxWidth(
      window.innerWidth,
      outlineOpen ? panelDisplay.outlineWidth : 0,
    );
  const outlineResizeLimit = (): number =>
    panelMaxWidth(
      window.innerWidth,
      sidebarPanelVisible ? panelDisplay.sidebarWidth : 0,
    );
  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const maxWidth = sidebarResizeLimit();
    if (maxWidth < SIDEBAR_MIN_WIDTH) return;
    beginPanelResize(event, {
      dragRef: sidebarResizeRef,
      railRef: sidebarRailRef,
      panelRef: sidebarRef,
      startWidth: panelDisplay.sidebarWidth,
      maxWidth,
      direction: 1,
      setResizing: setSidebarResizing,
      onLiveWidthChange: (width) => {
        headerRef.current?.style.setProperty(
          "--header-leading-width",
          `${ACTIVITY_RAIL_WIDTH + width}px`,
        );
      },
      commit: (width) => {
        setSidebar((current) =>
          current.width === width ? current : { ...current, width },
        );
      },
    });
  };
  const onSidebarResizerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = 16;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const maxWidth = sidebarResizeLimit();
    if (maxWidth < SIDEBAR_MIN_WIDTH) return;
    const delta = event.key === "ArrowRight" ? step : -step;
    const next = clampPanelResizeWidth(
      panelDisplay.sidebarWidth + delta,
      maxWidth,
    );
    if (next === panelDisplay.sidebarWidth) return;
    setSidebar((current) => ({ ...current, width: next }));
  };
  const startOutlineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const maxWidth = outlineResizeLimit();
    if (maxWidth < SIDEBAR_MIN_WIDTH) return;
    beginPanelResize(event, {
      dragRef: outlineResizeRef,
      railRef: outlineRailRef,
      panelRef: outlineRef,
      startWidth: panelDisplay.outlineWidth,
      maxWidth,
      direction: -1,
      setResizing: setOutlineResizing,
      commit: (width) => {
        setOutline((current) =>
          current.width === width ? current : { width },
        );
      },
    });
  };
  const onOutlineResizerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const maxWidth = outlineResizeLimit();
    if (maxWidth < SIDEBAR_MIN_WIDTH) return;
    const delta = event.key === "ArrowLeft" ? 16 : -16;
    const next = clampPanelResizeWidth(
      panelDisplay.outlineWidth + delta,
      maxWidth,
    );
    if (next === panelDisplay.outlineWidth) return;
    setOutline({ width: next });
  };
  // The resizers' ARIA max follows the same layout-aware cap used while
  // dragging: the activity rail, the other visible panel and the editor floor
  // all constrain what a drag or key press can reach.
  const sidebarResizeMaxWidth = panelMaxWidth(
    windowWidth,
    outlineOpen ? panelDisplay.outlineWidth : 0,
  );
  const outlineResizeMaxWidth = panelMaxWidth(
    windowWidth,
    sidebarPanelVisible ? panelDisplay.sidebarWidth : 0,
  );
  // While dragging, force the resize cursor and block text selection
  // anywhere under the pointer.
  useEffect(() => {
    if (!sidebarResizing) return;
    document.body.classList.add("sidebar-resizing");
    return () => document.body.classList.remove("sidebar-resizing");
  }, [sidebarResizing]);
  useEffect(() => {
    if (!outlineResizing) return;
    document.body.classList.add("outline-resizing");
    return () => document.body.classList.remove("outline-resizing");
  }, [outlineResizing]);
  useEffect(() => {
    if (!contentWidthResizing) return;
    document.body.classList.add("content-width-resizing");
    return () => document.body.classList.remove("content-width-resizing");
  }, [contentWidthResizing]);
  const workspacePath = controller.workspace?.path ?? null;
  const [imageDrop, setImageDrop] = useState<EditorImageDrop | null>(null);
  const imageDropSequenceRef = useRef(0);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const updateButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const editorAreaRef = useRef<HTMLDivElement>(null);
  // The live EditorView of the active tab, fed by MarkdownEditor's
  // onEditorView prop; the translation viewport provider reads it on demand.
  const activeEditorViewRef = useRef<EditorView | null>(null);
  // The same view as state, so the scroll-derived title/outline state
  // re-attaches when a tab's view is created or destroyed.
  const [activeEditorView, setActiveEditorView] = useState<EditorView | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const pendingTabFocusRef = useRef<"close" | "reopen" | null>(null);
  const active = controller.state.tabs.find(
    (tab) => tab.id === controller.state.activeId,
  );
  const contentWidthEditorSpan = editorColumnWidthOf(
    windowWidth,
    sidebarPanelVisible ? panelDisplay.sidebarWidth : 0,
    outlineOpen ? panelDisplay.outlineWidth : 0,
  );
  const contentWidthResizeMax =
    windowWidth > 0
      ? contentWidthMax(contentWidthEditorSpan)
      : EDITOR_PREFERENCE_LIMITS.contentWidthPx.max;
  const showContentWidthHandles =
    Boolean(active) &&
    contentWidthResizeMax >= EDITOR_PREFERENCE_LIMITS.contentWidthPx.min;
  const contentWidthAriaValueNow = Math.min(
    contentWidthResizeMax,
    Math.max(
      EDITOR_PREFERENCE_LIMITS.contentWidthPx.min,
      controller.editorPreferences.contentWidthPx,
    ),
  );
  const contentWidthLiveLimit = (): number => {
    const scrollerWidth =
      activeEditorViewRef.current?.scrollDOM.clientWidth ||
      editorAreaRef.current?.clientWidth ||
      0;
    return scrollerWidth > 0
      ? contentWidthMax(scrollerWidth)
      : contentWidthResizeMax;
  };
  const measuredContentColumnWidth = (maxWidth: number): number => {
    const measured =
      activeEditorViewRef.current?.contentDOM.getBoundingClientRect().width ||
      editorAreaRef.current
        ?.querySelector<HTMLElement>(".cm-content")
        ?.getBoundingClientRect().width ||
      0;
    if (measured > 0) {
      return clampContentResizeWidth(measured, maxWidth);
    }
    return clampContentResizeWidth(
      controllerRef.current.editorPreferences.contentWidthPx,
      maxWidth,
    );
  };
  const startContentWidthResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    direction: 1 | -1,
  ) => {
    if (event.button !== 0) return;
    const maxWidth = contentWidthLiveLimit();
    if (maxWidth < EDITOR_PREFERENCE_LIMITS.contentWidthPx.min) return;
    const startWidth = measuredContentColumnWidth(maxWidth);
    event.preventDefault();
    const root = document.documentElement;
    const previousCssWidth = root.style.getPropertyValue(
      "--editor-content-width",
    );
    const previousWidthMode = root.dataset.editorWidthMode;
    const applyWidth = (width: number) => {
      root.dataset.editorWidthMode = "fixed";
      root.style.setProperty("--editor-content-width", `${width}px`);
    };
    const drag: ContentWidthDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      lastWidth: startWidth,
      previousCssWidth,
      previousWidthMode,
      frame: null,
      cleanup: () => {},
    };
    const flush = () => {
      drag.frame = null;
      applyWidth(drag.lastWidth);
    };
    const scheduleFlush = () => {
      if (drag.frame !== null) return;
      if (typeof requestAnimationFrame === "function") {
        drag.frame = requestAnimationFrame(flush);
      } else {
        flush();
      }
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("lostpointercapture", onCancel);
      window.removeEventListener("blur", onBlur);
      if (drag.frame !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(drag.frame);
      }
      contentWidthResizeRef.current = null;
      setContentWidthResizing(false);
      if (commit && drag.lastWidth !== drag.startWidth) {
        applyWidth(drag.lastWidth);
        const currentPrefs = controllerRef.current.editorPreferences;
        controllerRef.current.setEditorPreferences({
          ...currentPrefs,
          contentWidthPx: drag.lastWidth,
          contentWidthPinned: true,
        });
      } else {
        if (drag.previousCssWidth) {
          root.style.setProperty(
            "--editor-content-width",
            drag.previousCssWidth,
          );
        } else {
          root.style.removeProperty("--editor-content-width");
        }
        if (drag.previousWidthMode === undefined) {
          delete root.dataset.editorWidthMode;
        } else {
          root.dataset.editorWidthMode = drag.previousWidthMode;
        }
      }
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== drag.pointerId) return;
      if (move.buttons === 0) {
        finish(true);
        return;
      }
      drag.lastWidth = clampContentResizeWidth(
        drag.startWidth + direction * 2 * (move.clientX - drag.startX),
        maxWidth,
      );
      scheduleFlush();
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== drag.pointerId) return;
      finish(true);
    };
    const onCancel = (cancel: Event) => {
      if (
        cancel instanceof PointerEvent &&
        cancel.pointerId !== drag.pointerId
      ) {
        return;
      }
      finish(false);
    };
    const onBlur = () => {
      finish(false);
    };
    drag.cleanup = () => finish(false);
    contentWidthResizeRef.current = drag;
    // No setPointerCapture for WebKitGTK/Wayland seat safety.
    setContentWidthResizing(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("lostpointercapture", onCancel);
    window.addEventListener("blur", onBlur);
  };
  const resetContentWidth = () => {
    const { contentWidthPinned: _pinned, ...rest } =
      controllerRef.current.editorPreferences;
    controllerRef.current.setEditorPreferences({
      ...rest,
      contentWidthPx: DEFAULT_EDITOR_PREFERENCES.contentWidthPx,
    });
  };
  const onContentWidthKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    direction: 1 | -1,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const maxWidth = contentWidthLiveLimit();
    if (maxWidth < EDITOR_PREFERENCE_LIMITS.contentWidthPx.min) return;
    const step = 20;
    const delta = (event.key === "ArrowRight" ? step : -step) * direction;
    const baseWidth = measuredContentColumnWidth(maxWidth);
    const next = clampContentResizeWidth(baseWidth + delta, maxWidth);
    if (next === baseWidth) return;
    const currentPrefs = controllerRef.current.editorPreferences;
    controllerRef.current.setEditorPreferences({
      ...currentPrefs,
      contentWidthPx: next,
      contentWidthPinned: true,
    });
  };
  const viewMode = controller.viewModeOf(active?.id);
  const presenting = controller.presentationOpenOf(active?.id);
  // OS fullscreen while presenting, restored when the overlay closes or the
  // shell unmounts. Leaving fullscreen manually never closes the overlay —
  // only the presenting flag drives this. Errors are swallowed: fullscreen
  // is an enhancement, never a requirement. getCurrentWindow() throws
  // synchronously when Tauri internals are only partially mocked (jsdom),
  // hence the try/catch around the sync call.
  useEffect(() => {
    if (!presenting) return;
    const tauri = "__TAURI_INTERNALS__" in window;
    try {
      if (tauri) void getCurrentWindow().setFullscreen(true).catch(() => {});
      else void document.documentElement.requestFullscreen?.().catch(() => {});
    } catch {
      // Best effort only.
    }
    return () => {
      try {
        if (tauri) void getCurrentWindow().setFullscreen(false).catch(() => {});
        else void document.exitFullscreen?.().catch(() => {});
      } catch {
        // Best effort only.
      }
    };
  }, [presenting]);
  const activeTranslation = controller.translationOf(active?.id);
  // The partial translation shown while batches are still in flight; absent
  // until the first batch completes, after which the editor follows it.
  const translatingPartial =
    activeTranslation?.state.phase === "translating"
      ? activeTranslation.state.translatedText
      : undefined;
  // A translation on screen — finished or partial — freezes the editor:
  // value is the (partial) translated text, the view mode is forced to
  // reading, and save/change are no-ops.
  const translationReady =
    activeTranslation?.state.phase === "ready" &&
    activeTranslation.visible === true;
  const translationShown = translationReady || translatingPartial !== undefined;
  let translationLabel = "翻译文档";
  if (activeTranslation?.state.phase === "translating") translationLabel = "取消翻译";
  else if (translationReady) translationLabel = "显示原文";
  else if (activeTranslation?.state.phase === "ready") translationLabel = "显示译文";
  // While the outline is collapsed, the reading/translation state would be
  // invisible (both controls live in the outline toolbar). A slim status bar
  // above the editor keeps the state visible and offers an exit action.
  const editorStateAction =
    activeTranslation?.state.phase === "translating"
      ? "取消翻译"
      : translationReady
        ? "显示原文"
        : "返回编辑";
  const showEditorStateBar = Boolean(
    active && !outlineOpen && (translationShown || viewMode === "reading"),
  );
  // The translation scheduler picks batches nearest the visible character
  // range of the active editor. The range is provided on demand — the getter
  // is read fresh at every batch pick, so no scroll listener is needed — and
  // the EditorView instance is stable across translation toggles (keyed by
  // tab). Registered while the view exists (reading it outside a run is
  // harmless) and unregistered when the view is destroyed or the tab changes.
  useEffect(() => {
    const view = activeEditorViewRef.current;
    if (!view) return;
    controller.setTranslationViewportProvider(() => visibleTextRangeOf(view));
    return () => controller.setTranslationViewportProvider(null);
  }, [controller.setTranslationViewportProvider, activeEditorView, active?.id]);
  const [outlinesByTab, setOutlinesByTab] = useState<
    ReadonlyMap<string, ReadonlyArray<OutlineHeading>>
  >(new Map());
  // The doc revision each published outline was extracted from; navigation
  // requests carry it so the editor can reject stale offsets.
  const [outlineDocsByTab, setOutlineDocsByTab] = useState<
    ReadonlyMap<string, Text>
  >(new Map());
  const [collapsedOutlineIdsByTab, setCollapsedOutlineIdsByTab] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(new Map());
  const [outlineNavigation, setOutlineNavigation] = useState<
    (OutlineNavigationRequest & { readonly tabId: string }) | null
  >(null);
  const outlineSequenceRef = useRef(0);
  const [tableFocusRequest, setTableFocusRequest] = useState<
    PendingTableFocus | null
  >(null);
  const tableFocusSequenceRef = useRef(0);
  // Per-tab light-mode UI state: "继续完整渲染" overrides and banner
  // dismissals are tab-scoped, so they are pruned as soon as a tab closes —
  // a closed-and-reopened document always returns to automatic mode.
  const [forceFullTabs, setForceFullTabs] = useState<ReadonlySet<string>>(new Set());
  const [dismissedPerfTabs, setDismissedPerfTabs] = useState<ReadonlySet<string>>(new Set());
  const tabIdsKey = controller.state.tabs.map((tab) => tab.id).join("\n");
  useEffect(() => {
    const open = new Set(controller.state.tabs.map((tab) => tab.id));
    const prune = (current: ReadonlySet<string>) => {
      if ([...current].every((id) => open.has(id))) return current;
      return new Set([...current].filter((id) => open.has(id)));
    };
    setForceFullTabs(prune);
    setDismissedPerfTabs(prune);
    setOutlinesByTab((current) => pruneTabMap(current, open));
    setOutlineDocsByTab((current) => pruneTabMap(current, open));
    setCollapsedOutlineIdsByTab((current) => pruneTabMap(current, open));
    setTableFocusRequest((current) =>
      current && !open.has(current.tabId) ? null : current
    );
    // Keyed on the open tab ids; the reducer's tab list is the source of truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabIdsKey]);
  const activeOutline = active ? outlinesByTab.get(active.id) ?? null : null;
  const activeCollapsedOutlineIds = active
    ? collapsedOutlineIdsByTab.get(active.id) ?? EMPTY_OUTLINE_IDS
    : EMPTY_OUTLINE_IDS;
  // Scroll-derived shell state: the title folds away once the document is
  // scrolled, and the outline highlights the section holding the viewport.
  // An open inline title editor pins the title expanded.
  const editorScrollState = useEditorScrollState(activeEditorView, activeOutline);
  // The title must never be made inert/aria-hidden while it owns focus: a
  // wheel scroll with the title button focused would otherwise drop focus to
  // the body and strand the user. Focus inside the title keeps it expanded.
  const titleRef = useRef<HTMLDivElement>(null);
  const [titleHasFocus, setTitleHasFocus] = useState(false);
  const titleCompact =
    editorScrollState.titleCompact && titleEditing === null && !titleHasFocus;
  // Closing the inline title editor removes the focused input; browsers move
  // focus to the body without a React blur in that case, so clear the flag
  // unless focus really stayed inside the title.
  useEffect(() => {
    if (titleEditing !== null) return;
    if (!titleRef.current?.contains(document.activeElement)) {
      setTitleHasFocus(false);
    }
  }, [titleEditing]);
  const publishOutline = (
    tabId: string,
    headings: ReadonlyArray<OutlineHeading>,
    doc: Text,
  ) => {
    setOutlinesByTab((current) => {
      const next = new Map(current);
      next.set(tabId, headings);
      return next;
    });
    setOutlineDocsByTab((current) => {
      const next = new Map(current);
      next.set(tabId, doc);
      return next;
    });
    // A collapse marker is only meaningful while the heading still owns
    // children. Dropping leaf IDs prevents newly-added descendants from
    // unexpectedly inheriting a stale collapsed state.
    const validIds = collectOutlineParentIds(headings);
    setCollapsedOutlineIdsByTab((current) => {
      const existing = current.get(tabId) ?? EMPTY_OUTLINE_IDS;
      const retained = new Set(
        [...existing].filter((id) => validIds.has(id)),
      );
      if (
        retained.size === existing.size &&
        [...retained].every((id) => existing.has(id))
      ) {
        if (current.has(tabId)) return current;
      }
      const next = new Map(current);
      next.set(tabId, retained);
      return next;
    });
  };
  const toggleOutlineBranch = (tabId: string, id: string) => {
    setCollapsedOutlineIdsByTab((current) => {
      const nextIds = new Set(current.get(tabId) ?? EMPTY_OUTLINE_IDS);
      if (nextIds.has(id)) nextIds.delete(id);
      else nextIds.add(id);
      const next = new Map(current);
      next.set(tabId, nextIds);
      return next;
    });
  };
  const collapseAllOutlineBranches = (
    tabId: string,
    headings: ReadonlyArray<OutlineHeading>,
  ) => {
    setCollapsedOutlineIdsByTab((current) => {
      const next = new Map(current);
      next.set(tabId, collectOutlineParentIds(headings));
      return next;
    });
  };
  const expandAllOutlineBranches = (tabId: string) => {
    setCollapsedOutlineIdsByTab((current) => {
      if (!current.has(tabId)) return current;
      const next = new Map(current);
      next.set(tabId, new Set<string>());
      return next;
    });
  };
  const navigateToOutlineHeading = (
    tabId: string,
    heading: OutlineHeading,
  ) => {
    outlineSequenceRef.current += 1;
    setOutlineNavigation({
      tabId,
      sequence: outlineSequenceRef.current,
      id: heading.id,
      from: heading.from,
      textFrom: heading.textFrom,
      doc: outlineDocsByTab.get(tabId) ?? null,
    });
  };
  const requestTableEdit = (request: TableCellEditRequest) => {
    if (!active) return;
    const tabId = active.id;
    tableFocusSequenceRef.current += 1;
    setTableFocusRequest({
      ...request,
      tabId,
      sequence: tableFocusSequenceRef.current,
    });
    controller.setViewMode(tabId, "editing");
  };
  const consumeTableFocus = (
    tabId: string,
    request: TableFocusRequest,
  ) => {
    setTableFocusRequest((current) =>
      current?.tabId === tabId && current.sequence === request.sequence
        ? null
        : current
    );
  };
  const activeText = active?.text ?? null;
  // Bounded per keystroke: O(1) for out-of-band documents, one synchronous
  // scan per tab switch, debounced re-evaluation for in-band edits.
  const automaticMode = useAutomaticPerformanceMode(active?.id ?? null, activeText);
  const forceFull = active !== undefined && forceFullTabs.has(active.id);
  const lightMode = automaticMode === "light" && !forceFull;
  const reducedSyntaxLightMode =
    lightMode && (activeText?.length ?? 0) >= REDUCED_SYNTAX_MIN_LENGTH;
  const showPerfBanner = Boolean(
    active && automaticMode === "light" && !forceFull && !dismissedPerfTabs.has(active.id),
  );
  const closing = controller.state.tabs.find(
    (tab) => tab.id === controller.closeDocumentId,
  );
  // Only one modal at a time, in priority order: the close confirmation, the
  // save-failure dialog, the launch recovery flow, a per-tab conflict, then
  // settings (the only user-triggered one, so it yields to everything else).
  // The auto update prompt comes last and yields to every other modal.
  const conflictTab =
    !closing && !controller.saveError && active?.status === "conflict"
      ? active
      : null;
  const recoveryOpen =
    !closing && !controller.saveError && !conflictTab &&
    Boolean(controller.recoveryDrafts?.length);
  const saveErrorOpen = !closing && Boolean(controller.saveError);
  const settingsOpen =
    settingsRequested && !closing && !saveErrorOpen && !recoveryOpen && !conflictTab;
  const updateOpen =
    updateOffer !== null &&
    !closing &&
    !saveErrorOpen &&
    !recoveryOpen &&
    !conflictTab &&
    !settingsOpen;
  const anyDialogOpen = Boolean(
    closing || saveErrorOpen || recoveryOpen || conflictTab || settingsOpen || updateOpen,
  );
  // The app-wide alert channel. A missing translation key is a setup hint,
  // not a failure: it gets a quieter accent tone and a direct settings action.
  const alertMessage = renameError ?? controller.error ?? externalError;
  const translationKeyHint = alertMessage === TRANSLATION_KEY_MISSING_MESSAGE;

  useGSAP(
    () => {
      const root = shellRef.current;
      if (!root) return;
      const header = root.querySelector<HTMLElement>(".app-header");
      if (header) animatePanelIntro(header);
    },
    { scope: shellRef },
  );

  // Elastic scale hover applies to header actions, not tab controls; the
  // activity rail stays fixed-scale. Rebinds when conditionally rendered
  // buttons change; cleanup removes listeners and in-flight transforms.
  // Panel toggles additionally animate the icon's divider line on hover as
  // a preview of the collapse/expand they trigger.
  const panelDividerStateRef = useRef({ leftCollapsed: true, rightCollapsed: true });
  panelDividerStateRef.current = {
    leftCollapsed: !sidebarPanelVisible,
    rightCollapsed: !outlineOpen,
  };
  useGSAP(
    () => {
      const root = shellRef.current;
      if (!root) return;
      const header = root.querySelector<HTMLElement>(".app-header");
      if (!header) return;
      const cleanups = [
        bindButtonHoverMotion(
          header,
          "button:not(:disabled):not(.tab):not(.tab-close):not(.tab-create)",
        ),
      ];
      // Rail buttons keep a fixed scale so their panel dividers stay stable.
      const leftToggle = root.querySelector<HTMLElement>(".sidebar-toggle");
      if (leftToggle) {
        cleanups.push(
          bindPanelDividerHover(
            leftToggle,
            "left",
            () => panelDividerStateRef.current.leftCollapsed,
          ),
        );
      }
      const rightToggle = header.querySelector<HTMLElement>(".right-sidebar-toggle");
      if (rightToggle) {
        cleanups.push(
          bindPanelDividerHover(
            rightToggle,
            "right",
            () => panelDividerStateRef.current.rightCollapsed,
          ),
        );
      }
      const viewModeToggle = root.querySelector<HTMLElement>(".view-mode-toggle");
      if (viewModeToggle) cleanups.push(bindViewModeHover(viewModeToggle));
      const translateToggle = root.querySelector<HTMLElement>(".translate-toggle");
      if (translateToggle) cleanups.push(bindTranslateHover(translateToggle));
      return () => {
        cleanups.forEach((cleanup) => cleanup());
      };
    },
    {
      scope: shellRef,
      dependencies: [
        sidebarAvailable,
        controller.state.tabs.length > 0,
        Boolean(active),
        outlineOpen,
        fileActionsInHeader,
      ],
      revertOnUpdate: true,
    },
  );

  // Keep each panel toggle icon's divider in sync with the panel state;
  // tweened, so clicking the toggle animates the icon along with the panel.
  useGSAP(
    () => {
      const root = shellRef.current;
      if (!root) return;
      const leftToggle = root.querySelector<HTMLElement>(".sidebar-toggle");
      if (leftToggle) setPanelDividerState(leftToggle, "left", !sidebarPanelVisible);
      const rightToggle = root.querySelector<HTMLElement>(".right-sidebar-toggle");
      if (rightToggle) setPanelDividerState(rightToggle, "right", !outlineOpen);
    },
    {
      scope: shellRef,
      dependencies: [
        sidebarPanelVisible,
        outlineOpen,
        sidebarAvailable,
        Boolean(active),
      ],
    },
  );

  useGSAP(
    () => {
      const banner = shellRef.current?.querySelector<HTMLElement>(
        '[data-motion-panel="perf-banner"]',
      );
      if (banner) animatePanelIntro(banner);
    },
    {
      scope: shellRef,
      dependencies: [showPerfBanner],
      revertOnUpdate: true,
    },
  );

  useGSAP(
    () => {
      const root = shellRef.current;
      if (!root) return;
      root
        .querySelectorAll<HTMLElement>("[data-motion-dialog]")
        .forEach((dialog) => animateDialogIntro(dialog));
    },
    {
      scope: shellRef,
      dependencies: [
        settingsOpen,
        closing?.id,
        saveErrorOpen,
        recoveryOpen,
        conflictTab?.id,
        updateOpen,
      ],
      revertOnUpdate: true,
    },
  );

  // Set by explicit user open actions (picker buttons, recent-folder items);
  // only those reveal the drawer — session restores keep the persisted
  // collapse state.
  const revealSidebarOnOpenRef = useRef(false);

  // Opening a workspace through an explicit user action always reveals the
  // drawer; it stays manually collapsible afterwards.
  useEffect(() => {
    if (!workspacePath || !revealSidebarOnOpenRef.current) return;
    revealSidebarOnOpenRef.current = false;
    revealSidebarPanel();
    // The reveal helper is recreated with the current panel widths; the ref
    // guard above keeps the effect from acting on anything but an explicit
    // workspace open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath, setSidebar]);

  useEffect(() => {
    if (!subscribeToImageDrops) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void subscribeToImageDrops((drop) => {
      if (disposed) return;
      imageDropSequenceRef.current += 1;
      setImageDrop({ sequence: imageDropSequenceRef.current, ...drop });
    }).then((created) => {
      if (disposed) created();
      else unlisten = created;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [subscribeToImageDrops]);

  // One best-effort update check at startup; only an available update is
  // acted on, so launching never depends on the update channel.
  useEffect(() => {
    let disposed = false;
    void checkUpdate().then((result) => {
      if (disposed || result.status !== "update") return;
      setUpdateOffer(result.offer);
    });
    return () => {
      disposed = true;
    };
  }, []);

  // Native E2E scenario runner. The dynamic import is compiled only into the
  // dedicated test build (`MODE === "native-e2e"` plus the `native-e2e`
  // Cargo feature); normal production builds have MODE "production" and
  // never include the runner chunk. It drives the real controller, the real
  // CodeMirror view, and the real TauriDocumentPort — nothing here is
  // exercised by the browser-shell E2E mode.
  useEffect(() => {
    if (import.meta.env.MODE !== "native-e2e") return;
    let disposed = false;
    void import("./nativeE2e")
      .then(({ runNativeE2e }) => {
        if (disposed) return undefined;
        return runNativeE2e({
          port,
          controller: () => controllerRef.current,
          editorView: () => activeEditorViewRef.current,
        });
      })
      .catch((error: unknown) => {
        // The runner writes its own failure report through the marker/report
        // channel; this only keeps an unexpected load/startup failure visible
        // in the native log.
        console.error("native E2E runner failed", error);
      });
    return () => {
      disposed = true;
    };
  }, [port]);

  // Manual check from the settings dialog. An available update hands off to
  // the existing update dialog (which yields to the open settings dialog and
  // appears after it closes); the other outcomes are reported inline in the
  // settings dialog through updateCheckState. A result resolving after the
  // shell unmounted is dropped, mirroring the startup check's guard.
  const updateCheckDisposedRef = useRef(false);
  useEffect(() => {
    updateCheckDisposedRef.current = false;
    return () => {
      updateCheckDisposedRef.current = true;
    };
  }, []);
  const checkForUpdates = () => {
    if (updateCheckState === "checking") return;
    setUpdateCheckState("checking");
    void checkUpdate().then((result) => {
      if (updateCheckDisposedRef.current) return;
      if (result.status === "update") {
        setUpdateCheckState("idle");
        setUpdateOffer(result.offer);
        return;
      }
      setUpdateCheckState(result.status);
    });
  };

  const reopenClosed = () => {
    if (controller.state.recentlyClosed.length === 0) return;
    pendingTabFocusRef.current = "reopen";
    controller.reopenClosed();
  };

  const openWorkspaceFromUser = () => {
    revealSidebarOnOpenRef.current = true;
    void controller.openWorkspace();
  };

  const openRecentFromUser = (item: RecentItem) => {
    if (item.kind === "folder") revealSidebarOnOpenRef.current = true;
    void controller.openRecent(item);
  };

  const closeTab = (id: string) => {
    const document = controller.state.tabs.find((tab) => tab.id === id);
    if (document?.status === "clean" && !document.pendingSave) {
      pendingTabFocusRef.current = "close";
    }
    controller.close(id);
  };

  const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  /** The document title shown above the editor: file name without its
   *  Markdown extension (the default 未命名 title carries no extension). */
  const titleBaseName = (title: string): string =>
    title.replace(/\.(md|markdown)$/i, "");

  // The title editor is open while the active document can still be
  // renamed; leaving the tab, losing editability, or a rename (success or
  // failure) closes it again.
  const titleEditableFor = (tab: DocumentSnapshot): boolean =>
    tab.path !== null &&
    tab.pendingSave === undefined &&
    tab.status !== "missing" &&
    tab.status !== "conflict";

  const openSettingsFrom = (invoker: HTMLElement) => {
    // Same pattern as the header button: remember the invoker so the dialog
    // can restore focus on close.
    previousFocusRef.current = invoker;
    setSettingsRequested(true);
  };

  const submitDocumentRename = async (newBaseName: string) => {
    if (!active || active.path === null) {
      setTitleEditing(null);
      return;
    }
    // Blur commits too, so an unchanged or empty name must close quietly
    // instead of round-tripping a no-op rename through the backend.
    const trimmed = newBaseName.trim();
    if (trimmed === "" || trimmed === titleBaseName(active.title)) {
      setTitleEditing(null);
      return;
    }
    const tabId = active.id;
    try {
      await controller.renameDocument(tabId, trimmed);
      setTitleEditing(null);
    } catch (caught) {
      // The title falls back to the still-valid old name; the error message
      // explains why through the app-alert channel.
      setRenameError(errorMessage(caught));
      setTitleEditing(null);
    }
  };

  // A tab-menu 重命名 requests the title editor; when the requested tab is
  // not active yet, activate it and wait for the next render before editing.
  useEffect(() => {
    if (!titleEditRequest) return;
    if (!controller.state.tabs.some((tab) => tab.id === titleEditRequest.tabId)) {
      setTitleEditRequest(null);
      return;
    }
    if (titleEditRequest.tabId !== active?.id) {
      controller.activate(titleEditRequest.tabId);
      return;
    }
    setTitleEditRequest(null);
    setTitleEditing({
      tabId: titleEditRequest.tabId,
      sequence: titleEditRequest.sequence,
    });
    // Keyed on the request and the active tab; activate() is recreated each
    // render, so it is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleEditRequest, active?.id]);

  // Close the title editor when the document stops being editable (status,
  // pending save, translation shown) or the tab swaps underneath it.
  useEffect(() => {
    if (!titleEditing) return;
    if (
      !active ||
      active.id !== titleEditing.tabId ||
      !titleEditableFor(active) ||
      translationShown
    ) {
      setTitleEditing(null);
    }
  }, [titleEditing, active, translationShown]);

  // Fallback context menu for anything that does not handle right-clicks
  // itself (header, empty state, banners, outline panel).
  const openShellContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          id: "new",
          label: "新建",
          onSelect: () => controller.newDocument(),
        },
        {
          id: "open-files",
          label: "打开文件",
          onSelect: () => void controller.openFiles(),
        },
        {
          id: "open-folder",
          label: "打开文件夹",
          onSelect: openWorkspaceFromUser,
        },
        { type: "separator" },
        {
          id: "settings",
          label: "设置",
          onSelect: () => {
            // Like the native menu's menu.settings: remember the current
            // focus so the dialog can restore it on close.
            previousFocusRef.current = document.activeElement as HTMLElement | null;
            setSettingsRequested(true);
          },
        },
      ],
    });
  };

  // Editor-area context menu: undo/redo, clipboard, select-all and the
  // view-mode switch. In reading mode or while a translation is on screen
  // the editing commands are disabled; 复制/全选 and the mode switch stay
  // available.
  const runEditorCommand = (command: "cut" | "copy" | "paste" | "selectAll") => {
    void (async () => {
      // A rendered table cell owns the DOM selection when the user is
      // editing a cell: the menu command must then read/write that cell's
      // DOM selection (restored by the context menu before the item runs),
      // never CodeMirror's state selection.
      const handledByCell =
        (await editorRef.current?.runTableCellClipboardCommand(command)) ?? false;
      if (handledByCell) return;
      editorRef.current?.focus();
      // jsdom and older engines lack execCommand; the editor still receives
      // focus, which is the part the menu can guarantee.
      document.execCommand?.(command);
    })();
  };

  const openEditorAreaContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    // No active tab: the empty state falls through to the shell fallback.
    if (!active) return;
    event.preventDefault();
    event.stopPropagation();
    const isMac = detectPathPlatform() === "macos";
    const mod = isMac ? "⌘" : "Ctrl+";
    const shiftMod = isMac ? "⇧⌘" : "Ctrl+Shift+";
    const editing = viewMode === "editing" && !translationShown;
    const disabledItem = (id: string, label: string, shortcut: string) => ({
      id,
      label,
      shortcut,
      disabled: true,
      onSelect: () => {},
    });
    const items: ReadonlyArray<ContextMenuItem> = [
      editing
        ? {
            id: "undo",
            label: "撤销",
            shortcut: `${mod}Z`,
            onSelect: () => {
              editorRef.current?.undo();
            },
          }
        : disabledItem("undo", "撤销", `${mod}Z`),
      editing
        ? {
            id: "redo",
            label: "重做",
            shortcut: `${shiftMod}Z`,
            onSelect: () => {
              editorRef.current?.redo();
            },
          }
        : disabledItem("redo", "重做", `${shiftMod}Z`),
      { type: "separator" },
      editing
        ? {
            id: "cut",
            label: "剪切",
            shortcut: `${mod}X`,
            onSelect: () => runEditorCommand("cut"),
          }
        : disabledItem("cut", "剪切", `${mod}X`),
      {
        id: "copy",
        label: "复制",
        shortcut: `${mod}C`,
        onSelect: () => runEditorCommand("copy"),
      },
      editing
        ? {
            id: "paste",
            label: "粘贴",
            shortcut: `${mod}V`,
            onSelect: () => runEditorCommand("paste"),
          }
        : disabledItem("paste", "粘贴", `${mod}V`),
      { type: "separator" },
      {
        id: "select-all",
        label: "全选",
        shortcut: `${mod}A`,
        onSelect: () => runEditorCommand("selectAll"),
      },
      { type: "separator" },
      {
        id: "toggle-mode",
        label: editing ? "切换到阅读模式" : "切换到编辑模式",
        shortcut: `${mod}E`,
        onSelect: () => controller.toggleReading(active.id),
      },
      {
        id: "presentation",
        label: "演示模式",
        onSelect: () => controller.openPresentation(active.id),
      },
    ];
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  // Tab context menu: rename (untitled documents have no file to rename, so
  // naming one goes through Save As), save (only dirty), close.
  const openTabContextMenu = (tabId: string, event: ReactMouseEvent) => {
    const tab = controller.state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          id: "rename",
          label: "重命名",
          onSelect: () => {
            if (tab.path === null) {
              void controller.saveAs(tabId);
              return;
            }
            controller.activate(tabId);
            titleEditSequenceRef.current += 1;
            setTitleEditRequest({
              tabId,
              sequence: titleEditSequenceRef.current,
            });
          },
        },
        {
          id: "save",
          label: "保存",
          disabled: tab.status !== "dirty" || Boolean(tab.pendingSave),
          onSelect: () => void controller.save(tabId),
        },
        { type: "separator" },
        {
          id: "close",
          label: "关闭标签",
          onSelect: () => closeTab(tabId),
        },
      ],
    });
  };

  const installUpdate = () => {
    if (updateOffer === null || updateDownloading) return;
    setUpdateDownloading(true);
    void updateOffer
      .downloadAndInstall()
      .then(async () => {
        // relaunch() is a hard process restart that never emits the window
        // close event, so flush any pending debounced session save first —
        // the latest preference change (e.g. a translation API key) would
        // otherwise be lost. The flush is best-effort and must never block
        // the restart.
        await port.flushSession();
        return relaunchApp();
      })
      .catch(() => {
        // Keep the dialog open so the user can retry or dismiss.
        setUpdateDownloading(false);
      });
  };

  const dismissUpdate = () => {
    if (updateDownloading) return;
    setUpdateOffer(null);
  };

  // The menu subscription registers once per subscriber identity; routing
  // through a ref keeps the handler in sync with the latest controller state
  // without re-subscribing on every render.
  const menuActionHandlerRef = useRef<(action: string) => void>(() => {});
  menuActionHandlerRef.current = (action: string) => {
    // Menu accelerators bypass the inert background, so gate them like the
    // shell keyboard shortcuts: no file actions while a modal dialog is up.
    if (anyDialogOpen || fileSwitcherOpen) return;
    switch (action) {
      case "menu.new":
        controller.newDocument();
        break;
      case "menu.open_files":
        void controller.openFiles();
        break;
      case "menu.open_folder":
        openWorkspaceFromUser();
        break;
      case "menu.save":
        if (active) void controller.save(active.id);
        break;
      case "menu.save_as":
        if (active) void controller.saveAs(active.id);
        break;
      case "menu.close_tab":
        if (active) closeTab(active.id);
        break;
      case "menu.settings":
        // Like the header button, remember the current focus so the dialog
        // can restore it on close.
        previousFocusRef.current = document.activeElement as HTMLElement | null;
        setSettingsRequested(true);
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    if (!subscribeToMenuActions) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void subscribeToMenuActions((action) => {
      if (disposed) return;
      menuActionHandlerRef.current(action);
    }).then((created) => {
      if (disposed) created();
      else unlisten = created;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [subscribeToMenuActions]);

  // Custom file header (non-macOS native builds): a compact dropdown
  // standing in for the absent native menu bar. It closes on Escape, on an outside pointerdown, and
  // after choosing an item; focus moves into the menu on open and returns
  // to the toggle on dismiss.
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const fileMenuAnchorRef = useRef<HTMLDivElement>(null);
  const fileMenuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!fileMenuOpen) return;
    fileMenuAnchorRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]')
      ?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!fileMenuAnchorRef.current?.contains(event.target as Node)) {
        setFileMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [fileMenuOpen]);

  // Entry motion for the file menu; the helper honors prefers-reduced-motion.
  useGSAP(
    () => {
      const root = shellRef.current;
      if (!root || !fileMenuOpen) return;
      const menu = root.querySelector<HTMLElement>(".file-menu");
      if (menu) animatePanelIntro(menu);
    },
    { scope: shellRef, dependencies: [fileMenuOpen] },
  );

  const runFileMenuAction = (action: () => void) => {
    setFileMenuOpen(false);
    fileMenuButtonRef.current?.focus();
    action();
  };

  const onFileMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(fileMenuAnchorRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? []),
    ];
    if (event.key === "Escape") {
      event.preventDefault();
      setFileMenuOpen(false);
      fileMenuButtonRef.current?.focus();
      return;
    }
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      items[(current + delta + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items.at(-1)?.focus();
    }
  };

  // Non-macOS native builds install no native menu bar, so its accelerators
  // are re-bound at the window level and routed through the same handler the
  // macOS menu drives (which gates them while a modal dialog is open).
  // Chords the editor already owns — CodeMirror's Mod-s keymap calls
  // preventDefault — are left to it, so nothing double-fires.
  useEffect(() => {
    if (!customFileHeader) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      let action: string | null = null;
      if (event.shiftKey) {
        if (key === "o") action = "menu.open_folder";
        else if (key === "s") action = "menu.save_as";
      } else if (key === "n") action = "menu.new";
      else if (key === "o") action = "menu.open_files";
      else if (key === "s") action = "menu.save";
      else if (key === "w") action = "menu.close_tab";
      else if (key === ",") action = "menu.settings";
      if (action === null) return;
      event.preventDefault();
      setFileMenuOpen(false);
      menuActionHandlerRef.current(action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [customFileHeader]);

  const onShellKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (anyDialogOpen || fileSwitcherOpen) return;
    if (!(event.metaKey || event.ctrlKey)) return;
    if ((event.target as HTMLElement).closest(".cm-editor")) return;
    const key = event.key.toLowerCase();
    if (event.shiftKey && key === "t") {
      event.preventDefault();
      reopenClosed();
      return;
    }
    if (!active) return;
    if (!event.shiftKey && key === "e") {
      event.preventDefault();
      controller.toggleReading(active.id);
    }
  };

  useEffect(() => {
    if (!pendingTabFocusRef.current) return;
    pendingTabFocusRef.current = null;
    // The tab button may not be rendered (sidebar or its tabs section
    // collapsed); fall back to the editor, then the shell, like the
    // dialog-restore path below.
    const target =
      (controller.state.activeId
        ? document.getElementById(`document-tab-${controller.state.activeId}`)
        : document.querySelector<HTMLElement>('[aria-label="空白状态"] button')) ??
      document.querySelector<HTMLElement>('[role="textbox"]') ??
      shellRef.current;
    target?.focus();
  }, [
    controller.state.activeId,
    controller.state.recentlyClosed.length,
    controller.state.tabs.length,
  ]);

  useEffect(() => {
    if (closing) {
      if (!previousFocusRef.current) {
        previousFocusRef.current = document.activeElement as HTMLElement | null;
      }
      if (controller.closeSaving) dialogRef.current?.focus();
      else saveButtonRef.current?.focus();
      return;
    }
    if (saveErrorOpen) {
      if (!previousFocusRef.current) {
        previousFocusRef.current = document.activeElement as HTMLElement | null;
      }
      retryButtonRef.current?.focus();
      return;
    }
    if (recoveryOpen || conflictTab || settingsOpen) {
      // These dialogs focus their own primary control on mount; the shell
      // only remembers where to return afterwards.
      if (!previousFocusRef.current) {
        previousFocusRef.current = document.activeElement as HTMLElement | null;
      }
      return;
    }
    if (updateOpen) {
      if (!previousFocusRef.current) {
        previousFocusRef.current = document.activeElement as HTMLElement | null;
      }
      updateButtonRef.current?.focus();
      return;
    }
    const previous = previousFocusRef.current;
    previousFocusRef.current = null;
    const fallback = document.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"], [role="textbox"]',
    );
    if (previous?.isConnected) previous.focus();
    else (fallback ?? shellRef.current)?.focus();
  }, [closing, controller.closeSaving, saveErrorOpen, recoveryOpen, conflictTab, settingsOpen, updateOpen]);

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !controller.closeSaving) {
      event.preventDefault();
      void controller.confirmClose("cancel");
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const first = buttons[0];
    const last = buttons.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const trapDialogFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const first = buttons[0];
    const last = buttons.at(-1);
    if (!first || !last) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onSaveErrorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      controller.dismissSaveError();
      return;
    }
    if (event.key !== "Tab") return;
    trapDialogFocus(event);
  };

  const onUpdateDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !updateDownloading) {
      event.preventDefault();
      dismissUpdate();
      return;
    }
    if (event.key !== "Tab") return;
    trapDialogFocus(event);
  };

  // The undecorated Windows window has no native titlebar double-click
  // handling: double-clicking empty header space toggles maximization.
  // Buttons (window controls, toggles) keep their own double-click behavior.
  const onHeaderDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (!isWindowsNative()) return;
    if ((event.target as HTMLElement).closest("button")) return;
    void getCurrentWindow().toggleMaximize();
  };

  const onHeaderMouseDown = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0 || !("__TAURI_INTERNALS__" in window)) return;
    const target = event.target as HTMLElement;
    if (
      target.closest(
        "button, input, select, [role='slider'], .tab-item, .window-controls",
      )
    ) {
      return;
    }
    event.preventDefault();
    void getCurrentWindow().startDragging();
  };

  return (
    <main
      ref={shellRef}
      tabIndex={-1}
      className="app-shell"
      data-motion-shell="true"
      onKeyDown={onShellKeyDown}
      onContextMenu={openShellContextMenu}
    >
      <div
        data-testid="app-background"
        inert={anyDialogOpen ? true : undefined}
        aria-hidden={anyDialogOpen ? true : undefined}
        className="app-background"
      >
      <header
        ref={headerRef}
        aria-label="应用标题栏"
        className="app-header"
        data-sidebar-collapsed={sidebarPanelVisible ? "false" : "true"}
        data-tauri-drag-region
        onMouseDown={onHeaderMouseDown}
        onDoubleClick={onHeaderDoubleClick}
        style={{
          "--header-leading-width": `${ACTIVITY_RAIL_WIDTH + (sidebarAvailable && sidebarPanelVisible ? panelDisplay.sidebarWidth : 0)}px`,
        } as CSSProperties}
      >
        <div className="app-header-leading">
        {customFileHeader && (
          <div className="file-menu-anchor" ref={fileMenuAnchorRef}>
            <button
              ref={fileMenuButtonRef}
              type="button"
              className="icon-button file-menu-toggle"
              aria-haspopup="menu"
              aria-expanded={fileMenuOpen}
              aria-controls="file-menu"
              aria-label="文件"
              title="文件"
              onClick={() => setFileMenuOpen((open) => !open)}
            >
              <FileTextIcon size={16} />
            </button>
            {fileMenuOpen && (
              <div
                id="file-menu"
                role="menu"
                aria-label="文件"
                className="file-menu"
                onKeyDown={onFileMenuKeyDown}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runFileMenuAction(() => controller.newDocument())}
                >
                  新建
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runFileMenuAction(() => void controller.openFiles())}
                >
                  打开文件
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runFileMenuAction(openWorkspaceFromUser)}
                >
                  打开文件夹
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runFileMenuAction(() => void controller.saveAs(active?.id))}
                >
                  另存为…
                </button>
              </div>
            )}
          </div>
        )}
        {sidebarAvailable && (
          <button
            type="button"
            className="icon-button sidebar-toggle"
            aria-expanded={sidebarPanelVisible}
            aria-controls="app-sidebar"
            aria-label={sidebarPanelVisible ? "收起侧栏" : "展开侧栏"}
            title={sidebarPanelVisible ? "收起侧栏" : "展开侧栏"}
            onClick={toggleSidebarPanel}
          >
            <PanelLeftIcon />
          </button>
        )}
        {!(customFileHeader && detectPathPlatform() === "linux") && (
          <strong className="app-title" data-tauri-drag-region>
            Opus
          </strong>
        )}
        </div>
        {controller.state.tabs.length > 0 ? (
          <div className="document-tabs-bar">
            <TabList
              tabs={tabItems}
              activeId={controller.state.activeId}
              onActivate={controller.activate}
              onClose={closeTab}
              onCreate={controller.newDocument}
              onTabContextMenu={openTabContextMenu}
            />
          </div>
        ) : (
          <div />
        )}
        <div className="app-header-actions">
        {controller.state.tabs.length > 0 && (
          <>
            {fileActionsInHeader && (
              <>
                <button type="button" onClick={controller.newDocument}>新建</button>
                <button type="button" onClick={() => void controller.openFiles()}>打开文件</button>
                <button type="button" onClick={openWorkspaceFromUser}>打开文件夹</button>
                <button type="button" onClick={() => void controller.saveAs(active?.id)}>另存为…</button>
              </>
            )}
            {active && (
              <button
                type="button"
                className="icon-button right-sidebar-toggle"
                aria-expanded={outlineOpen}
                aria-pressed={outlineOpen}
                aria-controls="app-outline"
                aria-label={outlineOpen ? "收起右侧栏" : "展开右侧栏"}
                title={outlineOpen ? "收起右侧栏" : "展开右侧栏"}
                onClick={toggleOutlinePanel}
              >
                <PanelRightIcon />
              </button>
            )}
          </>
        )}
        <WindowControls />
        </div>
      </header>

      <WindowResizeHandles />

      <section className="app-body">
        <nav
          className="activity-rail"
          aria-label="活动栏"
          data-sidebar-collapsed={sidebarPanelVisible ? "false" : "true"}
        >
          <div className="activity-rail-top">
            <button
              type="button"
              className="icon-button activity-rail-button"
              aria-label="文件"
              title="文件"
              aria-haspopup="dialog"
              onClick={() => {
                if (sidebarView !== "files" || !sidebarPanelVisible) {
                  setSidebarView("files");
                  revealSidebarPanel();
                } else {
                  setFileSwitcherOpen(true);
                }
              }}
            >
              <FileTextIcon size={16} />
            </button>
            {sidebarAvailable && (
              <button
                type="button"
                className="icon-button activity-rail-button"
                aria-label="搜索"
                title="搜索"
                aria-pressed={sidebarView === "search"}
                aria-controls="app-sidebar"
                onClick={() => {
                  setSidebarView((current) => current === "search" ? "files" : "search");
                  revealSidebarPanel();
                }}
              >
                <SearchIcon size={16} />
              </button>
            )}
          </div>
        </nav>
        {sidebarAvailable && (
          <>
          <div
            ref={sidebarRailRef}
            className="sidebar-rail"
            data-motion-panel="sidebar"
            data-collapsed={sidebarPanelVisible ? "false" : "true"}
            style={{ width: sidebarPanelVisible ? panelDisplay.sidebarWidth : 0 }}
          >
          <aside
            ref={sidebarRef}
            id="app-sidebar"
            aria-label="侧栏"
            aria-hidden={!sidebarPanelVisible ? true : undefined}
            inert={!sidebarPanelVisible ? true : undefined}
            className="sidebar"
            style={{
              width: sidebarPanelVisible ? panelDisplay.sidebarWidth : sidebar.width,
            }}
          >
            {sidebarView === "search" ? (
              <WorkspaceSearch
                port={port}
                workspace={controller.workspace}
                dedicated
                autoFocus
                onOpenResult={(match) => void controller.openPath(match.path)}
              />
            ) : (
              <div className="sidebar-scroll">
                <section className="sidebar-section explorer-section">
                  <button
                    type="button"
                    className="sidebar-section-header"
                    aria-expanded={!sidebar.filesSectionCollapsed}
                    aria-controls="sidebar-files-content"
                    onClick={() =>
                      setSidebar((current) => ({
                        ...current,
                        filesSectionCollapsed: !current.filesSectionCollapsed,
                      }))
                    }
                  >
                    资源管理器
                  </button>
                  <div id="sidebar-files-content">
                    {!sidebar.filesSectionCollapsed && (
                      controller.workspace ? (
                        <FileSidebar
                          root={controller.workspace}
                          port={port}
                          activePath={active?.path ?? null}
                          onOpenFile={(path) => void controller.openPath(path)}
                          onCloseWorkspace={controller.closeWorkspace}
                        />
                      ) : (
                        <div className="explorer-empty">
                          <p>尚未打开文件夹。</p>
                          <p className="explorer-empty-hint">打开一个文件夹，即可浏览和全文搜索其中的 Markdown 文档。</p>
                          <button type="button" aria-label="打开文件夹（资源管理器）" onClick={openWorkspaceFromUser}>打开文件夹</button>
                        </div>
                      )
                    )}
                  </div>
                </section>
              </div>
            )}
            <div className="sidebar-settings-row">
              <button
                type="button"
                className="icon-button sidebar-settings"
                aria-label="设置"
                title="设置"
                onClick={(event) => openSettingsFrom(event.currentTarget)}
              >
                <SettingsIcon size={16} />
              </button>
            </div>
          </aside>
          </div>
          {sidebarPanelVisible && (
          <div
            role="slider"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            aria-valuenow={panelDisplay.sidebarWidth}
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={sidebarResizeMaxWidth}
            tabIndex={0}
            className="sidebar-resizer"
            onPointerDown={startSidebarResize}
            onKeyDown={onSidebarResizerKeyDown}
          />
          )}
          </>
        )}
        <div className="editor-column">
        <div
          role={active ? "tabpanel" : "region"}
          aria-label={active ? undefined : "空白状态"}
          id={active ? `document-panel-${active.id}` : undefined}
          aria-labelledby={
            active && activeTabVisible ? `document-tab-${active.id}` : undefined
          }
          ref={editorAreaRef}
          className="editor-area"
          onContextMenu={openEditorAreaContextMenu}
        >
        {active && (
          <div
            ref={titleRef}
            className="document-title"
            data-compact={titleCompact ? "true" : undefined}
            inert={titleCompact ? true : undefined}
            aria-hidden={titleCompact ? true : undefined}
            onFocus={() => setTitleHasFocus(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setTitleHasFocus(false);
              }
            }}
          >
            {titleEditing?.tabId === active.id && titleEditableFor(active) ? (
              <InlineNameInput
                key={titleEditing.sequence}
                ariaLabel="文档标题"
                defaultValue={titleBaseName(active.title)}
                commitOnBlur
                onCommit={(name) => void submitDocumentRename(name)}
                onCancel={() => setTitleEditing(null)}
              />
            ) : titleEditableFor(active) && !translationShown ? (
              <button
                type="button"
                className="document-title-button"
                title="重命名"
                onClick={() => {
                  titleEditSequenceRef.current += 1;
                  setTitleEditing({
                    tabId: active.id,
                    sequence: titleEditSequenceRef.current,
                  });
                }}
              >
                {titleBaseName(active.title)}
              </button>
            ) : active.path === null &&
              active.pendingSave === undefined &&
              !translationShown ? (
              // An untitled document has no file to rename; clicking its
              // title names it by saving it.
              <button
                type="button"
                className="document-title-button"
                title="命名并保存"
                onClick={() => void controller.saveAs(active.id)}
              >
                {active.title}
              </button>
            ) : (
              <span className="document-title-static">
                {titleBaseName(active.title)}
              </span>
            )}
          </div>
        )}
        {showEditorStateBar && active && (
          <div className="editor-state-bar" role="group" aria-label="视图状态">
            <button
              type="button"
              className="editor-state-chip"
              title="展开大纲"
              aria-label={`${
                translationShown ? "正在查看译文" : "阅读模式"
              }，打开大纲`}
              onClick={openOutlinePanel}
            >
              <BookOpenIcon />
              <span>
                {translationShown ? "正在查看译文" : "阅读模式"}
              </span>
            </button>
            {activeTranslation?.state.phase !== "translating" && (
              <button
                type="button"
                className="editor-state-exit"
                onClick={() =>
                  translationShown
                    ? controller.toggleTranslation(active.id)
                    : controller.toggleReading(active.id)
                }
              >
                {editorStateAction}
              </button>
            )}
          </div>
        )}
        {showPerfBanner && active && (
          <div role="status" className="perf-banner" data-motion-panel="perf-banner">
            <span className="perf-banner-text">
              {reducedSyntaxLightMode
                ? "大文档已切换到轻量模式：图片与公式渲染已暂停；极端大文档使用精简 Markdown 语法。文本内容不受影响。"
                : "大文档已切换到轻量模式：图片与公式渲染已暂停，文本内容不受影响。"}
            </span>
            <button
              type="button"
              onClick={() =>
                setForceFullTabs((current) => new Set(current).add(active.id))
              }
            >
              继续完整渲染
            </button>
            <button
              type="button"
              aria-label="关闭轻量模式提示"
              onClick={() =>
                setDismissedPerfTabs((current) => new Set(current).add(active.id))
              }
            >
              ×
            </button>
          </div>
        )}
        {active && activeTranslation?.state.phase === "translating" && (
          <div role="status" className="translation-banner">
            <span className="translation-banner-text">
              {activeTranslation.state.completedBatches !== undefined &&
              activeTranslation.state.totalBatches !== undefined
                ? `正在翻译… (${activeTranslation.state.completedBatches}/${activeTranslation.state.totalBatches})`
                : "正在翻译…"}
            </span>
            <button
              type="button"
              onClick={() => controller.toggleTranslation(active.id)}
            >
              取消
            </button>
          </div>
        )}
        {active && activeTranslation?.state.phase === "error" && (
          <div role="status" className="translation-banner">
            <span className="translation-banner-text">
              翻译失败：{activeTranslation.state.error}
            </span>
            <button
              type="button"
              onClick={() => controller.toggleTranslation(active.id)}
            >
              重试
            </button>
            <button
              type="button"
              aria-label="关闭翻译错误提示"
              onClick={() => controller.dismissTranslationError(active.id)}
            >
              ×
            </button>
          </div>
        )}
        {active ? (
          <MarkdownEditor
            key={active.id}
            ref={editorRef}
            value={
              translationReady
                ? activeTranslation.state.translatedText
                : translatingPartial ?? active.text
            }
            onChange={
              translationShown
                ? () => {}
                : (text) => controller.changeText(active.id, text)
            }
            onSave={
              translationShown
                ? () => {}
                : () => void controller.save(active.id)
            }
            onReopenClosed={reopenClosed}
            onToggleReading={() => controller.toggleReading(active.id)}
            viewMode={
              translationShown ||
              activeTranslation?.state.phase === "translating"
                ? "reading"
                : viewMode
            }
            documentPath={active.path}
            saveClipboardImage={withAssetScopeForSavedImage(port, active.id)}
            resolveImageUrl={tauriImagePreviewUrl}
            imageDrop={imageDrop}
            onOutlineChange={(headings, doc) =>
              publishOutline(active.id, headings, doc)
            }
            outlineNavigation={
              outlineNavigation?.tabId === active.id
                ? outlineNavigation
                : null
            }
            onRequestTableEdit={requestTableEdit}
            tableFocusRequest={
              tableFocusRequest?.tabId === active.id
                ? tableFocusRequest
                : null
            }
            onTableFocusConsumed={(request) =>
              consumeTableFocus(active.id, request)
            }
            performanceMode={lightMode ? "light" : "full"}
            onEditorView={(view) => {
              activeEditorViewRef.current = view;
              setActiveEditorView(view);
            }}
          />
        ) : (
          <WelcomeScreen
            recent={controller.recent}
            onNewDocument={controller.newDocument}
            onOpenFiles={() => void controller.openFiles()}
            onOpenWorkspace={openWorkspaceFromUser}
            onOpenRecent={openRecentFromUser}
          />
        )}
        {showContentWidthHandles && (
          <div className="editor-width-handles">
            <div className="editor-width-frame">
              <div
                role="slider"
                aria-orientation="vertical"
                aria-label="调整正文宽度（左侧）"
                aria-valuenow={contentWidthAriaValueNow}
                aria-valuemin={EDITOR_PREFERENCE_LIMITS.contentWidthPx.min}
                aria-valuemax={contentWidthResizeMax}
                tabIndex={0}
                title="拖动调整正文宽度（双击恢复默认）"
                className="editor-width-handle editor-width-handle-left"
                onPointerDown={(event) => startContentWidthResize(event, -1)}
                onDoubleClick={resetContentWidth}
                onKeyDown={(event) => onContentWidthKeyDown(event, -1)}
              />
              <div
                role="slider"
                aria-orientation="vertical"
                aria-label="调整正文宽度（右侧）"
                aria-valuenow={contentWidthAriaValueNow}
                aria-valuemin={EDITOR_PREFERENCE_LIMITS.contentWidthPx.min}
                aria-valuemax={contentWidthResizeMax}
                tabIndex={0}
                title="拖动调整正文宽度（双击恢复默认）"
                className="editor-width-handle editor-width-handle-right"
                onPointerDown={(event) => startContentWidthResize(event, 1)}
                onDoubleClick={resetContentWidth}
                onKeyDown={(event) => onContentWidthKeyDown(event, 1)}
              />
            </div>
          </div>
        )}
        </div>
        </div>
        {active && (
          <>
            {outlineOpen && (
              <div
                role="slider"
                aria-orientation="vertical"
                aria-label="调整大纲宽度"
                aria-valuenow={panelDisplay.outlineWidth}
                aria-valuemin={SIDEBAR_MIN_WIDTH}
                aria-valuemax={outlineResizeMaxWidth}
                tabIndex={0}
                className="outline-resizer"
                onPointerDown={startOutlineResize}
                onKeyDown={onOutlineResizerKeyDown}
              />
            )}
            <div
              ref={outlineRailRef}
              className="outline-rail"
              data-motion-panel="outline"
              data-collapsed={!outlineOpen}
              style={{
                width: outlineOpen ? panelDisplay.outlineWidth : 0,
              }}
            >
              <aside
                ref={outlineRef}
                id="app-outline"
                aria-label="大纲侧栏"
                aria-hidden={!outlineOpen ? true : undefined}
                inert={!outlineOpen ? true : undefined}
                className="outline-sidebar"
                style={{
                  width: outlineOpen ? panelDisplay.outlineWidth : outline.width,
                }}
              >
                <OutlinePanel
                  actions={
                    <>
                      <button
                        type="button"
                        className="icon-button translate-toggle"
                        aria-pressed={translationReady}
                        aria-label={translationLabel}
                        title={translationLabel}
                        onClick={() => controller.toggleTranslation(active.id)}
                      >
                        <TranslateIcon />
                      </button>
                      <button
                        type="button"
                        className="icon-button view-mode-toggle"
                        aria-pressed={viewMode === "reading"}
                        aria-label={viewMode === "reading" ? "阅读模式" : "编辑模式"}
                        title={
                          viewMode === "reading"
                            ? "切换到编辑模式"
                            : "切换到阅读模式"
                        }
                        onClick={() => controller.toggleReading(active.id)}
                      >
                        {viewMode === "reading" ? <PencilLineIcon /> : <BookOpenIcon />}
                      </button>
                      <button
                        type="button"
                        className="icon-button presentation-toggle"
                        aria-pressed={presenting}
                        aria-label="演示模式"
                        title="演示模式"
                        onClick={() => controller.openPresentation(active.id)}
                      >
                        <PresentationIcon />
                      </button>
                    </>
                  }
                  headings={activeOutline}
                  activeId={editorScrollState.activeHeadingId}
                  collapsedIds={activeCollapsedOutlineIds}
                  onToggle={(id) => toggleOutlineBranch(active.id, id)}
                  onCollapseAll={() =>
                    collapseAllOutlineBranches(active.id, activeOutline ?? [])
                  }
                  onExpandAll={() => expandAllOutlineBranches(active.id)}
                  onNavigate={(heading) =>
                    navigateToOutlineHeading(active.id, heading)
                  }
                />
              </aside>
            </div>
          </>
        )}
      </section>
      </div>

      {(controller.error || externalError || renameError) && (
        <div
          role="alert"
          className="app-alert"
          data-motion-panel="alert"
          data-tone={translationKeyHint ? "notice" : "danger"}
        >
          <span>{alertMessage}</span>
          {translationKeyHint && (
            <button
              type="button"
              className="app-alert-action"
              onClick={(event) => {
                controller.dismissError();
                openSettingsFrom(event.currentTarget);
              }}
            >
              打开设置
            </button>
          )}
          {renameError ? (
            <button
              type="button"
              aria-label="关闭错误提示"
              onClick={() => setRenameError(null)}
            >
              ×
            </button>
          ) : controller.error ? (
            // The controller's own message is dismissible too; a rename error
            // and a host-supplied external error each own their own state.
            <button
              type="button"
              aria-label="关闭错误提示"
              onClick={controller.dismissError}
            >
              ×
            </button>
          ) : (
            externalError && onDismissExternalError && (
              <button type="button" aria-label="关闭错误提示" onClick={onDismissExternalError}>×</button>
            )
          )}
        </div>
      )}

      <FileQuickSwitcher
        open={fileSwitcherOpen && !anyDialogOpen}
        port={port}
        workspace={controller.workspace}
        additionalPaths={fileSwitcherPaths}
        onOpenFile={(path) => controller.openPath(path)}
        onClose={() => setFileSwitcherOpen(false)}
      />

      {closing && (
        <div className="dialog-overlay" data-motion-dialog="true">
        <div
          ref={dialogRef}
          role="dialog"
          tabIndex={-1}
          aria-modal="true"
          aria-busy={controller.closeSaving}
          aria-labelledby="close-dialog-title"
          onKeyDown={onDialogKeyDown}
        >
          <h2 id="close-dialog-title">保存更改</h2>
          <p>是否保存对 {closing.title} 的更改？</p>
          <div className="dialog-actions">
          <button
            ref={saveButtonRef}
            type="button"
            className="button-primary"
            disabled={controller.closeSaving}
            onClick={() => void controller.confirmClose("save")}
          >
            {controller.closeSaving ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            className="button-danger"
            disabled={controller.closeSaving}
            onClick={() => void controller.confirmClose("discard")}
          >
            放弃
          </button>
          <button type="button" disabled={controller.closeSaving} onClick={() => void controller.confirmClose("cancel")}>取消</button>
          </div>
        </div>
        </div>
      )}

      {saveErrorOpen && controller.saveError && (
        <div className="dialog-overlay" data-motion-dialog="true">
        <div
          role="dialog"
          tabIndex={-1}
          aria-modal="true"
          aria-labelledby="save-error-dialog-title"
          onKeyDown={onSaveErrorKeyDown}
        >
          <h2 id="save-error-dialog-title">保存失败</h2>
          <p>{controller.saveError.message}</p>
          <div className="dialog-actions">
          <button
            ref={retryButtonRef}
            type="button"
            className="button-primary"
            onClick={controller.retrySave}
          >
            重试
          </button>
          <button type="button" onClick={controller.saveErrorSaveAs}>另存为…</button>
          <button type="button" onClick={controller.dismissSaveError}>取消</button>
          </div>
        </div>
        </div>
      )}

      {recoveryOpen && controller.recoveryDrafts && (
        <div className="dialog-overlay" data-motion-dialog="true">
        <RecoveryDialog
          drafts={controller.recoveryDrafts}
          onRestore={(info) => void controller.restoreDraft(info)}
          onDiscard={(info) => void controller.discardRecoveryDraft(info)}
          readSource={async (draftId) => (await port.readDraft(draftId)).text}
        />
        </div>
      )}

      {conflictTab && (
        <div className="dialog-overlay" data-motion-dialog="true">
        <ConflictDialog
          title={conflictTab.title}
          path={conflictTab.path}
          onLoadDisk={() => void controller.loadDiskVersion(conflictTab.id)}
          onKeepLocal={() => controller.keepLocalVersion(conflictTab.id)}
          onSaveAs={() => void controller.saveAs(conflictTab.id)}
        />
        </div>
      )}

      {settingsOpen && (
        <div className="dialog-overlay" data-motion-dialog="true">
        <SettingsDialog
          theme={controller.theme}
          editorPreferences={controller.editorPreferences}
          translationSettings={controller.translationSettings}
          port={port}
          onThemeChange={controller.setTheme}
          onEditorPreferencesChange={controller.setEditorPreferences}
          onTranslationSettingsChange={controller.setTranslationSettings}
          onClose={() => setSettingsRequested(false)}
          onCheckForUpdates={checkForUpdates}
          updateCheckState={updateCheckState}
        />
        </div>
      )}

      {updateOpen && updateOffer && (
        <div className="dialog-overlay" data-motion-dialog="true">
        <div
          role="dialog"
          tabIndex={-1}
          aria-modal="true"
          aria-busy={updateDownloading}
          aria-labelledby="update-dialog-title"
          onKeyDown={onUpdateDialogKeyDown}
        >
          <h2 id="update-dialog-title">发现新版本 v{updateOffer.version}</h2>
          <p>新版本已准备就绪，下载完成后应用将自动重启以完成更新。</p>
          <div className="dialog-actions">
          <button
            ref={updateButtonRef}
            type="button"
            className="button-primary"
            disabled={updateDownloading}
            onClick={installUpdate}
          >
            {updateDownloading ? "正在下载更新…" : "立即更新"}
          </button>
          <button type="button" disabled={updateDownloading} onClick={dismissUpdate}>稍后</button>
          </div>
        </div>
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      {presenting && active && (
        <PresentationOverlay
          markdown={active.text}
          documentPath={active.path}
          resolveImageUrl={tauriImagePreviewUrl}
          onExit={() => controller.closePresentation(active.id)}
        />
      )}
    </main>
  );
}
