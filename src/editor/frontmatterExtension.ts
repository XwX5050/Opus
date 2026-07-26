import type { Input, PartialParse } from "@lezer/common";
import type { BlockContext, Line, MarkdownExtension } from "@lezer/markdown";

export const FrontMatter = "FrontMatter";

const openingDelimiter = /^---[\t ]*\r?$/;
const closingDelimiter = /^[\t ]*(?:---|\.\.\.)[\t ]*\r?$/;

// BlockContext does not expose the document Input, so the wrapper below
// captures it during advance() — the same approach as mathExtension.
const activeInputs: Input[] = [];

// Frontmatter is only recognized at the very start of the document: an
// opening `---` line at offset 0, closed by a `---` or `...` line.
const findClosingDelimiter = (
  input: Input,
  firstLine: Line,
): { lineStart: number; delimiterTo: number } | null => {
  let lineStart = firstLine.text.length + 1;
  while (lineStart < input.length) {
    let lineEnd = lineStart;
    while (lineEnd < input.length && input.read(lineEnd, lineEnd + 1) !== "\n") {
      lineEnd += 1;
    }
    const text = input.read(lineStart, lineEnd);
    if (closingDelimiter.test(text)) {
      const delimiterTo =
        lineStart + (text.endsWith("\r") ? text.length - 1 : text.length);
      return { lineStart, delimiterTo };
    }
    lineStart = lineEnd + 1;
  }
  return null;
};

const parseFrontMatter = (cx: BlockContext, line: Line) => {
  if (cx.lineStart !== 0 || line.pos !== 0) return false;
  if (!openingDelimiter.test(line.text)) return false;
  const input = activeInputs.at(-1);
  if (!input) return false;
  const closing = findClosingDelimiter(input, line);
  if (!closing) return false;
  while (cx.nextLine()) {
    if (cx.lineStart === closing.lineStart) {
      cx.nextLine();
      cx.addElement(cx.elt(FrontMatter, 0, closing.delimiterTo));
      return true;
    }
  }
  return false;
};

export const frontmatterMarkdownExtension: MarkdownExtension = {
  defineNodes: [{ name: FrontMatter, block: true }],
  parseBlock: [
    {
      name: FrontMatter,
      before: "HorizontalRule",
      parse: parseFrontMatter,
    },
  ],
  wrap(inner: PartialParse, input: Input) {
    return {
      advance() {
        activeInputs.push(input);
        try {
          return inner.advance();
        } finally {
          activeInputs.pop();
        }
      },
      get parsedPos() {
        return inner.parsedPos;
      },
      stopAt(pos: number) {
        inner.stopAt(pos);
      },
      get stoppedAt() {
        return inner.stoppedAt;
      },
    };
  },
};
