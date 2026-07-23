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
import { searchKeymap } from "@codemirror/search";
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
    ...markdownKeymap,
    ...defaultKeymap,
    ...historyKeymap,
    ...searchKeymap,
  ]),
];
