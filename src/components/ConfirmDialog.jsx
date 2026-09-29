import { useEffect, useRef, useState } from 'react'
import Delta from '../api/DeltaAPI.js'

/**
 * In-app stand-in for window.confirm(). Electron does show a real native
 * dialog for confirm() (unlike prompt(), which shows nothing at all), but
 * it's an unstyled OS popup that looks nothing like the rest of Delta -
 * this renders one that actually matches, and resolves true/false via the
 * caller's own `resolve` the same way PromptDialog resolves its text.
 */
export default function ConfirmDialog() {
  const [state, setState] = useState(null) // { message, danger, confirmLabel, cancelLabel, resolve }
  const confirmRef = useRef(null)

  useEffect(() => {
    return Delta.on('confirm:open', (payload) => setState(payload))
  }, [])

  useEffect(() => {
    if (!state) return
    const raf = requestAnimationFrame(() => confirmRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [state])

  if (!state) return null

  function submit(result) {
    state.resolve(result)
    setState(null)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      submit(false)
    }
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) submit(false)
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="dialog-box">
        <p className="dialog-message">{state.message}</p>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={() => submit(false)} type="button">
            {state.cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => submit(true)}
            type="button"
          >
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
