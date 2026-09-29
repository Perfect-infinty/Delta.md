import { useEffect, useState } from 'react'
import Delta from '../api/DeltaAPI.js'
import { toDeltaFileUrl } from '../utils/localFileUrl.js'
import { IMAGE_EXTS, VIDEO_EXTS, TEXT_EXTS, iconFor } from '../utils/fileKind.js'
import { showMoveToMenu } from '../utils/moveToMenu.js'

function formatDate(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * A card for a non-.md vault file (image/video/audio/text/anything
 * else dragged in from the OS), shown in the same grid as NoteCard so
 * notes and files can sit side by side. A plain click opens a quick
 * in-app preview (image/video/audio) or hands off to the OS's default
 * app; "Open in new tab" (right-click, or middle-click) opens it as a
 * real persistent tab instead - see FileViewer.jsx.
 */
// `dragProps` - see NoteCard: spread onto the root so the drag ghost is
// just this card, not a wrapper that catches neighbors in the snapshot.
export default function FileCard({ file, onOpen = (f) => Delta.openFile(f), dragProps = {} }) {
  const isImage = IMAGE_EXTS.has(file.ext)
  const isVideo = VIDEO_EXTS.has(file.ext)
  const isText = TEXT_EXTS.has(file.ext)
  const Icon = iconFor(file.ext)

  const [snippet, setSnippet] = useState('')

  useEffect(() => {
    if (!isText) return
    let cancelled = false
    Delta.readFileSnippet(file.path, 400).then((text) => {
      if (!cancelled) setSnippet(text)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, isText])

  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(file)
    }
  }

  async function handleRename() {
    // See NoteCard.jsx's handleRename - window.prompt() never actually
    // shows anything in Electron, so this uses the in-app Delta.prompt().
    const newName = await Delta.prompt('Rename file', file.name)
    if (!newName || !newName.trim() || newName.trim() === file.name) return
    await Delta.renameFile(file.path, newName.trim())
  }

  async function handleDelete() {
    // See NoteCard.jsx's handleDelete - window.confirm() shows an
    // unstyled native dialog, so this uses the in-app Delta.confirm().
    const ok = await Delta.confirm(`Delete "${file.name}"? This can't be undone.`, {
      danger: true,
      confirmLabel: 'Delete'
    })
    if (!ok) return
    await Delta.deleteFile(file.path)
  }

  function handleContextMenu(e) {
    e.preventDefault()
    const { clientX: x, clientY: y } = e
    Delta.showContextMenu(x, y, [
      {
        label: 'Open in new tab',
        onClick: () =>
          Delta.openTab({ type: 'file', filePath: file.path, fileName: file.name, fileExt: file.ext }, { newTab: true })
      },
      { label: 'Rename', onClick: handleRename },
      { label: 'Move to…', onClick: () => showMoveToMenu(x, y, file.path) },
      { label: 'Delete', onClick: handleDelete, danger: true }
    ])
  }

  function handleAuxClick(e) {
    // Middle-click - same "open in new tab" convention as NoteCard/a browser.
    if (e.button !== 1) return
    Delta.openTab({ type: 'file', filePath: file.path, fileName: file.name, fileExt: file.ext }, { newTab: true })
  }

  return (
    <div
      className="note-card file-card"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(file)}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      onAuxClick={handleAuxClick}
      {...dragProps}
    >
      <div className="note-card-header">
        <Icon fontSize="small" />
        <span className="note-card-title">{file.name}</span>
      </div>
      <div className="note-card-excerpt file-card-preview">
        {isImage && <img src={toDeltaFileUrl(file.path)} alt={file.name} loading="lazy" />}
        {isVideo && <video src={toDeltaFileUrl(file.path)} muted preload="metadata" />}
        {isText &&
          (snippet ? (
            <pre className="file-card-text">{snippet}</pre>
          ) : (
            <span className="note-card-empty">Empty file</span>
          ))}
        {!isImage && !isVideo && !isText && (
          <span className="note-card-empty">{(file.ext || 'file').toUpperCase()} file</span>
        )}
      </div>
      <div className="note-card-date">{formatDate(file.mtime)}</div>
    </div>
  )
}
