import { useEffect, useState } from 'react'
import Delta from '../api/DeltaAPI.js'

/**
 * Renders the small transient notices triggered by `Delta.showNotice()`
 * (from the app itself or from plugins). Each toast removes itself after
 * `duration` ms (default 3000); `type` ('info' | 'error' | ...) only picks
 * the CSS class.
 */
export default function Toasts() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    // Delta.on() returns an unsubscribe function, used as the cleanup.
    return Delta.on('notice', (toast) => {
      const id = Math.random().toString(36).slice(2)
      setToasts((prev) => [...prev, { id, ...toast }])
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
      }, toast.duration || 3000)
    })
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
