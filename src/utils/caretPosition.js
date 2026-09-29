/**
 * Computes the on-screen (viewport-relative) coordinates of the caret
 * inside a <textarea>, by mirroring its text into an invisible div with
 * identical typography/box metrics and measuring where a marker span
 * lands. This is the standard "textarea-caret-position" technique,
 * hand-rolled here to avoid adding a dependency for it.
 */
const MIRRORED_PROPERTIES = [
  'direction',
  'boxSizing',
  'width',
  'overflowX',
  'overflowY',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontSizeAdjust',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'textDecoration',
  'letterSpacing',
  'wordSpacing',
  'tabSize'
]

// `position` is a character offset into textarea.value. The returned
// `top` is already shifted down by one line height, so it can be used
// directly as the top edge of a popup that sits just below the caret.
export function getCaretCoordinates(textarea, position) {
  const computed = window.getComputedStyle(textarea)
  // Hidden mirror element: same box + typography as the textarea, so the
  // text wraps at exactly the same places.
  const div = document.createElement('div')
  document.body.appendChild(div)

  const style = div.style
  style.whiteSpace = 'pre-wrap'
  style.wordWrap = 'break-word'
  style.position = 'absolute'
  style.visibility = 'hidden'
  style.top = '0'
  style.left = '0'

  MIRRORED_PROPERTIES.forEach((prop) => {
    style[prop] = computed[prop]
  })

  // Text before the caret goes in the div; the marker span holds the rest
  // (or a '.' so it never collapses to zero height at the end of the text),
  // and its offset inside the div is the caret's offset inside the textarea.
  div.textContent = textarea.value.substring(0, position)
  const span = document.createElement('span')
  span.textContent = textarea.value.substring(position) || '.'
  div.appendChild(span)

  const rect = textarea.getBoundingClientRect()
  const lineHeight = parseInt(computed.lineHeight, 10) || 20

  const coords = {
    top: rect.top - textarea.scrollTop + span.offsetTop + lineHeight,
    left: rect.left - textarea.scrollLeft + span.offsetLeft
  }

  document.body.removeChild(div)
  return coords
}
