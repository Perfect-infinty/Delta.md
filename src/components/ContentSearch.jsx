import { useEffect, useRef, useState } from 'react'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import Delta from '../api/DeltaAPI.js'
import { requestFindInNote } from '../utils/pendingFind.js'

// Wraps the first occurrence of `query` inside `snippet` in <mark>.
// Case-insensitive; returns the snippet untouched when there is no match
// (the main process can return a snippet-less result for title-only hits).
function highlight(snippet, query) {
  if (!query || !snippet) return snippet
  const idx = snippet.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return snippet
  return (
    <>
      {snippet.slice(0, idx)}
      <mark>{snippet.slice(idx, idx + query.length)}</mark>
      {snippet.slice(idx + query.length)}
    </>
  )
}

/**
 * Cmd/Ctrl+F - full-text search across every note's *content* (not just
 * titles, which is what Cmd+K's quick switcher covers).
 */
export default function ContentSearch({ open, onClose }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef(null)
  const debounceRef = useRef(null)

  // Every time the dialog opens, start from a clean slate and focus the input.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setResults([])
    setSelectedIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  useEffect(() => {
    clearTimeout(debounceRef.current)
    if (!query.trim()) {
      setResults([])
      return
    }
    // Debounced so we don't scan the whole vault on every keystroke.
    // `cancelled` guards against out-of-order responses: if the query
    // changed while a slow search was running, its stale results must
    // not overwrite the newer ones.
    let cancelled = false
    debounceRef.current = setTimeout(async () => {
      const found = await Delta.searchNotes(query)
      if (cancelled) return
      setResults(found)
      setSelectedIndex(0)
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(debounceRef.current)
    }
  }, [query])

  if (!open) return null

  function openResult(item, opts = {}) {
    if (!item) return
    onClose()
    // So the note editor lands right on this match (focused, scrolled
    // into view, highlighted) instead of just opening at the top of the
    // note with no indication of where the actual hit was - the same
    // thing clicking a search result does in a real text/code editor.
    requestFindInNote(item.path, query)
    Delta.openTab({ type: 'editor', notePath: item.path }, opts)
  }

  // Arrow keys wrap around the result list; Enter opens the selection.
  function handleKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => (results.length ? (i + 1) % results.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Cmd/Ctrl+Enter opens in a new tab instead of navigating this one.
      openResult(results[selectedIndex], { newTab: e.metaKey || e.ctrlKey })
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="command-palette-backdrop" onMouseDown={onClose}>
      <div className="command-palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search inside all notes…"
        />
        <div className="command-palette-results">
          {query.trim() && results.length === 0 ? (
            <div className="command-palette-empty">No matches</div>
          ) : (
            results.map((item, i) => (
              <button
                key={item.path}
                type="button"
                className={`command-palette-item search-result-item ${i === selectedIndex ? 'active' : ''}`}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={(e) => openResult(item, { newTab: e.metaKey || e.ctrlKey })}
              >
                <DescriptionOutlinedIcon fontSize="small" />
                <div className="search-result-text">
                  <div className="search-result-title">{item.title}</div>
                  {item.snippet && <div className="search-result-snippet">{highlight(item.snippet, query)}</div>}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
