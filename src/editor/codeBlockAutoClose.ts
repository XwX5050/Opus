import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";

// Typing assists that are STRICTLY scoped to fenced code blocks:
//
// - Fence auto-close: typing the third backtick on a bare "``" line opens a
//   fenced block and puts the closing fence on the next line (also for "~~").
//   A fence typed inside an already-open block is a closing fence, and a
//   closing fence already below means the user is wrapping existing content —
//   both leave the text alone.
// - Pair auto-close: ( [ { " ' insert their closers with the cursor between,
//   a closer typed before the same char steps over it, an opener with a
//   selection wraps it, and Backspace between an empty pair deletes both.
//   Backticks are never paired (they belong to the fence logic).
//
// Everything is gated on the syntax tree so prose paragraphs, inline code,
// and every other construct keep their exact current behavior.
//
// With more than one cursor both assists stand down: the input handler is
// handed the main selection's insertion only, so taking the input over would
// drop the keystroke at every other cursor, and the Backspace command would
// do the same for the deletion. Multi-cursor editing keeps the default
// behavior, which covers all of them.

const FENCE_LENGTH = 3;
const FENCE_CHARS = new Set(["`", "~"]);

// The closing match for each opener; quotes close onto themselves.
const PAIRS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  '"': '"',
  "'": "'",
};
const CLOSERS = new Set([")", "]", "}"]);

// The tree check runs on every managed keystroke, so its parse budget must
// stay small: on a huge unparsed document the assist skips (plain typing)
// instead of blocking on a full parse. The return value of the parse is
// authoritative — when the tree cannot be produced we never guess.
const TREE_PARSE_BUDGET = 100;

const insideFencedCode = (tree: Tree, pos: number): boolean => {
  let node: SyntaxNode | null = tree.resolveInner(pos, 0);
  while (node) {
    if (node.name === "FencedCode") return true;
    node = node.parent;
  }
  return false;
};

// The whole selection must live inside a FencedCode node; a wrap that
// crosses the closing fence would corrupt the block, so it falls through.
const selectionInsideFencedCode = (
  state: EditorState,
  from: number,
  to: number,
): boolean => {
  const tree = ensureSyntaxTree(state, Math.max(from, to), TREE_PARSE_BUDGET);
  if (!tree) return false;
  return insideFencedCode(tree, from) && insideFencedCode(tree, to);
};

// Any line below (same fence char, run >= the opening length, ignoring
// surrounding whitespace) counts as an existing closing fence.
const closingFenceBelow = (
  state: EditorState,
  firstLine: number,
  char: string,
): boolean => {
  for (let number = firstLine + 1; number <= state.doc.lines; number += 1) {
    const text = state.doc.line(number).text.trim();
    if (text.length >= FENCE_LENGTH && text === char.repeat(text.length)) {
      return true;
    }
  }
  return false;
};

// Feature 1: completes a bare fence line with its closing fence. Returns
// true only when it takes the input over; every other case lets the default
// insertion proceed untouched.
const autoCloseFence = (
  view: EditorView,
  from: number,
  to: number,
  text: string,
): boolean => {
  const state = view.state;
  if (from !== to) return false;
  const line = state.doc.lineAt(from);
  if (from !== line.to) return false;
  // CodeMirror normalizes CRLF to LF inside the document (newline style is
  // preserved at the file-I/O boundary), so the bare line text is the match.
  if (line.text !== text.repeat(FENCE_LENGTH - 1)) return false;
  // Inside an open block the typed fence is its closing fence — adding
  // another after it would leave a dangling opener behind.
  if (selectionInsideFencedCode(state, from, to)) return false;
  // A closing fence below means the user is wrapping existing content.
  if (closingFenceBelow(state, line.number, text)) return false;
  view.dispatch({
    changes: {
      from,
      to,
      insert: `${text}\n${text.repeat(FENCE_LENGTH)}`,
    },
    // The cursor stays at the end of the opening fence so a language name
    // can be typed before Enter drops into the block.
    selection: { anchor: from + 1 },
    userEvent: "input.type",
    scrollIntoView: true,
  });
  return true;
};

// Feature 2: pair behavior inside fenced code, called only when the typed
// character is a managed opener or closer.
const autoClosePair = (
  view: EditorView,
  from: number,
  to: number,
  text: string,
): boolean => {
  const state = view.state;
  if (!selectionInsideFencedCode(state, from, to)) return false;
  if (CLOSERS.has(text)) {
    // Typeover: a closer typed directly before the same char steps past it.
    if (from !== to || state.sliceDoc(from, from + 1) !== text) return false;
    view.dispatch({
      selection: { anchor: from + 1 },
      userEvent: "input.type",
      scrollIntoView: true,
    });
    return true;
  }
  const closer = PAIRS[text];
  const main = state.selection.main;
  if (from !== to) {
    // An opener wraps the selection, which stays selected.
    view.dispatch({
      changes: { from, to, insert: text + state.sliceDoc(from, to) + closer },
      selection: { anchor: main.anchor + 1, head: main.head + 1 },
      userEvent: "input.type",
      scrollIntoView: true,
    });
    return true;
  }
  // Quotes stay plain right after a word character (apostrophes, closing
  // quotes); everywhere else they insert their pair.
  if ((text === '"' || text === "'") && from > 0 && /\w/.test(state.sliceDoc(from - 1, from))) {
    return false;
  }
  view.dispatch({
    changes: { from, to, insert: text + closer },
    selection: { anchor: from + 1 },
    userEvent: "input.type",
    scrollIntoView: true,
  });
  return true;
};

/** Input handler for both typing assists; mirrors the facet's contract. */
export const codeBlockAutoCloseInput = (
  view: EditorView,
  from: number,
  to: number,
  text: string,
): boolean => {
  // The IME guard mirrors livePreview.ts: never dispatch while a
  // composition is active, or the composing caret breaks (WebKitGTK).
  if (view.compositionStarted || view.state.readOnly) return false;
  if (text.length !== 1) return false;
  // The facet reports the insertion of the main selection only. With several
  // cursors a dispatch here would consume the input and leave every other
  // cursor without its character, so multi-cursor input always takes the
  // default path — which inserts at all of them.
  if (view.state.selection.ranges.length > 1) return false;
  // The DOM-reported insertion and the main selection must agree; anything
  // else is a strange input state the assists should not second-guess.
  const main = view.state.selection.main;
  if (from !== main.from || to !== main.to) return false;
  if (FENCE_CHARS.has(text)) return autoCloseFence(view, from, to, text);
  if (!PAIRS[text] && !CLOSERS.has(text)) return false;
  return autoClosePair(view, from, to, text);
};

/** Backspace between an empty pair inside fenced code deletes both chars. */
export const codeBlockAutoCloseBackspace = (view: EditorView): boolean => {
  if (view.compositionStarted || view.state.readOnly) return false;
  const state = view.state;
  // Same rule as the input handler: deleting the pair at the main cursor
  // would swallow Backspace at every other cursor.
  if (state.selection.ranges.length > 1) return false;
  const range = state.selection.main;
  if (!range.empty) return false;
  const closer = PAIRS[state.sliceDoc(range.from - 1, range.from)];
  if (!closer) return false;
  if (state.sliceDoc(range.from, range.from + 1) !== closer) return false;
  if (!selectionInsideFencedCode(state, range.from, range.from)) return false;
  view.dispatch({
    changes: { from: range.from - 1, to: range.from + 1 },
    selection: { anchor: range.from - 1 },
    userEvent: "delete.backward",
    scrollIntoView: true,
  });
  return true;
};

/**
 * Install the code-block typing assists. The Backspace binding must stay
 * ahead of `markdownKeymap`/`defaultKeymap` (both bind Backspace), which the
 * extension wiring in editorExtensions.ts does by placing this before the
 * shared keymap block — kept together here so the precedence is visible.
 */
export const codeBlockAutoClose = (): Extension => [
  EditorView.inputHandler.of(codeBlockAutoCloseInput),
  keymap.of([{ key: "Backspace", run: codeBlockAutoCloseBackspace }]),
];