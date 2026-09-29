import { useEffect, useRef } from 'react'
import { scrollItemIntoView } from '../utils/scrollWithin.js'

/**
 * The little suggestion list that pops up next to the caret after typing
 * `[[` or `![[` in the editor. Purely presentational: NoteEditor owns the
 * filtering, the selected index and the keyboard handling, and passes in
 * `items` ({ title, isNew }), the caret's viewport position (`top`/`left`,
 * from utils/caretPosition.js) and `onSelect(item)`. An `isNew` item is the
 * "Create note ..." entry shown when no existing title matches.
 */
export default function WikilinkAutocomplete({ items, selectedIndex, top, left, onSelect }) {
  const listRef = useRef(null)

  // The dropdown holds more items than fit its max-height, so arrowing
  // past the visible ones has to scroll the list along with the
  // selection - otherwise everything below the fold was unreachable by
  // keyboard. Scrolls only the dropdown itself (see scrollWithin.js),
  // never the page behind it.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    scrollItemIntoView(list, list.children[selectedIndex])
  }, [selectedIndex, items])

  if (!items || items.length === 0) return null

  return (
    <div className="wikilink-autocomplete" style={{ top, left }} ref={listRef}>
      {items.map((item, i) => (
        <div
          key={item.title + (item.isNew ? '-new' : '')}
          className={`wikilink-autocomplete-item ${i === selectedIndex ? 'active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault() // keep focus on the textarea, don't blur it
            onSelect(item)
          }}
        >
          {item.isNew ? (
            <span>
              Create note “<strong>{item.title}</strong>”
            </span>
          ) : (
            <span>{item.title}</span>
          )}
        </div>
      ))}
    </div>
  )
}
