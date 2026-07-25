import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ClipboardImageInput } from "../document/DocumentPort";

export interface ImagePasteOptions {
  saveClipboardImage(input: ClipboardImageInput): Promise<string | null>;
  getDocumentPath(): string | null;
  onError?: (error: unknown) => void;
}

const clipboardImageMimeType = (
  type: string,
): ClipboardImageInput["mimeType"] | null =>
  type === "image/png" || type === "image/jpeg" ? type : null;

const IMAGE_FILE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/**
 * Wraps destinations containing whitespace or bracket characters in angle
 * brackets, which CommonMark treats as a literal destination. `<` and `>`
 * cannot appear literally inside angle-bracket destinations, so they are
 * percent-encoded first.
 */
export const escapeMarkdownImageDestination = (path: string): string => {
  if (!/[\s()<>]/.test(path)) return path;
  return `<${path.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
};

export const markdownImageText = (path: string): string =>
  `![image](${escapeMarkdownImageDestination(path)})`;

const insertImageMarkdown = (
  view: EditorView,
  path: string,
  at: number | null,
  userEvent: "input.paste" | "input.drop",
) => {
  const text = markdownImageText(path);
  const from = at ?? view.state.selection.main.from;
  const to = at === null ? view.state.selection.main.to : at;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent,
  });
};

/**
 * Inserts `![image](path)` references for dropped image files in a single
 * undoable transaction at `at` (or the cursor when null). Used by both the
 * native image-drop event and the DOM drop fallback.
 */
export const insertDroppedImages = (
  view: EditorView,
  paths: ReadonlyArray<string>,
  at: number | null,
) => {
  const text = paths.map(markdownImageText).join("\n");
  const from = at ?? view.state.selection.main.head;
  view.dispatch({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
    userEvent: "input.drop",
  });
};

const droppedFilePath = (file: File, transfer: DataTransfer): string | null => {
  // Tauri/Electron-style File objects may carry the absolute source path.
  const carried = (file as File & { path?: string }).path;
  if (carried) return carried;
  const uriList = transfer.getData("text/uri-list").split(/\r?\n/)[0]?.trim();
  if (uriList?.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(uriList).pathname);
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Handles clipboard bitmaps and image file drops. A pasted bitmap is saved
 * through the document port (which shows a save dialog) and inserted as
 * `![image](path)` in a single undoable transaction; cancelling the dialog
 * inserts nothing. Dropped image files are referenced in place, never
 * copied.
 *
 * Note: in the packaged app, Tauri 2's default `dragDropEnabled: true`
 * routes drops to the native window handler (src-tauri/src/lib.rs), which
 * emits `image-files-dropped`; this DOM drop handler is a fallback for
 * environments where HTML5 drops do fire. Dropped `File` objects only
 * carry a usable path on runtimes that inject one (Tauri v1/Electron
 * style) or via a `file://` uri-list.
 */
export const imagePasteExtension = (options: ImagePasteOptions): Extension =>
  EditorView.domEventHandlers({
    paste(event: ClipboardEvent, view: EditorView) {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind !== "file") continue;
        const mimeType = clipboardImageMimeType(item.type);
        if (!mimeType) continue;
        const file = item.getAsFile();
        if (!file) continue;
        event.preventDefault();
        void (async () => {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const path = await options.saveClipboardImage({
              bytes,
              mimeType,
              documentPath: options.getDocumentPath(),
            });
            if (path !== null) insertImageMarkdown(view, path, null, "input.paste");
          } catch (error) {
            options.onError?.(error);
          }
        })();
        return;
      }
    },
    drop(event: DragEvent, view: EditorView) {
      const transfer = event.dataTransfer;
      if (!transfer?.files.length) return;
      const file = [...transfer.files].find(
        (candidate) =>
          candidate.type.startsWith("image/") || IMAGE_FILE_NAME.test(candidate.name),
      );
      if (!file) return;
      const path = droppedFilePath(file, transfer);
      if (!path) return;
      // Swallow the drop even when read-only: letting it through would make
      // the browser navigate to the file, and inserting would bypass the
      // read-only facet (programmatic dispatches are not filtered).
      event.preventDefault();
      if (view.state.readOnly) return;
      const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
      insertDroppedImages(view, [path], at);
    },
  });
