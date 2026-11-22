import { useEffect, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { DocumentSnapshot } from "../document/types";

/**
 * The fields a document tab renders. The props deliberately carry no
 * document text: a whole `DocumentSnapshot` would route every open document's
 * body through this component's props on each keystroke — and React's
 * development build stringifies changed string props during its per-commit
 * component-performance track, which measures as an O(document size) cost per
 * keystroke (see docs/performance.md).
 */
export type TabListItem = Pick<
  DocumentSnapshot,
  "id" | "title" | "status" | "pendingSave"
>;

export interface TabListProps {
  tabs: ReadonlyArray<TabListItem>;
  activeId: string | null;
  onActivate(id: string): void;
  onClose(id: string): void;
  onCreate(): void;
  /**
   * Called with the tab id and the right-click event after the tab button
   * handled it (preventDefault + stopPropagation), so the host can open its
   * own context menu without the shell fallback also firing.
   */
  onTabContextMenu?(tabId: string, event: ReactMouseEvent): void;
}

/** Horizontal document tabs with roving focus and a single-row overflow strip. */
export default function TabList({ tabs, activeId, onActivate, onClose, onCreate, onTabContextMenu }: TabListProps) {
  useEffect(() => {
    if (!activeId) return;
    document.getElementById(`document-tab-${activeId}`)?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeId]);

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (tabs.length === 0) return;
    let targetIndex: number | null = null;
    if (event.key === "ArrowLeft") targetIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "ArrowRight") targetIndex = (index + 1) % tabs.length;
    if (event.key === "Home") targetIndex = 0;
    if (event.key === "End") targetIndex = tabs.length - 1;
    if (targetIndex === null) return;
    event.preventDefault();
    onActivate(tabs[targetIndex].id);
    const tabButtons = event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabButtons?.[targetIndex]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="打开的文档"
      aria-orientation="horizontal"
      className="tab-list"
      data-motion-list="tabs"
    >
      {tabs.map((tab, index) => (
        <div key={tab.id} className="tab-item">
          <button
            type="button"
            role="tab"
            id={`document-tab-${tab.id}`}
            className="tab"
            data-motion-item="tab"
            aria-selected={tab.id === activeId}
            aria-controls={`document-panel-${tab.id}`}
            tabIndex={tab.id === activeId ? 0 : -1}
            onClick={() => onActivate(tab.id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onTabContextMenu?.(tab.id, event);
            }}
          >
            {tab.title}
            {tab.status !== "clean" && (
              <>
                <span
                  aria-hidden="true"
                  className={`tab-dirty${tab.status === "conflict" ? " tab-dirty-conflict" : ""}${tab.status === "missing" ? " tab-dirty-missing" : ""}`}
                >
                  {" ●"}
                </span>
                <span className="visually-hidden">
                  {tab.status === "conflict"
                    ? " 冲突"
                    : tab.status === "missing"
                      ? " 文件缺失"
                      : " 未保存"}
                </span>
              </>
            )}
          </button>
          <button
            type="button"
            className="tab-close"
            aria-label={`关闭 ${tab.title}`}
            disabled={Boolean(tab.pendingSave)}
            onClick={() => onClose(tab.id)}
          >
            ×
          </button>
          {index === tabs.length - 1 && (
            <button
              type="button"
              className="tab-create"
              aria-label="新建文件"
              title="新建文件"
              onClick={onCreate}
            >
              +
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
