import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WINDOW_WIDTH_FRACTION,
} from "../document/types";
import type { OutlineHeading } from "../editor/outline";
import { EDITOR_PREFERENCE_LIMITS } from "../theme/preferences";

/**
 * Shell layout refinements: keeping the reading column usable when side
 * panels are open, and deriving lightweight scroll state (compact document
 * title + the heading the reader is currently under).
 *
 * Two panel layers exist for the explorer:
 *
 * - the persisted preference (`sidebarCollapsed` / `sidebarWidth`), owned by
 *   the user and written only by explicit user actions;
 * - `sidebarAutoHidden`, a runtime-only flag the shell sets when the window
 *   cannot hold the explorer beside a usable editor. It never touches the
 *   preference, so restarting at a wide window restores the panel.
 *
 * Displayed widths are derived from the preferences and the window width;
 * they are clamped so the editor always keeps at least `EDITOR_MIN_WIDTH`.
 */

export const SHELL_ACTIVITY_RAIL_WIDTH = 36;

/**
 * The smallest editor column the shell accepts before it starts reclaiming
 * space from the side panels. Narrower columns cannot hold a full line of
 * body text next to the gutter and make tabs look truncated. Keep this in
 * sync with the `.editor-column` floor in shellRefinements.css.
 */
export const EDITOR_MIN_WIDTH = 320;

/**
 * Extra room required before an automatically hidden panel is restored.
 * Hiding and restoring use different thresholds so a window that sits on the
 * boundary cannot oscillate between the two states.
 */
const PANEL_RESTORE_MARGIN = 32;

/** Scroll distances at which the document title folds away and comes back. */
const TITLE_COMPACT_AT = 72;
const TITLE_RESTORE_AT = 16;

export interface PanelLayoutSnapshot {
  readonly windowWidth: number;
  /** The user's preferred width; displayed width may be smaller. */
  readonly sidebarWidth: number;
  /** The user's persisted collapse preference. */
  readonly sidebarCollapsed: boolean;
  /** Runtime-only: the shell hid the explorer because the window is narrow. */
  readonly sidebarAutoHidden: boolean;
  /** The user's preferred outline width; displayed width may be smaller. */
  readonly outlineWidth: number;
  readonly outlineOpen: boolean;
}

export interface PanelDisplayState {
  /** Horizontal room for panels: window minus the rail and editor floor. */
  readonly room: number;
  readonly sidebarVisible: boolean;
  readonly sidebarWidth: number;
  readonly outlineVisible: boolean;
  readonly outlineWidth: number;
}

/** Room the side panels may occupy without breaking the editor floor. */
export const panelRoomOf = (windowWidth: number): number =>
  Math.max(0, windowWidth - SHELL_ACTIVITY_RAIL_WIDTH - EDITOR_MIN_WIDTH);

/**
 * The widest a panel may be dragged/resized to while another panel is
 * visible: it must leave the activity rail and the editor floor untouched.
 */
export const panelWidthLimit = (
  windowWidth: number,
  otherPanelWidth: number,
): number =>
  Math.max(0, panelRoomOf(windowWidth) - Math.max(0, otherPanelWidth));

/**
 * Effective panel widths for the current render. The explorer is visible when
 * the user expanded it and the runtime space-hide is clear; both panels are
 * clamped so their combined width never eats into the editor floor. A panel
 * that cannot keep its own minimum width is left to the layout guard, which
 * hides it before paint.
 */
export const resolvePanelDisplayWidths = (
  snapshot: PanelLayoutSnapshot,
): PanelDisplayState => {
  const room = panelRoomOf(snapshot.windowWidth);
  const sidebarVisible =
    !snapshot.sidebarCollapsed && !snapshot.sidebarAutoHidden;
  const sidebarWidth = sidebarVisible
    ? Math.min(snapshot.sidebarWidth, room)
    : 0;
  const outlineVisible = snapshot.outlineOpen;
  const outlineWidth = outlineVisible
    ? Math.min(snapshot.outlineWidth, Math.max(0, room - sidebarWidth))
    : 0;
  return { room, sidebarVisible, sidebarWidth, outlineVisible, outlineWidth };
};

/**
 * The maximum value for a drag/keyboard resize of one panel: the window
 * fraction cap, the absolute maximum, and the space left by the other panel
 * and the editor floor. May be below `SIDEBAR_MIN_WIDTH` when the current
 * layout cannot hold both panels; callers must then refuse the resize
 * instead of shrinking a panel below its minimum.
 */
export const panelMaxWidth = (
  windowWidth: number,
  otherPanelWidth: number,
): number => {
  const fractionCap = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.round(windowWidth * SIDEBAR_WINDOW_WIDTH_FRACTION),
  );
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    fractionCap,
    panelWidthLimit(windowWidth, otherPanelWidth),
  );
};

/** Clamp a drag/keyboard width into [panel minimum, max]. */
export const clampPanelResizeWidth = (
  width: number,
  maxWidth: number,
): number =>
  Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxWidth, Math.round(width)));

/** Minimum horizontal inset reserved on each side of the reading column. */
export const CONTENT_WIDTH_EDGE_MARGIN = 24;

/** Horizontal width available to the editor column beside any open panels. */
export const editorColumnWidthOf = (
  windowWidth: number,
  sidebarWidth: number,
  outlineWidth: number,
): number =>
  Math.max(
    0,
    windowWidth -
      SHELL_ACTIVITY_RAIL_WIDTH -
      Math.max(0, sidebarWidth) -
      Math.max(0, outlineWidth),
  );

/** Widest reading-column width that still leaves margin on both sides. */
export const contentWidthMax = (editorColumnWidth: number): number =>
  Math.min(
    EDITOR_PREFERENCE_LIMITS.contentWidthPx.max,
    Math.max(0, Math.floor(editorColumnWidth - CONTENT_WIDTH_EDGE_MARGIN * 2)),
  );

/** Clamp a drag/keyboard reading-column width into [min, maxWidth]. */
export const clampContentResizeWidth = (
  width: number,
  maxWidth: number,
): number =>
  Math.max(
    EDITOR_PREFERENCE_LIMITS.contentWidthPx.min,
    Math.min(maxWidth, Math.round(width)),
  );

export interface PanelLayoutMemory {
  /** True while the outline is closed because the shell reclaimed it. */
  readonly outline: boolean;
}

export interface SettledPanelLayout {
  readonly sidebarAutoHidden: boolean;
  readonly outlineOpen: boolean;
  readonly autoOutline: boolean;
}

export interface SettleOptions {
  /**
   * Restore automatically hidden panels when the window is wide enough
   * again. Only window resizes (and the initial mount) pass true; a panel
   * width change must never resurrect a panel the user just sized.
   */
  readonly allowRestore: boolean;
}

/**
 * Resolves the panel visibility for one window width.
 *
 * Collapsing follows the required priority: the outline is reclaimed first
 * (when both panels' preferred widths no longer fit), then the explorer —
 * and the explorer only when even its minimum width would leave no room for
 * the editor. Widths beyond the available room are clamped by the display
 * resolver before this runs, so a wide persisted panel does not force a hide;
 * it is simply displayed narrower until the window grows.
 *
 * The function is idempotent: feeding its own result back produces the same
 * state, and a restore only happens when the preferred layout fits with the
 * hysteresis margin, so no resize loop is possible.
 */
export const settlePanelLayout = (
  snapshot: PanelLayoutSnapshot,
  memory: PanelLayoutMemory,
  options: SettleOptions,
): SettledPanelLayout => {
  let sidebarAutoHidden = snapshot.sidebarCollapsed
    ? false
    : snapshot.sidebarAutoHidden;
  let outlineOpen = snapshot.outlineOpen;
  let autoOutline = memory.outline;
  const room = panelRoomOf(snapshot.windowWidth);
  const sidebarWanted = !snapshot.sidebarCollapsed;
  const sidebarVisible = sidebarWanted && !sidebarAutoHidden;
  const sidebarDisplay = sidebarVisible
    ? Math.min(snapshot.sidebarWidth, room)
    : 0;

  // Reclaim the outline first: both preferred widths no longer fit, or what
  // is left beside the explorer cannot hold the outline's minimum width.
  if (outlineOpen) {
    const outlineAvailable = room - sidebarDisplay;
    const bothPreferredFit = sidebarVisible
      ? snapshot.sidebarWidth + snapshot.outlineWidth <= room
      : true;
    if (!bothPreferredFit || outlineAvailable < SIDEBAR_MIN_WIDTH) {
      outlineOpen = false;
      autoOutline = true;
    }
  }
  // Then the explorer, only when it cannot keep its own minimum width.
  if (sidebarWanted && !sidebarAutoHidden && room < SIDEBAR_MIN_WIDTH) {
    sidebarAutoHidden = true;
  }
  if (outlineOpen) autoOutline = false;

  if (!options.allowRestore) {
    return { sidebarAutoHidden, outlineOpen, autoOutline };
  }

  // Restore in reverse priority: the explorer (hidden last) first, then the
  // outline. Both restores require the preferred layout to fit with the
  // hysteresis margin, so the next (restore-disabled) settle cannot hide the
  // panel again immediately.
  if (sidebarAutoHidden && sidebarWanted) {
    const bothFit =
      !outlineOpen ||
      snapshot.sidebarWidth + snapshot.outlineWidth + PANEL_RESTORE_MARGIN <=
        room;
    if (room >= SIDEBAR_MIN_WIDTH + PANEL_RESTORE_MARGIN && bothFit) {
      sidebarAutoHidden = false;
    }
  }
  const restoredSidebarVisible = sidebarWanted && !sidebarAutoHidden;
  const restoredSidebarWidth = restoredSidebarVisible
    ? Math.min(snapshot.sidebarWidth, room)
    : 0;
  if (autoOutline && !outlineOpen) {
    const bothFit =
      !restoredSidebarVisible ||
      snapshot.sidebarWidth + snapshot.outlineWidth + PANEL_RESTORE_MARGIN <=
        room;
    if (
      room - restoredSidebarWidth >=
        SIDEBAR_MIN_WIDTH + PANEL_RESTORE_MARGIN &&
      bothFit
    ) {
      outlineOpen = true;
      autoOutline = false;
    }
  }

  return { sidebarAutoHidden, outlineOpen, autoOutline };
};

export interface PanelLayoutGuardOptions {
  readonly windowWidth: number;
  readonly sidebarWidth: number;
  readonly sidebarCollapsed: boolean;
  readonly sidebarAutoHidden: boolean;
  readonly outlineWidth: number;
  readonly outlineOpen: boolean;
  hideSidebar(): void;
  showSidebar(): void;
  closeOutline(): void;
  openOutline(): void;
}

export interface PanelLayoutGuard {
  /** The user toggled the outline; stop auto-restoring it. */
  noteManualOutlineToggle(): void;
}

/**
 * Tracks the window width (rAF-throttled) so panel geometry re-renders with
 * the live window instead of waiting for a panel visibility change.
 */
export const useWindowWidth = (): number => {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  useLayoutEffect(() => {
    let frame: number | null = null;
    const update = () => {
      frame = null;
      setWidth(window.innerWidth);
    };
    const schedule = () => {
      if (frame !== null) return;
      if (typeof requestAnimationFrame === "function") {
        frame = requestAnimationFrame(update);
      } else {
        update();
      }
    };
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("resize", schedule);
      if (frame !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frame);
      }
    };
  }, []);
  return width;
};

/**
 * Settles panel visibility on window resizes and on late-arriving layout
 * inputs (a session restored after mount, a manually opened panel, a panel
 * width commit). Restores only run when the window width itself changed, so a
 * panel drag never resurrects a panel and cannot loop with the resize path.
 */
export const usePanelLayoutGuard = (
  options: PanelLayoutGuardOptions,
): PanelLayoutGuard => {
  const latest = useRef(options);
  latest.current = options;
  const memory = useRef<PanelLayoutMemory>({ outline: false });
  const previousWidth = useRef<number | null>(null);

  useLayoutEffect(() => {
    const current = latest.current;
    if (!Number.isFinite(current.windowWidth) || current.windowWidth <= 0) {
      return;
    }
    const previous = previousWidth.current;
    previousWidth.current = current.windowWidth;
    const allowRestore = previous === null || previous !== current.windowWidth;
    const settled = settlePanelLayout(
      {
        windowWidth: current.windowWidth,
        sidebarWidth: current.sidebarWidth,
        sidebarCollapsed: current.sidebarCollapsed,
        sidebarAutoHidden: current.sidebarAutoHidden,
        outlineWidth: current.outlineWidth,
        outlineOpen: current.outlineOpen,
      },
      memory.current,
      { allowRestore },
    );
    memory.current = { outline: settled.autoOutline };
    if (settled.sidebarAutoHidden !== current.sidebarAutoHidden) {
      if (settled.sidebarAutoHidden) current.hideSidebar();
      else current.showSidebar();
    }
    if (settled.outlineOpen !== current.outlineOpen) {
      if (settled.outlineOpen) current.openOutline();
      else current.closeOutline();
    }
  }, [
    options.windowWidth,
    options.sidebarWidth,
    options.sidebarCollapsed,
    options.sidebarAutoHidden,
    options.outlineWidth,
    options.outlineOpen,
  ]);

  return useMemo(
    () => ({
      noteManualOutlineToggle: () => {
        memory.current = { outline: false };
      },
    }),
    [],
  );
};

export const flattenOutline = (
  headings: ReadonlyArray<OutlineHeading> | null,
): ReadonlyArray<OutlineHeading> => {
  if (headings === null || headings.length === 0) return [];
  const flat: OutlineHeading[] = [];
  const visit = (items: ReadonlyArray<OutlineHeading>) => {
    for (const heading of items) {
      flat.push(heading);
      visit(heading.children);
    }
  };
  visit(headings);
  return flat;
};

/**
 * Id of the last heading at or above the given document offset — the section
 * the reader is currently inside. Offsets of a collapsed branch still count;
 * collapsing the outline is a display choice, not a scroll position.
 */
export const activeHeadingIdAt = (
  headings: ReadonlyArray<OutlineHeading>,
  offset: number,
): string | null => {
  let active: string | null = null;
  for (const heading of headings) {
    if (heading.from > offset) break;
    active = heading.id;
  }
  return active;
};

export interface EditorScrollState {
  readonly titleCompact: boolean;
  readonly activeHeadingId: string | null;
}

const INITIAL_SCROLL_STATE: EditorScrollState = {
  titleCompact: false,
  activeHeadingId: null,
};

/**
 * Tracks the live editor's scroll position. The title folds away once the
 * document has scrolled past it and returns near the top (with hysteresis so
 * a scroll that hovers at the boundary cannot flicker); the active heading
 * follows the first line in the viewport.
 *
 * The title is only measured with a fresh `initial` reset when the editor
 * view changes. Re-publishing the outline (every heading edit) updates the
 * active heading alone, so typing inside the 16–72px hysteresis band does
 * not pop the title back open.
 */
export const useEditorScrollState = (
  view: EditorView | null,
  headings: ReadonlyArray<OutlineHeading> | null,
): EditorScrollState => {
  const flatHeadings = useMemo(() => flattenOutline(headings), [headings]);
  const flatHeadingsRef = useRef(flatHeadings);
  flatHeadingsRef.current = flatHeadings;
  const measureActiveRef = useRef<(() => void) | null>(null);
  const [state, setState] = useState<EditorScrollState>(INITIAL_SCROLL_STATE);

  useLayoutEffect(() => {
    if (!view) {
      setState((current) =>
        current === INITIAL_SCROLL_STATE ? current : INITIAL_SCROLL_STATE,
      );
      return;
    }
    const scroller = view.scrollDOM;
    let frame: number | null = null;
    const offsetAtTop = (): number => {
      const scrollTop = Math.max(0, scroller.scrollTop);
      try {
        return view.lineBlockAtHeight(scrollTop).from;
      } catch {
        return 0;
      }
    };
    const measureActive = () => {
      const activeHeadingId = activeHeadingIdAt(
        flatHeadingsRef.current,
        offsetAtTop(),
      );
      setState((current) =>
        current.activeHeadingId === activeHeadingId
          ? current
          : { ...current, activeHeadingId },
      );
    };
    const measure = (initial: boolean) => {
      frame = null;
      const scrollTop = Math.max(0, scroller.scrollTop);
      const activeHeadingId = activeHeadingIdAt(
        flatHeadingsRef.current,
        offsetAtTop(),
      );
      setState((current) => {
        const titleCompact = initial
          ? scrollTop > TITLE_COMPACT_AT
          : current.titleCompact
            ? scrollTop >= TITLE_RESTORE_AT
            : scrollTop > TITLE_COMPACT_AT;
        return current.titleCompact === titleCompact &&
          current.activeHeadingId === activeHeadingId
          ? current
          : { titleCompact, activeHeadingId };
      });
    };
    const schedule = () => {
      if (frame !== null) return;
      if (typeof requestAnimationFrame === "function") {
        frame = requestAnimationFrame(() => measure(false));
      } else {
        measure(false);
      }
    };
    measureActiveRef.current = measureActive;
    measure(true);
    scroller.addEventListener("scroll", schedule, { passive: true });
    return () => {
      measureActiveRef.current = null;
      scroller.removeEventListener("scroll", schedule);
      if (frame !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frame);
      }
    };
  }, [view]);

  // Outline re-publishes happen on every heading edit. They must refresh the
  // active heading without resetting the title's compact state.
  useLayoutEffect(() => {
    measureActiveRef.current?.();
  }, [flatHeadings]);

  return state;
};
