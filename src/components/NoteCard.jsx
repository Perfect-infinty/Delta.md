import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import PushPinIcon from '@mui/icons-material/PushPin'
import MarkdownPreview from './MarkdownPreview.jsx'
import Delta from '../api/DeltaAPI.js'
import { dirnameOf } from '../utils/path.js'
import { showMoveToMenu } from '../utils/moveToMenu.js'

function formatDate(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function NoteCard({
  note,
  pinned = false,
  onTogglePin,
  onOpen = (n) => Delta.openTab({ type: 'editor', notePath: n.path }),
  // Extra props spread onto the card's root (draggable/onDragStart from
  // NotesList, so a card can be dragged onto a FolderCard/breadcrumb).
  // Spread directly on the root instead of using a wrapper div - the
  // browser's drag ghost is snapshotted from the draggable element, and
  // a wrapper picked up neighboring cards in the picture.
  dragProps = {}
}) {
  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(note)
    }
  }

  async function handleRename() {
    // window.prompt() isn't implemented by Electron's BrowserWindow (it
    // silently resolves to null, unlike alert/confirm which do show a
    // native dialog) - Delta.prompt() shows an in-app one instead.
    const newTitle = await Delta.prompt('Rename note', note.title)
    if (!newTitle || !newTitle.trim() || newTitle.trim() === note.title) return
    await Delta.renameNote(note.path, newTitle.trim())
  }

  async function handleDelete() {
    // window.confirm() does show a real native dialog in Electron, but an
    // unstyled OS popup next to Delta's own UI looks out of place - use
    // the in-app one instead, same reasoning as Delta.prompt() above.
    const ok = await Delta.confirm(`Delete "${note.title}"? This can't be undone.`, {
      danger: true,
      confirmLabel: 'Delete'
    })
    if (!ok) return
    await Delta.deleteNote(note.path)
  }

  function handleContextMenu(e) {
    e.preventDefault()
    const { clientX: x, clientY: y } = e
    Delta.showContextMenu(x, y, [
      { label: 'Open in new tab', onClick: () => Delta.openTab({ type: 'editor', notePath: note.path }, { newTab: true }) },
      { label: pinned ? 'Unpin' : 'Pin', onClick: () => onTogglePin?.() },
      { label: 'Rename', onClick: handleRename },
      // Also the way *out* of a folder - picks any other folder or the
      // vault root. (Dragging the card onto a breadcrumb segment works
      // too; this is the discoverable, click-only route.)
      { label: 'Move to…', onClick: () => showMoveToMenu(x, y, note.path) },
      { label: 'Delete', onClick: handleDelete, danger: true }
    ])
  }

  function handleAuxClick(e) {
    // Middle-click - same "open in new tab" convention as a browser.
    if (e.button !== 1) return
    Delta.openTab({ type: 'editor', notePath: note.path }, { newTab: true })
  }

  return (
    <div
      className={`note-card ${pinned ? 'note-card-pinned' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(note)}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      onAuxClick={handleAuxClick}
      {...dragProps}
    >
      <div className="note-card-header">
        <DescriptionOutlinedIcon fontSize="small" />
        <span className="note-card-title">{note.title}</span>
        {pinned && <PushPinIcon className="note-card-pin-icon" fontSize="inherit" titleAccess="Pinned" />}
      </div>
      <div className="note-card-excerpt">
        {note.excerpt ? (
          <MarkdownPreview content={note.excerpt} basePath={dirnameOf(note.path)} />
        ) : (
          <span className="note-card-empty">Empty note</span>
        )}
      </div>
      <div className="note-card-date">{formatDate(note.mtime)}</div>
    </div>
  )
}
