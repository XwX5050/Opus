import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { redo, undo } from "@codemirror/commands";
import { forceParsing } from "@codemirror/language";
import {
  Annotation,
  Compartment,
  EditorState,
  type Text,
  Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ClipboardImageInput } from "../document/DocumentPort";
import { reportEditorEditable } from "../document/tauriDocumentPort";
import {
  observeEditorWidgets,
  playEditorIntro,
} from "../motion/editorMotion";
import {
  editorExtensions,
  markdownLanguageExtension,
} from "./editorExtensions";
import { imagePasteExtension, insertDroppedImages } from "./imagePaste";
import { imageWidgetsExtension } from "./imageWidgets";
import { livePreviewExtension } from "./livePreview";
import { searchMatchOffset } from "./searchNavigation";
import { mathWidgetsExtension } from "./mathWidgets";
import {
  extractOutline,
  findOutlineHeadingById,
  type OutlineHeading,
} from "./outline";
import {
  DEFAULT_PARSE_SLICE_MS,
  outlinePublisherExtension,
} from "./outlineExtension";
import {
  markdownSyntaxFor,
  type MarkdownSyntaxMode,
  type PerformanceMode,
} from "./performanceMode";
import {
  focusMarkdownTableCell,
  runTableCellClipboardCommand,
  tableWidgetsExtension,
  type TableCellClipboardCommand,
  type TableCellEditRequest,
} from "./tableWidgets";
import type { EditorViewMode } from "./viewMode";

const externalValueSync = Annotation.define<boolean>();

// Light mode bounds semantic table DOM per table. Oversized tables stay as
// editable raw Markdown until the user opts back into full rendering.
const LIGHT_MODE_TABLE_CELL_LIMIT = 1_000;

/**
 * Resolves the position an outline navigation request points at, or null
 * when the request cannot be honored. A request carrying the current
 * document revision is used as-is; an older revision (the outline publishes
 * on a debounce, so the panel can lag the document) is re-located by heading
 * id against a freshly parsed tree. An incomplete parse or a vanished
 * heading drops the click rather than land on obsolete offsets.
 */
const outlineNavigationTarget = (
  view: EditorView,
  request: OutlineNavigationRequest,
): { from: number; textFrom: number } | null => {
  if (request.doc === view.state.doc) {
    return { from: request.from, textFrom: request.textFrom };
  }
  if (!forceParsing(view, view.state.doc.length, DEFAULT_PARSE_SLICE_MS)) {
    return null;
  }
  const fresh = findOutlineHeadingById(extractOutline(view.state), request.id);
  if (fresh === null) return null;
  return { from: fresh.from, textFrom: fresh.textFrom };
};

export interface EditorImageDrop {
  readonly sequence: number;
  readonly paths: ReadonlyArray<string>;
  readonly x: number;
  readonly y: number;
}

export interface OutlineNavigationRequest {
  readonly sequence: number;
  /**
   * Heading id in the published tree; used to re-locate the heading after
   * edits shifted the stored offsets.
   */
  readonly id: string;
  readonly from: number;
  readonly textFrom: number;
  /**
   * The document revision the offsets were extracted from. A request whose
   * revision no longer matches the editor's doc is stale; it is either
   * re-located against a fresh parse or dropped.
   */
  readonly doc: Text | null;
}

export interface SearchNavigationRequest {
  readonly sequence: number;
  readonly line: number;
  readonly column: number;
}

export interface TableFocusRequest extends TableCellEditRequest {
  readonly sequence: number;
}

/**
 * Imperative commands exposed to host components (e.g. the AppShell context
 * menu). undo/redo are routed to the live EditorView; both return false when
 * there is nothing to undo/redo or the editor is not mounted.
 */
export interface MarkdownEditorHandle {
  /** Focuses the editor content. */
  focus(): void;
  /** Undoes one history group. */
  undo(): boolean;
  /** Redoes one history group. */
  redo(): boolean;
  /**
   * Applies a clipboard/selection command to the rendered table cell that
   * currently owns the DOM selection (context-menu commands). Resolves to
   * false when no editable cell owns the selection so the caller can fall
   * back to the CodeMirror-level command.
   */
  runTableCellClipboardCommand(
    command: TableCellClipboardCommand,
  ): Promise<boolean>;
}

export interface MarkdownEditorProps {
  value: string;
  onChange(value: string): void;
  onSave(): void;
  onReopenClosed(): void;
  onToggleReading(): void;
  viewMode: EditorViewMode;
  documentPath: string | null;
  saveClipboardImage(input: ClipboardImageInput): Promise<string | null>;
  resolveImageUrl(path: string): string;
  imageDrop?: EditorImageDrop | null;
  onOutlineChange?(
    headings: ReadonlyArray<OutlineHeading>,
    doc: Text,
  ): void;
  outlineNavigation?: OutlineNavigationRequest | null;
  searchNavigation?: SearchNavigationRequest | null;
  onSearchNavigationConsumed?(sequence: number): void;
  onRequestTableEdit?(request: TableCellEditRequest): void;
  tableFocusRequest?: TableFocusRequest | null;
  onTableFocusConsumed?(request: TableFocusRequest): void;
  /**
   * Large documents open in "light" mode: Markdown parsing, selection,
   * search and visible-range text styling stay active, while offscreen
   * image creation and nonessential block widgets (math, images) are paused.
   * Tables over the per-table cell budget stay as raw Markdown. Light mode
   * never changes the document text.
   */
  performanceMode?: PerformanceMode;
  /**
   * Called with the live EditorView right after it is created and with null
   * when it is destroyed. Additive: hosts that do not need the view can omit
   * it. The view mounts once per document; switching tabs remounts it.
   */
  onEditorView?(view: EditorView | null): void;
}

const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(props, ref) {
    const {
      value,
      onChange,
      onSave,
      onReopenClosed,
      onToggleReading,
      viewMode,
      documentPath,
      saveClipboardImage,
      resolveImageUrl,
      imageDrop = null,
      onOutlineChange,
      outlineNavigation = null,
      searchNavigation = null,
      onSearchNavigationConsumed,
      onRequestTableEdit,
      tableFocusRequest = null,
      onTableFocusConsumed,
      performanceMode = "full",
      onEditorView,
    } = props;
  const markdownSyntaxRef = useRef<MarkdownSyntaxMode>(
    markdownSyntaxFor(performanceMode, value.length),
  );
  const pendingMarkdownSyntaxRef = useRef<MarkdownSyntaxMode | null>(null);
  const compositionWaitCleanupRef = useRef<(() => void) | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const previewCompartmentRef = useRef(new Compartment());
  const markdownCompartmentRef = useRef(new Compartment());
  const previousPreviewRef = useRef({ viewMode, performanceMode });
  const documentPathRef = useRef(documentPath);
  documentPathRef.current = documentPath;
  const callbacksRef = useRef({
    onChange,
    onSave,
    onReopenClosed,
    onToggleReading,
    onOutlineChange,
    onSearchNavigationConsumed,
    onRequestTableEdit,
    onTableFocusConsumed,
  });
  callbacksRef.current = {
    onChange,
    onSave,
    onReopenClosed,
    onToggleReading,
    onOutlineChange,
    onSearchNavigationConsumed,
    onRequestTableEdit,
    onTableFocusConsumed,
  };
  const tableEditRequestHandlerRef = useRef<
    (request: TableCellEditRequest) => void
  >((request) => callbacksRef.current.onRequestTableEdit?.(request));
  const imageSupportRef = useRef({ saveClipboardImage, resolveImageUrl });
  imageSupportRef.current = { saveClipboardImage, resolveImageUrl };
  // Identity of the last value this editor emitted or adopted. Comparing
  // strings by reference lets the controlled-value sync below skip without
  // copying the document — a doc.toString() per keystroke is fine for notes
  // but costs tens of milliseconds on pressure-sized documents.
  const lastSyncedValueRef = useRef(value);
  // The live view is reported from the mount effect, which runs once; the ref
  // keeps the callback current across renders without re-creating the view.
  const onEditorViewRef = useRef(onEditorView);
  onEditorViewRef.current = onEditorView;

  const previewExtensionsFor = (mode: EditorViewMode, perf: PerformanceMode) => {
    const readOnly =
      mode === "reading"
        ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
        : [];
    return [
      ...readOnly,
      // Reading mode never reveals source markers, wherever the cursor sits.
      livePreviewExtension({ revealSelection: mode !== "reading" }),
      tableWidgetsExtension({
        editable: mode === "editing",
        onRequestEdit: tableEditRequestHandlerRef.current,
        ...(perf === "light"
          ? { maxRenderedCells: LIGHT_MODE_TABLE_CELL_LIMIT }
          : {}),
      }),
      // Light mode pauses offscreen image creation and nonessential block
      // widgets; visible-range text styling (live preview) stays on.
      ...(perf === "light"
        ? []
        : [
            mathWidgetsExtension({ revealSelection: mode !== "reading" }),
            imageWidgetsExtension(
              {
                getDocumentPath: () => documentPathRef.current,
                resolveLocalUrl: (path) => imageSupportRef.current.resolveImageUrl(path),
              },
              { revealSelection: mode !== "reading" },
            ),
          ]),
    ];
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          editorExtensions(
            {
              onSave: () => callbacksRef.current.onSave(),
              onReopenClosed: () => callbacksRef.current.onReopenClosed(),
              onToggleReading: () => callbacksRef.current.onToggleReading(),
            },
            previewCompartmentRef.current.of(
              previewExtensionsFor(viewMode, performanceMode),
            ),
            markdownCompartmentRef.current.of(
              markdownLanguageExtension(markdownSyntaxRef.current),
            ),
          ),
          imagePasteExtension({
            saveClipboardImage: (input) =>
              imageSupportRef.current.saveClipboardImage(input),
            getDocumentPath: () => documentPathRef.current,
          }),
          outlinePublisherExtension((headings, doc) =>
            callbacksRef.current.onOutlineChange?.(headings, doc),
          ),
          EditorView.contentAttributes.of({
            "aria-label": "Markdown 编辑器",
          }),
          EditorView.updateListener.of((update) => {
            const isExternal = update.transactions.some(
              (transaction) => transaction.annotation(externalValueSync),
            );
            if (update.docChanged && !isExternal) {
              const text = update.state.doc.toString();
              lastSyncedValueRef.current = text;
              callbacksRef.current.onChange(text);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    onEditorViewRef.current?.(view);
    requestAnimationFrame(() => {
      if (import.meta.env.DEV || import.meta.env.MODE === "perf") {
        // Perf harness hooks (scripts/measure-editor.mjs): the first frame
        // after the editor mounts approximates "open to editable", and the
        // view lets the harness prove the platform document-end shortcut
        // really reached the end before it samples input latency. The
        // production perf bundle carries MODE=perf; normal production
        // builds eliminate these branches entirely.
        performance.mark("markdown-edit:editor-editable");
        (window as Window & { __OPUS_PERF_EDITOR_VIEW__?: EditorView })
          .__OPUS_PERF_EDITOR_VIEW__ = view;
      }
      // Process-level hook (scripts/measure-startup.mjs): no-op unless the
      // app was launched with MARKDOWN_EDIT_PERF_MARK set.
      reportEditorEditable();
    });
    return () => {
      viewRef.current = null;
      clearCompositionWait();
      pendingMarkdownSyntaxRef.current = null;
      onEditorViewRef.current?.(null);
      if (import.meta.env.DEV || import.meta.env.MODE === "perf") {
        const perfWindow = window as Window & {
          __OPUS_PERF_EDITOR_VIEW__?: EditorView;
        };
        if (perfWindow.__OPUS_PERF_EDITOR_VIEW__ === view) {
          delete perfWindow.__OPUS_PERF_EDITOR_VIEW__;
        }
      }
      view.destroy();
    };
    // One EditorView owns this mounted document. Prop changes are synchronized below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    const previous = lastSyncedValueRef.current;
    if (!view || value === previous) return;
    lastSyncedValueRef.current = value;
    const docLength = view.state.doc.length;
    const head = Math.min(view.state.selection.main.head, value.length);
    const anchor = Math.min(view.state.selection.main.anchor, value.length);
    let from = 0;
    let to = docLength;
    let insert = value;
    if (previous.length === docLength) {
      let prefix = 0;
      const minLength = Math.min(previous.length, value.length);
      while (prefix < minLength && previous[prefix] === value[prefix]) {
        prefix += 1;
      }
      let suffix = 0;
      while (
        suffix < minLength - prefix &&
        previous[previous.length - 1 - suffix] ===
          value[value.length - 1 - suffix]
      ) {
        suffix += 1;
      }
      from = prefix;
      to = previous.length - suffix;
      insert = value.slice(prefix, value.length - suffix);
    }
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor, head },
      annotations: [
        Transaction.addToHistory.of(false),
        externalValueSync.of(true),
      ],
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    const previous = previousPreviewRef.current;
    if (
      !view ||
      (previous.viewMode === viewMode &&
        previous.performanceMode === performanceMode)
    ) {
      return;
    }
    previousPreviewRef.current = { viewMode, performanceMode };
    view.dispatch({
      effects: previewCompartmentRef.current.reconfigure(
        previewExtensionsFor(viewMode, performanceMode),
      ),
    });
    // Preview extensions read live refs; rebuilding them on toggle is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, performanceMode]);

  const clearCompositionWait = () => {
    compositionWaitCleanupRef.current?.();
    compositionWaitCleanupRef.current = null;
  };

  const dispatchMarkdownSyntax = (
    view: EditorView,
    mode: MarkdownSyntaxMode,
  ) => {
    view.dispatch({
      effects: markdownCompartmentRef.current.reconfigure(
        markdownLanguageExtension(mode),
      ),
    });
  };

  /**
   * A language reconfigure must never dispatch while CodeMirror is composing:
   * WebKitGTK's fcitx5 composition pins the preedit caret if a transaction
   * rewrites the DOM selection mid-composition. Keep the latest requested
   * grammar, wait for compositionend, and poll as a fallback for missed end
   * events. The actual dispatch happens only after `view.composing` is false.
   */
  const deferMarkdownSyntax = (
    view: EditorView,
    mode: MarkdownSyntaxMode,
  ) => {
    pendingMarkdownSyntaxRef.current = mode;
    if (compositionWaitCleanupRef.current) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      window.removeEventListener("compositionend", handleCompositionEnd, true);
      if (timer !== null) clearTimeout(timer);
      compositionWaitCleanupRef.current = null;
    };
    const applyPending = () => {
      if (done) return;
      if (viewRef.current !== view) {
        cleanup();
        return;
      }
      if (view.composing) {
        timer = setTimeout(applyPending, 50);
        return;
      }
      const next = pendingMarkdownSyntaxRef.current;
      pendingMarkdownSyntaxRef.current = null;
      cleanup();
      if (next !== null) dispatchMarkdownSyntax(view, next);
    };
    const handleCompositionEnd = () => {
      // CodeMirror clears `composing` in its own compositionend handler;
      // a microtask runs after the event's listeners have all completed.
      queueMicrotask(applyPending);
    };
    window.addEventListener("compositionend", handleCompositionEnd, true);
    timer = setTimeout(applyPending, 50);
    compositionWaitCleanupRef.current = cleanup;
  };

  const requestMarkdownSyntax = (
    view: EditorView,
    mode: MarkdownSyntaxMode,
  ) => {
    if (view.composing) {
      deferMarkdownSyntax(view, mode);
      return;
    }
    pendingMarkdownSyntaxRef.current = null;
    clearCompositionWait();
    dispatchMarkdownSyntax(view, mode);
  };

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = markdownSyntaxFor(
      performanceMode,
      value.length,
      markdownSyntaxRef.current,
    );
    if (next === markdownSyntaxRef.current) return;
    markdownSyntaxRef.current = next;
    requestMarkdownSyntax(view, next);
    // The ref is the current grammar; value.length only participates in the
    // enter/exit hysteresis decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [performanceMode, value.length]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let intro: { kill(): void } | null = null;
    let stopObserving: () => void = () => undefined;
    const frame = requestAnimationFrame(() => {
      if (!host.isConnected) return;
      intro = playEditorIntro(host, performanceMode, viewMode);
      if (viewMode === "reading") {
        stopObserving = observeEditorWidgets(host, performanceMode);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      intro?.kill();
      stopObserving();
    };
  }, [performanceMode, viewMode]);

  const consumedOutlineNavigationRef = useRef(0);

  const consumedTableFocusRef = useRef(0);

  useEffect(() => {
    const view = viewRef.current;
    if (
      !view ||
      viewMode !== "editing" ||
      !tableFocusRequest ||
      tableFocusRequest.sequence <= consumedTableFocusRef.current
    ) {
      return;
    }
    consumedTableFocusRef.current = tableFocusRequest.sequence;
    focusMarkdownTableCell(view, tableFocusRequest);
    callbacksRef.current.onTableFocusConsumed?.(tableFocusRequest);
  }, [tableFocusRequest, viewMode]);

  useEffect(() => {
    const view = viewRef.current;
    if (
      !view ||
      !outlineNavigation ||
      outlineNavigation.sequence <= consumedOutlineNavigationRef.current
    ) {
      return;
    }
    consumedOutlineNavigationRef.current = outlineNavigation.sequence;
    const target = outlineNavigationTarget(view, outlineNavigation);
    if (target === null) return;
    const requestedPosition =
      viewMode === "reading" ? target.from : target.textFrom;
    const position = Math.min(
      view.state.doc.length,
      Math.max(0, requestedPosition),
    );
    view.dispatch({
      ...(viewMode === "editing"
        ? { selection: { anchor: position } }
        : {}),
      effects: EditorView.scrollIntoView(position, {
        y: "start",
        yMargin: 24,
      }),
    });
    if (viewMode === "editing") view.focus();
  }, [outlineNavigation, viewMode]);

  const consumedSearchNavigationRef = useRef(0);
  useEffect(() => {
    const view = viewRef.current;
    if (
      !view ||
      !searchNavigation ||
      searchNavigation.sequence <= consumedSearchNavigationRef.current
    ) {
      return;
    }
    consumedSearchNavigationRef.current = searchNavigation.sequence;
    const position = searchMatchOffset(
      view.state.doc.toString(),
      searchNavigation.line,
      searchNavigation.column,
    );
    if (position === null) return;
    view.dispatch({
      selection: { anchor: position },
      annotations: [Transaction.addToHistory.of(false)],
      effects: EditorView.scrollIntoView(position, { y: "center" }),
    });
    view.focus();
    callbacksRef.current.onSearchNavigationConsumed?.(searchNavigation.sequence);
  }, [searchNavigation]);

  // A drop delivered before this editor mounted is stale: only drops with a
  // newer sequence are inserted.
  const consumedImageDropRef = useRef(imageDrop?.sequence ?? 0);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !imageDrop || imageDrop.sequence === consumedImageDropRef.current) return;
    // Consume the sequence even when read-only (reading mode): the read-only
    // facet does not filter programmatic dispatches, and skipping without
    // consuming would let the stale drop land when editing resumes.
    consumedImageDropRef.current = imageDrop.sequence;
    if (view.state.readOnly) return;
    insertDroppedImages(
      view,
      imageDrop.paths,
      view.posAtCoords({ x: imageDrop.x, y: imageDrop.y }),
    );
  }, [imageDrop]);

  // Public imperative API for host components: the CodeMirror undo/redo
  // commands already consult the history and read-only state, so the handle
  // only forwards to the mounted EditorView (false when it is gone). No
  // transaction is ever dispatched from here on its own.
  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    undo: () => (viewRef.current ? undo(viewRef.current) : false),
    redo: () => (viewRef.current ? redo(viewRef.current) : false),
    runTableCellClipboardCommand: (command) =>
      viewRef.current
        ? runTableCellClipboardCommand(viewRef.current, command)
        : Promise.resolve(false),
  }), []);

  return (
    <div
      ref={hostRef}
      className="markdown-editor"
      data-document-path={documentPath ?? ""}
      data-view-mode={viewMode}
    />
  );
  },
);

export default MarkdownEditor;
