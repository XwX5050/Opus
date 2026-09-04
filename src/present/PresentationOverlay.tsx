/**
 * Presentation overlay (演示模式): plays the current document one slide at a
 * time in a fullscreen overlay. Slides come from `presentationPlan.ts` —
 * explicit `---` separators stay hard slide boundaries, and each section's
 * natural blocks are packed by measured rendered height, so an over-tall
 * section paginates within itself while a section that fits stays one slide.
 * The visible slide renders through the same reading-mode preview extensions
 * as the editor, so math, tables, and images look identical to the reading
 * view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorExtensions } from "../editor/editorExtensions";
import { imageWidgetsExtension } from "../editor/imageWidgets";
import { livePreviewExtension } from "../editor/livePreview";
import { mathWidgetsExtension } from "../editor/mathWidgets";
import { tableWidgetsExtension } from "../editor/tableWidgets";
import {
  packBlocksByHeight,
  splitManualSlides,
  splitNaturalBlocks,
} from "./presentationPlan";
import "./presentation.css";

const noop = (): void => undefined;

/** Exit fade duration; matches --anim-fast. */
const EXIT_FADE_MS = 160;
/** Idle time before the chrome fades to low opacity. */
const CHROME_IDLE_MS = 3000;
const RESIZE_DEBOUNCE_MS = 150;
const LOAD_DEBOUNCE_MS = 120;
/** Post-mount retry so fonts/images that load late get measured. */
const SETTLE_RETRY_MS = 600;
/** Bottom band reserved for the slide counter. */
const COUNTER_ALLOWANCE = 48;
const MIN_USABLE_HEIGHT = 160;
const FALLBACK_VIEWPORT = 720;
/** Heuristic line metrics: visual lines at ~1.6em, headings weighted more. */
const LINE_HEIGHT_EM = 1.6;
const MAJOR_HEADING_EM = 2.3;
const MINOR_HEADING_EM = 1.9;

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The resolved presentation font size: clamp(20px, 2.2vw, 30px). */
const presentationEm = (): number =>
  Math.min(30, Math.max(20, window.innerWidth * 0.022));

const debounce = (fn: () => void, delay: number): (() => void) => {
  let handle: number | undefined;
  return () => {
    if (handle !== undefined) window.clearTimeout(handle);
    handle = window.setTimeout(fn, delay);
  };
};

/** Line-count height estimate used when the browser cannot measure (jsdom). */
const estimateBlockHeight = (block: string, em: number): number => {
  let height = 0;
  for (const line of block.split("\n")) {
    const heading = /^#{1,6} /.exec(line);
    if (heading) {
      const level = heading[0].length - 1;
      height += (level <= 2 ? MAJOR_HEADING_EM : MINOR_HEADING_EM) * em;
    } else {
      height += LINE_HEIGHT_EM * em;
    }
  }
  return height;
};

/** Rendered block heights measured against the joined measurement doc. */
const measureBlockHeights = (
  view: EditorView,
  blocks: readonly string[],
): number[] => {
  const doc = view.state.doc;
  const heights: number[] = [];
  let offset = 0;
  for (const block of blocks) {
    const from = offset;
    offset += block.length + 2; // blocks join with "\n\n"
    const start = view.lineBlockAt(from);
    const end = view.lineBlockAt(from + Math.max(0, block.length - 1));
    heights.push(end.bottom - start.top);
  }
  return heights;
};

export interface PresentationOverlayProps {
  markdown: string;
  documentPath: string | null;
  resolveImageUrl(path: string): string;
  onExit(): void;
}

interface PackedSlide {
  readonly text: string;
  /** Index of this slide's first block across all sections. */
  readonly firstBlock: number;
  readonly blockCount: number;
}

interface SlidePack {
  readonly slides: readonly PackedSlide[];
  readonly index: number;
}

/** All natural blocks across sections, in document order (the measurement doc). */
const allBlocksOf = (sections: readonly (readonly string[])[]): string[] =>
  sections.flatMap((section) => section);

/**
 * Packs each section's natural blocks independently and flattens the result.
 * A section whose blocks fit `maxHeight` becomes a single slide; an
 * overflowing section paginates within itself and never merges with a
 * neighbor, so manual `---` boundaries are always honored. `firstBlock` is
 * the section's first block index in the joined measurement doc, so position
 * preservation works across re-packs.
 */
const packSections = (
  sections: readonly (readonly string[])[],
  heights: readonly number[],
  maxHeight: number,
): readonly PackedSlide[] => {
  const slides: PackedSlide[] = [];
  let blockCursor = 0;
  for (const blocks of sections) {
    const heightByBlock = new Map<string, number>();
    blocks.forEach((block, index) => {
      heightByBlock.set(block, heights[blockCursor + index] ?? 0);
    });
    const packed = packBlocksByHeight(
      blocks,
      (block) => heightByBlock.get(block) ?? 0,
      maxHeight,
    );
    let firstBlock = blockCursor;
    for (const group of packed) {
      slides.push({
        text: group.join("\n\n"),
        firstBlock,
        blockCount: group.length,
      });
      firstBlock += group.length;
    }
    blockCursor += blocks.length;
  }
  return slides;
};

/** Locates the slide holding `blockIndex`; falls back to clamping. */
const findSlideForBlock = (
  slides: readonly PackedSlide[],
  blockIndex: number,
  fallback: number,
): number => {
  for (let index = 0; index < slides.length; index++) {
    const slide = slides[index];
    if (
      blockIndex >= slide.firstBlock &&
      blockIndex < slide.firstBlock + slide.blockCount
    ) {
      return index;
    }
  }
  return Math.max(0, Math.min(fallback, slides.length - 1));
};

export default function PresentationOverlay(
  props: PresentationOverlayProps,
): JSX.Element {
  const { markdown, documentPath, resolveImageUrl, onExit } = props;

  interface Planning {
    /**
     * Natural blocks per slide section — one section per manual `---` slide,
     * or a single section holding the whole document when there are no
     * separators. Sections pack independently so manual boundaries never
     * merge.
     */
    readonly sections: readonly (readonly string[])[];
  }

  const planning = useMemo<Planning>(() => {
    const manual = splitManualSlides(markdown);
    return { sections: (manual ?? [markdown]).map(splitNaturalBlocks) };
  }, [markdown]);

  /** Every block across sections, in document order (the measurement doc). */
  const allBlocks = useMemo(() => allBlocksOf(planning.sections), [planning]);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const slideHostRef = useRef<HTMLDivElement>(null);
  const measureHostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const measureViewRef = useRef<EditorView | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const exitRequestedRef = useRef(false);
  // Latest-value mirrors read by stable callbacks and event handlers.
  const packRef = useRef<SlidePack | null>(null);
  const planningRef = useRef<Planning>(planning);
  const environmentRef = useRef({ documentPath, resolveImageUrl });
  const exitRef = useRef(onExit);
  planningRef.current = planning;
  environmentRef.current = { documentPath, resolveImageUrl };
  exitRef.current = onExit;

  /** Measured slide viewport height minus the counter allowance. */
  const usableHeight = (): number => {
    const scroller = scrollerRef.current;
    const viewport =
      scroller && scroller.clientHeight > 0
        ? scroller.clientHeight
        : window.innerHeight;
    const base = viewport > 0 ? viewport : FALLBACK_VIEWPORT;
    return Math.max(MIN_USABLE_HEIGHT, base - COUNTER_ALLOWANCE);
  };

  const initialPack = (): SlidePack => {
    const heights = allBlocks.map((block) =>
      estimateBlockHeight(block, presentationEm()),
    );
    return {
      index: 0,
      slides: packSections(planning.sections, heights, usableHeight()),
    };
  };

  const [pack, setPack] = useState<SlidePack>(initialPack);
  const [exiting, setExiting] = useState(false);
  const [chromeFaded, setChromeFaded] = useState(false);
  packRef.current = pack;

  /** Shared reading-mode extension set for the visible and measurement views. */
  const buildExtensions = useCallback((): Extension[] => {
    return [
      editorExtensions(
        { onSave: noop, onReopenClosed: noop, onToggleReading: noop },
        [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          livePreviewExtension({ revealSelection: false }),
          tableWidgetsExtension({ editable: false, onRequestEdit: noop }),
          mathWidgetsExtension({ revealSelection: false }),
          imageWidgetsExtension(
            {
              getDocumentPath: () => environmentRef.current.documentPath,
              resolveLocalUrl: (path) =>
                environmentRef.current.resolveImageUrl(path),
            },
            { revealSelection: false },
          ),
        ],
      ),
    ];
  }, []);

  const requestExit = useCallback(() => {
    if (exitRequestedRef.current) return;
    exitRequestedRef.current = true;
    if (prefersReducedMotion()) {
      exitRef.current();
      return;
    }
    setExiting(true);
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null;
      exitRef.current();
    }, EXIT_FADE_MS);
  }, []);

  const goTo = useCallback((next: number) => {
    if (exitRequestedRef.current) return;
    setPack((prev) => {
      const clamped = Math.max(0, Math.min(prev.slides.length - 1, next));
      return clamped === prev.index ? prev : { ...prev, index: clamped };
    });
  }, []);

  const advance = useCallback(() => {
    if (exitRequestedRef.current) return;
    const current = packRef.current;
    if (!current) return;
    if (current.slides.length === 0 || current.index >= current.slides.length - 1) {
      return;
    }
    setPack({ ...current, index: current.index + 1 });
  }, []);

  const retreat = useCallback(() => {
    goTo((packRef.current?.index ?? 0) - 1);
  }, [goTo]);

  const pokeChrome = useCallback(() => {
    if (prefersReducedMotion()) return;
    setChromeFaded(false);
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(
      () => setChromeFaded(true),
      CHROME_IDLE_MS,
    );
  }, []);

  const remeasure = useCallback(() => {
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (exitRequestedRef.current) return;
        const view = measureViewRef.current;
        const sections = planningRef.current.sections;
        if (!view || sections.length === 0) return;
        const blocks = allBlocksOf(sections);
        if (blocks.length === 0) return;
        const maxHeight = usableHeight();
        setPack((prev) => {
          // In zero-layout environments (jsdom) the measure host never
          // renders, yet CodeMirror's height map can report phantom
          // non-zero block heights after its measure cycle. Trust measured
          // heights only when the host has real layout; otherwise the
          // line-count heuristic stays in charge, keeping re-packs
          // deterministic where measurement cannot work.
          const measured = view.dom.clientHeight > 0;
          const heights = measured ? measureBlockHeights(view, blocks) : [];
          const hasRealHeights = heights.some((height) => height > 0);
          const effective = blocks.map((block, index) =>
            hasRealHeights && heights[index] > 0
              ? heights[index]
              : estimateBlockHeight(block, presentationEm()),
          );
          const slides = packSections(sections, effective, maxHeight);
          if (
            slides.length === prev.slides.length &&
            slides.every((slide, index) => slide.text === prev.slides[index].text)
          ) {
            return prev;
          }
          const remembered = prev.slides[prev.index]?.firstBlock ?? 0;
          return {
            slides,
            index: findSlideForBlock(slides, remembered, prev.index),
          };
        });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the overlay on mount and restore the previous focus on unmount.
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  // Clean up timers on unmount.
  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    };
  }, []);

  // Start the chrome idle-fade timer on mount.
  useEffect(() => {
    pokeChrome();
  }, [pokeChrome]);

  // The visible slide editor: one EditorView for the whole session; slide
  // changes dispatch a whole-doc replacement below.
  useEffect(() => {
    const host = slideHostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: "", extensions: buildExtensions() }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [buildExtensions]);

  // Sync the visible editor to the current slide.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || pack.slides.length === 0) return;
    const text = pack.slides[pack.index].text;
    if (text === view.state.doc.toString()) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 },
      annotations: Transaction.addToHistory.of(false),
    });
    scrollerRef.current!.scrollTop = 0;
    view.scrollDOM.scrollTop = 0;
  }, [pack]);

  // The hidden measurement view: same extensions and presentation classes,
  // measuring every block of the joined document with real layout.
  useEffect(() => {
    if (allBlocks.length === 0) return;
    const host = measureHostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: allBlocks.join("\n\n"),
        extensions: buildExtensions(),
      }),
    });
    measureViewRef.current = view;
    let disposed = false;
    const settle = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!disposed) remeasure();
      });
    });
    const retry = window.setTimeout(() => {
      if (!disposed) remeasure();
    }, SETTLE_RETRY_MS);
    return () => {
      disposed = true;
      measureViewRef.current = null;
      cancelAnimationFrame(settle);
      window.clearTimeout(retry);
      view.destroy();
    };
  }, [allBlocks, buildExtensions, remeasure]);

  // Re-pack after the window resizes.
  useEffect(() => {
    const onResize = debounce(() => remeasure(), RESIZE_DEBOUNCE_MS);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [remeasure]);

  // Re-pack once images/fonts settle: capture-phase 'load' + the retry above.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onLoad = debounce(() => remeasure(), LOAD_DEBOUNCE_MS);
    root.addEventListener("load", onLoad, true);
    return () => root.removeEventListener("load", onLoad, true);
  }, [remeasure]);

  // Re-plan when the markdown prop changes (rare), keeping the position.
  useEffect(() => {
    const maxHeight = usableHeight();
    setPack((prev) => {
      const heights = allBlocks.map((block) =>
        estimateBlockHeight(block, presentationEm()),
      );
      const slides = packSections(planning.sections, heights, maxHeight);
      if (
        slides.length === prev.slides.length &&
        slides.every((slide, index) => slide.text === prev.slides[index].text)
      ) {
        return prev;
      }
      const remembered = prev.slides[prev.index]?.firstBlock ?? 0;
      return { slides, index: findSlideForBlock(slides, remembered, prev.index) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planning]);

  // ------------------------- interaction handlers -------------------------

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (exitRequestedRef.current) return;
    if (event.key === "Escape") {
      event.preventDefault();
      pokeChrome();
      requestExit();
      return;
    }
    let action: "next" | "prev" | undefined;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        action = "next";
        break;
      case "ArrowLeft":
      case "ArrowUp":
        action = "prev";
        break;
    }
    if (!action) return;
    event.preventDefault();
    pokeChrome();
    if (action === "next") advance();
    else retreat();
  };

  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (exitRequestedRef.current) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest(".presentation-exit")) return;
    pokeChrome();
    advance();
  };

  const handlePointerMove = (): void => {
    pokeChrome();
  };

  const slideCount = pack.slides.length;

  return (
    <div
      ref={rootRef}
      className={`presentation-overlay${exiting ? " presentation-overlay--exiting" : ""}`}
      tabIndex={-1}
      role="dialog"
      aria-label="演示模式"
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      onPointerMove={handlePointerMove}
    >
      <div className="presentation-stage">
        {slideCount === 0 ? (
          <div className="presentation-empty">（空文档）</div>
        ) : (
          <div ref={scrollerRef} className="presentation-scroller">
            <div ref={slideHostRef} className="presentation-slide-host" />
          </div>
        )}
        {allBlocks.length > 0 && slideCount > 0 && (
          <div
            ref={measureHostRef}
            className="presentation-slide-host presentation-measure"
            aria-hidden="true"
          />
        )}
      </div>
      <div
        className={`presentation-chrome${chromeFaded ? " presentation-chrome--faded" : ""}`}
      >
        {slideCount > 0 && (
          <div className="presentation-counter" aria-live="polite">
            {pack.index + 1} / {slideCount}
          </div>
        )}
        <button
          type="button"
          className="presentation-exit"
          aria-label="退出演示"
          title="退出演示"
          onClick={requestExit}
        >
          ✕
        </button>
      </div>
    </div>
  );
}