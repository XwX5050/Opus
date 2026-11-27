import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Chinese copy for `@codemirror/search`. The search panel reads these keys
 * once, when the panel is built, so the whole find/replace surface — fields,
 * checkboxes, buttons, close control and the screen-reader announcements —
 * speaks the product language instead of CodeMirror's English defaults.
 */
export const searchPanelPhrases: Readonly<Record<string, string>> = {
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全选",
  "match case": "区分大小写",
  regexp: "正则表达式",
  "by word": "全字匹配",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "Go to line": "跳转到行",
  go: "转到",
  "current match": "当前匹配",
  "on line": "，行号",
  "replaced match on line $": "已替换第 $ 行的匹配",
  "replaced $ matches": "已替换 $ 处匹配",
};

/**
 * Token-driven skin for the built-in search panel.
 *
 * CodeMirror's base theme gives its form controls 70% font sizes, silver
 * borders, a white field and light/dark linear-gradient buttons. Those base
 * rules are class-prefixed (`.ͼX .cm-button`, `.ͼX .cm-textfield`) and the
 * panel button rule in `app.css` is weaker still, so a plain class-level
 * override would lose the cascade. Every selector here includes the panel or
 * field classes, which makes the theme's `EditorView.theme` prefix enough to
 * win on specificity without `!important`.
 *
 * All colors resolve through design tokens, so the same rules serve both
 * themes: flipping `[data-theme]` on <html> repaints the panel through the
 * CSS variable cascade and never needs a reconfiguration of the EditorView
 * (IME state, selection and undo history stay untouched). No `&light` or
 * `&dark` branches are used — CodeMirror would otherwise keep a stale
 * light/dark look until the view were rebuilt.
 */
export const searchPanelTheme: Extension = EditorView.theme({
  ".cm-panels": {
    backgroundColor: "var(--surface)",
    color: "var(--text-primary)",
    borderBottom: "1px solid var(--divider)",
    fontFamily: "var(--font-ui)",
    fontSize: "13px",
  },
  ".cm-panel.cm-search": {
    position: "relative",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "6px",
    rowGap: "4px",
    padding: "8px 44px 8px 12px",
    backgroundColor: "var(--surface)",
    color: "var(--text-primary)",
    fontFamily: "var(--font-ui)",
    fontSize: "13px",
    lineHeight: "1.4",
  },
  // The stock panel separates the search row from the replace row with a
  // bare <br>. Flex layout ignores it (a <br> is not laid out as an ordinary
  // flex item), so hide it and force the break with a generated full-basis
  // item placed between the two groups by `order`.
  ".cm-panel.cm-search br": {
    display: "none",
  },
  ".cm-panel.cm-search::after": {
    content: '""',
    order: "1",
    flex: "0 0 100%",
    height: "0",
    margin: "0",
  },
  ".cm-panel.cm-search input[name=replace]": {
    order: "2",
  },
  ".cm-panel.cm-search button[name=replace]": {
    order: "2",
  },
  ".cm-panel.cm-search button[name=replaceAll]": {
    order: "2",
  },
  ".cm-panel.cm-search input.cm-textfield": {
    flex: "1 1 180px",
    minWidth: "140px",
    height: "28px",
    margin: "0",
    padding: "0 8px",
    border: "1px solid var(--divider)",
    borderRadius: "var(--radius-small)",
    backgroundColor: "var(--canvas)",
    color: "var(--text-primary)",
    fontFamily: "var(--font-ui)",
    fontSize: "13px",
    lineHeight: "26px",
    boxSizing: "border-box",
  },
  ".cm-panel.cm-search input.cm-textfield::placeholder": {
    color: "var(--text-muted)",
    opacity: "1",
  },
  ".cm-panel.cm-search input.cm-textfield:hover": {
    borderColor: "var(--text-muted)",
  },
  ".cm-panel.cm-search input.cm-textfield:focus": {
    borderColor: "var(--focus-ring)",
  },
  ".cm-panel.cm-search input.cm-textfield:focus-visible": {
    outline: "none",
    boxShadow: "inset 0 0 0 1px var(--focus-ring)",
  },
  ".cm-panel.cm-search button.cm-button": {
    flex: "0 0 auto",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: "26px",
    minWidth: "26px",
    margin: "0",
    padding: "0 10px",
    border: "1px solid transparent",
    borderRadius: "var(--radius-small)",
    backgroundColor: "var(--surface-hover)",
    backgroundImage: "none",
    boxShadow: "none",
    color: "var(--text-primary)",
    fontFamily: "var(--font-ui)",
    fontSize: "12px",
    lineHeight: "1",
    textTransform: "none",
  },
  ".cm-panel.cm-search button.cm-button:hover": {
    backgroundColor: "var(--surface-active)",
    backgroundImage: "none",
  },
  ".cm-panel.cm-search button.cm-button:active": {
    backgroundColor: "var(--surface-active)",
    backgroundImage: "none",
  },
  ".cm-panel.cm-search button.cm-button:focus-visible": {
    outline: "2px solid var(--focus-ring)",
    outlineOffset: "1px",
    backgroundImage: "none",
  },
  ".cm-panel.cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    minHeight: "24px",
    margin: "0",
    padding: "0 4px",
    color: "var(--text-secondary)",
    fontFamily: "var(--font-ui)",
    fontSize: "12px",
    lineHeight: "1.4",
    whiteSpace: "nowrap",
  },
  ".cm-panel.cm-search label:hover": {
    color: "var(--text-primary)",
  },
  ".cm-panel.cm-search label:focus-within": {
    color: "var(--text-primary)",
  },
  ".cm-panel.cm-search input[type=checkbox]": {
    width: "15px",
    height: "15px",
    margin: "0",
    accentColor: "var(--accent)",
  },
  ".cm-panel.cm-search [name=close]": {
    position: "absolute",
    top: "8px",
    right: "8px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "26px",
    height: "26px",
    minWidth: "26px",
    margin: "0",
    padding: "0",
    border: "1px solid transparent",
    borderRadius: "var(--radius-small)",
    backgroundColor: "transparent",
    backgroundImage: "none",
    boxShadow: "none",
    color: "var(--text-secondary)",
    fontFamily: "var(--font-ui)",
    fontSize: "18px",
    lineHeight: "1",
  },
  ".cm-panel.cm-search [name=close]:hover": {
    backgroundColor: "var(--surface-active)",
    color: "var(--text-primary)",
  },
  ".cm-panel.cm-search [name=close]:active": {
    backgroundColor: "var(--surface-active)",
  },
  ".cm-panel.cm-search [name=close]:focus-visible": {
    outline: "2px solid var(--focus-ring)",
    outlineOffset: "1px",
    color: "var(--text-primary)",
  },
  // The search package only tints matches through its base theme's fixed
  // yellow/cyan literals; the token colors need the same specificity here.
  ".cm-searchMatch": {
    backgroundColor: "var(--search-match)",
    borderRadius: "var(--radius-small)",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "var(--accent-soft)",
    boxShadow: "inset 0 -2px 0 var(--accent)",
  },
});

/**
 * Search panel copy and skin. `editorExtensions` includes this by default so
 * every host (document editor, presentation preview) renders the same
 * localized panel without extra wiring.
 */
export const searchPanelExtensions: Extension = [
  EditorState.phrases.of(searchPanelPhrases),
  searchPanelTheme,
];
