import {
  CollapseAllIcon,
  DisclosureChevronIcon,
} from "../app/icons";
import {
  collectOutlineParentIds,
  type OutlineHeading,
} from "./outline";

export interface OutlinePanelProps {
  readonly headings: ReadonlyArray<OutlineHeading> | null;
  readonly collapsedIds: ReadonlySet<string>;
  onToggle(id: string): void;
  onCollapseAll(): void;
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
  onNavigate,
}: OutlinePanelProps) {
  const parentIds =
    headings === null ? new Set<string>() : collectOutlineParentIds(headings);
  const collapseAllDisabled =
    parentIds.size === 0 ||
    [...parentIds].every((id) => collapsedIds.has(id));

  return (
    <>
      <div className="outline-toolbar">
        <h2>大纲</h2>
        <button
          type="button"
          className="outline-icon-button outline-collapse-all"
          aria-label="全部折叠"
          title="全部折叠"
          disabled={collapseAllDisabled}
          onClick={onCollapseAll}
        >
          <CollapseAllIcon />
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
