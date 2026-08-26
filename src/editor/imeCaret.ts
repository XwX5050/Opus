import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { detectPathPlatform } from "../document/platform";

/**
 * WebKitGTK + fcitx5 composition caret workaround (Linux native only).
 *
 * During an IME composition the platform never renders a caret inside the
 * marked (preedit) text — verified with a plain contenteditable — and the DOM
 * selection it reports sits one character into the composition rather than at
 * its end. The editor's drawn caret follows that reported selection, so it
 * would appear after the first preedit letter. While a composition is active
 * this plugin hides the regular caret layer (via the `cm-ime-composing`
 * class) and positions a plain caret element at the end of the preedit text
 * node, read straight from the live DOM (`compositionupdate` is not reliably
 * fired for every preedit change under WebKitGTK, so the DOM is the only
 * trustworthy source). Committed text and the post-composition selection are
 * untouched.
 */
const compositionCaretPlugin = ViewPlugin.fromClass(
  class {
    private composing = false;
    private caret: HTMLElement | null = null;
    private readonly onReposition = () => this.positionCaret();

    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate) {
      if (this.composing && (update.docChanged || update.geometryChanged)) {
        this.positionCaret();
      }
    }

    startComposition() {
      if (this.composing) return;
      this.composing = true;
      this.view.dom.classList.add("cm-ime-composing");
      this.caret = document.createElement("div");
      this.caret.className = "cm-ime-caret";
      document.body.appendChild(this.caret);
      this.view.scrollDOM.addEventListener("scroll", this.onReposition);
      // WebKitGTK sometimes grows the preedit without a compositionupdate;
      // selectionchange always accompanies those mutations.
      document.addEventListener("selectionchange", this.onReposition);
      this.positionCaret();
    }

    endComposition() {
      if (!this.composing) return;
      this.composing = false;
      this.view.dom.classList.remove("cm-ime-composing");
      this.view.scrollDOM.removeEventListener("scroll", this.onReposition);
      document.removeEventListener("selectionchange", this.onReposition);
      this.caret?.remove();
      this.caret = null;
    }

    positionCaret() {
      if (!this.caret) return;
      // The platform keeps the (wrong) DOM selection inside the preedit text
      // node, so the node itself is easy to find; its end is where the caret
      // belongs while typing. Composing mid-line makes WebKit split the line
      // text around the marked range, so the preedit owns its node.
      const node = window.getSelection()?.focusNode ?? null;
      if (
        !node ||
        node.nodeType !== Node.TEXT_NODE ||
        !this.view.contentDOM.contains(node)
      ) {
        this.caret.style.display = "none";
        return;
      }
      const range = document.createRange();
      range.setStart(node, (node.textContent ?? "").length);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      if (rect.height === 0 && rect.top === 0 && rect.left === 0) {
        this.caret.style.display = "none";
        return;
      }
      this.caret.style.display = "";
      this.caret.style.left = `${rect.left}px`;
      this.caret.style.top = `${rect.top}px`;
      this.caret.style.height = `${rect.height}px`;
    }

    destroy() {
      this.view.scrollDOM.removeEventListener("scroll", this.onReposition);
      document.removeEventListener("selectionchange", this.onReposition);
      this.caret?.remove();
    }
  },
  {
    eventHandlers: {
      compositionstart() {
        this.startComposition();
      },
      compositionupdate() {
        this.startComposition();
        this.positionCaret();
      },
      compositionend() {
        this.endComposition();
      },
      blur() {
        // If focus leaves mid-composition without a compositionend, drop the
        // caret; a later compositionupdate restarts it.
        this.endComposition();
      },
    },
  },
);

/** Linux-native-only composition caret workaround; empty extension elsewhere. */
export const imeCaretExtension = (): Extension =>
  detectPathPlatform() === "linux" && "__TAURI_INTERNALS__" in window
    ? compositionCaretPlugin
    : [];
