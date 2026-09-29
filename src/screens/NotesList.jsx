import { useEffect, useState, useCallback, useRef } from 'react'
import AddIcon from '@mui/icons-material/Add'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined'
import ViewListOutlinedIcon from '@mui/icons-material/ViewListOutlined'
import NoteCard from '../components/NoteCard.jsx'
import FileCard from '../components/FileCard.jsx'
import FolderCard, { INTERNAL_DRAG_MIME } from '../components/FolderCard.jsx'
// (FolderCard also exports FOLDER_DRAG_MIME, consumed inside FolderCard
// itself - folder reordering arrives here via its onReorder callback.)
import Delta from '../api/DeltaAPI.js'
import { setCardDragImage } from '../utils/dragImage.js'

// All path comparisons here run on forward slashes, whatever the OS
// hands us - same normalization utils/path.js's dirnameOf applies.
function norm(p) {
  return (p || '').replace(/\\/g, '/')
}
function parentOf(p) {
  const n = norm(p)
  const idx = n.lastIndexOf('/')
  return idx === -1 ? '' : n.slice(0, idx)
}

// Notes and non-.md files are shown mixed together in one grid - pinned
// notes first, then anything the user has hand-ordered (drag one card
// onto another - the order lives in settings.gridOrder, per folder),
// then everything else by mtime. Items not yet in the order array (new
// notes, fresh imports) sort in *front* of ordered ones, same place a
// brand-new note lands in the default mtime-desc grid. Folders render
// before all of that, pinned folders first - like every file manager.
function mergeEntries(notes, files, pinnedSet, orderIndex) {
  const noteEntries = notes.map((n) => ({
    type: 'note',
    mtime: n.mtime,
    key: n.path,
    data: n,
    pinned: pinnedSet.has(n.path)
  }))
  const fileEntries = files.map((f) => ({ type: 'file', mtime: f.mtime, key: f.path, data: f, pinned: false }))
  return [...noteEntries, ...fileEntries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const ai = orderIndex(a.data.path)
    const bi = orderIndex(b.data.path)
    if (ai !== bi) return ai - bi
    return b.mtime - a.mtime
  })
}

// Session-only override for the card/list layout - the toolbar toggle
// changes this, but it never touches settings: the *default* (what a
// fresh app launch starts on) always comes from settings.notesView,
// set in Settings > General. `sessionNotesViewBase` records which
// settings value the override was made against - if the user changes
// the default in Settings afterwards, the stale override is discarded
// so the new default actually shows up (instead of looking like the
// setting "didn't work").
let sessionNotesView = null
let sessionNotesViewBase = null

// Remembers the folder being browsed across unmounts - opening a note
// from inside a folder fully unmounts this screen, and Back would
// otherwise always land on the vault root instead of the folder the
// note was opened from. Session-only, same idea as NoteEditor's
// viewModeByPath.
let lastBrowsedFolder = null

// `initialFolder` - the folder this tab was last browsing (restored
// from the session, or carried on an openTab target so an editor
// breadcrumb can land directly in a folder). `onFolderChange` reports
// the browsed folder upward so App can show its name on the tab.
export default function NotesList({ settings, onSettingsChange, initialFolder = null, onFolderChange }) {
  // Seed straight from Delta's in-memory cache so coming back to this
  // screen (it fully unmounts every time you open a note) repaints the
  // grid instantly instead of flashing "Loading notes…" again - the real
  // listNotes()/listFiles() calls below still run to catch anything
  // that changed.
  const cachedNotes = Delta.getCachedNotesList()
  const cachedFiles = Delta.getCachedFilesList()
  const [notes, setNotes] = useState(cachedNotes || [])
  const [files, setFiles] = useState(cachedFiles || [])
  // null = not fetched yet - deliberately NOT [] so the "does the
  // remembered folder still exist?" check below can tell "no folders in
  // the vault" apart from "the list just hasn't arrived yet" (notes/
  // files come from cache instantly, folders always need the IPC call).
  const [folders, setFolders] = useState(null)
  const [loading, setLoading] = useState(!cachedNotes && !cachedFiles)
  const [dragging, setDragging] = useState(false)
  // Which folder is being browsed - this tab's own remembered folder
  // first (initialFolder, restored across sessions), then wherever the
  // user last was this session (lastBrowsedFolder - covers Back from a
  // note, which builds a fresh tab), then the vault root. Held as an
  // absolute path. The stale check guards against a remembered folder
  // from a different vault.
  const [currentFolder, setCurrentFolder] = useState(() => {
    const root = Delta.vaultPath || ''
    const candidate = initialFolder || lastBrowsedFolder
    if (candidate && norm(candidate).startsWith(norm(root))) return candidate
    return root
  })

  // Tell App which folder this tab is on (it puts the folder's name on
  // the tab itself) - on mount and on every navigation.
  useEffect(() => {
    onFolderChange?.(currentFolder)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolder])

  useEffect(() => {
    lastBrowsedFolder = currentFolder
  }, [currentFolder])

  // The remembered folder can be deleted/renamed while this screen is
  // unmounted (the folder:delete/rename listeners below only run while
  // mounted) - once the real folder list arrives, fall back to the root
  // if it's gone. `folders === null` means the list hasn't been fetched
  // yet this mount - checking against it would wrongly reset to root.
  useEffect(() => {
    if (folders === null) return
    const root = norm(Delta.vaultPath)
    setCurrentFolder((cur) => {
      const c = norm(cur)
      if (!c || c === root) return cur
      return folders.some((f) => norm(f.path) === c) ? cur : Delta.vaultPath
    })
  }, [folders])

  // Published so TabBar's New note / New folder buttons (which live
  // outside this screen) create things in the folder being browsed
  // instead of always dumping them at the vault root.
  useEffect(() => {
    Delta.currentFolder = currentFolder || Delta.vaultPath
    return () => {
      // Only reset if nothing else (another grid tab) took over since.
      if (Delta.currentFolder === (currentFolder || Delta.vaultPath)) Delta.currentFolder = null
    }
  }, [currentFolder])

  const refresh = useCallback(async () => {
    const [noteList, fileList, folderList] = await Promise.all([
      Delta.listNotes(),
      Delta.listFiles(),
      Delta.listFolders()
    ])
    setNotes(noteList)
    setFiles(fileList)
    setFolders(folderList)
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
    const events = [
      'note:save', 'note:create', 'note:delete', 'note:rename',
      'file:import', 'file:rename', 'file:delete',
      'folder:create', 'folder:rename', 'folder:delete'
    ]
    const offs = events.map((ev) => Delta.on(ev, refresh))
    return () => offs.forEach((off) => off())
  }, [refresh])

  // A renamed/deleted folder can take the folder currently being browsed
  // with it - follow the rename, or fall back to the vault root.
  useEffect(() => {
    return Delta.on('folder:rename', ({ oldPath, newPath }) => {
      setCurrentFolder((cur) => {
        const c = norm(cur)
        const o = norm(oldPath)
        if (c === o || c.startsWith(o + '/')) return norm(newPath) + c.slice(o.length)
        return cur
      })
    })
  }, [])
  useEffect(() => {
    return Delta.on('folder:delete', ({ path }) => {
      setCurrentFolder((cur) => {
        const c = norm(cur)
        const o = norm(path)
        return c === o || c.startsWith(o + '/') ? Delta.vaultPath : cur
      })
    })
  }, [])

  async function createNote() {
    const path = await Delta.createNote('Untitled', currentFolder || undefined)
    Delta.openTab({ type: 'editor', notePath: path })
  }

  function handleDragOver(e) {
    e.preventDefault()
    setDragging(true)
  }

  // Dropping OS files on the grid's background imports them into the
  // folder currently being browsed (not blindly the vault root).
  async function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    const dropped = Array.from(e.dataTransfer.files || [])
    if (dropped.length === 0) return
    for (const f of dropped) {
      const sourcePath = Delta.getDroppedFilePath(f)
      if (sourcePath) await Delta.importFile(sourcePath, currentFolder || Delta.vaultPath)
    }
    refresh()
  }

  // 'grid' (cards) or 'list' (compact rows). The toolbar button toggles
  // it for this session only - the default is always settings.notesView
  // (Settings > General). A session override is honored only while the
  // settings default it was made against is unchanged; changing the
  // default in Settings always wins, immediately.
  const settingsView = settings?.notesView === 'list' ? 'list' : 'grid'
  const [notesView, setNotesView] = useState(() =>
    sessionNotesView && sessionNotesViewBase === settingsView ? sessionNotesView : settingsView
  )
  const viewSyncedOnce = useRef(false)
  useEffect(() => {
    // Skip the mount run (initial state already resolved above) - this
    // only reacts to the default *changing* while we're mounted.
    if (!viewSyncedOnce.current) {
      viewSyncedOnce.current = true
      return
    }
    sessionNotesView = null
    sessionNotesViewBase = null
    setNotesView(settingsView)
  }, [settingsView])
  function toggleNotesView() {
    setNotesView((v) => {
      const next = v === 'grid' ? 'list' : 'grid'
      sessionNotesView = next
      sessionNotesViewBase = settingsView
      return next
    })
  }

  const pinnedNotes = settings?.pinnedNotes || []
  const pinnedFolders = settings?.pinnedFolders || []
  const pinnedSet = new Set(pinnedNotes)
  const pinnedFolderSet = new Set(pinnedFolders)

  // Pinned state lives in the same settings.json every other per-vault
  // preference (theme, enabled plugins) is already persisted through -
  // no separate file, no touching the note's own content, just a plain
  // list of paths. handleSettingsChange (App.jsx) both updates React
  // state and writes it to disk, same as toggling a plugin does.
  function togglePin(path) {
    if (!onSettingsChange) return
    const isPinned = pinnedSet.has(path)
    const nextPinned = isPinned ? pinnedNotes.filter((p) => p !== path) : [...pinnedNotes, path]
    onSettingsChange({ ...settings, pinnedNotes: nextPinned })
  }

  function toggleFolderPin(path) {
    if (!onSettingsChange) return
    const isPinned = pinnedFolderSet.has(path)
    const nextPinned = isPinned ? pinnedFolders.filter((p) => p !== path) : [...pinnedFolders, path]
    onSettingsChange({ ...settings, pinnedFolders: nextPinned })
  }

  // Only this folder's direct children - notes/files/folders that live
  // deeper show up once you navigate into their own folder.
  const here = norm(currentFolder || Delta.vaultPath)

  // Hand-made ordering (drag a card onto another card) - one array of
  // paths per browsed folder, folders and notes/files together. Items
  // missing from it (never reordered, or new since) get -1 so they sort
  // ahead, where a new item would land in the default mtime-desc grid.
  const gridOrder = settings?.gridOrder || {}
  const order = gridOrder[here] || []
  const orderIndex = (p) => order.indexOf(norm(p))

  const notesHere = notes.filter((n) => parentOf(n.path) === here)
  const filesHere = files.filter((f) => parentOf(f.path) === here)
  const foldersHere = (folders || [])
    .filter((f) => parentOf(f.path) === here)
    .sort((a, b) => {
      const ai = orderIndex(a.path)
      const bi = orderIndex(b.path)
      if (ai !== bi) return ai - bi
      return a.name.localeCompare(b.name)
    })
  const entries = mergeEntries(notesHere, filesHere, pinnedSet, orderIndex)

  // Final card sequence: everything pinned first - pinned folders AND
  // pinned notes, ahead of even unpinned folders (a pin means "always on
  // top", period) - then the remaining folders, then everything else.
  const displayCards = [
    ...foldersHere.filter((f) => pinnedFolderSet.has(f.path)).map((f) => ({ kind: 'folder', folder: f })),
    ...entries.filter((en) => en.pinned).map((en) => ({ kind: 'entry', entry: en })),
    ...foldersHere.filter((f) => !pinnedFolderSet.has(f.path)).map((f) => ({ kind: 'folder', folder: f })),
    ...entries.filter((en) => !en.pinned).map((en) => ({ kind: 'entry', entry: en }))
  ]

  // Drop of card A onto card B = "A goes right in front of B". Persists
  // the *entire* current visual sequence for this folder, so one drag
  // pins down the whole arrangement, not just A.
  function reorderItem(draggedPath, targetPath) {
    if (!onSettingsChange || draggedPath === targetPath) return
    const seq = displayCards.map((c) => norm(c.kind === 'folder' ? c.folder.path : c.entry.data.path))
    const src = norm(draggedPath)
    const dst = norm(targetPath)
    const from = seq.indexOf(src)
    if (from === -1) return
    seq.splice(from, 1)
    const to = seq.indexOf(dst)
    if (to === -1) return
    seq.splice(to, 0, src)
    onSettingsChange({ ...settings, gridOrder: { ...gridOrder, [here]: seq } })
  }

  // What each folder card previews: its own direct children.
  function folderContents(folderPath) {
    const p = norm(folderPath)
    const inside = [
      ...(folders || []).filter((f) => parentOf(f.path) === p).map((f) => ({ kind: 'folder', name: f.name })),
      ...notes.filter((n) => parentOf(n.path) === p).map((n) => ({ kind: 'note', name: n.title })),
      ...files.filter((f) => parentOf(f.path) === p).map((f) => ({ kind: 'file', name: f.name }))
    ]
    return inside
  }

  // Breadcrumb segments from the vault root down to the current folder.
  const vaultRoot = norm(Delta.vaultPath)
  const crumbs = [{ label: vaultRoot.split('/').pop() || 'Vault', path: Delta.vaultPath }]
  if (here && here !== vaultRoot && here.startsWith(vaultRoot + '/')) {
    let acc = vaultRoot
    for (const seg of here.slice(vaultRoot.length + 1).split('/')) {
      acc += '/' + seg
      crumbs.push({ label: seg, path: acc })
    }
  }

  // Cards are drag *sources* (dropping one on a FolderCard/breadcrumb
  // moves it there) and also drop *targets* for each other - dropping
  // card A on card B reorders A in front of B. Spread onto each card's
  // own root element (NOT a wrapper div): the browser snapshots the
  // draggable element for the drag ghost, and a wrapper's snapshot
  // caught the neighboring cards in the picture.
  function dragProps(path) {
    return {
      draggable: true,
      onDragStart: (e) => {
        e.dataTransfer.setData(INTERNAL_DRAG_MIME, path)
        e.dataTransfer.effectAllowed = 'move'
        setCardDragImage(e) // explicit ghost - just this card, no neighbors
      },
      onDragOver: (e) => {
        if (!e.dataTransfer.types.includes(INTERNAL_DRAG_MIME)) return
        e.preventDefault()
        e.stopPropagation()
      },
      onDrop: (e) => {
        const src = e.dataTransfer.getData(INTERNAL_DRAG_MIME)
        if (!src || src === path) return
        e.preventDefault()
        e.stopPropagation()
        reorderItem(src, path)
      }
    }
  }

  // Breadcrumb segments double as drop targets, so a card can be dragged
  // *up* the tree, not only down into folder cards.
  function crumbDropProps(destPath) {
    return {
      onDragOver: (e) => {
        if (!e.dataTransfer.types.includes(INTERNAL_DRAG_MIME)) return
        e.preventDefault()
        e.stopPropagation()
      },
      onDrop: async (e) => {
        const internalPath = e.dataTransfer.getData(INTERNAL_DRAG_MIME)
        if (!internalPath) return
        e.preventDefault()
        e.stopPropagation()
        await Delta.moveFile(internalPath, destPath)
        refresh()
      }
    }
  }

  return (
    <div className="screen notes-screen">
      <div className="notes-toolbar">
        <nav className="notes-breadcrumb">
          {crumbs.map((crumb, i) => (
            <span key={crumb.path} className="notes-breadcrumb-item">
              {i > 0 && <ChevronRightIcon fontSize="inherit" className="notes-breadcrumb-sep" />}
              <button
                className={`notes-breadcrumb-btn ${i === crumbs.length - 1 ? 'notes-breadcrumb-current' : ''}`}
                onClick={() => setCurrentFolder(crumb.path)}
                type="button"
                {...crumbDropProps(crumb.path)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <div className="notes-toolbar-actions">
          <button
            className="icon-btn"
            onClick={toggleNotesView}
            title={notesView === 'grid' ? 'Switch to list view' : 'Switch to card view'}
            type="button"
          >
            {notesView === 'grid' ? <ViewListOutlinedIcon fontSize="small" /> : <GridViewOutlinedIcon fontSize="small" />}
          </button>
        </div>
      </div>

      <main
        className={`notes-grid-wrap ${dragging ? 'drop-target-active' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        {loading ? (
          <p className="empty-hint">Loading notes…</p>
        ) : displayCards.length === 0 ? (
          <div className="empty-state">
            <p>Nothing here yet. Drag a file in, or:</p>
            <button className="btn btn-primary" onClick={createNote} type="button">
              <AddIcon fontSize="small" />
              <span>Create a note</span>
            </button>
          </div>
        ) : (
          <div className={notesView === 'list' ? 'notes-grid notes-list' : 'notes-grid'}>
            {displayCards.map((card) =>
              card.kind === 'folder' ? (
                <FolderCard
                  key={card.folder.path}
                  folder={card.folder}
                  contents={folderContents(card.folder.path)}
                  pinned={pinnedFolderSet.has(card.folder.path)}
                  onTogglePin={() => toggleFolderPin(card.folder.path)}
                  onOpen={(f) => setCurrentFolder(f.path)}
                  onMoved={refresh}
                  onReorder={reorderItem}
                />
              ) : card.entry.type === 'note' ? (
                <NoteCard
                  key={card.entry.key}
                  note={card.entry.data}
                  pinned={card.entry.pinned}
                  onTogglePin={() => togglePin(card.entry.data.path)}
                  dragProps={dragProps(card.entry.data.path)}
                />
              ) : (
                <FileCard key={card.entry.key} file={card.entry.data} dragProps={dragProps(card.entry.data.path)} />
              )
            )}
          </div>
        )}
      </main>
    </div>
  )
}
