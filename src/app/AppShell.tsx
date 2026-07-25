import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { DocumentPort } from "../document/DocumentPort";
import { tauriImagePreviewUrl, type ImageDrop } from "../document/tauriDocumentPort";
import type { RecentItem } from "../document/types";
import ConflictDialog from "../conflict/ConflictDialog";
import MarkdownEditor, { type EditorImageDrop } from "../editor/MarkdownEditor";
import { useAutomaticPerformanceMode } from "./usePerformanceMode";
import RecoveryDialog from "../recovery/RecoveryDialog";
import { useTheme } from "../theme/useTheme";
import FileSidebar from "../workspace/FileSidebar";
import SettingsDialog from "./SettingsDialog";
import TabList from "./TabList";
import { type EventSubscriber, useAppController } from "./useAppController";

export type ImageDropSubscriber = (
  onImages: (drop: ImageDrop) => void,
  signal?: AbortSignal,
) => Promise<() => void>;

export interface AppShellProps {
  port: DocumentPort;
  subscribeToEvents?: EventSubscriber | null;
  subscribeToImageDrops?: ImageDropSubscriber | null;
  externalError?: string | null;
  onDismissExternalError?: () => void;
}

export default function AppShell({
  port,
  subscribeToEvents = null,
  subscribeToImageDrops = null,
  externalError = null,
  onDismissExternalError,
}: AppShellProps) {
  const controller = useAppController(port, subscribeToEvents);
  useTheme(controller.theme, controller.editorPreferences);
  const sidebar = controller.sidebarPreferences;
  const setSidebar = controller.setSidebarPreferences;
  const sidebarAvailable =
    controller.state.tabs.length > 0 || controller.workspace !== null;
  // The tab element only exists when the sidebar and its tabs section are
  // both expanded; the tabpanel drops its label reference otherwise.
  const activeTabVisible =
    sidebarAvailable && !sidebar.collapsed && !sidebar.tabsSectionCollapsed;
  const [settingsRequested, setSettingsRequested] = useState(false);
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
    // Keyed on the open tab ids; the reducer's tab list is the source of truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabIdsKey]);
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
    if (event.shiftKey && key === "e") {
      event.preventDefault();
      controller.toggleSource(active.id);
      return;
    }
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
      <header aria-label="应用标题栏" className="app-header">
        <strong className="app-title">Markdown Edit</strong>
        {controller.state.tabs.length > 0 && (
          <>
            <button type="button" onClick={controller.newDocument}>新建</button>
            <button type="button" onClick={() => void controller.openFiles()}>打开文件</button>
            <button type="button" onClick={openWorkspaceFromUser}>打开文件夹</button>
            <button type="button" onClick={() => void controller.saveAs(active?.id)}>另存为…</button>
            {active && (
              <div role="group" aria-label="视图模式" className="view-mode-switch">
                {(["reading", "editing", "source"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={viewMode === mode}
                    onClick={() => controller.setViewMode(active.id, mode)}
                  >
                    {{ reading: "阅读", editing: "编辑", source: "源码" }[mode]}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {sidebarAvailable && sidebar.collapsed && (
          <button
            type="button"
            onClick={() => setSidebar((current) => ({ ...current, collapsed: false }))}
          >
            展开侧栏
          </button>
        )}
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
      </header>

      <section className="app-body">
        {sidebarAvailable && !sidebar.collapsed && (
          <aside aria-label="侧栏" className="sidebar">
            <div className="sidebar-actions">
              <button
                type="button"
                onClick={() => setSidebar((current) => ({ ...current, collapsed: true }))}
              >
                收起侧栏
              </button>
            </div>
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
            onToggleSource={() => controller.toggleSource(active.id)}
            viewMode={viewMode}
            documentPath={active.path}
            saveClipboardImage={(input) => port.saveClipboardImage(input)}
            resolveImageUrl={tauriImagePreviewUrl}
            imageDrop={imageDrop}
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
