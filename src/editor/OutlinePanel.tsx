import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  CollapseAllIcon,
  DisclosureChevronIcon,
  ExpandAllIcon,
  ListTreeIcon,
} from "../app/icons";
import { bindChevronSpreadHover } from "../motion/motionRuntime";
import {
  collectOutlineParentIds,
  type OutlineHeading,
} from "./outline";
import "./outlinePanel.css";

export interface OutlinePanelProps {
  readonly headings: ReadonlyArray<OutlineHeading> | null;
  readonly collapsedIds: ReadonlySet<string>;
  /** Id of the heading holding the current editor location, when known. */
  readonly activeId?: string | null;
  onToggle(id: string): void;
  onCollapseAll(): void;
  onExpandAll(): void;
  onNavigate(heading: OutlineHeading): void;
  readonly actions?: ReactNode;
}

interface OutlineRowsProps {
  readonly headings: ReadonlyArray<OutlineHeading>;
  readonly collapsedIds: ReadonlySet<string>;
  readonly activeId?: string | null;
  readonly collapsedAncestorId?: string | null;
  onToggle(id: string): void;
  onNavigate(heading: OutlineHeading): void;
  readonly root?: boolean;
}

function OutlineRows({
  headings,
  collapsedIds,
  activeId = null,
  collapsedAncestorId = null,
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
        const active = heading.id === activeId;
        const collapsedAncestor = heading.id === collapsedAncestorId;
        return (
          <li key={heading.id} role="none" className="outline-tree-node">
            <div
              className={
                active
                  ? "outline-tree-row outline-heading-active"
                  : "outline-tree-row"
              }
              data-motion-item="outline"
              data-level={heading.level}
              data-current-ancestor={collapsedAncestor ? "true" : undefined}
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
                aria-current={active ? "location" : undefined}
                aria-label={
                  collapsedAncestor
                    ? `${heading.text}，包含当前标题`
                    : undefined
                }
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
                activeId={activeId}
                collapsedAncestorId={collapsedAncestorId}
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

/** Root-to-heading id path, or null when the id is not in this outline. */
const findOutlinePath = (
  headings: ReadonlyArray<OutlineHeading>,
  id: string,
): ReadonlyArray<string> | null => {
  for (const heading of headings) {
    if (heading.id === id) return [heading.id];
    const childPath = findOutlinePath(heading.children, id);
    if (childPath) return [heading.id, ...childPath];
  }
  return null;
};

const cssPixels = (value: string): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const revealRowInContainer = (content: HTMLElement, rowElement: HTMLElement) => {
  const style = getComputedStyle(content);
  const view = content.getBoundingClientRect();
  const top = view.top + cssPixels(style.paddingTop);
  const bottom = view.bottom - cssPixels(style.paddingBottom);
  const row = rowElement.getBoundingClientRect();
  if (row.top < top) {
    content.scrollTop = Math.max(0, content.scrollTop - (top - row.top));
  } else if (row.bottom > bottom) {
    content.scrollTop += row.bottom - bottom;
  }
};

export default function OutlinePanel({
  headings,
  collapsedIds,
  onToggle,
  onCollapseAll,
  onExpandAll,
  onNavigate,
  activeId = null,
  actions,
}: OutlinePanelProps) {
  const parentIds =
    headings === null ? new Set<string>() : collectOutlineParentIds(headings);
  const allCollapsed =
    parentIds.size > 0 &&
    [...parentIds].every((id) => collapsedIds.has(id));
  const toggleAllLabel = allCollapsed ? "全部展开" : "全部折叠";

  const activePath = useMemo(
    () =>
      headings === null || activeId === null
        ? null
        : findOutlinePath(headings, activeId),
    [headings, activeId],
  );
  const resolvedActiveId =
    activePath === null ? null : activePath[activePath.length - 1];
  // The nearest visible ancestor whose collapse hides the current heading.
  // Only that row is marked; the tree never expands on its own, so following
  // the editor cannot reflow the panel underneath the user.
  const collapsedAncestorId = useMemo(() => {
    if (activePath === null) return null;
    for (const id of activePath.slice(0, -1)) {
      if (collapsedIds.has(id)) return id;
    }
    return null;
  }, [activePath, collapsedIds]);

  // Chevron spread hover on the collapse/expand-all toggle.
  const toggleAllRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const button = toggleAllRef.current;
    if (!button) return;
    return bindChevronSpreadHover(button);
  }, []);

  // Follow the current heading with the smallest possible scroll, and only
  // when it changes: re-renders and manual scrolling never pull the panel
  // back. When the current heading sits inside a collapsed branch its row is
  // absent, so the marked ancestor is revealed instead of expanding the tree.
  // The visible band excludes the content's padding, so scrolling up to the
  // first heading lands on scrollTop 0 and keeps the 8px breathing room.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const content = contentRef.current;
    const target =
      content?.querySelector<HTMLElement>(".outline-heading-active") ??
      content?.querySelector<HTMLElement>('[data-current-ancestor="true"]');
    if (!content || !target) return;
    revealRowInContainer(content, target);
  }, [resolvedActiveId, collapsedAncestorId]);

  const focusOutline = () => {
    const content = contentRef.current;
    if (!content) return;
    const targetButton =
      content.querySelector<HTMLButtonElement>(
        ".outline-heading-active .outline-heading-button",
      ) ??
      content.querySelector<HTMLButtonElement>(
        '[data-current-ancestor="true"] .outline-heading-button',
      ) ??
      content.querySelector<HTMLButtonElement>(".outline-heading-button");
    if (targetButton) {
      const row = targetButton.closest<HTMLElement>(".outline-tree-row");
      if (row) revealRowInContainer(content, row);
      targetButton.focus();
    } else {
      content.scrollTop = 0;
    }
  };

  return (
    <>
      <div className="outline-toolbar">
        <h2 className="visually-hidden">大纲</h2>
        <button
          type="button"
          className="icon-button outline-title-button"
          aria-label="大纲"
          title="大纲"
          onClick={focusOutline}
        >
          <ListTreeIcon />
        </button>
        {actions && <div className="outline-document-actions">{actions}</div>}
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
      <div
        ref={contentRef}
        className="outline-content"
        data-motion-list="outline"
      >
        {headings === null ? (
          <p className="outline-message" role="status">正在生成大纲…</p>
        ) : headings.length === 0 ? (
          <p className="outline-message">当前文档没有标题</p>
        ) : (
          <OutlineRows
            headings={headings}
            collapsedIds={collapsedIds}
            activeId={resolvedActiveId}
            collapsedAncestorId={collapsedAncestorId}
            onToggle={onToggle}
            onNavigate={onNavigate}
            root
          />
        )}
      </div>
    </>
  );
}
