import {
  defaultKeymap,
  history,
  historyKeymap,
} from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
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
}

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
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
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
