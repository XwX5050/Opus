/** Converts a saved-file line/character match into a CodeMirror document offset. */
export const searchMatchOffset = (
  text: string,
  line: number,
  column: number,
): number | null => {
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 0) {
    return null;
  }
  const lines = text.split("\n");
  const target = lines[line - 1];
  if (target === undefined) return null;
  let prefix = 0;
  for (let index = 0; index < line - 1; index += 1) prefix += lines[index].length + 1;
  return prefix + Math.min(column, [...target].length);
};
