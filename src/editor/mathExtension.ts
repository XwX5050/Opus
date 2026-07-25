import type { Input, PartialParse } from "@lezer/common";
import type { BlockContext, Line, MarkdownExtension } from "@lezer/markdown";

export const InlineMath = "InlineMath";
export const BlockMath = "BlockMath";

const dollar = 36;
const backslash = 92;

const isWhitespace = (character: number) =>
  character === 9 || character === 10 || character === 13 || character === 32;

const isIndependentDelimiterLine = (line: Line) =>
  line.text.slice(line.pos).match(/^\$\$[\t ]*\r?$/) !== null;

const activeInputs: Input[] = [];

const closingDelimiter = (
  cx: BlockContext,
  openingLine: Line,
): { lineStart: number; delimiterTo: number } | null => {
  const input = activeInputs.at(-1);
  if (!input) return null;
  const nextLineStart = cx.lineStart + openingLine.text.length + 1;
  if (nextLineStart >= input.length) return null;
  const rest = input.read(nextLineStart, input.length);
  const match = /^[\t ]*\$\$[\t ]*\r?$/m.exec(rest);
  if (!match || match.index === undefined) return null;
  const delimiterOffset = match[0].indexOf("$$");
  return {
    lineStart: nextLineStart + match.index,
    delimiterTo: nextLineStart + match.index + delimiterOffset + 2,
  };
};

const parseBlockMath = (cx: BlockContext, line: Line) => {
  if (!isIndependentDelimiterLine(line)) return false;
  const closing = closingDelimiter(cx, line);
  if (!closing) return false;
  const from = cx.lineStart + line.pos;
  while (cx.nextLine()) {
    if (cx.lineStart === closing.lineStart) {
      cx.nextLine();
      cx.addElement(cx.elt(BlockMath, from, closing.delimiterTo));
      return true;
    }
  }
  return false;
};

export const mathMarkdownExtension: MarkdownExtension = {
  defineNodes: [InlineMath, { name: BlockMath, block: true }],
  parseBlock: [
    {
      name: "BlockMath",
      before: "FencedCode",
      parse: parseBlockMath,
    },
  ],
  parseInline: [
    {
      name: "InlineMath",
      before: "HTMLTag",
      parse(cx, next, pos) {
        if (
          next !== dollar ||
          (cx.char(pos - 1) === dollar &&
            (cx.char(pos - 2) === dollar ||
              cx.char(pos - 2) < 0 ||
              isWhitespace(cx.char(pos - 2)))) ||
          cx.char(pos + 1) === dollar ||
          isWhitespace(cx.char(pos + 1))
        ) {
          return -1;
        }

        for (let cursor = pos + 1; cursor < cx.end; cursor += 1) {
          const character = cx.char(cursor);
          if (character === 10 || character === 13) return -1;
          if (character === backslash) {
            cursor += 1;
            continue;
          }
          if (
            character === dollar &&
            cx.char(cursor - 1) !== dollar &&
            !isWhitespace(cx.char(cursor - 1))
          ) {
            return cx.addElement(cx.elt(InlineMath, pos, cursor + 1));
          }
        }
        return -1;
      },
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
