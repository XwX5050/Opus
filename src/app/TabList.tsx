import type { KeyboardEvent } from "react";
import type { DocumentSnapshot } from "../document/types";

export interface TabListProps {
  tabs: ReadonlyArray<DocumentSnapshot>;
  activeId: string | null;
  onActivate(id: string): void;
  onClose(id: string): void;
}

/**
 * Vertical tab list rendered inside the sidebar. Keeps the same ARIA wiring
 * as the old horizontal strip (stable `document-tab-*` ids, roving tabindex),
 * with the vertical-tablist arrow keys (Up/Down instead of Left/Right).
 */
export default function TabList({ tabs, activeId, onActivate, onClose }: TabListProps) {
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (tabs.length === 0) return;
    let targetIndex: number | null = null;
    if (event.key === "ArrowUp") targetIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "ArrowDown") targetIndex = (index + 1) % tabs.length;
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
      aria-orientation="vertical"
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
        </div>
      ))}
    </div>
  );
}
