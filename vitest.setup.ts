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

// jsdom never runs layout, so HTMLElement.prototype.offsetParent is always
// null. GSAP's CSSPlugin treats a null offsetParent as "element is not in the
// document flow" (display:none / position:fixed) and, to read its transform,
// temporarily reparents the element into `documentElement` then puts it back.
// In jsdom that move is visible to the DOM: if the animated element (or an
// ancestor) is focused, the round-trip drops document focus with nothing to
// restore it — a real browser never reparents a laid-out visible element, so
// this is purely a test-environment artifact. Stub offsetParent to the body so
// GSAP measures in place, matching browser behavior.
const nativeOffsetParent = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetParent",
);
if (nativeOffsetParent?.configurable) {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      // Mirrors browsers only for elements that are actually visible in the
      // flow; nothing in the app animates intentionally-hidden elements, so a
      // single non-null stand-in keeps every tween on its original DOM node.
      return this.style.display === "none" || this.hidden ? null : document.body;
    },
  });
}
