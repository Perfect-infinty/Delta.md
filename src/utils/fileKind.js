import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined'
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined'
import MovieOutlinedIcon from '@mui/icons-material/MovieOutlined'
import AudiotrackOutlinedIcon from '@mui/icons-material/AudiotrackOutlined'
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined'

// Shared file-extension categorization - used by FileCard (Notes grid
// previews) and CommandPalette (search result icons), so both agree on
// what counts as an image/video/audio/previewable-text file.
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'])
export const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'])
export const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac'])
// Anything plain-text enough to preview a snippet of - txt and html
// included. These are also what FileViewer opens as an *editable* tab
// now (html additionally gets a rendered preview mode there).
export const TEXT_EXTS = new Set([
  'txt', 'csv', 'log', 'json', 'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'htm',
  'xml', 'yml', 'yaml', 'sh', 'py', 'java', 'c', 'cpp', 'h', 'ini', 'conf'
])
// Word documents FileViewer can render in-app (read-only, via mammoth).
// Legacy binary .doc isn't parseable by mammoth, so only .docx here -
// .doc keeps falling through to "open externally".
export const DOCX_EXTS = new Set(['docx'])

export function iconFor(ext) {
  if (IMAGE_EXTS.has(ext)) return ImageOutlinedIcon
  if (VIDEO_EXTS.has(ext)) return MovieOutlinedIcon
  if (AUDIO_EXTS.has(ext)) return AudiotrackOutlinedIcon
  if (ext === 'pdf') return PictureAsPdfOutlinedIcon
  if (TEXT_EXTS.has(ext) || DOCX_EXTS.has(ext) || ext === 'doc') return DescriptionOutlinedIcon
  return InsertDriveFileOutlinedIcon
}
