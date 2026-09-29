import { useEffect, useRef } from 'react'

/**
 * A generic right-click context menu, positioned at a fixed (x, y) with
 * a list of `{ label, onClick }` items. Triggered from anywhere via
 * `Delta.showContextMenu(x, y, items)` - App.jsx just renders whatever
 * the event bus hands it, so any component (or plugin) can show one
 * without needing its own menu implementation.
 */
export default function ContextMenu({ menu, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    if (!menu) return
    function handlePointerDown(e) {
      if (!ref.current?.contains(e.target)) onClose()
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    // Capture phase so this still closes the menu even if the click
    // that dismisses it lands on something with its own stopPropagation.
    window.addEventListener('mousedown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [menu, onClose])

  if (!menu) return null

  const estimatedHeight = menu.items.length * 32 + 8
  const style = {
    left: Math.max(4, Math.min(menu.x, window.innerWidth - 200)),
    top: Math.max(4, Math.min(menu.y, window.innerHeight - estimatedHeight))
  }

  return (
    <div className="context-menu" style={style} ref={ref}>
      {menu.items.map((item, i) => (
        <button
          key={i}
          type="button"
          className={`context-menu-item ${item.danger ? 'context-menu-item-danger' : ''}`}
          onClick={() => {
            item.onClick()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
