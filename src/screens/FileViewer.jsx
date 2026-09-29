import { useEffect, useRef, useState } from 'react'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import EditIcon from '@mui/icons-material/Edit'
import VisibilityIcon from '@mui/icons-material/Visibility'
import DOMPurify from 'dompurify'
import Delta from '../api/DeltaAPI.js'
import { toDeltaFileUrl } from '../utils/localFileUrl.js'
import { IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, TEXT_EXTS, DOCX_EXTS, iconFor } from '../utils/fileKind.js'

// html files get a real rendered mode on top of source editing - shown
// in a sandboxed iframe (no scripts), so a random .html dropped into
// the vault can't run code inside the app.
const HTML_EXTS = new Set(['html', 'htm'])

// Same session-only "remember where this tab was" idea as NoteEditor's
// viewModeByPath - tabs fully unmount when another tab is active, so
// without this an html file would snap back to its default mode every
// time you switched away and back.
const modeByPath = new Map()

/**
 * A non-.md vault file opened as a real, persistent tab (via "Open in
 * new tab" on a FileCard, or just clicking a text/docx card) - as
 * opposed to FileViewerModal, the quick transient preview for media.
 *
 * - image/video/audio render natively, as before
 * - text files (txt/html/css/json/... - TEXT_EXTS) are now *editable*
 *   in place, autosaving like a note does
 * - html/htm additionally get a rendered preview mode (sandboxed iframe)
 * - .docx renders read-only via mammoth (docx -> HTML), sanitized
 * - anything else falls back to "open externally"
 */
export default function FileViewer({ file, onBack = () => Delta.openTab({ type: 'notes' }) }) {
  const isImage = IMAGE_EXTS.has(file.ext)
  const isVideo = VIDEO_EXTS.has(file.ext)
  const isAudio = AUDIO_EXTS.has(file.ext)
  const isText = TEXT_EXTS.has(file.ext)
  const isHtml = HTML_EXTS.has(file.ext)
  const isDocx = DOCX_EXTS.has(file.ext)
  // Chromium ships a full PDF viewer - an iframe pointed at the file
  // renders it natively, zoom/search/print included. Not sandboxed on
  // purpose: sandboxing disables the internal PDF plugin.
  const isPdf = file.ext === 'pdf'
  // Legacy binary .doc - mammoth only reads .docx, so the main process
  // extracts the plain text body via word-extractor instead (read-only).
  const isDoc = file.ext === 'doc'
  const Icon = iconFor(file.ext)
  const url = toDeltaFileUrl(file.path)

  const [text, setText] = useState(null) // null = still loading
  const [docxHtml, setDocxHtml] = useState(null) // sanitized HTML, or '' on failure
  const [docText, setDocText] = useState(undefined) // undefined = loading, null = failed
  // 'edit' | 'rendered' - only meaningful for html files; plain text
  // files are always in edit mode.
  const [mode, setMode] = useState(() => modeByPath.get(file.path) || (isHtml ? 'rendered' : 'edit'))
  // Bumped when switching to rendered mode so the iframe re-reads the
  // just-saved file from disk instead of showing a stale cached copy.
  const [renderVersion, setRenderVersion] = useState(0)
  const saveTimer = useRef(null)
  // Latest unsaved content + path, so flushSave/unmount cleanup never
  // close over a stale render's values.
  const pendingRef = useRef(null)

  useEffect(() => {
    modeByPath.set(file.path, mode)
  }, [mode, file.path])

  // Full text load (not the capped snippet the grid cards use) - the
  // whole point of this tab is that the file can be edited, and saving
  // a truncated read back would destroy everything past the cap.
  useEffect(() => {
    if (!isText) return
    let cancelled = false
    // .catch for the same reason as the .doc effect below - never let a
    // failed/missing bridge call leave the tab stuck on "Loading…".
    Promise.resolve()
      .then(() => Delta.readFileText(file.path))
      .catch(() => '')
      .then((t) => {
        if (!cancelled) setText(t ?? '')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, isText])

  // .docx -> HTML via mammoth, loaded lazily so its chunk only ever
  // downloads when a docx is actually opened. The bytes come through the
  // same delta-file:// protocol the media elements use (it supports
  // fetch), and the result is sanitized before touching the DOM.
  useEffect(() => {
    if (!isDocx) return
    let cancelled = false
    ;(async () => {
      try {
        const mammoth = await import('mammoth')
        const res = await fetch(url)
        const arrayBuffer = await res.arrayBuffer()
        const { value } = await mammoth.convertToHtml({ arrayBuffer })
        if (!cancelled) setDocxHtml(DOMPurify.sanitize(value))
      } catch (err) {
        console.error('[Delta] docx render failed:', err)
        if (!cancelled) setDocxHtml('')
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, isDocx])

  useEffect(() => {
    if (!isDoc) return
    let cancelled = false
    // The .catch matters: an older running app (preload loaded before
    // this bridge method existed) or a missing word-extractor install
    // must land on the "couldn't read" fallback, not hang on Loading.
    Promise.resolve()
      .then(() => Delta.readDocText(file.path))
      .catch(() => null)
      .then((t) => {
        if (!cancelled) setDocText(t)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, isDoc])

  function flushSave() {
    clearTimeout(saveTimer.current)
    if (pendingRef.current == null) return Promise.resolve()
    const { path, content } = pendingRef.current
    pendingRef.current = null
    return Delta.writeFileText(path, content)
  }

  function handleChange(e) {
    const value = e.target.value
    setText(value)
    pendingRef.current = { path: file.path, content: value }
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flushSave, 400)
  }

  // Never lose the last few keystrokes when the tab unmounts (switching
  // tabs, closing the tab, quitting to the Notes grid) mid-debounce.
  useEffect(() => {
    return () => {
      flushSave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function showRendered() {
    await flushSave() // the iframe reads from disk - make sure disk is current
    setRenderVersion((v) => v + 1)
    setMode('rendered')
  }

  function openExternally() {
    window.deltaBridge.shell.openPath(file.path)
  }

  const noPreview = !isImage && !isVideo && !isAudio && !isText && !isDocx && !isPdf && !isDoc

  return (
    <div className="screen file-viewer-screen">
      <header className="top-bar">
        <div className="top-bar-actions">
          <button className="icon-btn" onClick={onBack} title="Back" type="button">
            <ArrowBackIcon />
          </button>
          {isHtml && (
            <>
              <button
                className={`icon-btn ${mode === 'edit' ? 'icon-btn-active' : ''}`}
                onClick={() => setMode('edit')}
                title="Edit source"
                type="button"
              >
                <EditIcon />
              </button>
              <button
                className={`icon-btn ${mode === 'rendered' ? 'icon-btn-active' : ''}`}
                onClick={showRendered}
                title="Rendered view"
                type="button"
              >
                <VisibilityIcon />
              </button>
            </>
          )}
        </div>

        <span className="file-viewer-screen-name">
          <Icon fontSize="small" />
          {file.name}
        </span>

        <div className="top-bar-actions">
          <button className="icon-btn" onClick={openExternally} title="Open with system app" type="button">
            <OpenInNewIcon />
          </button>
        </div>
      </header>

      <main className="file-viewer-screen-body">
        {isImage && <img src={url} alt={file.name} />}
        {isVideo && <video src={url} controls autoPlay />}
        {isAudio && <audio src={url} controls autoPlay />}

        {isText && (isHtml && mode === 'rendered' ? (
          // sandbox with no allow-* tokens: no scripts, no forms, no
          // popups - it's a document viewer, not a browser.
          <iframe
            key={renderVersion}
            className="file-viewer-screen-frame"
            src={url}
            sandbox=""
            title={file.name}
          />
        ) : (
          text === null ? (
            <div className="empty-state"><p>Loading…</p></div>
          ) : (
            <textarea
              className="file-viewer-screen-textarea"
              value={text}
              onChange={handleChange}
              spellCheck={false}
              placeholder="Empty file"
            />
          )
        ))}

        {isPdf && <iframe className="file-viewer-screen-frame" src={url} title={file.name} />}

        {isDoc && (
          docText === undefined ? (
            <div className="empty-state"><p>Loading…</p></div>
          ) : docText === null ? (
            <div className="empty-state">
              <p>Couldn't read this document.</p>
              <button className="btn btn-ghost" onClick={openExternally} type="button">
                <OpenInNewIcon fontSize="small" />
                <span>Open externally</span>
              </button>
            </div>
          ) : (
            <pre className="file-viewer-screen-pre">{docText || 'Empty document'}</pre>
          )
        )}

        {isDocx && (
          docxHtml === null ? (
            <div className="empty-state"><p>Loading…</p></div>
          ) : docxHtml === '' ? (
            <div className="empty-state">
              <p>Couldn't render this document.</p>
              <button className="btn btn-ghost" onClick={openExternally} type="button">
                <OpenInNewIcon fontSize="small" />
                <span>Open externally</span>
              </button>
            </div>
          ) : (
            <div className="file-viewer-screen-doc" dangerouslySetInnerHTML={{ __html: docxHtml }} />
          )
        )}

        {noPreview && (
          <div className="empty-state">
            <p>No in-app preview for .{(file.ext || '').toUpperCase()} files.</p>
            <button className="btn btn-ghost" onClick={openExternally} type="button">
              <OpenInNewIcon fontSize="small" />
              <span>Open externally</span>
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
