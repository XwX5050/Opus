import { useEffect, useRef } from "react";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorExtensions } from "./editorExtensions";
import { livePreviewExtension } from "./livePreview";
import { mathWidgetsExtension } from "./mathWidgets";

const externalValueSync = Annotation.define<boolean>();

export interface MarkdownEditorProps {
  value: string;
  onChange(value: string): void;
  onSave(): void;
  onReopenClosed(): void;
  sourceMode: boolean;
  documentPath: string | null;
}

export default function MarkdownEditor({
  value,
  onChange,
  onSave,
  onReopenClosed,
  sourceMode,
  documentPath,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const previewCompartmentRef = useRef(new Compartment());
  const previousSourceModeRef = useRef(sourceMode);
  const callbacksRef = useRef({ onChange, onSave, onReopenClosed });
  callbacksRef.current = { onChange, onSave, onReopenClosed };

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
              sourceMode
                ? []
                : [livePreviewExtension(), mathWidgetsExtension()],
            ),
          ),
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
        sourceMode
          ? []
          : [livePreviewExtension(), mathWidgetsExtension()],
      ),
    });
  }, [sourceMode]);

  return (
    <div
      ref={hostRef}
      className="markdown-editor"
      data-document-path={documentPath ?? ""}
      data-source-mode={sourceMode ? "true" : "false"}
    />
  );
}
