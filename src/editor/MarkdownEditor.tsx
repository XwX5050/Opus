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
import type { PerformanceMode } from "./performanceMode";

const externalValueSync = Annotation.define<boolean>();

export interface EditorImageDrop {
  readonly sequence: number;
  readonly paths: ReadonlyArray<string>;
  readonly x: number;
  readonly y: number;
}

export interface MarkdownEditorProps {
  value: string;
  onChange(value: string): void;
  onSave(): void;
  onReopenClosed(): void;
  sourceMode: boolean;
  documentPath: string | null;
  saveClipboardImage(input: ClipboardImageInput): Promise<string | null>;
  resolveImageUrl(path: string): string;
  imageDrop?: EditorImageDrop | null;
  /**
   * Large documents open in "light" mode: Markdown parsing, selection,
   * search and visible-range text styling stay active, while offscreen
   * image creation and nonessential block widgets (math, images) are
   * paused. Light mode never changes the document text.
   */
  performanceMode?: PerformanceMode;
}

export default function MarkdownEditor({
  value,
  onChange,
  onSave,
  onReopenClosed,
  sourceMode,
  documentPath,
  saveClipboardImage,
  resolveImageUrl,
  imageDrop = null,
  performanceMode = "full",
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const previewCompartmentRef = useRef(new Compartment());
  const previousPreviewRef = useRef({ sourceMode, performanceMode });
  const documentPathRef = useRef(documentPath);
  documentPathRef.current = documentPath;
  const callbacksRef = useRef({ onChange, onSave, onReopenClosed });
  callbacksRef.current = { onChange, onSave, onReopenClosed };
  const imageSupportRef = useRef({ saveClipboardImage, resolveImageUrl });
  imageSupportRef.current = { saveClipboardImage, resolveImageUrl };
  // Identity of the last value this editor emitted or adopted. Comparing
  // strings by reference lets the controlled-value sync below skip without
  // copying the document — a doc.toString() per keystroke is fine for notes
  // but costs tens of milliseconds on pressure-sized documents.
  const lastSyncedValueRef = useRef(value);

  const previewExtensions = (mode: PerformanceMode) => [
    livePreviewExtension(),
    // Light mode pauses offscreen image creation and nonessential block
    // widgets; visible-range text styling (live preview) stays on.
    ...(mode === "light"
      ? []
      : [
          mathWidgetsExtension(),
          imageWidgetsExtension({
            getDocumentPath: () => documentPathRef.current,
            resolveLocalUrl: (path) => imageSupportRef.current.resolveImageUrl(path),
          }),
        ]),
  ];

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
            },
            previewCompartmentRef.current.of(
              sourceMode ? [] : previewExtensions(performanceMode),
            ),
          ),
          imagePasteExtension({
            saveClipboardImage: (input) =>
              imageSupportRef.current.saveClipboardImage(input),
            getDocumentPath: () => documentPathRef.current,
          }),
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
      (previous.sourceMode === sourceMode &&
        previous.performanceMode === performanceMode)
    ) {
      return;
    }
    previousPreviewRef.current = { sourceMode, performanceMode };
    view.dispatch({
      effects: previewCompartmentRef.current.reconfigure(
        sourceMode ? [] : previewExtensions(performanceMode),
      ),
    });
    // Preview extensions read live refs; rebuilding them on toggle is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceMode, performanceMode]);

  // A drop delivered before this editor mounted is stale: only drops with a
  // newer sequence are inserted.
  const consumedImageDropRef = useRef(imageDrop?.sequence ?? 0);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !imageDrop || imageDrop.sequence === consumedImageDropRef.current) return;
    consumedImageDropRef.current = imageDrop.sequence;
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
      data-source-mode={sourceMode ? "true" : "false"}
    />
  );
}
