/**
 * Scrolls `item` into view by adjusting `container`'s scrollTop ONLY -
 * never any other ancestor. The native Element.scrollIntoView() walks
 * and scrolls *every* scrollable ancestor, and `overflow: hidden`
 * elements are still programmatically scrollable - so a single
 * scrollIntoView() call could scroll .app-root itself and shove the
 * whole UI up underneath the macOS traffic-light titlebar strip, with
 * no way for the user to scroll it back. Always use this instead.
 *
 * `center: true` vertically centers the item (find-match style);
 * otherwise it scrolls the minimum needed to reveal it (list-selection
 * style), and does nothing when the item is already fully visible.
 */
export function scrollItemIntoView(container, item, { center = false } = {}) {
  if (!container || !item) return
  const cRect = container.getBoundingClientRect()
  const iRect = item.getBoundingClientRect()
  if (center) {
    container.scrollTop += iRect.top - cRect.top - (container.clientHeight - iRect.height) / 2
    return
  }
  if (iRect.top < cRect.top) {
    container.scrollTop += iRect.top - cRect.top
  } else if (iRect.bottom > cRect.bottom) {
    container.scrollTop += iRect.bottom - cRect.bottom
  }
}
