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

export interface LivePreviewRange {
  from: number;
  to: number;
}

export interface LivePreviewDiagnostics {
  visitedNodes: number;
}

interface Structure {
  node: SyntaxNode;
}

interface MarkerNode {
  from: number;
  to: number;
  name: string;
}

const structureNames = new Set([
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "InlineCode",
  "Link",
  "Autolink",
  "LinkReference",
  "Blockquote",
  "ListItem",
  "Task",
  "FencedCode",
  "HorizontalRule",
]);

const isHeading = (name: string) =>
  name.startsWith("ATXHeading") || name.startsWith("SetextHeading");

const linkContainerNames = new Set(["Link", "Autolink", "LinkReference"]);

const isStructure = (node: SyntaxNode, ancestorNames: readonly string[]) =>
  structureNames.has(node.name) ||
  isHeading(node.name) ||
  (node.name === "URL" &&
    !ancestorNames.some((name) => linkContainerNames.has(name)));

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
    case "URL":
      return "cm-live-preview-link";
    case "LinkReference":
      return "cm-live-preview-reference-definition";
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
      return (
        node.name === "LinkMark" ||
        node.name === "URL" ||
        node.name === "LinkTitle" ||
        node.name === "LinkLabel"
      );
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

const normalizeRanges = (
  docLength: number,
  ranges: readonly LivePreviewRange[] | undefined,
): LivePreviewRange[] => {
  if (docLength === 0) return [];
  const requested = ranges ?? [{ from: 0, to: docLength }];
  const normalized = requested
    .map((range) => {
      let from = Math.max(0, Math.min(range.from, range.to, docLength));
      let to = Math.max(0, Math.min(Math.max(range.from, range.to), docLength));
      if (from === to) {
        if (to < docLength) to += 1;
        else from -= 1;
      }
      return { from, to };
    })
    .filter(({ from, to }) => from >= 0 && to > from)
    .sort((left, right) => left.from - right.from || left.to - right.to);

  const merged: LivePreviewRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
};

export const planLivePreview = (
  state: EditorState,
  ranges?: readonly LivePreviewRange[],
  diagnostics?: LivePreviewDiagnostics,
): PlannedDecoration[] => {
  const structures: Structure[] = [];
  const markerCandidates: { owner: Structure; node: MarkerNode }[] = [];
  const tree = syntaxTree(state);

  for (const range of normalizeRanges(state.doc.length, ranges)) {
    const nodeNames: string[] = [];
    const structureStack: Structure[] = [];
    const createdStructure: boolean[] = [];
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(nodeRef) {
        if (diagnostics) diagnostics.visitedNodes += 1;
        const node = nodeRef.node;
        const createsStructure = isStructure(node, nodeNames);
        nodeNames.push(node.name);
        createdStructure.push(createsStructure);
        if (createsStructure) {
          const structure = { node };
          structures.push(structure);
          structureStack.push(structure);
        }
        const current = structureStack.at(-1);
        if (current && shouldReplace(current, node)) {
          markerCandidates.push({ owner: current, node });
        }
      },
      leave() {
        nodeNames.pop();
        if (createdStructure.pop()) structureStack.pop();
      },
    });
  }

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
  const markersByOwner = new Map<Structure, MarkerNode[]>();
  for (const { owner, node } of markerCandidates) {
    const markers = markersByOwner.get(owner) ?? [];
    markers.push(node);
    markersByOwner.set(owner, markers);
  }
  const effectiveMarkerCandidates: { owner: Structure; node: MarkerNode }[] = [];
  for (const [owner, markers] of markersByOwner) {
    if (owner.node.name === "Link") {
      const opening = markers.find(
        (node) => node.name === "LinkMark" && state.sliceDoc(node.from, node.to) === "(",
      );
      const closing = markers.find(
        (node) => node.name === "LinkMark" && state.sliceDoc(node.from, node.to) === ")",
      );
      if (opening && closing) {
        for (const node of markers) {
          if (node.to <= opening.from || node.from >= closing.to) {
            effectiveMarkerCandidates.push({ owner, node });
          }
        }
        effectiveMarkerCandidates.push({
          owner,
          node: { from: opening.from, to: closing.to, name: "LinkDestination" },
        });
        continue;
      }
    }
    for (const node of markers) effectiveMarkerCandidates.push({ owner, node });
  }

  for (const { owner, node } of effectiveMarkerCandidates) {
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
    rule.setAttribute("role", "separator");
    rule.setAttribute("aria-label", "分隔线");
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
    marker.setAttribute("role", "listitem");
    marker.setAttribute(
      "aria-label",
      this.text === "•" ? "项目符号" : `列表序号 ${this.text}`,
    );
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
    checkbox.setAttribute("role", "checkbox");
    checkbox.setAttribute("aria-checked", String(this.checked));
    checkbox.setAttribute("aria-disabled", "true");
    checkbox.setAttribute("aria-label", this.checked ? "已完成任务" : "未完成任务");
    return checkbox;
  }

  destroy(_dom: HTMLElement) {}

  ignoreEvent() {
    return true;
  }
}

const planningRanges = (view: EditorView): LivePreviewRange[] => [
  ...view.visibleRanges,
  ...view.state.selection.ranges.map(({ from, to }) => ({ from, to })),
];

const decorationSetsFor = (
  state: EditorState,
  ranges?: readonly LivePreviewRange[],
): { decorations: DecorationSet; atomicRanges: DecorationSet } => {
  const decorations: ReturnType<Decoration["range"]>[] = [];
  const atomicRanges: ReturnType<Decoration["range"]>[] = [];
  for (const item of planLivePreview(state, ranges)) {
    let decoration: ReturnType<Decoration["range"]>;
    if (item.kind === "mark") {
      decorations.push(
        Decoration.mark({ class: item.className }).range(item.from, item.to),
      );
      continue;
    } else if (item.kind === "horizontal-rule") {
      decoration = Decoration.replace({ widget: new HorizontalRuleWidget() }).range(
        item.from,
        item.to,
      );
    } else if (item.kind === "list-marker") {
      decoration = Decoration.replace({
        widget: new ListMarkerWidget(item.displayText ?? "•"),
      }).range(item.from, item.to);
    } else if (item.kind === "task-checkbox") {
      decoration = Decoration.replace({
        widget: new TaskCheckboxWidget(item.checked ?? false),
      }).range(item.from, item.to);
    } else {
      let from = item.from;
      while (from < item.to) {
        const line = state.doc.lineAt(from);
        const to = Math.min(item.to, line.to);
        if (to > from) {
          const segment = Decoration.replace({}).range(from, to);
          decorations.push(segment);
          atomicRanges.push(segment);
        }
        if (to === item.to) break;
        from = line.to + 1;
      }
      continue;
    }
    decorations.push(decoration);
    atomicRanges.push(decoration);
  }
  return {
    decorations: Decoration.set(decorations, true),
    atomicRanges: Decoration.set(atomicRanges, true),
  };
};

const refreshLivePreview = StateEffect.define<null>();

class LivePreviewPlugin {
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
  private composing: boolean;

  constructor(view: EditorView) {
    this.composing = view.compositionStarted;
    if (this.composing) {
      this.decorations = Decoration.none;
      this.atomicRanges = Decoration.none;
    } else {
      const sets = decorationSetsFor(view.state, planningRanges(view));
      this.decorations = sets.decorations;
      this.atomicRanges = sets.atomicRanges;
    }
  }

  update(update: ViewUpdate) {
    if (this.composing) {
      this.decorations = Decoration.none;
      this.atomicRanges = Decoration.none;
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
      const sets = decorationSetsFor(update.state, planningRanges(update.view));
      this.decorations = sets.decorations;
      this.atomicRanges = sets.atomicRanges;
    }
  }

  startComposition(view: EditorView) {
    this.composing = true;
    this.decorations = Decoration.none;
    this.atomicRanges = Decoration.none;
    view.dispatch({ effects: refreshLivePreview.of(null) });
  }

  endComposition(view: EditorView) {
    this.composing = false;
    const sets = decorationSetsFor(view.state, planningRanges(view));
    this.decorations = sets.decorations;
    this.atomicRanges = sets.atomicRanges;
    view.dispatch({ effects: refreshLivePreview.of(null) });
  }
}

const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (plugin) => plugin.decorations,
  provide: (plugin) =>
    EditorView.atomicRanges.of(
      (view) => view.plugin(plugin)?.atomicRanges ?? Decoration.none,
    ),
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
    backgroundColor: "var(--surface)",
    borderRadius: "0.2em",
  },
  ".cm-live-preview-quote": {
    borderLeft: "0.2em solid var(--text-muted)",
  },
  ".cm-live-preview-link": { textDecoration: "underline" },
  ".cm-live-preview-reference-definition": { opacity: "0.75" },
  ".cm-live-preview-list-marker": {
    display: "inline-block",
    minWidth: "1em",
  },
  ".cm-live-preview-task-checkbox": {
    margin: "0 0.25em 0 0",
    pointerEvents: "none",
  },
  ".cm-live-preview-horizontal-rule": {
    borderTop: "1px solid var(--divider)",
    display: "inline-block",
    width: "100%",
  },
});

export const livePreviewExtension = (): Extension => [
  livePreviewPlugin,
  livePreviewTheme,
];
