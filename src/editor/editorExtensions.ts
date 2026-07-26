import {
  defaultKeymap,
  history,
  historyKeymap,
} from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
} from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { mathMarkdownExtension } from "./mathExtension";

export interface EditorCommands {
  onSave(): void;
  onReopenClosed(): void;
  onToggleReading(): void;
}

// Syntax colors resolve through the design-token cascade (see
// theme/tokens.css), so a single style serves both themes — CodeMirror
// injects these declarations, and `var()` follows `[data-theme]` on <html>.
const editorHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--text-primary)", fontWeight: "650" },
  { tag: tags.strong, fontWeight: "650" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--accent)" },
  { tag: tags.keyword, color: "var(--syntax-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syntax-string)" },
  { tag: tags.comment, color: "var(--syntax-comment)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
  { tag: [tags.typeName, tags.className, tags.tagName], color: "var(--syntax-type)" },
  { tag: [tags.processingInstruction, tags.meta], color: "var(--syntax-meta)" },
]);

// Open the search panel and move focus into its replace field.
const openSearchPanelForReplace = (view: EditorView): boolean => {
  openSearchPanel(view);
  const replace = view.dom.querySelector<HTMLInputElement>(
    '.cm-panel.cm-search input[name="replace"]',
  );
  if (replace) {
    replace.focus();
    replace.select();
  }
  return true;
};

export const editorExtensions = (
  commands: EditorCommands,
  livePreview: Extension = [],
): Extension => [
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(editorHighlightStyle, { fallback: true }),
  bracketMatching(),
  EditorView.lineWrapping,
  markdown({
    codeLanguages: languages,
    extensions: [GFM, mathMarkdownExtension],
    addKeymap: false,
  }),
  livePreview,
  search({ top: true }),
  keymap.of([
    {
      key: "Mod-e",
      preventDefault: true,
      run: () => {
        commands.onToggleReading();
        return true;
      },
    },
    {
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        commands.onSave();
        return true;
      },
    },
    {
      key: "Mod-Shift-t",
      preventDefault: true,
      run: () => {
        commands.onReopenClosed();
        return true;
      },
    },
    {
      key: "Mod-Alt-f",
      preventDefault: true,
      scope: "editor search-panel",
      run: openSearchPanelForReplace,
    },
    ...markdownKeymap,
    ...defaultKeymap,
    ...historyKeymap,
    ...searchKeymap,
  ]),
];
