// Tiny path helpers for the renderer, which has no access to Node's
// `path` module (nodeIntegration is off, by design - see preload.js).

// Folder part of a path, always with forward slashes (handles both
// Windows and POSIX separators). Returns '' when there is no folder part.
export function dirnameOf(filePath) {
  const normalized = filePath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? '' : normalized.slice(0, idx)
}
