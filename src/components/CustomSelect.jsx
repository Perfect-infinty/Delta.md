import { useEffect, useRef, useState } from 'react'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import CheckIcon from '@mui/icons-material/Check'

/**
 * A small custom-styled dropdown, standing in for a native <select> -
 * so it actually matches the app's theme (native selects can't be
 * fully restyled cross-platform, especially their open option list).
 */
// `options` is an array of `{ value, label }`; `value` is the currently
// selected option's value; `onChange(value)` fires when the user picks one.
export default function CustomSelect({ value, options, onChange }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  // While the menu is open, clicking anywhere outside it or pressing
  // Escape closes it. Listeners only exist while `open` is true.
  useEffect(() => {
    if (!open) return
    function handleOutside(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    function handleEscape(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const selected = options.find((o) => o.value === value)

  return (
    <div className="custom-select" ref={rootRef}>
      <button type="button" className="custom-select-trigger" onClick={() => setOpen((v) => !v)}>
        <span>{selected ? selected.label : 'Select…'}</span>
        <ArrowDropDownIcon fontSize="small" className={open ? 'custom-select-arrow-open' : ''} />
      </button>
      {open && (
        <div className="custom-select-menu">
          {options.map((opt) => (
            <div
              key={opt.value}
              className={`custom-select-option ${opt.value === value ? 'active' : ''}`}
              onClick={() => {
                onChange(opt.value)
                setOpen(false)
              }}
            >
              <span>{opt.label}</span>
              {opt.value === value && <CheckIcon fontSize="small" />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
