import { useEffect, useRef } from "react";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ClipboardImageInput } from "../document/DocumentPort";
import { editorExtensions } from "./editorExtensions";
import { imagePasteExtension, insertDroppedImages } from "./imagePaste";
import { imageWidgetsExtension } from "./imageWidgets";
import { livePreviewExtension } from "./livePreview";
import { mathWidgetsExtension } from "./mathWidgets";

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
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const previewCompartmentRef = useRef(new Compartment());
  const previousSourceModeRef = useRef(sourceMode);
  const documentPathRef = useRef(documentPath);
  documentPathRef.current = documentPath;
  const callbacksRef = useRef({ onChange, onSave, onReopenClosed });
  callbacksRef.current = { onChange, onSave, onReopenClosed };
  const imageSupportRef = useRef({ saveClipboardImage, resolveImageUrl });
  imageSupportRef.current = { saveClipboardImage, resolveImageUrl };

  const previewExtensions = () => [
    livePreviewExtension(),
    mathWidgetsExtension(),
    imageWidgetsExtension({
      getDocumentPath: () => documentPathRef.current,
      resolveLocalUrl: (path) => imageSupportRef.current.resolveImageUrl(path),
    }),
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
              sourceMode ? [] : previewExtensions(),
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
              callbacksRef.current.onChange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // One EditorView owns this mounted document. Prop changes are synchronized below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
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
    if (!view || previousSourceModeRef.current === sourceMode) return;
    previousSourceModeRef.current = sourceMode;
    view.dispatch({
      effects: previewCompartmentRef.current.reconfigure(
        sourceMode ? [] : previewExtensions(),
      ),
    });
    // Preview extensions read live refs; rebuilding them on toggle is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceMode]);

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
