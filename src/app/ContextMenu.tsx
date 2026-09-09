import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, KeyboardEvent } from "react";
import { useGSAP } from "@gsap/react";
import { animatePanelIntro } from "../motion/motionRuntime";

export type ContextMenuItem =
  | {
      id: string;
      label: string;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      onSelect: () => void;
    }
  | { type: "separator" };

export interface ContextMenuProps {
  position: { x: number; y: number };
  items: ReadonlyArray<ContextMenuItem>;
  onClose: () => void;
}

type MenuActionItem = Extract<ContextMenuItem, { id: string }>;

interface SavedFocusState {
  readonly element: HTMLElement | null;
  readonly range: Range | null;
}

const clampTextOffset = (node: Node, offset: number) =>
  node instanceof Text ? Math.min(offset, node.nodeValue?.length ?? 0) : offset;

/**
 * Re-asserts a range captured when the menu opened. Nodes that were removed
 * or rewritten while the menu was open make the restore a silent no-op; a
 * surviving range (the cell keeps its editing DOM while the menu is open)
 * is re-selected so the menu never eats the user's selection.
 */
const restoreSelectionRange = (saved: Range) => {
  const selection = document.getSelection();
  if (!selection) return;
  try {
    const startNode = saved.startContainer;
    const endNode = saved.endContainer;
    if (!startNode.isConnected || !endNode.isConnected) return;
    const range = document.createRange();
    range.setStart(startNode, clampTextOffset(startNode, saved.startOffset));
    range.setEnd(endNode, clampTextOffset(endNode, saved.endOffset));
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // The DOM shifted under the saved range; a stale restore must never
    // throw or clobber whatever selection the closing action produced.
  }
};

/**
 * Shared context menu rendered in a portal on `document.body`. Implements the
 * ARIA menu pattern: roving focus over the enabled items (arrow keys wrap,
 * Home/End jump, Enter/Space activate, Escape closes), closes on outside
 * pointerdown or window blur, and restores focus to the element that was
 * focused when the menu opened. The initial placement is the requested
 * position, flipped to the pointer's left/top side when it would run past the
 * viewport's right/bottom edge. Styling is intentionally left to the
 * integrator: the component only emits the `.context-menu*` class hooks plus
 * the inline fixed position; entry motion uses the same panel helper as the
 * file menu, which honors `prefers-reduced-motion`.
 */
export default function ContextMenu({ position, items, onClose }: ContextMenuProps) {
  const rootRef = useRef<HTMLUListElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [placement, setPlacement] = useState<CSSProperties>(() => ({
    position: "fixed",
    left: position.x,
    top: position.y,
  }));

  // Indices of actionable (non-separator, enabled) items; arrow navigation
  // and Home/End move only within this list, so disabled items and
  // separators are always skipped.
  const enabledIndices = useMemo(() => {
    const indices: number[] = [];
    items.forEach((item, index) => {
      if (!isActionItem(item) || item.disabled) return;
      indices.push(index);
    });
    return indices;
  }, [items]);

  const focusItem = (index: number) => {
    itemRefs.current[index]?.focus();
  };

  // Focus and DOM-selection state captured when the menu opened. An action
  // item restores both before its handler runs; closing without an action
  // restores them on unmount.
  const savedFocusRef = useRef<SavedFocusState>({ element: null, range: null });
  const activatedRef = useRef(false);

  const restoreFocusAndSelection = () => {
    const { element, range } = savedFocusRef.current;
    if (element?.isConnected) element.focus();
    if (range) restoreSelectionRange(range);
  };

  const selectItem = (index: number) => {
    const item = items[index];
    if (!item || !isActionItem(item) || item.disabled) return;
    activatedRef.current = true;
    restoreFocusAndSelection();
    item.onSelect();
    onClose();
  };

  // Measure once after mount and flip toward the pointer's left/up side when
  // the menu would overflow the viewport's right/bottom edge. Layout effects
  // run before paint, so the initial position never flashes.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const { innerWidth, innerHeight } = window;
    let { x, y } = position;
    if (x + rect.width > innerWidth) x = Math.max(0, x - rect.width);
    if (y + rect.height > innerHeight) y = Math.max(0, y - rect.height);
    setPlacement({ position: "fixed", left: x, top: y });
    // Position is fixed for the menu's lifetime; measure on open only.
  }, []);

  // Focus the first enabled item on open, remembering the element that had
  // focus and the DOM selection the menu opened over. On unmount, focus and
  // (unless an item was activated and produced its own state) the selection
  // are handed back, no matter how the menu closed. The previously focused
  // element is recorded inside the effect, so the StrictMode double-invoke
  // (setup → cleanup → setup) still ends with the pre-open element as the
  // restore target.
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const selection = document.getSelection();
    const savedRange =
      selection && selection.rangeCount > 0
        ? selection.getRangeAt(0).cloneRange()
        : null;
    savedFocusRef.current = { element: previouslyFocused, range: savedRange };
    activatedRef.current = false;
    const firstEnabled = enabledIndices[0];
    if (firstEnabled !== undefined) focusItem(firstEnabled);
    return () => {
      const { element, range } = savedFocusRef.current;
      if (element?.isConnected) element.focus();
      if (range && !activatedRef.current) restoreSelectionRange(range);
    };
  }, []);

  // Close on any interaction outside the menu and when the window blurs.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) {
        onClose();
      }
    };
    const onWindowBlur = () => onClose();
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [onClose]);

  // Entry motion shared with the file menu; the helper honors
  // prefers-reduced-motion.
  useGSAP(
    () => {
      const root = rootRef.current;
      if (root) animatePanelIntro(root);
    },
    { scope: rootRef },
  );

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (enabledIndices.length === 0) return;
    const focusedIndex = itemRefs.current.findIndex(
      (element) => element === document.activeElement,
    );
    const enabledPosition = enabledIndices.indexOf(focusedIndex);

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next =
        enabledPosition === -1
          ? step === 1
            ? 0
            : enabledIndices.length - 1
          : (enabledPosition + step + enabledIndices.length) % enabledIndices.length;
      focusItem(enabledIndices[next]);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusItem(enabledIndices[0]);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusItem(enabledIndices[enabledIndices.length - 1]);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (focusedIndex >= 0) selectItem(focusedIndex);
    }
  };

  return createPortal(
    <ul ref={rootRef} role="menu" className="context-menu" style={placement} onKeyDown={onKeyDown}>
      {items.map((item, index) =>
        isSeparator(item) ? (
          <li key={`separator-${index}`} role="separator" className="context-menu-separator" />
        ) : (
          <li key={item.id} role="none">
            <button
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              role="menuitem"
              className={`context-menu-item${item.danger ? " context-menu-item-danger" : ""}`}
              aria-disabled={item.disabled ?? false}
              disabled={item.disabled}
              tabIndex={-1}
              onClick={() => selectItem(index)}
            >
              {item.label}
              {item.shortcut !== undefined && (
                <span className="context-menu-shortcut">{item.shortcut}</span>
              )}
            </button>
          </li>
        ),
      )}
    </ul>,
    document.body,
  );
}

const isSeparator = (item: ContextMenuItem): item is { type: "separator" } =>
  "type" in item;

const isActionItem = (item: ContextMenuItem): item is MenuActionItem =>
  !isSeparator(item);