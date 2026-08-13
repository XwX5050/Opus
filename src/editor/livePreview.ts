import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { FrontMatter } from "./frontmatterExtension";
import { Highlight, HighlightMark } from "./highlightExtension";

export type PlannedDecorationKind =
  | "mark"
  | "line"
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

const markerRangeForPreview = (
  state: EditorState,
  owner: Structure,
  node: MarkerNode,
): MarkerNode => {
  if (!owner.node.name.startsWith("ATXHeading") || node.name !== "HeaderMark") {
    return node;
  }
  const line = state.doc.lineAt(node.to);
  let to = node.to;
  while (to < line.to && /[ \t]/.test(state.sliceDoc(to, to + 1))) to += 1;
  return { ...node, to };
};

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
  "FrontMatter",
  Highlight,
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
    case Highlight:
      return "cm-live-preview-highlight";
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
    case "FrontMatter":
      return "cm-live-preview-frontmatter";
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
    case Highlight:
      return node.name === HighlightMark;
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

const quoteLinePlans = (
  state: EditorState,
  structure: Structure,
  requestedRanges: readonly LivePreviewRange[],
): PlannedDecoration[] => {
  const blockFirst = state.doc.lineAt(structure.node.from);
  const blockLast = state.doc.lineAt(
    Math.max(structure.node.from, structure.node.to - 1),
  );
  const plans: PlannedDecoration[] = [];
  for (const range of requestedRanges) {
    const overlapFrom = Math.max(structure.node.from, range.from);
    const overlapTo = Math.min(structure.node.to, range.to);
    if (overlapFrom >= overlapTo) continue;
    const visibleFirst = state.doc.lineAt(overlapFrom);
    const visibleLast = state.doc.lineAt(
      Math.max(overlapFrom, overlapTo - 1),
    );
    for (
      let number = visibleFirst.number;
      number <= visibleLast.number;
      number += 1
    ) {
      const line = state.doc.line(number);
      const position =
        blockFirst.number === blockLast.number
          ? "single"
          : number === blockFirst.number
            ? "first"
            : number === blockLast.number
              ? "last"
              : "middle";
      plans.push({
        from: line.from,
        to: line.to,
        kind: "line",
        className:
          `cm-live-preview-quote-line cm-live-preview-quote-line-${position}`,
      });
    }
  }
  return plans;
};

export interface LivePreviewOptions {
  /**
   * When false, the selection never reveals source markers — used by reading
   * mode, which stays fully rendered wherever the cursor sits. Default true.
   */
  readonly revealSelection?: boolean;
}

export const planLivePreview = (
  state: EditorState,
  ranges?: readonly LivePreviewRange[],
  diagnostics?: LivePreviewDiagnostics,
  options?: LivePreviewOptions,
): PlannedDecoration[] => {
  const structures: Structure[] = [];
  const markerCandidates: { owner: Structure; node: MarkerNode }[] = [];
  const tree = syntaxTree(state);
  const requestedRanges = normalizeRanges(state.doc.length, ranges);

  for (const range of requestedRanges) {
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

  const directlySelected = (options?.revealSelection ?? true)
    ? structures.filter(({ node }) => selectionIntersects(state, node))
    : [];
  const revealed = (structure: Structure) =>
    directlySelected.some(({ node }) => rangesContainEachOther(structure.node, node));

  const planned: PlannedDecoration[] = [];
  for (const structure of structures) {
    if (structure.node.name === "Blockquote") {
      planned.push(...quoteLinePlans(state, structure, requestedRanges));
    }
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
      const previewNode = markerRangeForPreview(state, owner, node);
      const source = state.sliceDoc(previewNode.from, previewNode.to);
      if (owner.node.name === "ListItem") {
        if (owner.node.getChild("Task")) {
          // Task items render only the checkbox: hide the dash and the
          // whitespace between it and the TaskMarker.
          let to = previewNode.to;
          const line = state.doc.lineAt(previewNode.from);
          while (to < line.to && /[ \t]/.test(state.sliceDoc(to, to + 1))) to += 1;
          planned.push({ from: previewNode.from, to, kind: "replace" });
          continue;
        }
        planned.push({
          from: previewNode.from,
          to: previewNode.to,
          kind: "list-marker",
          className: "cm-live-preview-list-marker",
          displayText: source === "-" || source === "+" || source === "*" ? "•" : source,
        });
      } else if (owner.node.name === "Task") {
        const checked = source === "[x]" || source === "[X]";
        planned.push({
          from: previewNode.from,
          to: previewNode.to,
          kind: "task-checkbox",
          className: "cm-live-preview-task-checkbox",
          checked,
        });
        if (checked) {
          // Struck-through task text; skip the whitespace after the checkbox.
          let from = previewNode.to;
          while (
            from < owner.node.to &&
            /[ \t]/.test(state.sliceDoc(from, from + 1))
          ) {
            from += 1;
          }
          if (from < owner.node.to) {
            planned.push({
              from,
              to: owner.node.to,
              kind: "mark",
              className: "cm-live-preview-task-done",
            });
          }
        }
      } else {
        planned.push({
          from: previewNode.from,
          to: previewNode.to,
          kind: "replace",
        });
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
  constructor(
    private readonly from: number,
    private readonly to: number,
    private readonly checked: boolean,
  ) {
    super();
  }

  eq(other: WidgetType) {
    return other instanceof TaskCheckboxWidget && other.checked === this.checked;
  }

  toDOM(view: EditorView) {
    const checkbox = document.createElement("input");
    checkbox.className = "cm-live-preview-task-checkbox";
    checkbox.type = "checkbox";
    checkbox.checked = this.checked;
    checkbox.setAttribute("role", "checkbox");
    checkbox.setAttribute("aria-checked", String(this.checked));
    checkbox.setAttribute("aria-label", this.checked ? "已完成任务" : "未完成任务");
    const toggle = (event: Event) => {
      event.preventDefault();
      // A double-click fires two clicks; ignore the second one so the
      // checkbox does not toggle back in place.
      if ((event as MouseEvent).detail > 1) return;
      const source = view.state.sliceDoc(this.from, this.to);
      if (source !== "[ ]" && source !== "[x]" && source !== "[X]") return;
      view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: source === "[x]" || source === "[X]" ? "[ ]" : "[x]",
        },
      });
    };
    // Keep focus and the cursor where they are; the click still fires.
    checkbox.addEventListener("mousedown", (event) => event.preventDefault());
    checkbox.addEventListener("click", toggle);
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
  options?: LivePreviewOptions,
): { decorations: DecorationSet; atomicRanges: DecorationSet } => {
  const decorations: ReturnType<Decoration["range"]>[] = [];
  const atomicRanges: ReturnType<Decoration["range"]>[] = [];
  for (const item of planLivePreview(state, ranges, undefined, options)) {
    let decoration: ReturnType<Decoration["range"]>;
    if (item.kind === "line") {
      decorations.push(
        Decoration.line({
          attributes: { class: item.className ?? "" },
        }).range(item.from),
      );
      continue;
    } else if (item.kind === "mark") {
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
        widget: new TaskCheckboxWidget(item.from, item.to, item.checked ?? false),
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

// Reading mode hides frontmatter entirely, like Obsidian's reading view.
// A replace decoration that spans line breaks is forbidden in a view
// plugin, so the hiding lives in a state field (same mechanism as code
// folding). The trailing newline is swallowed too, leaving no blank line.
export const hiddenFrontmatterDecorations = (state: EditorState): DecorationSet => {
  const node = syntaxTree(state).topNode.getChild(FrontMatter);
  if (!node) return Decoration.none;
  // Swallow the line break after the closing delimiter (LF, or CRLF one
  // unit at a time) so reading mode leaves no blank line behind.
  let to = node.to;
  if (to < state.doc.length) {
    to += 1;
    if (state.doc.sliceString(node.to, to) === "\r" && to < state.doc.length) to += 1;
  }
  return Decoration.set([Decoration.replace({}).range(node.from, to)]);
};

const hiddenFrontmatterField = StateField.define<DecorationSet>({
  create: (state) => hiddenFrontmatterDecorations(state),
  update: (value, transaction) =>
    transaction.docChanged ||
    syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
      ? hiddenFrontmatterDecorations(transaction.state)
      : value,
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.from(field, (decorations) => () => decorations),
  ],
});

class LivePreviewPlugin {
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
  private composing: boolean;

  constructor(view: EditorView, private readonly options?: LivePreviewOptions) {
    this.composing = view.compositionStarted;
    if (this.composing) {
      this.decorations = Decoration.none;
      this.atomicRanges = Decoration.none;
    } else {
      const sets = decorationSetsFor(view.state, planningRanges(view), this.options);
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
      const sets = decorationSetsFor(update.state, planningRanges(update.view), this.options);
      this.decorations = sets.decorations;
      this.atomicRanges = sets.atomicRanges;
    }
  }

  startComposition(view: EditorView) {
    if (this.composing) return;
    this.composing = true;
    this.decorations = Decoration.none;
    this.atomicRanges = Decoration.none;
    view.dispatch({ effects: refreshLivePreview.of(null) });
  }

  endComposition(view: EditorView) {
    this.composing = false;
    const sets = decorationSetsFor(view.state, planningRanges(view), this.options);
    this.decorations = sets.decorations;
    this.atomicRanges = sets.atomicRanges;
    view.dispatch({ effects: refreshLivePreview.of(null) });
  }
}

const livePreviewPlugin = (options?: LivePreviewOptions) =>
  ViewPlugin.fromClass(
    class extends LivePreviewPlugin {
      constructor(view: EditorView) {
        super(view, options);
      }
    },
    {
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
    },
  );

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
  // Frontmatter reads as metadata: code-like but muted and smaller.
  ".cm-live-preview-frontmatter": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.85em",
    color: "var(--text-muted)",
  },
  ".cm-live-preview-inline-code": {
    backgroundColor: "var(--surface)",
    borderRadius: "0.2em",
  },
  ".cm-live-preview-link": { textDecoration: "underline" },
  ".cm-live-preview-reference-definition": { opacity: "0.75" },
  ".cm-live-preview-list-marker": {
    display: "inline-block",
    minWidth: "1em",
  },
  ".cm-live-preview-task-checkbox": {
    margin: "0 0.25em 0 0",
  },
  ".cm-live-preview-horizontal-rule": {
    borderTop: "1px solid var(--divider)",
    display: "inline-block",
    width: "100%",
  },
});

export const livePreviewExtension = (options?: LivePreviewOptions): Extension => [
  livePreviewPlugin(options),
  livePreviewTheme,
  ...(options?.revealSelection === false ? [hiddenFrontmatterField] : []),
];
