import { useEffect, useMemo, useRef, useState } from 'react'
import NoteAddIcon from '@mui/icons-material/NoteAdd'
import HubIcon from '@mui/icons-material/Hub'
import SettingsIcon from '@mui/icons-material/Settings'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import Delta from '../api/DeltaAPI.js'
import { iconFor } from '../utils/fileKind.js'
import { scrollItemIntoView } from '../utils/scrollWithin.js'

/**
 * Cmd/Ctrl+K quick switcher + command palette. Searches every note (by
 * title) and every other vault file (by filename), and always offers a
 * handful of core actions (new note, graph view, settings) - plugins
 * could add more via a future `Delta.registerCommand()` following the
 * same shape used here.
 */
export default function CommandPalette({ open, onClose }) {
  const [query, setQuery] = useState('')
  const [notes, setNotes] = useState([])
  const [files, setFiles] = useState([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef(null)
  const resultsRef = useRef(null)

  const actions = useMemo(
    () => [
      {
        id: 'new-note',
        type: 'action',
        label: 'New note',
        Icon: NoteAddIcon,
        run: async () => {
          const path = await Delta.createNote('Untitled')
          Delta.openTab({ type: 'editor', notePath: path })
        }
      },
      { id: 'graph', type: 'action', label: 'Graph view', Icon: HubIcon, run: () => Delta.openTab({ type: 'graph' }, { newTab: true }) },
      {
        id: 'settings',
        type: 'action',
        label: 'Settings',
        Icon: SettingsIcon,
        run: () => Delta.openTab({ type: 'settings' }, { newTab: true })
      }
    ],
    []
  )

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedIndex(0)
    Delta.listNotes().then(setNotes)
    Delta.listFiles().then(setFiles)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matchedActions = actions.filter((a) => !q || a.label.toLowerCase().includes(q))
    const matchedNotes = notes
      .filter((n) => !q || n.title.toLowerCase().includes(q))
      .slice(0, 20)
      .map((n) => ({ id: n.path, type: 'note', label: n.title, path: n.path, Icon: DescriptionOutlinedIcon }))
    const matchedFiles = files
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .slice(0, 20)
      .map((f) => ({ id: f.path, type: 'file', label: f.name, path: f.path, ext: f.ext, Icon: iconFor(f.ext) }))
    return [...matchedActions, ...matchedNotes, ...matchedFiles]
  }, [query, actions, notes, files])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Keep the keyboard selection visible: arrowing below the fold used to
  // move the highlight right out of view with the list never following.
  // Scrolls only the results list (see scrollWithin.js), so a hovered/
  // already-visible item never causes any movement.
  useEffect(() => {
    const list = resultsRef.current
    if (!list) return
    scrollItemIntoView(list, list.children[selectedIndex])
  }, [selectedIndex, results])

  if (!open) return null

  function runItem(item, opts = {}) {
    if (!item) return
    onClose()
    if (item.type === 'action') item.run?.()
    else if (item.type === 'file') Delta.openFile({ path: item.path, ext: item.ext, name: item.label })
    else Delta.openTab({ type: 'editor', notePath: item.path }, opts)
  }

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
      runItem(results[selectedIndex], { newTab: e.metaKey || e.ctrlKey })
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
          placeholder="Search notes or run a command…"
        />
        <div className="command-palette-results" ref={resultsRef}>
          {results.length === 0 ? (
            <div className="command-palette-empty">No matches</div>
          ) : (
            results.map((item, i) => (
              <button
                key={`${item.type}-${item.id}`}
                type="button"
                className={`command-palette-item ${i === selectedIndex ? 'active' : ''}`}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={(e) => runItem(item, { newTab: e.metaKey || e.ctrlKey })}
              >
                <item.Icon fontSize="small" />
                <span>{item.label}</span>
                {item.type === 'action' && <span className="command-palette-tag">Action</span>}
                {item.type === 'file' && <span className="command-palette-tag">File</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
