import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { DocumentPort } from "../document/DocumentPort";
import { tauriImagePreviewUrl, type ImageDrop } from "../document/tauriDocumentPort";
import ConflictDialog from "../conflict/ConflictDialog";
import MarkdownEditor, { type EditorImageDrop } from "../editor/MarkdownEditor";
import RecoveryDialog from "../recovery/RecoveryDialog";
import FileSidebar from "../workspace/FileSidebar";
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
  const [sourceMode, setSourceMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  const closing = controller.state.tabs.find(
    (tab) => tab.id === controller.closeDocumentId,
  );
  // Only one modal at a time, in priority order: the close confirmation, the
  // save-failure dialog, the launch recovery flow, then a per-tab conflict.
  const conflictTab =
    !closing && !controller.saveError && active?.status === "conflict"
      ? active
      : null;
  const recoveryOpen =
    !closing && !controller.saveError && !conflictTab &&
    Boolean(controller.recoveryDrafts?.length);
  const saveErrorOpen = !closing && Boolean(controller.saveError);
  const anyDialogOpen = Boolean(closing || saveErrorOpen || recoveryOpen || conflictTab);

  // Opening a workspace always reveals the drawer; it stays manually
  // collapsible afterwards.
  useEffect(() => {
    if (workspacePath) setSidebarCollapsed(false);
  }, [workspacePath]);

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

  const closeTab = (id: string) => {
    const document = controller.state.tabs.find((tab) => tab.id === id);
    if (document?.status === "clean" && !document.pendingSave) {
      pendingTabFocusRef.current = "close";
    }
    controller.close(id);
  };

  const onShellKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (anyDialogOpen) return;
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "t") return;
    if ((event.target as HTMLElement).closest(".cm-editor")) return;
    event.preventDefault();
    reopenClosed();
  };

  useEffect(() => {
    if (!pendingTabFocusRef.current) return;
    pendingTabFocusRef.current = null;
    const target = controller.state.activeId
      ? document.getElementById(`document-tab-${controller.state.activeId}`)
      : document.querySelector<HTMLElement>('[aria-label="空白状态"] button');
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
    if (recoveryOpen || conflictTab) {
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
  }, [closing, controller.closeSaving, saveErrorOpen, recoveryOpen, conflictTab]);

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

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const tabs = controller.state.tabs;
    let targetIndex: number | null = null;
    if (event.key === "ArrowLeft") targetIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "ArrowRight") targetIndex = (index + 1) % tabs.length;
    if (event.key === "Home") targetIndex = 0;
    if (event.key === "End") targetIndex = tabs.length - 1;
    if (targetIndex === null) return;
    event.preventDefault();
    controller.activate(tabs[targetIndex].id);
    const tabButtons = event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabButtons?.[targetIndex]?.focus();
  };

  return (
    <main
      ref={shellRef}
      tabIndex={-1}
      onKeyDown={onShellKeyDown}
      style={{ display: "grid", gridTemplateRows: "auto auto 1fr", minHeight: "100vh" }}
    >
      <div
        data-testid="app-background"
        inert={anyDialogOpen ? true : undefined}
        aria-hidden={anyDialogOpen ? true : undefined}
        style={{ display: "contents" }}
      >
      <header aria-label="应用标题栏" style={{ display: "flex", gap: 8, padding: 8 }}>
        <strong style={{ marginRight: "auto" }}>Markdown Edit</strong>
        {controller.state.tabs.length > 0 && (
          <>
            <button type="button" onClick={controller.newDocument}>新建</button>
            <button type="button" onClick={() => void controller.openFiles()}>打开文件</button>
            <button type="button" onClick={() => void controller.openWorkspace()}>打开文件夹</button>
            <button type="button" onClick={() => void controller.saveAs(active?.id)}>另存为…</button>
            <button
              type="button"
              aria-label="实时预览"
              aria-pressed={!sourceMode}
              onClick={() => setSourceMode((current) => !current)}
            >
              {sourceMode ? "源码模式" : "实时预览"}
            </button>
          </>
        )}
        {controller.workspace && sidebarCollapsed && (
          <button type="button" onClick={() => setSidebarCollapsed(false)}>展开侧栏</button>
        )}
      </header>

      {controller.state.tabs.length > 0 && (
        <div role="tablist" aria-label="打开的文档" style={{ display: "flex", gap: 4, padding: "0 8px" }}>
          {controller.state.tabs.map((tab, index) => (
            <div key={tab.id} style={{ display: "flex" }}>
              <button
                type="button"
                role="tab"
                id={`document-tab-${tab.id}`}
                aria-selected={tab.id === controller.state.activeId}
                aria-controls={`document-panel-${tab.id}`}
                tabIndex={tab.id === controller.state.activeId ? 0 : -1}
                onClick={() => controller.activate(tab.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
              >
                {tab.title}
                {tab.status !== "clean" && (
                  <>
                    <span aria-hidden="true"> ●</span>
                    <span style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}> 未保存</span>
                  </>
                )}
              </button>
              <button
                type="button"
                aria-label={`关闭 ${tab.title}`}
                disabled={Boolean(tab.pendingSave)}
                onClick={() => closeTab(tab.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <section
        role={active ? "tabpanel" : undefined}
        id={active ? `document-panel-${active.id}` : undefined}
        aria-labelledby={active ? `document-tab-${active.id}` : undefined}
        style={{ minHeight: 0, padding: 8, display: "flex", gap: 8 }}
      >
        {controller.workspace && !sidebarCollapsed && (
          <aside
            aria-label="文件侧栏"
            style={{ width: 260, minWidth: 220, maxWidth: 320, display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}
          >
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setSidebarCollapsed(true)}>收起侧栏</button>
            </div>
            <FileSidebar
              root={controller.workspace}
              port={port}
              onOpenFile={(path) => void controller.openPath(path)}
              onCloseWorkspace={controller.closeWorkspace}
            />
          </aside>
        )}
        <div style={{ flex: 1, minWidth: 0, display: "grid" }}>
        {active ? (
          <MarkdownEditor
            key={active.id}
            value={active.text}
            onChange={(text) => controller.changeText(active.id, text)}
            onSave={() => void controller.save(active.id)}
            onReopenClosed={reopenClosed}
            sourceMode={sourceMode}
            documentPath={active.path}
            saveClipboardImage={(input) => port.saveClipboardImage(input)}
            resolveImageUrl={tauriImagePreviewUrl}
            imageDrop={imageDrop}
          />
        ) : (
          <div aria-label="空白状态" style={{ display: "grid", placeItems: "center", gap: 12 }}>
            <p>打开 Markdown 文件或创建新文档。</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={controller.newDocument}>新建</button>
              <button type="button" onClick={() => void controller.openFiles()}>打开文件</button>
              <button type="button" onClick={() => void controller.openWorkspace()}>打开文件夹</button>
            </div>
            {controller.state.tabs.length === 0 && controller.recent.length > 0 && (
              <section aria-label="最近打开" style={{ display: "grid", gap: 4 }}>
                <h2 style={{ fontSize: "inherit", margin: 0 }}>最近打开</h2>
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
                  {controller.recent.map((item) => (
                    <li key={`${item.kind}:${item.path}`}>
                      <button
                        type="button"
                        aria-label={`${item.kind === "file" ? "文件" : "文件夹"} ${item.path}`}
                        onClick={() => void controller.openRecent(item)}
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
        <div role="alert">
          <span>{controller.error || externalError}</span>
          {!controller.error && externalError && onDismissExternalError && (
            <button type="button" aria-label="关闭错误提示" onClick={onDismissExternalError}>×</button>
          )}
        </div>
      )}

      {closing && (
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
      )}

      {saveErrorOpen && controller.saveError && (
        <div
          role="dialog"
          tabIndex={-1}
          aria-modal="true"
          aria-labelledby="save-error-dialog-title"
          onKeyDown={onSaveErrorKeyDown}
        >
          <h2 id="save-error-dialog-title">保存失败</h2>
          <p>{controller.saveError.message}</p>
          <button ref={retryButtonRef} type="button" onClick={controller.retrySave}>重试</button>
          <button type="button" onClick={controller.saveErrorSaveAs}>另存为…</button>
          <button type="button" onClick={controller.dismissSaveError}>取消</button>
        </div>
      )}

      {recoveryOpen && controller.recoveryDrafts && (
        <RecoveryDialog
          drafts={controller.recoveryDrafts}
          onRestore={(info) => void controller.restoreDraft(info)}
          onDiscard={(info) => void controller.discardRecoveryDraft(info)}
          readSource={async (draftId) => (await port.readDraft(draftId)).text}
        />
      )}

      {conflictTab && (
        <ConflictDialog
          title={conflictTab.title}
          path={conflictTab.path}
          onLoadDisk={() => void controller.loadDiskVersion(conflictTab.id)}
          onKeepLocal={() => controller.keepLocalVersion(conflictTab.id)}
          onSaveAs={() => void controller.saveAs(conflictTab.id)}
        />
      )}
    </main>
  );
}
