import Delta from '../api/DeltaAPI.js'

// Lets something outside the note editor (the vault-wide content search,
// currently) say "open this note AND jump straight to this search
// query's first match" - the same experience clicking a result gives you
// in any real code/text editor's project-wide search, instead of just
// dropping you at the top of the note with no indication of where the
// match actually was.
//
// Two delivery mechanisms, because the target note's editor may or may
// not already be mounted at the moment this is called (see App.jsx - a
// tab's content only stays mounted while its tab is the active one):
//  - A live event (`editor:find-request`), for when that note's editor
//    happens to already be the active tab right now.
//  - A plain pending-request map, for when opening the note causes a
//    fresh mount (a background tab becoming active, or a brand new tab)
//    - nothing is listening for the live event yet at the moment this
//    runs, so NoteEditor checks this map for itself once it mounts.
const pending = new Map(); // path -> query

export function requestFindInNote(path, query) {
  pending.set(path, query);
  Delta.emit('editor:find-request', { path, query });
}

/** Called by NoteEditor once it mounts (or its notePath changes) -
 * consumes (and forgets) whatever was pending for that exact path. */
export function takePendingFind(path) {
  const query = pending.get(path);
  if (query != null) pending.delete(path);
  return query ?? null;
}
