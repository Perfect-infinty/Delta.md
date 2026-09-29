import { useState } from 'react'
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined'
import PushPinIcon from '@mui/icons-material/PushPin'
import Delta from '../api/DeltaAPI.js'
import { setCardDragImage } from '../utils/dragImage.js'

const CONTENT_ICONS = {
  folder: FolderOutlinedIcon,
  note: DescriptionOutlinedIcon,
  file: InsertDriveFileOutlinedIcon
}
const PREVIEW_LIMIT = 5

/**
 * A vault subfolder in the Notes grid. Click to browse into it; drop a
 * note/file card (or files from the OS) onto it to move/import them
 * there; right-click for rename/delete/pin - the same operations
 * NoteCard offers, folder-flavored.
 *
 * `INTERNAL_DRAG_MIME` is how a dragged NoteCard/FileCard identifies
 * itself (vs. a file dragged in from the OS, which arrives in
 * dataTransfer.files instead) - see NotesList's card wrappers.
 */
export const INTERNAL_DRAG_MIME = 'application/x-delta-path'
// A dragged FolderCard - a separate mime from notes/files, because
// dropping a *note* on a folder means "move it inside", while dropping
// a *folder* on a folder means "reorder them" (see handleDrop below).
export const FOLDER_DRAG_MIME = 'application/x-delta-folder'

// `contents`: [{ kind: 'folder'|'note'|'file', name }] - the folder's
// direct children, shown as a small preview list inside the card so
// it's clear what's in a folder without opening it.
export default function FolderCard({ folder, contents = [], pinned = false, onTogglePin, onOpen, onMoved, onReorder }) {
  const [dropTarget, setDropTarget] = useState(false)

  async function handleRename() {
    const newName = await Delta.prompt('Rename folder', folder.name)
    if (!newName || !newName.trim() || newName.trim() === folder.name) return
    await Delta.renameFolder(folder.path, newName.trim())
  }

  async function handleDelete() {
    const ok = await Delta.confirm(
      `Delete "${folder.name}" and everything inside it? This can't be undone.`,
      { danger: true, confirmLabel: 'Delete' }
    )
    if (!ok) return
    await Delta.deleteFolder(folder.path)
  }

  function handleContextMenu(e) {
    e.preventDefault()
    Delta.showContextMenu(e.clientX, e.clientY, [
      { label: 'Open', onClick: () => onOpen?.(folder) },
      { label: pinned ? 'Unpin' : 'Pin', onClick: () => onTogglePin?.() },
      { label: 'Rename', onClick: handleRename },
      { label: 'Delete', onClick: handleDelete, danger: true }
    ])
  }

  function handleDragOver(e) {
    // Accept both an internal card drag and files from the OS.
    e.preventDefault()
    e.stopPropagation() // don't light up the whole grid's drop style too
    setDropTarget(true)
  }

  async function handleDrop(e) {
    e.preventDefault()
    e.stopPropagation() // the grid's own drop handler must not also import
    setDropTarget(false)

    // Another folder dropped here = "put it in front of me" (reorder),
    // not "move it inside me".
    const folderPath = e.dataTransfer.getData(FOLDER_DRAG_MIME)
    if (folderPath) {
      if (folderPath !== folder.path) onReorder?.(folderPath, folder.path)
      return
    }

    const internalPath = e.dataTransfer.getData(INTERNAL_DRAG_MIME)
    if (internalPath) {
      const newPath = await Delta.moveFile(internalPath, folder.path)
      if (newPath) onMoved?.()
      return
    }

    const dropped = Array.from(e.dataTransfer.files || [])
    for (const f of dropped) {
      const sourcePath = Delta.getDroppedFilePath(f)
      if (sourcePath) await Delta.importFile(sourcePath, folder.path)
    }
    if (dropped.length > 0) onMoved?.()
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen?.(folder)
    }
  }

  return (
    <div
      className={`note-card folder-card ${dropTarget ? 'drop-target-active' : ''} ${pinned ? 'note-card-pinned' : ''}`}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(FOLDER_DRAG_MIME, folder.path)
        e.dataTransfer.effectAllowed = 'move'
        setCardDragImage(e) // explicit ghost - just this card, no neighbors
      }}
      onClick={() => onOpen?.(folder)}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      onDragOver={handleDragOver}
      onDragLeave={() => setDropTarget(false)}
      onDrop={handleDrop}
    >
      <div className="note-card-header">
        <FolderOutlinedIcon fontSize="small" />
        <span className="note-card-title">{folder.name}</span>
        {pinned && <PushPinIcon className="note-card-pin-icon" fontSize="inherit" titleAccess="Pinned" />}
      </div>
      <div className="note-card-excerpt folder-card-contents">
        {contents.length === 0 ? (
          <span className="note-card-empty">Empty folder</span>
        ) : (
          <>
            {contents.slice(0, PREVIEW_LIMIT).map((item, i) => {
              const ItemIcon = CONTENT_ICONS[item.kind] || InsertDriveFileOutlinedIcon
              return (
                <div key={i} className="folder-card-item">
                  <ItemIcon fontSize="inherit" />
                  <span className="folder-card-item-name">{item.name}</span>
                </div>
              )
            })}
            {contents.length > PREVIEW_LIMIT && (
              <div className="folder-card-item folder-card-more">+{contents.length - PREVIEW_LIMIT} more</div>
            )}
          </>
        )}
      </div>
      <div className="note-card-date">
        {contents.length} item{contents.length === 1 ? '' : 's'}
      </div>
    </div>
  )
}
