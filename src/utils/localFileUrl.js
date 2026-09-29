// Builds a delta-file:// URL for an absolute path on disk, so local
// vault files (images/video/audio/etc.) can be used as <img>/<video>/
// <a> src/href values. Shared by MarkdownPreview.jsx and FileCard.jsx -
// keep this the single source of truth, since the URL shape here is
// deliberately non-obvious (see the comment below).
export function toDeltaFileUrl(absPath) {
  // "delta-file" is registered (electron/main.js) with `standard: true`
  // so relative resolution/CORS/etc. all work like a normal origin -
  // Chromium then parses it exactly like http(s), which means it wants
  // a real, non-empty host. "delta-file:///Users/foo" (empty host, 3
  // slashes) is *not* kept as an empty host + absolute path the way
  // you'd expect: Chromium silently swallows the first path segment
  // into the host slot instead ("delta-file://users/foo", host
  // "users", lowercased), which fails to load with net::ERR_UNEXPECTED.
  // A fixed placeholder host sidesteps that ambiguity entirely - the
  // protocol.handle() in main.js ignores the host and only looks at
  // the path.
  return `delta-file://local${encodeURI(absPath)}`
}
