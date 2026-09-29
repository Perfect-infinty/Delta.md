// A tab's content only stays mounted while its tab is active (see
// App.jsx) - switching away and back throws away and rebuilds the whole
// DOM subtree, which resets any scrollable element's scrollTop back to
// 0 along with it. Plain useRef/useState inside the screen can't survive
// that (the component itself is unmounted), so this remembers scroll
// positions in a module-level Map instead - same idea as NoteEditor's
// viewModeByPath and MarkdownPreview's cachedMd. Session-only, not
// persisted to disk.
const positions = new Map(); // key -> scrollTop

/** Call once when the scrollable element mounts, to jump it back to
 * wherever it was left last time (a no-op the very first time, when
 * there's nothing saved yet for this key). */
export function restoreScroll(key, el) {
  if (!el || key == null) return;
  const saved = positions.get(key);
  if (saved != null) el.scrollTop = saved;
}

/** Call on every scroll (and/or on unmount) to keep the saved position
 * current. */
export function saveScroll(key, el) {
  if (!el || key == null) return;
  positions.set(key, el.scrollTop);
}
