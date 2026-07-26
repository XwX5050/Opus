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
import katex from "katex";
import "katex/dist/katex.min.css";
import { BlockMath, InlineMath } from "./mathExtension";

export interface MathRange {
  from: number;
  to: number;
}

export interface PlannedMathWidget extends MathRange {
  source: string;
  displayMode: boolean;
}

export interface MathWidgetDiagnostics {
  visitedNodes: number;
}

export interface MathWidgetsOptions {
  /**
   * When false, the selection never reveals a formula's source — reading
   * mode keeps widgets mounted wherever the cursor sits. Default true.
   */
  readonly revealSelection?: boolean;
}

const selectionIntersects = (state: EditorState, range: MathRange) =>
  state.selection.ranges.some((selection) =>
    selection.empty
      ? selection.from >= range.from && selection.from <= range.to
      : selection.from < range.to && selection.to > range.from,
  );

const rangesIntersect = (left: MathRange, right: MathRange) =>
  left.from <= right.to && left.to >= right.from;

const normalizeRanges = (
  docLength: number,
  ranges: readonly MathRange[] | undefined,
): MathRange[] => {
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

  const merged: MathRange[] = [];
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

const blockSource = (source: string) =>
  source
    .replace(/^\$\$[\t ]*\r?\n/, "")
    .replace(/\r?\n[\t ]*\$\$$/, "");

export const planMathWidgets = (
  state: EditorState,
  ranges?: readonly MathRange[],
  diagnostics?: MathWidgetDiagnostics,
  additionallyRevealed: readonly MathRange[] = [],
  options?: MathWidgetsOptions,
): PlannedMathWidget[] => {
  const revealSelection = options?.revealSelection ?? true;
  const widgets = new Map<string, PlannedMathWidget>();
  const tree = syntaxTree(state);
  for (const range of normalizeRanges(state.doc.length, ranges)) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (diagnostics) diagnostics.visitedNodes += 1;
        if (node.name !== InlineMath && node.name !== BlockMath) return;
        const nodeRange = { from: node.from, to: node.to };
        if (
          (revealSelection && selectionIntersects(state, nodeRange)) ||
          additionallyRevealed.some((revealed) => rangesIntersect(revealed, nodeRange))
        ) {
          return;
        }
        const displayMode = node.name === BlockMath;
        const raw = state.sliceDoc(node.from, node.to);
        widgets.set(`${node.from}:${node.to}`, {
          ...nodeRange,
          source: displayMode ? blockSource(raw) : raw.slice(1, -1),
          displayMode,
        });
      },
    });
  }
  return [...widgets.values()].sort(
    (left, right) => left.from - right.from || left.to - right.to,
  );
};

export class MathWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly displayMode: boolean,
  ) {
    super();
  }

  eq(other: WidgetType) {
    return (
      other instanceof MathWidget &&
      other.source === this.source &&
      other.displayMode === this.displayMode
    );
  }

  toDOM() {
    const dom = document.createElement("span");
    dom.classList.add(this.displayMode ? "md-math-block" : "md-math-inline");
    dom.setAttribute("aria-label", `LaTeX 公式：${this.source}`);
    try {
      dom.classList.add("md-math");
      dom.innerHTML = katex.renderToString(this.source, {
        displayMode: this.displayMode,
        strict: "error",
        throwOnError: true,
        trust: false,
      });
    } catch {
      dom.classList.remove("md-math");
      dom.classList.add("md-math-error");
      dom.textContent = this.source;
      dom.setAttribute("title", "LaTeX 公式无效");
    }
    return dom;
  }

  destroy(_dom: HTMLElement) {
    // KaTeX output is self-contained and owns no external resources.
  }

  ignoreEvent() {
    return false;
  }
}

const planningRanges = (view: EditorView): MathRange[] => [
  ...view.visibleRanges,
  ...view.state.selection.ranges.map(({ from, to }) => ({ from, to })),
];

const decorationSetsFor = (
  state: EditorState,
  ranges: readonly MathRange[],
  additionallyRevealed: readonly MathRange[],
  options?: MathWidgetsOptions,
): { decorations: DecorationSet; atomicRanges: DecorationSet } => {
  const replacements: ReturnType<Decoration["range"]>[] = [];
  const atomicRanges: ReturnType<Decoration["range"]>[] = [];
  for (const { from, to, source, displayMode } of planMathWidgets(
    state,
    ranges,
    undefined,
    additionallyRevealed,
    options,
  )) {
    if (!displayMode) {
      const replacement = Decoration.replace({
        widget: new MathWidget(source, false),
      }).range(from, to);
      replacements.push(replacement);
      atomicRanges.push(replacement);
      continue;
    }

    let segmentFrom = from;
    let first = true;
    while (segmentFrom < to) {
      const line = state.doc.lineAt(segmentFrom);
      const segmentTo = Math.min(line.to, to);
      if (segmentTo > segmentFrom) {
        replacements.push(
          Decoration.replace({
            widget: first ? new MathWidget(source, true) : undefined,
          }).range(segmentFrom, segmentTo),
        );
        first = false;
      }
      if (segmentTo === to) break;
      segmentFrom = line.to + 1;
    }
    atomicRanges.push(Decoration.mark({}).range(from, to));
  }
  return {
    decorations: Decoration.set(replacements, true),
    atomicRanges: Decoration.set(atomicRanges, true),
  };
};

const selectedMathRanges = (state: EditorState): MathRange[] => {
  const ranges: MathRange[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (
        (node.name === InlineMath || node.name === BlockMath) &&
        selectionIntersects(state, node)
      ) {
        ranges.push({ from: node.from, to: node.to });
      }
    },
  });
  return ranges;
};

const refreshMathWidgets = StateEffect.define<null>();

class MathWidgetsPlugin {
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
  private composingRanges: MathRange[];

  constructor(
    view: EditorView,
    private readonly options?: MathWidgetsOptions,
  ) {
    this.composingRanges = view.compositionStarted
      ? selectedMathRanges(view.state)
      : [];
    const sets = decorationSetsFor(
      view.state,
      planningRanges(view),
      this.composingRanges,
      this.options,
    );
    this.decorations = sets.decorations;
    this.atomicRanges = sets.atomicRanges;
  }

  update(update: ViewUpdate) {
    if (update.docChanged && this.composingRanges.length) {
      this.composingRanges = this.composingRanges.map(({ from, to }) => ({
        from: update.changes.mapPos(from, 1),
        to: update.changes.mapPos(to, -1),
      }));
    }
    const syntaxChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
    const explicitlyRefreshed = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(refreshMathWidgets)),
    );
    if (
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      syntaxChanged ||
      explicitlyRefreshed
    ) {
      const sets = decorationSetsFor(
        update.state,
        planningRanges(update.view),
        this.composingRanges,
        this.options,
      );
      this.decorations = sets.decorations;
      this.atomicRanges = sets.atomicRanges;
    }
  }

  startComposition(view: EditorView) {
    if (!this.composingRanges.length) {
      this.composingRanges = selectedMathRanges(view.state);
    }
    view.dispatch({ effects: refreshMathWidgets.of(null) });
  }

  endComposition(view: EditorView) {
    this.composingRanges = [];
    view.dispatch({ effects: refreshMathWidgets.of(null) });
  }
}

const mathWidgetsPlugin = (options?: MathWidgetsOptions) =>
  ViewPlugin.fromClass(
    class extends MathWidgetsPlugin {
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

const mathWidgetsTheme = EditorView.baseTheme({
  ".md-math-inline": { display: "inline-block" },
  ".md-math-block": { display: "block", padding: "0.05em 0" },
  ".md-math-block .katex-display": { margin: "0.25em 0" },
  ".md-math-error": {
    color: "var(--danger)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    textDecoration: "underline wavy",
  },
});

export const mathWidgetsExtension = (options?: MathWidgetsOptions): Extension => [
  mathWidgetsPlugin(options),
  mathWidgetsTheme,
];
