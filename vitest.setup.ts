import '@testing-library/jest-dom/vitest';

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

// jsdom's select() does not focus the input, unlike browsers. CodeMirror's
// search panel relies on select() to move focus into the panel.
const nativeSelect = HTMLInputElement.prototype.select;
HTMLInputElement.prototype.select = function select() {
  nativeSelect.call(this);
  this.focus();
};
