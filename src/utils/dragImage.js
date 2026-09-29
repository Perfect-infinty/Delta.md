/**
 * Gives a dragstart event a clean, explicit drag ghost: a clone of just
 * the dragged card. Chromium's default ghost is a screenshot of the
 * page region around the element, which - in a dense grid - kept
 * catching the neighboring cards below in the picture. Cloning the node
 * offscreen and pointing setDragImage at it guarantees the ghost is the
 * card and nothing else.
 *
 * The clone must still be in the DOM when the browser takes its
 * snapshot (synchronously during the dragstart handler), so it's
 * removed a frame later, not immediately.
 */
export function setCardDragImage(e) {
  const el = e.currentTarget
  if (!el || !e.dataTransfer?.setDragImage) return
  const rect = el.getBoundingClientRect()
  const clone = el.cloneNode(true)
  clone.style.position = 'fixed'
  clone.style.top = '-10000px'
  clone.style.left = '0'
  clone.style.width = `${rect.width}px`
  clone.style.height = `${rect.height}px`
  clone.style.margin = '0'
  clone.style.boxSizing = 'border-box'
  clone.style.pointerEvents = 'none'
  document.body.appendChild(clone)
  e.dataTransfer.setDragImage(clone, e.clientX - rect.left, e.clientY - rect.top)
  requestAnimationFrame(() => clone.remove())
}
