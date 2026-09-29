import { useEffect } from 'react'
import CloseIcon from '@mui/icons-material/Close'
import { toDeltaFileUrl } from '../utils/localFileUrl.js'
import { IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS } from '../utils/fileKind.js'

/**
 * In-app viewer for a vault file, used instead of handing off to the
 * OS's default app when the file is something Delta can already render
 * itself (image/video/audio - the same three types FileCard previews).
 * Everything else still opens externally - see App.jsx's openFile().
 */
export default function FileViewerModal({ file, onClose }) {
  useEffect(() => {
    if (!file) return
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [file, onClose])

  if (!file) return null

  const isImage = IMAGE_EXTS.has(file.ext)
  const isVideo = VIDEO_EXTS.has(file.ext)
  const isAudio = AUDIO_EXTS.has(file.ext)
  const url = toDeltaFileUrl(file.path)

  return (
    <div className="file-viewer-backdrop" onMouseDown={onClose}>
      <div className="file-viewer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="file-viewer-header">
          <span className="file-viewer-name">{file.name}</span>
          <button className="icon-btn" onClick={onClose} title="Close" type="button">
            <CloseIcon />
          </button>
        </div>
        <div className="file-viewer-body">
          {isImage && <img src={url} alt={file.name} />}
          {isVideo && <video src={url} controls autoPlay />}
          {isAudio && <audio src={url} controls autoPlay />}
        </div>
      </div>
    </div>
  )
}
