import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { DocumentPort } from "../document/DocumentPort";
import { tauriImagePreviewUrl, type ImageDrop } from "../document/tauriDocumentPort";
import {
  clampSidebarWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  type RecentItem,
} from "../document/types";
import ConflictDialog from "../conflict/ConflictDialog";
import MarkdownEditor, {
  type EditorImageDrop,
  type OutlineNavigationRequest,
  type TableFocusRequest,
} from "../editor/MarkdownEditor";
import OutlinePanel from "../editor/OutlinePanel";
import {
  collectOutlineParentIds,
  type OutlineHeading,
} from "../editor/outline";
import { useAutomaticPerformanceMode } from "./usePerformanceMode";
import RecoveryDialog from "../recovery/RecoveryDialog";
import { useTheme } from "../theme/useTheme";
import FileSidebar from "../workspace/FileSidebar";
import {
  BookOpenIcon,
  ListTreeIcon,
  PanelLeftIcon,
  PencilLineIcon,
} from "./icons";
import SettingsDialog from "./SettingsDialog";
import TabList from "./TabList";
import { type EventSubscriber, useAppController } from "./useAppController";
import type { TableCellEditRequest } from "../editor/tableWidgets";

export type ImageDropSubscriber = (
  onImages: (drop: ImageDrop) => void,
  signal?: AbortSignal,
) => Promise<() => void>;

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
   * Renders the file-action text buttons (新建/打开文件/打开文件夹/另存为/设置)
   * in the header. Browser shells have no native menu bar and keep them;
   * production moves those actions into the macOS menu instead.
   */
  fileActionsInHeader?: boolean;
  externalError?: string | null;
  onDismissExternalError?: () => void;
}

const EMPTY_OUTLINE_IDS: ReadonlySet<string> = new Set();

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

export default function AppShell({
  port,
  subscribeToEvents = null,
  subscribeToImageDrops = null,
  subscribeToMenuActions = null,
  fileActionsInHeader = true,
  externalError = null,
  onDismissExternalError,
}: AppShellProps) {
  const controller = useAppController(port, subscribeToEvents);
  useTheme(controller.theme, controller.editorPreferences);
  const sidebar = controller.sidebarPreferences;
  const setSidebar = controller.setSidebarPreferences;
  const outline = controller.outlinePreferences;
  const setOutline = controller.setOutlinePreferences;
  const sidebarAvailable =
    controller.state.tabs.length > 0 || controller.workspace !== null;
  // The tab element only exists when the sidebar and its tabs section are
  // both expanded; the tabpanel drops its label reference otherwise.
  const activeTabVisible =
    sidebarAvailable && !sidebar.collapsed && !sidebar.tabsSectionCollapsed;
  const [settingsRequested, setSettingsRequested] = useState(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineResizing, setOutlineResizing] = useState(false);
  // Live width while dragging; committed to sidebarPreferences (which
  // persists the session) only on pointerup, not on every move.
  const [sidebarDragWidth, setSidebarDragWidth] = useState<number | null>(null);
  const sidebarResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    lastWidth: number;
  } | null>(null);
  const [outlineDragWidth, setOutlineDragWidth] = useState<number | null>(null);
  const outlineResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    lastWidth: number;
  } | null>(null);
  // Sidebar drag-resize: pointer capture keeps move/up events on the handle
  // even when the pointer leaves it; width is clamped on every move.
  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    sidebarResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebar.width,
      lastWidth: sidebar.width,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSidebarResizing(true);
  };
  const moveSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sidebarResizeRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const width = clampSidebarWidth(drag.startWidth + (event.clientX - drag.startX));
    drag.lastWidth = width;
    setSidebarDragWidth(width);
  };
  const endSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sidebarResizeRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    sidebarResizeRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setSidebarResizing(false);
    setSidebarDragWidth(null);
    if (drag.lastWidth !== sidebar.width) {
      setSidebar((current) => ({ ...current, width: drag.lastWidth }));
    }
  };
  const onSidebarResizerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = 16;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? step : -step;
    setSidebar((current) => ({
      ...current,
      width: clampSidebarWidth(current.width + delta),
    }));
  };
  const startOutlineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    outlineResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: outline.width,
      lastWidth: outline.width,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setOutlineResizing(true);
  };
  const moveOutlineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = outlineResizeRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const width = clampSidebarWidth(
      drag.startWidth + (drag.startX - event.clientX),
    );
    drag.lastWidth = width;
    setOutlineDragWidth(width);
  };
  const endOutlineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = outlineResizeRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    outlineResizeRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setOutlineResizing(false);
    setOutlineDragWidth(null);
    if (drag.lastWidth !== outline.width) {
      setOutline({ width: drag.lastWidth });
    }
  };
  const onOutlineResizerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? 16 : -16;
    setOutline((current) => ({
      width: clampSidebarWidth(current.width + delta),
    }));
  };
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
  const workspacePath = controller.workspace?.path ?? null;
  const [imageDrop, setImageDrop] = useState<EditorImageDrop | null>(null);
  const imageDropSequenceRef = useRef(0);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const pendingTabFocusRef = useRef<"close" | "reopen" | null>(null);
  const active = controller.state.tabs.find(
    (tab) => tab.id === controller.state.activeId,
  );
  const viewMode = controller.viewModeOf(active?.id);
  const [outlinesByTab, setOutlinesByTab] = useState<
    ReadonlyMap<string, ReadonlyArray<OutlineHeading>>
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
  const publishOutline = (
    tabId: string,
    headings: ReadonlyArray<OutlineHeading>,
  ) => {
    setOutlinesByTab((current) => {
      const next = new Map(current);
      next.set(tabId, headings);
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
  const navigateToOutlineHeading = (
    tabId: string,
    heading: OutlineHeading,
  ) => {
    outlineSequenceRef.current += 1;
    setOutlineNavigation({
      tabId,
      sequence: outlineSequenceRef.current,
      from: heading.from,
      textFrom: heading.textFrom,
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
  const activeText = active?.text ?? null;
  // Bounded per keystroke: O(1) for out-of-band documents, one synchronous
  // scan per tab switch, debounced re-evaluation for in-band edits.
  const automaticMode = useAutomaticPerformanceMode(active?.id ?? null, activeText);
  const forceFull = active !== undefined && forceFullTabs.has(active.id);
  const lightMode = automaticMode === "light" && !forceFull;
  const showPerfBanner = Boolean(
    active && automaticMode === "light" && !forceFull && !dismissedPerfTabs.has(active.id),
  );
  const closing = controller.state.tabs.find(
    (tab) => tab.id === controller.closeDocumentId,
  );
  // Only one modal at a time, in priority order: the close confirmation, the
  // save-failure dialog, the launch recovery flow, a per-tab conflict, then
  // settings (the only user-triggered one, so it yields to everything else).
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
  const anyDialogOpen = Boolean(
    closing || saveErrorOpen || recoveryOpen || conflictTab || settingsOpen,
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
    setSidebar((current) =>
      current.collapsed ? { ...current, collapsed: false } : current,
    );
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

  // The menu subscription registers once per subscriber identity; routing
  // through a ref keeps the handler in sync with the latest controller state
  // without re-subscribing on every render.
  const menuActionHandlerRef = useRef<(action: string) => void>(() => {});
  menuActionHandlerRef.current = (action: string) => {
    // Menu accelerators bypass the inert background, so gate them like the
    // shell keyboard shortcuts: no file actions while a modal dialog is up.
    if (anyDialogOpen) return;
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
      case "menu.save_as":
        if (active) void controller.saveAs(active.id);
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

  const onShellKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (anyDialogOpen) return;
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
    const previous = previousFocusRef.current;
    previousFocusRef.current = null;
    const fallback = document.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"], [role="textbox"]',
    );
    if (previous?.isConnected) previous.focus();
    else (fallback ?? shellRef.current)?.focus();
  }, [closing, controller.closeSaving, saveErrorOpen, recoveryOpen, conflictTab, settingsOpen]);

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

  return (
    <main
      ref={shellRef}
      tabIndex={-1}
      className="app-shell"
      onKeyDown={onShellKeyDown}
    >
      <div
        data-testid="app-background"
        inert={anyDialogOpen ? true : undefined}
        aria-hidden={anyDialogOpen ? true : undefined}
        className="app-background"
      >
      <header
        aria-label="应用标题栏"
        className="app-header"
        data-tauri-drag-region
      >
        {sidebarAvailable && (
          <button
            type="button"
            className="icon-button sidebar-toggle"
            aria-expanded={!sidebar.collapsed}
            aria-controls="app-sidebar"
            aria-label={sidebar.collapsed ? "展开侧栏" : "收起侧栏"}
            title={sidebar.collapsed ? "展开侧栏" : "收起侧栏"}
            onClick={() =>
              setSidebar((current) => ({ ...current, collapsed: !current.collapsed }))
            }
          >
            <PanelLeftIcon />
          </button>
        )}
        <strong className="app-title" data-tauri-drag-region>
          Opus
        </strong>
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
              <>
                <button
                  type="button"
                  className="icon-button view-mode-toggle"
                  aria-pressed={viewMode === "reading"}
                  aria-label={viewMode === "reading" ? "阅读模式" : "编辑模式"}
                  title={viewMode === "reading" ? "阅读模式" : "编辑模式"}
                  onClick={() => controller.toggleReading(active.id)}
                >
                  {viewMode === "reading" ? <BookOpenIcon /> : <PencilLineIcon />}
                </button>
                <button
                  type="button"
                  className="icon-button outline-toggle"
                  aria-expanded={outlineOpen}
                  aria-pressed={outlineOpen}
                  aria-controls="app-outline"
                  aria-label={outlineOpen ? "收起大纲" : "展开大纲"}
                  title={outlineOpen ? "收起大纲" : "展开大纲"}
                  onClick={() => setOutlineOpen((current) => !current)}
                >
                  <ListTreeIcon />
                </button>
              </>
            )}
          </>
        )}
        {fileActionsInHeader && (
          <button
            type="button"
            onClick={(event) => {
              // The dialog focuses its own first control before the shell's
              // effect could capture this, so remember the invoker here.
              previousFocusRef.current = event.currentTarget;
              setSettingsRequested(true);
            }}
          >
            设置
          </button>
        )}
      </header>

      <section className="app-body">
        {sidebarAvailable && (
          <>
          <div
            className="sidebar-rail"
            data-collapsed={sidebar.collapsed}
            style={{ width: sidebar.collapsed ? 0 : sidebarDragWidth ?? sidebar.width }}
          >
          <aside
            id="app-sidebar"
            aria-label="侧栏"
            aria-hidden={sidebar.collapsed ? true : undefined}
            inert={sidebar.collapsed ? true : undefined}
            className="sidebar"
            style={{ width: sidebarDragWidth ?? sidebar.width }}
          >
            {controller.state.tabs.length > 0 && (
              <section className="sidebar-section">
                <button
                  type="button"
                  className="sidebar-section-header"
                  aria-expanded={!sidebar.tabsSectionCollapsed}
                  aria-controls="sidebar-tabs-content"
                  onClick={() =>
                    setSidebar((current) => ({
                      ...current,
                      tabsSectionCollapsed: !current.tabsSectionCollapsed,
                    }))
                  }
                >
                  打开的标签
                </button>
                <div id="sidebar-tabs-content">
                  {!sidebar.tabsSectionCollapsed && (
                    <TabList
                      tabs={controller.state.tabs}
                      activeId={controller.state.activeId}
                      onActivate={controller.activate}
                      onClose={closeTab}
                    />
                  )}
                </div>
              </section>
            )}
            {controller.workspace && (
              <section className="sidebar-section">
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
                  文件夹
                </button>
                <div id="sidebar-files-content">
                  {!sidebar.filesSectionCollapsed && (
                    <FileSidebar
                      root={controller.workspace}
                      port={port}
                      onOpenFile={(path) => void controller.openPath(path)}
                      onCloseWorkspace={controller.closeWorkspace}
                    />
                  )}
                </div>
              </section>
            )}
          </aside>
          </div>
          {!sidebar.collapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            aria-valuenow={sidebar.width}
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={SIDEBAR_MAX_WIDTH}
            tabIndex={0}
            className="sidebar-resizer"
            onPointerDown={startSidebarResize}
            onPointerMove={moveSidebarResize}
            onPointerUp={endSidebarResize}
            onPointerCancel={endSidebarResize}
            onKeyDown={onSidebarResizerKeyDown}
          />
          )}
          </>
        )}
        <div
          role={active ? "tabpanel" : undefined}
          id={active ? `document-panel-${active.id}` : undefined}
          aria-labelledby={
            active && activeTabVisible ? `document-tab-${active.id}` : undefined
          }
          className="editor-area"
        >
        {showPerfBanner && active && (
          <div role="status" className="perf-banner">
            <span className="perf-banner-text">
              大文档已切换到轻量模式：图片与公式渲染已暂停，文本内容不受影响。
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
        {active ? (
          <MarkdownEditor
            key={active.id}
            value={active.text}
            onChange={(text) => controller.changeText(active.id, text)}
            onSave={() => void controller.save(active.id)}
            onReopenClosed={reopenClosed}
            onToggleReading={() => controller.toggleReading(active.id)}
            viewMode={viewMode}
            documentPath={active.path}
            saveClipboardImage={(input) => port.saveClipboardImage(input)}
            resolveImageUrl={tauriImagePreviewUrl}
            imageDrop={imageDrop}
            onOutlineChange={(headings) => publishOutline(active.id, headings)}
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
            performanceMode={lightMode ? "light" : "full"}
          />
        ) : (
          <div role="region" aria-label="空白状态" className="empty-state">
            <p>打开 Markdown 文件或创建新文档。</p>
            <div className="empty-actions">
              <button type="button" onClick={controller.newDocument}>新建</button>
              <button type="button" onClick={() => void controller.openFiles()}>打开文件</button>
              <button type="button" onClick={openWorkspaceFromUser}>打开文件夹</button>
            </div>
            {controller.state.tabs.length === 0 && controller.recent.length > 0 && (
              <section aria-label="最近打开" className="recent-section">
                <h2 className="recent-title">最近打开</h2>
                <ul className="recent-list">
                  {controller.recent.map((item) => (
                    <li key={`${item.kind}:${item.path}`}>
                      <button
                        type="button"
                        aria-label={`${item.kind === "file" ? "文件" : "文件夹"} ${item.path}`}
                        onClick={() => openRecentFromUser(item)}
                      >
                        <span aria-hidden="true">{item.kind === "file" ? "📄 " : "📁 "}</span>
                        {item.path}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
        </div>
        {active && (
          <>
            {outlineOpen && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="调整大纲宽度"
                aria-valuenow={outline.width}
                aria-valuemin={SIDEBAR_MIN_WIDTH}
                aria-valuemax={SIDEBAR_MAX_WIDTH}
                tabIndex={0}
                className="outline-resizer"
                onPointerDown={startOutlineResize}
                onPointerMove={moveOutlineResize}
                onPointerUp={endOutlineResize}
                onPointerCancel={endOutlineResize}
                onKeyDown={onOutlineResizerKeyDown}
              />
            )}
            <div
              className="outline-rail"
              data-collapsed={!outlineOpen}
              style={{
                width: outlineOpen
                  ? outlineDragWidth ?? outline.width
                  : 0,
              }}
            >
              <aside
                id="app-outline"
                aria-label="大纲侧栏"
                aria-hidden={!outlineOpen ? true : undefined}
                inert={!outlineOpen ? true : undefined}
                className="outline-sidebar"
                style={{ width: outlineDragWidth ?? outline.width }}
              >
                <OutlinePanel
                  headings={activeOutline}
                  collapsedIds={activeCollapsedOutlineIds}
                  onToggle={(id) => toggleOutlineBranch(active.id, id)}
                  onCollapseAll={() =>
                    collapseAllOutlineBranches(active.id, activeOutline ?? [])
                  }
                  onNavigate={(heading) =>
                    navigateToOutlineHeading(active.id, heading)
                  }
                  onClose={() => setOutlineOpen(false)}
                />
              </aside>
            </div>
          </>
        )}
      </section>
      </div>

      {(controller.error || externalError) && (
        <div role="alert" className="app-alert">
          <span>{controller.error || externalError}</span>
          {!controller.error && externalError && onDismissExternalError && (
            <button type="button" aria-label="关闭错误提示" onClick={onDismissExternalError}>×</button>
          )}
        </div>
      )}

      {closing && (
        <div className="dialog-overlay">
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
            disabled={controller.closeSaving}
            onClick={() => void controller.confirmClose("save")}
          >
            {controller.closeSaving ? "保存中…" : "保存"}
          </button>
          <button type="button" disabled={controller.closeSaving} onClick={() => void controller.confirmClose("discard")}>放弃</button>
          <button type="button" disabled={controller.closeSaving} onClick={() => void controller.confirmClose("cancel")}>取消</button>
          </div>
        </div>
        </div>
      )}

      {saveErrorOpen && controller.saveError && (
        <div className="dialog-overlay">
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
          <button ref={retryButtonRef} type="button" onClick={controller.retrySave}>重试</button>
          <button type="button" onClick={controller.saveErrorSaveAs}>另存为…</button>
          <button type="button" onClick={controller.dismissSaveError}>取消</button>
          </div>
        </div>
        </div>
      )}

      {recoveryOpen && controller.recoveryDrafts && (
        <div className="dialog-overlay">
        <RecoveryDialog
          drafts={controller.recoveryDrafts}
          onRestore={(info) => void controller.restoreDraft(info)}
          onDiscard={(info) => void controller.discardRecoveryDraft(info)}
          readSource={async (draftId) => (await port.readDraft(draftId)).text}
        />
        </div>
      )}

      {conflictTab && (
        <div className="dialog-overlay">
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
        <div className="dialog-overlay">
        <SettingsDialog
          theme={controller.theme}
          editorPreferences={controller.editorPreferences}
          onThemeChange={controller.setTheme}
          onEditorPreferencesChange={controller.setEditorPreferences}
          onClose={() => setSettingsRequested(false)}
        />
        </div>
      )}
    </main>
  );
}
