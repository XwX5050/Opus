import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

export interface ImageWidgetRange {
  from: number;
  to: number;
}

export interface ImageWidgetDiagnostics {
  visitedNodes: number;
}

/** Builds a webview-loadable URL for an absolute local path (asset protocol). */
export type LocalImageUrlResolver = (absolutePath: string) => string;

export interface ImageWidgetEnvironment {
  getDocumentPath(): string | null;
  resolveLocalUrl: LocalImageUrlResolver;
}

export interface PlannedImageWidget extends ImageWidgetRange {
  alt: string;
  src: string;
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;
const NETWORK_URL = /^https?:\/\//i;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const ANY_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const hasImageExtension = (url: string): boolean =>
  IMAGE_EXTENSION.test(url.split(/[?#]/, 1)[0]);

const parentDirectoryOf = (path: string): string | null => {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return index === 0 ? "/" : null;
  return normalized.slice(0, index);
};

/**
 * Maps a Markdown image destination to a loadable URL, or null when the
 * destination must not be rendered as an image. Only `http(s):` network
 * URLs and local paths with a known image extension are allowed; every
 * other scheme (`javascript:`, `data:`, `file:`, …) is rejected, so a
 * malicious destination never reaches an `<img>` element. A throwing
 * resolver (e.g. no Tauri runtime) yields null instead of breaking the
 * editor.
 */
export const resolveImageSrc = (
  url: string,
  documentPath: string | null,
  resolveLocalUrl: LocalImageUrlResolver,
): string | null => {
  const local = (path: string) => {
    try {
      return resolveLocalUrl(path);
    } catch {
      return null;
    }
  };
  if (!url || !hasImageExtension(url)) return null;
  if (NETWORK_URL.test(url)) return url;
  if (ANY_SCHEME.test(url) && !WINDOWS_ABSOLUTE.test(url)) return null;
  if (url.startsWith("/") || WINDOWS_ABSOLUTE.test(url)) return local(url);
  const directory = documentPath === null ? null : parentDirectoryOf(documentPath);
  if (!directory) return null;
  return local(directory === "/" ? `/${url}` : `${directory}/${url}`);
};

const selectionIntersects = (state: EditorState, range: ImageWidgetRange) =>
  state.selection.ranges.some((selection) =>
    selection.empty
      ? selection.from >= range.from && selection.from <= range.to
      : selection.from < range.to && selection.to > range.from,
  );

const normalizeRanges = (
  docLength: number,
  ranges: readonly ImageWidgetRange[] | undefined,
): ImageWidgetRange[] => {
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

  const merged: ImageWidgetRange[] = [];
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

// Backslash escapes of ASCII punctuation are literal in Markdown destinations.
const unescapeDestination = (url: string): string =>
  url.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");

const imageParts = (
  state: EditorState,
  node: SyntaxNode,
): { alt: string; url: string } | null => {
  const marks: { from: number; to: number }[] = [];
  let url: { from: number; to: number } | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "LinkMark") marks.push({ from: child.from, to: child.to });
    else if (child.name === "URL") url = { from: child.from, to: child.to };
  }
  if (marks.length < 2 || !url) return null;
  const raw = state.sliceDoc(url.from, url.to);
  const unwrapped = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
  return {
    alt: state.sliceDoc(marks[0].to, marks[1].from),
    url: unescapeDestination(unwrapped),
  };
};

export const planImageWidgets = (
  state: EditorState,
  environment: ImageWidgetEnvironment,
  ranges?: readonly ImageWidgetRange[],
  diagnostics?: ImageWidgetDiagnostics,
): PlannedImageWidget[] => {
  const planned: PlannedImageWidget[] = [];
  const tree = syntaxTree(state);
  for (const range of normalizeRanges(state.doc.length, ranges)) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (diagnostics) diagnostics.visitedNodes += 1;
        if (node.name !== "Image") return;
        const nodeRange = { from: node.from, to: node.to };
        if (selectionIntersects(state, nodeRange)) return;
        // Replace decorations cannot cross line breaks; leave rare
        // multi-line image syntax as source text.
        if (state.sliceDoc(node.from, node.to).includes("\n")) return;
        const parts = imageParts(state, node.node);
        if (!parts) return;
        const src = resolveImageSrc(
          parts.url,
          environment.getDocumentPath(),
          environment.resolveLocalUrl,
        );
        if (src === null) return;
        planned.push({ ...nodeRange, alt: parts.alt, src });
      },
    });
  }
  return planned.sort(
    (left, right) => left.from - right.from || left.to - right.to,
  );
};

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }

  eq(other: WidgetType) {
    return (
      other instanceof ImageWidget &&
      other.src === this.src &&
      other.alt === this.alt
    );
  }

  toDOM() {
    const wrapper = document.createElement("span");
    wrapper.className = "md-image-widget";
    const image = document.createElement("img");
    image.className = "md-image";
    image.src = this.src;
    image.alt = this.alt;
    image.addEventListener("error", () => {
      image.remove();
      wrapper.classList.add("md-image-broken");
      const indicator = document.createElement("span");
      indicator.className = "md-image-broken-indicator";
      indicator.setAttribute("role", "img");
      indicator.setAttribute("aria-label", `图片加载失败：${this.alt || this.src}`);
      indicator.textContent = `⚠ ${this.alt || this.src}`;
      wrapper.append(indicator);
    });
    wrapper.append(image);
    return wrapper;
  }

  destroy(_dom: HTMLElement) {
    // The widget owns no external resources. CodeMirror removes its DOM node.
  }

  ignoreEvent() {
    return false;
  }
}

const planningRanges = (view: EditorView): ImageWidgetRange[] => [
  ...view.visibleRanges,
  ...view.state.selection.ranges.map(({ from, to }) => ({ from, to })),
];

const decorationsFor = (
  state: EditorState,
  environment: ImageWidgetEnvironment,
  ranges: readonly ImageWidgetRange[],
): { decorations: DecorationSet; atomicRanges: DecorationSet } => {
  const decorations: ReturnType<Decoration["range"]>[] = [];
  for (const { from, to, alt, src } of planImageWidgets(state, environment, ranges)) {
    decorations.push(
      Decoration.replace({ widget: new ImageWidget(src, alt) }).range(from, to),
    );
  }
  return {
    decorations: Decoration.set(decorations, true),
    atomicRanges: Decoration.set(decorations, true),
  };
};

class ImageWidgetsPlugin {
  decorations: DecorationSet;
  atomicRanges: DecorationSet;

  constructor(
    view: EditorView,
    private readonly environment: ImageWidgetEnvironment,
  ) {
    const sets = decorationsFor(view.state, environment, planningRanges(view));
    this.decorations = sets.decorations;
    this.atomicRanges = sets.atomicRanges;
  }

  update(update: ViewUpdate) {
    const syntaxChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
    if (
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      syntaxChanged
    ) {
      const sets = decorationsFor(
        update.state,
        this.environment,
        planningRanges(update.view),
      );
      this.decorations = sets.decorations;
      this.atomicRanges = sets.atomicRanges;
    }
  }
}

const imageWidgetsTheme = EditorView.baseTheme({
  ".md-image-widget": { display: "inline-block", verticalAlign: "text-bottom" },
  ".md-image": { maxWidth: "100%", maxHeight: "24em" },
  ".md-image-broken-indicator": {
    color: "#b42318",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    border: "1px dashed rgba(180, 35, 24, 0.6)",
    borderRadius: "0.2em",
    padding: "0 0.25em",
  },
});

export const imageWidgetsExtension = (
  environment: ImageWidgetEnvironment,
): Extension => [
  ViewPlugin.define(
    (view) => new ImageWidgetsPlugin(view, environment),
    {
      decorations: (plugin) => plugin.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(plugin)?.atomicRanges ?? Decoration.none,
        ),
    },
  ),
  imageWidgetsTheme,
];
