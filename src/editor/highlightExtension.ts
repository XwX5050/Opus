import { tags } from "@lezer/highlight";
import type { MarkdownExtension } from "@lezer/markdown";

export const Highlight = "Highlight";
export const HighlightMark = "HighlightMark";

const equals = 61;
const backslash = 92;

const isWhitespace = (character: number) =>
  character === 9 || character === 10 || character === 13 || character === 32;

export const highlightMarkdownExtension: MarkdownExtension = {
  defineNodes: [
    Highlight,
    { name: HighlightMark, style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: Highlight,
      after: "Emphasis",
      parse(cx, next, pos) {
        if (
          next !== equals ||
          cx.char(pos - 1) === equals ||
          cx.char(pos + 1) !== equals ||
          cx.char(pos + 2) === equals ||
          isWhitespace(cx.char(pos + 2))
        ) {
          return -1;
        }

        for (let cursor = pos + 2; cursor < cx.end - 1; cursor += 1) {
          const character = cx.char(cursor);
          if (character === 10 || character === 13) return -1;
          if (character === backslash) {
            cursor += 1;
            continue;
          }
          if (
            character === equals &&
            cx.char(cursor - 1) !== equals &&
            cx.char(cursor + 1) === equals &&
            cx.char(cursor + 2) !== equals &&
            !isWhitespace(cx.char(cursor - 1))
          ) {
            return cx.addElement(
              cx.elt(Highlight, pos, cursor + 2, [
                cx.elt(HighlightMark, pos, pos + 2),
                ...cx.parser.parseInline(cx.slice(pos + 2, cursor), pos + 2),
                cx.elt(HighlightMark, cursor, cursor + 2),
              ]),
            );
          }
        }
        return -1;
      },
    },
  ],
};
