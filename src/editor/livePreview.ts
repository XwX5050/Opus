import { syntaxTree } from "@codemirror/language";
import { StateEffect, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

export type PlannedDecorationKind =
  | "mark"
  | "replace"
  | "horizontal-rule"
  | "list-marker"
  | "task-checkbox";

export interface PlannedDecoration {
  from: number;
  to: number;
  kind: PlannedDecorationKind;
  className?: string;
  displayText?: string;
  checked?: boolean;
}

interface Structure {
  node: SyntaxNode;
}

const structureNames = new Set([
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "InlineCode",
  "Link",
  "Autolink",
  "Blockquote",
  "ListItem",
  "Task",
  "FencedCode",
  "HorizontalRule",
]);

const isHeading = (name: string) =>
  name.startsWith("ATXHeading") || name.startsWith("SetextHeading");

const isStructure = (node: SyntaxNode) =>
  structureNames.has(node.name) || isHeading(node.name);

// Cursor ranges include node.to to keep delimiters visible at the editing edge.
// Non-empty selections use normal half-open overlap semantics.
const selectionIntersects = (state: EditorState, node: SyntaxNode) =>
  state.selection.ranges.some((range) =>
    range.empty
      ? range.from >= node.from && range.from <= node.to
      : range.from < node.to && range.to > node.from,
  );

const classNameFor = (node: SyntaxNode): string | undefined => {
  if (node.name.startsWith("ATXHeading")) {
    return `cm-live-preview-heading-${node.name.slice("ATXHeading".length)}`;
  }
  if (node.name.startsWith("SetextHeading")) {
    return `cm-live-preview-heading-${node.name.slice("SetextHeading".length)}`;
  }
  switch (node.name) {
    case "Emphasis":
      return "cm-live-preview-emphasis";
    case "StrongEmphasis":
      return "cm-live-preview-strong";
    case "Strikethrough":
      return "cm-live-preview-strikethrough";
    case "InlineCode":
      return "cm-live-preview-inline-code";
    case "Link":
    case "Autolink":
      return "cm-live-preview-link";
    case "Blockquote":
      return "cm-live-preview-quote";
    case "FencedCode":
      return "cm-live-preview-code-block";
    default:
      return undefined;
  }
};

const shouldReplace = (owner: Structure, node: SyntaxNode) => {
  switch (owner.node.name) {
    case "Emphasis":
    case "StrongEmphasis":
      return node.name === "EmphasisMark";
    case "Strikethrough":
      return node.name === "StrikethroughMark";
    case "InlineCode":
      return node.name === "CodeMark";
    case "Link":
      // Preview shows the readable label and hides both punctuation and destination.
      return node.name === "LinkMark" || node.name === "URL";
    case "Autolink":
      // An autolink's URL is also its label, so only its angle brackets disappear.
      return node.name === "LinkMark";
    case "Blockquote":
      return node.name === "QuoteMark";
    case "ListItem":
      return node.name === "ListMark";
    case "Task":
      return node.name === "TaskMarker";
    case "FencedCode":
      return node.name === "CodeMark" || node.name === "CodeInfo";
    default:
      return isHeading(owner.node.name) && node.name === "HeaderMark";
  }
};

const rangesContainEachOther = (left: SyntaxNode, right: SyntaxNode) =>
  (left.from <= right.from && left.to >= right.to) ||
  (right.from <= left.from && right.to >= left.to);

export const planLivePreview = (state: EditorState): PlannedDecoration[] => {
  const structures: Structure[] = [];
  const markerCandidates: { owner: Structure; node: SyntaxNode }[] = [];

  const visit = (node: SyntaxNode, parentStructure: Structure | null) => {
    let current = parentStructure;
    if (isStructure(node)) {
      current = { node };
      structures.push(current);
    }
    if (current && shouldReplace(current, node)) {
      markerCandidates.push({ owner: current, node });
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      visit(child, current);
    }
  };
  visit(syntaxTree(state).topNode, null);

  const directlySelected = structures.filter(({ node }) => selectionIntersects(state, node));
  const revealed = (structure: Structure) =>
    directlySelected.some(({ node }) => rangesContainEachOther(structure.node, node));

  const planned: PlannedDecoration[] = [];
  for (const structure of structures) {
    const className = classNameFor(structure.node);
    if (className) {
      planned.push({
        from: structure.node.from,
        to: structure.node.to,
        kind: "mark",
        className,
      });
    }
    if (structure.node.name === "HorizontalRule" && !revealed(structure)) {
      planned.push({
        from: structure.node.from,
        to: structure.node.to,
        kind: "horizontal-rule",
        className: "cm-live-preview-horizontal-rule",
      });
    }
  }
  for (const { owner, node } of markerCandidates) {
    if (!revealed(owner)) {
      const source = state.sliceDoc(node.from, node.to);
      if (owner.node.name === "ListItem") {
        planned.push({
          from: node.from,
          to: node.to,
          kind: "list-marker",
          className: "cm-live-preview-list-marker",
          displayText: source === "-" || source === "+" || source === "*" ? "•" : source,
        });
      } else if (owner.node.name === "Task") {
        planned.push({
          from: node.from,
          to: node.to,
          kind: "task-checkbox",
          className: "cm-live-preview-task-checkbox",
          checked: source === "[x]" || source === "[X]",
        });
      } else {
        planned.push({ from: node.from, to: node.to, kind: "replace" });
      }
    }
  }

  const unique = new Map<string, PlannedDecoration>();
  for (const item of planned) {
    if (item.from >= 0 && item.to > item.from && item.to <= state.doc.length) {
      unique.set(
        `${item.kind}:${item.from}:${item.to}:${item.className ?? ""}:${item.displayText ?? ""}:${item.checked ?? ""}`,
        item,
      );
    }
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.from - right.from ||
      left.to - right.to ||
      left.kind.localeCompare(right.kind),
  );
};

class HorizontalRuleWidget extends WidgetType {
  eq(other: WidgetType) {
    return other instanceof HorizontalRuleWidget;
  }

  toDOM() {
    const rule = document.createElement("span");
    rule.className = "cm-live-preview-horizontal-rule";
    rule.setAttribute("role", "presentation");
    rule.setAttribute("aria-hidden", "true");
    return rule;
  }

  destroy(_dom: HTMLElement) {
    // The widget owns no external resources. CodeMirror removes its DOM node.
  }

  ignoreEvent() {
    return true;
  }
}

class ListMarkerWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  eq(other: WidgetType) {
    return other instanceof ListMarkerWidget && other.text === this.text;
  }

  toDOM() {
    const marker = document.createElement("span");
    marker.className = "cm-live-preview-list-marker";
    marker.textContent = this.text;
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }

  destroy(_dom: HTMLElement) {}

  ignoreEvent() {
    return true;
  }
}

class TaskCheckboxWidget extends WidgetType {
  constructor(private readonly checked: boolean) {
    super();
  }

  eq(other: WidgetType) {
    return other instanceof TaskCheckboxWidget && other.checked === this.checked;
  }

  toDOM() {
    const checkbox = document.createElement("input");
    checkbox.className = "cm-live-preview-task-checkbox";
    checkbox.type = "checkbox";
    checkbox.checked = this.checked;
    checkbox.disabled = true;
    checkbox.tabIndex = -1;
    checkbox.setAttribute("aria-hidden", "true");
    return checkbox;
  }

  destroy(_dom: HTMLElement) {}

  ignoreEvent() {
    return true;
  }
}

const decorationsFor = (state: EditorState): DecorationSet => {
  const decorations = planLivePreview(state).map((item) => {
    if (item.kind === "mark") {
      return Decoration.mark({ class: item.className }).range(item.from, item.to);
    }
    if (item.kind === "horizontal-rule") {
      return Decoration.replace({ widget: new HorizontalRuleWidget() }).range(
        item.from,
        item.to,
      );
    }
    if (item.kind === "list-marker") {
      return Decoration.replace({
        widget: new ListMarkerWidget(item.displayText ?? "•"),
      }).range(item.from, item.to);
    }
    if (item.kind === "task-checkbox") {
      return Decoration.replace({
        widget: new TaskCheckboxWidget(item.checked ?? false),
      }).range(item.from, item.to);
    }
    return Decoration.replace({}).range(item.from, item.to);
  });
  return Decoration.set(decorations, true);
};

const refreshLivePreview = StateEffect.define<null>();

class LivePreviewPlugin {
  decorations: DecorationSet;
  private composing = false;

  constructor(view: EditorView) {
    this.decorations = decorationsFor(view.state);
  }

  update(update: ViewUpdate) {
    if (this.composing) {
      this.decorations = Decoration.none;
      return;
    }
    const syntaxChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
    const explicitlyRefreshed = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(refreshLivePreview)),
    );
    if (
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      syntaxChanged ||
      explicitlyRefreshed
    ) {
      this.decorations = decorationsFor(update.state);
    }
  }

  startComposition(view: EditorView) {
    this.composing = true;
    this.decorations = Decoration.none;
    view.dispatch({ effects: refreshLivePreview.of(null) });
  }

  endComposition(view: EditorView) {
    this.composing = false;
    this.decorations = decorationsFor(view.state);
    view.dispatch({ effects: refreshLivePreview.of(null) });
  }
}

const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (plugin) => plugin.decorations,
  eventHandlers: {
    compositionstart(_event, view) {
      this.startComposition(view);
    },
    compositionupdate(_event, view) {
      this.startComposition(view);
    },
    compositionend(_event, view) {
      this.endComposition(view);
    },
  },
});

const livePreviewTheme = EditorView.baseTheme({
  ".cm-live-preview-heading-1": { fontSize: "1.6em", fontWeight: "700" },
  ".cm-live-preview-heading-2": { fontSize: "1.4em", fontWeight: "700" },
  ".cm-live-preview-heading-3": { fontSize: "1.2em", fontWeight: "700" },
  ".cm-live-preview-heading-4, .cm-live-preview-heading-5, .cm-live-preview-heading-6": {
    fontWeight: "700",
  },
  ".cm-live-preview-strong": { fontWeight: "700" },
  ".cm-live-preview-emphasis": { fontStyle: "italic" },
  ".cm-live-preview-strikethrough": { textDecoration: "line-through" },
  ".cm-live-preview-inline-code, .cm-live-preview-code-block": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  ".cm-live-preview-inline-code": {
    backgroundColor: "rgba(127, 127, 127, 0.12)",
    borderRadius: "0.2em",
  },
  ".cm-live-preview-quote": {
    borderLeft: "0.2em solid rgba(127, 127, 127, 0.45)",
  },
  ".cm-live-preview-link": { textDecoration: "underline" },
  ".cm-live-preview-list-marker": {
    display: "inline-block",
    minWidth: "1em",
  },
  ".cm-live-preview-task-checkbox": {
    margin: "0 0.25em 0 0",
    pointerEvents: "none",
  },
  ".cm-live-preview-horizontal-rule": {
    borderTop: "1px solid rgba(127, 127, 127, 0.45)",
    display: "inline-block",
    width: "100%",
  },
});

export const livePreviewExtension = (): Extension => [
  livePreviewPlugin,
  livePreviewTheme,
];
