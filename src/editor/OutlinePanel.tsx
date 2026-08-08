import { useEffect, useRef } from "react";
import {
  CollapseAllIcon,
  DisclosureChevronIcon,
  ExpandAllIcon,
} from "../app/icons";
import { bindChevronSpreadHover } from "../motion/motionRuntime";
import {
  collectOutlineParentIds,
  type OutlineHeading,
} from "./outline";

export interface OutlinePanelProps {
  readonly headings: ReadonlyArray<OutlineHeading> | null;
  readonly collapsedIds: ReadonlySet<string>;
  onToggle(id: string): void;
  onCollapseAll(): void;
  onExpandAll(): void;
  onNavigate(heading: OutlineHeading): void;
}

interface OutlineRowsProps {
  readonly headings: ReadonlyArray<OutlineHeading>;
  readonly collapsedIds: ReadonlySet<string>;
  onToggle(id: string): void;
  onNavigate(heading: OutlineHeading): void;
  readonly root?: boolean;
}

function OutlineRows({
  headings,
  collapsedIds,
  onToggle,
  onNavigate,
  root = false,
}: OutlineRowsProps) {
  return (
    <ul
      className={root ? "outline-tree" : "outline-tree-group"}
      role={root ? "tree" : "group"}
      aria-label={root ? "文档大纲" : undefined}
    >
      {headings.map((heading) => {
        const expandable = heading.children.length > 0;
        const expanded = expandable && !collapsedIds.has(heading.id);
        return (
          <li key={heading.id} role="none" className="outline-tree-node">
            <div
              className="outline-tree-row"
              data-motion-item="outline"
              data-level={heading.level}
            >
              {expandable ? (
                <button
                  type="button"
                  className="outline-disclosure"
                  aria-label={`${expanded ? "收起" : "展开"} ${heading.text}`}
                  aria-expanded={expanded}
                  onClick={() => onToggle(heading.id)}
                >
                  <span data-expanded={expanded}>
                    <DisclosureChevronIcon />
                  </span>
                </button>
              ) : (
                <span className="outline-disclosure-spacer" aria-hidden="true" />
              )}
              <button
                type="button"
                className="outline-heading-button"
                role="treeitem"
                aria-level={heading.level}
                title={heading.text}
                onClick={() => onNavigate(heading)}
              >
                {heading.text}
              </button>
            </div>
            {expanded && (
              <OutlineRows
                headings={heading.children}
                collapsedIds={collapsedIds}
                onToggle={onToggle}
                onNavigate={onNavigate}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function OutlinePanel({
  headings,
  collapsedIds,
  onToggle,
  onCollapseAll,
  onExpandAll,
  onNavigate,
}: OutlinePanelProps) {
  const parentIds =
    headings === null ? new Set<string>() : collectOutlineParentIds(headings);
  const allCollapsed =
    parentIds.size > 0 &&
    [...parentIds].every((id) => collapsedIds.has(id));
  const toggleAllLabel = allCollapsed ? "全部展开" : "全部折叠";

  // Chevron spread hover on the collapse/expand-all toggle.
  const toggleAllRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const button = toggleAllRef.current;
    if (!button) return;
    return bindChevronSpreadHover(button);
  }, []);

  return (
    <>
      <div className="outline-toolbar">
        <h2>大纲</h2>
        <button
          ref={toggleAllRef}
          type="button"
          className="outline-icon-button outline-collapse-all"
          aria-label={toggleAllLabel}
          aria-pressed={allCollapsed}
          title={toggleAllLabel}
          disabled={parentIds.size === 0}
          onClick={allCollapsed ? onExpandAll : onCollapseAll}
        >
          {allCollapsed ? <ExpandAllIcon /> : <CollapseAllIcon />}
        </button>
      </div>
      <div className="outline-content" data-motion-list="outline">
        {headings === null ? (
          <p className="outline-message" role="status">正在生成大纲…</p>
        ) : headings.length === 0 ? (
          <p className="outline-message">当前文档没有标题</p>
        ) : (
          <OutlineRows
            headings={headings}
            collapsedIds={collapsedIds}
            onToggle={onToggle}
            onNavigate={onNavigate}
            root
          />
        )}
      </div>
    </>
  );
}
