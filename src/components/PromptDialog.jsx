import { useEffect, useRef, useState } from 'react'
import Delta from '../api/DeltaAPI.js'

/**
 * In-app stand-in for window.prompt(), which Electron's BrowserWindow
 * never actually implements - unlike alert()/confirm() (which do show a
 * real native dialog), calling prompt() there just silently resolves to
 * null with nothing shown on screen. Delta.prompt() emits 'prompt:open'
 * instead, which this (mounted once, in App.jsx) picks up and resolves
 * via the caller's own `resolve` once the user submits or cancels.
 */
export default function PromptDialog() {
  const [state, setState] = useState(null) // { message, defaultValue, resolve }
  const [value, setValue] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    return Delta.on('prompt:open', (payload) => {
      setState(payload)
      setValue(payload.defaultValue || '')
    })
  }, [])

  useEffect(() => {
    if (!state) return
    // Autofocus with the existing text pre-selected - matches what the
    // native prompt() this replaces would have done, so renaming a note
    // is still a single "select all, type, Enter" motion.
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
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
      submit(value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      submit(null)
    }
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) submit(null)
      }}
    >
      <div className="dialog-box">
        <p className="dialog-message">{state.message}</p>
        <input
          ref={inputRef}
          className="dialog-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={() => submit(null)} type="button">
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => submit(value)} type="button">
            Rename
          </button>
        </div>
      </div>
    </div>
  )
}
