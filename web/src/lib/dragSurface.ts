// =============================================================================
// Drag-surface judgment — "did this pointerdown land on grabbable chrome, or on
// something already doing its own thing (selectable text, a link/control, a
// scrollbar gutter)?"
//
// Extracted from Glasshouse's whole-pane drag so the same judgment can gate the
// feed card's HTML5 drag-to-another-feed without swallowing text selection: a
// pointerdown on bare chrome enables dragging, one on text/controls leaves the
// browser free to select or click. Boundary is the element to stop walking at
// (the pane, or the card shell).
// =============================================================================

// Elements that own their own pointer behaviour — never a drag handle.
export const NO_DRAG_SELECTOR =
  'a, button, input, textarea, select, label, audio, video, [role="button"], [role="link"], [role="textbox"], [contenteditable=""], [contenteditable="true"], [data-no-drag]';

// Does this element hold its own selectable text (a <p>/<span>/heading), versus
// being a bare layout container (the margins)? Only direct text nodes count, so
// a wrapper whose text lives in child elements still reads as draggable chrome.
export function hasOwnText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 && (node.textContent ?? "").trim().length > 0)
      return true;
  }
  return false;
}

export function isDragSurface(
  target: Element,
  boundary: Element,
  clientX: number,
  clientY: number,
): boolean {
  let el: Element | null = target;
  while (el && el !== boundary) {
    if (el.matches?.(NO_DRAG_SELECTOR)) return false;
    el = el.parentElement;
  }
  if (hasOwnText(target)) return false;
  // Native scrollbar gutter of a scrollable element → let it scroll, don't drag.
  const rect = target.getBoundingClientRect();
  if (
    target.scrollHeight > target.clientHeight &&
    clientX >= rect.left + target.clientWidth
  )
    return false;
  if (
    target.scrollWidth > target.clientWidth &&
    clientY >= rect.top + target.clientHeight
  )
    return false;
  return true;
}
