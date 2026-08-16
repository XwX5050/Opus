import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface OutlineHeading {
  readonly id: string;
  readonly level: HeadingLevel;
  readonly text: string;
  readonly from: number;
  readonly textFrom: number;
  readonly children: ReadonlyArray<OutlineHeading>;
}

interface FlatHeading {
  readonly level: HeadingLevel;
  readonly text: string;
  readonly from: number;
  readonly textFrom: number;
}

interface MutableOutlineHeading {
  readonly id: string;
  readonly level: HeadingLevel;
  readonly text: string;
  readonly from: number;
  readonly textFrom: number;
  readonly children: MutableOutlineHeading[];
}

const headingNode = /^(ATX|Setext)Heading([1-6])$/;

const directHeaderMarks = (node: SyntaxNode): SyntaxNode[] => {
  const marks: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "HeaderMark") marks.push(child);
  }
  return marks;
};

const skipHorizontalSpace = (
  state: EditorState,
  from: number,
  to: number,
): number => {
  let position = from;
  while (position < to && /[ \t]/.test(state.sliceDoc(position, position + 1))) {
    position += 1;
  }
  return position;
};

const trimEndPosition = (
  state: EditorState,
  from: number,
  to: number,
): number => {
  let position = to;
  while (position > from && /\s/.test(state.sliceDoc(position - 1, position))) {
    position -= 1;
  }
  return position;
};

const readHeading = (
  state: EditorState,
  node: SyntaxNode,
  kind: "ATX" | "Setext",
  level: HeadingLevel,
): FlatHeading => {
  const marks = directHeaderMarks(node);
  if (kind === "ATX") {
    const opening = marks[0];
    const closing = marks.length > 1 ? marks.at(-1) : undefined;
    const rawStart = opening?.to ?? node.from;
    const textFrom = skipHorizontalSpace(state, rawStart, node.to);
    const rawEnd = closing?.from ?? node.to;
    const textEnd = trimEndPosition(state, textFrom, rawEnd);
    const text = state.sliceDoc(textFrom, textEnd).trim() || "无标题";
    return { level, text, from: node.from, textFrom };
  }

  const underline = marks.at(-1);
  const rawEnd = underline?.from ?? node.to;
  const textEnd = trimEndPosition(state, node.from, rawEnd);
  const textFrom = skipHorizontalSpace(state, node.from, textEnd);
  const text = state.sliceDoc(textFrom, textEnd).trim() || "无标题";
  return { level, text, from: node.from, textFrom };
};

const normalizedPathPart = (text: string): string =>
  text.normalize("NFKC").trim().toLocaleLowerCase();

export function extractOutline(
  state: EditorState,
): ReadonlyArray<OutlineHeading> {
  const flat: FlatHeading[] = [];
  syntaxTree(state).iterate({
    enter(reference) {
      const match = headingNode.exec(reference.name);
      if (!match) return;
      flat.push(
        readHeading(
          state,
          reference.node,
          match[1] as "ATX" | "Setext",
          Number(match[2]) as HeadingLevel,
        ),
      );
      return false;
    },
  });

  const roots: MutableOutlineHeading[] = [];
  const stack: MutableOutlineHeading[] = [];
  const occurrences = new Map<string, number>();

  for (const heading of flat) {
    while (
      stack.length > 0 &&
      stack[stack.length - 1].level >= heading.level
    ) {
      stack.pop();
    }
    const pathKey = [...stack.map((entry) => entry.text), heading.text]
      .map(normalizedPathPart)
      .join("\u001f");
    const occurrence = (occurrences.get(pathKey) ?? 0) + 1;
    occurrences.set(pathKey, occurrence);
    const next: MutableOutlineHeading = {
      ...heading,
      id: `${encodeURIComponent(pathKey)}:${occurrence}`,
      children: [],
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(next);
    else roots.push(next);
    stack.push(next);
  }

  return roots;
}

const collectIds = (
  headings: ReadonlyArray<OutlineHeading>,
  includeLeaves: boolean,
): ReadonlySet<string> => {
  const ids = new Set<string>();
  const visit = (items: ReadonlyArray<OutlineHeading>) => {
    for (const heading of items) {
      if (includeLeaves || heading.children.length > 0) ids.add(heading.id);
      visit(heading.children);
    }
  };
  visit(headings);
  return ids;
};

export const collectOutlineIds = (
  headings: ReadonlyArray<OutlineHeading>,
): ReadonlySet<string> => collectIds(headings, true);

export const collectOutlineParentIds = (
  headings: ReadonlyArray<OutlineHeading>,
): ReadonlySet<string> => collectIds(headings, false);

/**
 * Locates a heading by id inside a tree. Ids derive from the heading path
 * text, so a heading whose text changed carries a new id and is not found.
 */
export const findOutlineHeadingById = (
  headings: ReadonlyArray<OutlineHeading>,
  id: string,
): OutlineHeading | null => {
  for (const heading of headings) {
    if (heading.id === id) return heading;
    const found = findOutlineHeadingById(heading.children, id);
    if (found) return found;
  }
  return null;
};
