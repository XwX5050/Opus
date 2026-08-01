import { useEffect, useRef } from "react";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ClipboardImageInput } from "../document/DocumentPort";
import { reportEditorEditable } from "../document/tauriDocumentPort";
import { editorExtensions } from "./editorExtensions";
import { imagePasteExtension, insertDroppedImages } from "./imagePaste";
import { imageWidgetsExtension } from "./imageWidgets";
import { livePreviewExtension } from "./livePreview";
import { mathWidgetsExtension } from "./mathWidgets";
import type { OutlineHeading } from "./outline";
import { outlinePublisherExtension } from "./outlineExtension";
import type { PerformanceMode } from "./performanceMode";
import {
  focusMarkdownTableCell,
  tableWidgetsExtension,
  type TableCellEditRequest,
} from "./tableWidgets";
import type { EditorViewMode } from "./viewMode";

const externalValueSync = Annotation.define<boolean>();

// Light mode bounds semantic table DOM per table. Oversized tables stay as
// editable raw Markdown until the user opts back into full rendering.
const LIGHT_MODE_TABLE_CELL_LIMIT = 1_000;

export interface EditorImageDrop {
  readonly sequence: number;
  readonly paths: ReadonlyArray<string>;
  readonly x: number;
  readonly y: number;
}

export interface OutlineNavigationRequest {
  readonly sequence: number;
  readonly from: number;
  readonly textFrom: number;
}

export interface TableFocusRequest extends TableCellEditRequest {
  readonly sequence: number;
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
  onOutlineChange?(headings: ReadonlyArray<OutlineHeading>): void;
  outlineNavigation?: OutlineNavigationRequest | null;
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
}

export default function MarkdownEditor({
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
  onRequestTableEdit,
  tableFocusRequest = null,
  onTableFocusConsumed,
  performanceMode = "full",
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const previewCompartmentRef = useRef(new Compartment());
  const previousPreviewRef = useRef({ viewMode, performanceMode });
  const documentPathRef = useRef(documentPath);
  documentPathRef.current = documentPath;
  const callbacksRef = useRef({
    onChange,
    onSave,
    onReopenClosed,
    onToggleReading,
    onOutlineChange,
    onRequestTableEdit,
    onTableFocusConsumed,
  });
  callbacksRef.current = {
    onChange,
    onSave,
    onReopenClosed,
    onToggleReading,
    onOutlineChange,
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
          ),
          imagePasteExtension({
            saveClipboardImage: (input) =>
              imageSupportRef.current.saveClipboardImage(input),
            getDocumentPath: () => documentPathRef.current,
          }),
          outlinePublisherExtension((headings) =>
            callbacksRef.current.onOutlineChange?.(headings),
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
    requestAnimationFrame(() => {
      if (import.meta.env.DEV) {
        // Perf harness hook (scripts/measure-editor.mjs): the first frame
        // after the editor mounts approximates "open to editable".
        performance.mark("markdown-edit:editor-editable");
      }
      // Process-level hook (scripts/measure-startup.mjs): no-op unless the
      // app was launched with MARKDOWN_EDIT_PERF_MARK set.
      reportEditorEditable();
    });
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // One EditorView owns this mounted document. Prop changes are synchronized below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === lastSyncedValueRef.current) return;
    lastSyncedValueRef.current = value;
    const head = Math.min(view.state.selection.main.head, value.length);
    const anchor = Math.min(view.state.selection.main.anchor, value.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
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
    const requestedPosition =
      viewMode === "reading"
        ? outlineNavigation.from
        : outlineNavigation.textFrom;
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

  return (
    <div
      ref={hostRef}
      className="markdown-editor"
      data-document-path={documentPath ?? ""}
      data-view-mode={viewMode}
    />
  );
}
