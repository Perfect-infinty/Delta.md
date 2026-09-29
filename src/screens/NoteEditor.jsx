import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import VerticalSplitIcon from '@mui/icons-material/VerticalSplit'
import OpenInFullIcon from '@mui/icons-material/OpenInFull'
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import CalculateIcon from '@mui/icons-material/Calculate'
import BoltIcon from '@mui/icons-material/Bolt'
import StarIcon from '@mui/icons-material/Star'
import ExtensionIcon from '@mui/icons-material/Extension'
import TimerIcon from '@mui/icons-material/Timer'
import StopIcon from '@mui/icons-material/Stop'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import PauseIcon from '@mui/icons-material/Pause'
import RefreshIcon from '@mui/icons-material/Refresh'
import AddIcon from '@mui/icons-material/Add'
import CloseIcon from '@mui/icons-material/Close'
import CheckIcon from '@mui/icons-material/Check'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import SearchIcon from '@mui/icons-material/Search'
import SaveIcon from '@mui/icons-material/Save'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import LinkIcon from '@mui/icons-material/Link'
import ImageIcon from '@mui/icons-material/Image'
import TableChartIcon from '@mui/icons-material/TableChart'
import CodeIcon from '@mui/icons-material/Code'
import CalendarTodayIcon from '@mui/icons-material/CalendarToday'
import NotificationsIcon from '@mui/icons-material/Notifications'
import SettingsIcon from '@mui/icons-material/Settings'
import InfoIcon from '@mui/icons-material/Info'
import WarningIcon from '@mui/icons-material/Warning'
import HelpIcon from '@mui/icons-material/Help'
import VisibilityIcon from '@mui/icons-material/Visibility'
import LockIcon from '@mui/icons-material/Lock'
import PersonIcon from '@mui/icons-material/Person'
import LabelIcon from '@mui/icons-material/Label'
import FlagIcon from '@mui/icons-material/Flag'
import BookmarkIcon from '@mui/icons-material/Bookmark'
import HistoryIcon from '@mui/icons-material/History'
import SyncIcon from '@mui/icons-material/Sync'
import AttachFileIcon from '@mui/icons-material/AttachFile'
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted'
import TerminalIcon from '@mui/icons-material/Terminal'
import FolderIcon from '@mui/icons-material/Folder'
import ShareIcon from '@mui/icons-material/Share'
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty'
import AlarmIcon from '@mui/icons-material/Alarm'
import EventIcon from '@mui/icons-material/Event'
import MarkdownPreview from '../components/MarkdownPreview.jsx'
import WikilinkAutocomplete from '../components/WikilinkAutocomplete.jsx'
import FindReplaceBar from '../components/FindReplaceBar.jsx'
import Delta from '../api/DeltaAPI.js'
import { getCaretCoordinates } from '../utils/caretPosition.js'
import { dirnameOf } from '../utils/path.js'
import { restoreScroll, saveScroll } from '../utils/scrollMemory.js'
import { takePendingFind } from '../utils/pendingFind.js'

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const HTML_ESCAPE_RE = /[&<>]/g
const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
function escapeHtml(str) {
  return str.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch])
}

// Fixed set of icons plugin authors can reference by name from their
// manifest/toolbar registration. Keeps plugins dependency-free (no icon
// packages to install) while still looking native. Keyed lowercase and
// looked up lowercase below, so a plugin using "timer", "Timer" or
// "TIMER" all resolve the same way instead of silently falling back to
// the generic Extension icon over a casing mismatch.
const TOOLBAR_ICONS = {
  calculate: CalculateIcon,
  bolt: BoltIcon,
  star: StarIcon,
  extension: ExtensionIcon,
  timer: TimerIcon,
  stop: StopIcon,
  playarrow: PlayArrowIcon,
  play: PlayArrowIcon,
  pause: PauseIcon,
  refresh: RefreshIcon,
  add: AddIcon,
  close: CloseIcon,
  check: CheckIcon,
  delete: DeleteIcon,
  edit: EditIcon,
  search: SearchIcon,
  save: SaveIcon,
  contentcopy: ContentCopyIcon,
  copy: ContentCopyIcon,
  link: LinkIcon,
  image: ImageIcon,
  tablechart: TableChartIcon,
  table: TableChartIcon,
  code: CodeIcon,
  calendartoday: CalendarTodayIcon,
  calendar: CalendarTodayIcon,
  notifications: NotificationsIcon,
  settings: SettingsIcon,
  info: InfoIcon,
  warning: WarningIcon,
  help: HelpIcon,
  visibility: VisibilityIcon,
  lock: LockIcon,
  person: PersonIcon,
  label: LabelIcon,
  flag: FlagIcon,
  bookmark: BookmarkIcon,
  history: HistoryIcon,
  sync: SyncIcon,
  attachfile: AttachFileIcon,
  attach: AttachFileIcon,
  formatlistbulleted: FormatListBulletedIcon,
  list: FormatListBulletedIcon,
  terminal: TerminalIcon,
  folder: FolderIcon,
  share: ShareIcon,
  hourglassempty: HourglassEmptyIcon,
  hourglass: HourglassEmptyIcon,
  alarm: AlarmIcon,
  event: EventIcon
}

function titleFromPath(path) {
  const fileName = path.split(/[\\/]/).pop() || ''
  return fileName.replace(/\.md$/i, '')
}

const EMBED_RE = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g
// Matches an *unclosed* [[ or ![[ right up to the caret, so we know the
// user is actively in the middle of typing a link/embed target.
const OPEN_WIKILINK_RE = /(!)?\[\[([^\]|\n]*)$/

// Remembers each note's last view mode (edit/split/preview) for this
// session - a tab's content only stays mounted while its tab is active
// (see App.jsx), so switching to another tab and back fully unmounts
// and remounts NoteEditor, which would otherwise reset viewMode to the
// 'preview' default every single time instead of where you left it.
// Not persisted to disk - same idea as MarkdownPreview's module-level
// cachedMd, just for the current run of the app.
const viewModeByPath = new Map()

// Extension -> what to insert when a file with that extension is
// dropped into the editor, so it shows up embedded right away instead
// of just as a plain link. Video's `type=` needs the actual MIME
// subtype, which isn't always the same as the file extension.
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'])
const VIDEO_MIME_BY_EXT = {
  mp4: 'mp4', m4v: 'mp4', webm: 'webm', mov: 'quicktime', mkv: 'x-matroska', avi: 'x-msvideo'
}
const AUDIO_MIME_BY_EXT = { mp3: 'mpeg', wav: 'wav', ogg: 'ogg', m4a: 'mp4', flac: 'flac' }

function buildEmbedSnippet(filename, ext) {
  const lowerExt = (ext || '').toLowerCase()
  if (IMAGE_EXTS.has(lowerExt)) return `![${filename}](${filename})`
  if (VIDEO_MIME_BY_EXT[lowerExt]) {
    return `<video controls>\n  <source src="${filename}" type="video/${VIDEO_MIME_BY_EXT[lowerExt]}">\n</video>`
  }
  if (AUDIO_MIME_BY_EXT[lowerExt]) {
    return `<audio controls src="${filename}"></audio>`
  }
  return `[${filename}](${filename})`
}

// Defaults make this usable as a plain top-level tab (App.jsx renders
// it with none of these props supplied) while still letting GraphView
// override all three for its own nested, non-tab note-preview pane.
export default function NoteEditor({
  notePath,
  // Whether this editor's tab is the active one. Every open tab stays
  // mounted now (see App.jsx's .tab-panel keep-alive rendering), so
  // several NoteEditors can be alive at once - only the active one may
  // react to global events (Cmd/Ctrl+F's 'editor:find-open') or register
  // itself as the editor Delta's cursor/selection API operates on.
  // Defaults to true for nested, non-tab usage (GraphView's note pane).
  isActive = true,
  // The Back arrow always means "return to the Notes grid" - it must
  // NOT just close this tab (closeActiveTab reveals whatever tab
  // happens to sit next to it, which reads as "jumping to a random
  // other open tab" rather than going back). Notes tabs aren't deduped
  // (see keyForTarget in App.jsx), so this replaces this tab's content
  // in place instead of disturbing any other open tab.
  onBack = () => Delta.openTab({ type: 'notes' }),
  onDeleted = () => Delta.closeActiveTab(),
  onNavigateNote = (title, opts) => Delta.navigateToNoteTitle(title, opts),
  // What a freshly-opened note starts in ('edit' | 'split' | 'preview') -
  // user-configurable in Settings (App passes settings.defaultEditorView).
  // Only the *initial* mode: once the user switches modes on a note,
  // viewModeByPath remembers that choice for the rest of the session.
  defaultViewMode = 'preview'
}) {
  const [content, setContent] = useState('')
  const [title, setTitle] = useState(titleFromPath(notePath))
  const [viewMode, setViewMode] = useState(() => viewModeByPath.get(notePath) || defaultViewMode) // 'edit' | 'split' | 'preview' (full-screen preview)
  const [toolbarButtons, setToolbarButtons] = useState(Delta.toolbarButtons)
  const [currentPath, setCurrentPath] = useState(notePath)
  const [embedContents, setEmbedContents] = useState(new Map())
  const [allNotes, setAllNotes] = useState([])
  const [autocomplete, setAutocomplete] = useState(null) // { start, query, top, left, items, selectedIndex }
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [replaceQuery, setReplaceQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [dragging, setDragging] = useState(false)
  const saveTimer = useRef(null)
  const embedTimer = useRef(null)
  const refreshTitlesTimer = useRef(null)
  const textareaRef = useRef(null)
  const findInputRef = useRef(null)
  // True once the user has typed anything since this note was loaded -
  // guards the background disk read below from ever clobbering an
  // in-progress edit with a stale cached/disk value.
  const editedSinceLoadRef = useRef(false)

  // Keeps viewModeByPath current so the next time this note's tab is
  // (re)mounted - after switching away and back - it picks up wherever
  // the user last left it instead of resetting to 'preview'.
  useEffect(() => {
    viewModeByPath.set(currentPath, viewMode)
  }, [viewMode, currentPath])

  // All open tabs stay mounted now (App.jsx), so global events like
  // 'editor:find-open' reach every mounted editor - this ref lets the
  // mount-once listeners below check "am I the active tab?" at the
  // moment the event fires, without re-subscribing on every change.
  const isActiveRef = useRef(isActive)
  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  // Cmd/Ctrl+F opens *this* note's own find bar instead of the app-wide
  // vault search when a note editor is the active tab (see App.jsx's
  // global shortcut handler, which emits this only in that case) -
  // always opens (never toggles closed) and refocuses+reselects the
  // query, so pressing Cmd+F again while it's already open is still
  // useful instead of a no-op. Only the *active* tab's editor may react:
  // with keep-alive tabs, every open editor is mounted and would
  // otherwise all pop their find bars at once.
  useEffect(() => {
    return Delta.on('editor:find-open', () => {
      if (!isActiveRef.current) return
      setFindOpen(true)
      requestAnimationFrame(() => findInputRef.current?.select())
    })
  }, [])

  // The live counterpart to takePendingFind() above - covers a search
  // result for a note whose editor happens to already be the active,
  // mounted tab right now (the pending-map check only runs on mount, so
  // it can't catch that case - nothing remounts to trigger it).
  useEffect(() => {
    return Delta.on('editor:find-request', ({ path, query }) => {
      if (path !== latestRef.current.currentPath) return
      // Consume the pending-map entry too (requestFindInNote sets both) -
      // with keep-alive tabs this live path handles most cases, and a
      // leftover entry would otherwise auto-open a stale query the next
      // time this note mounts fresh.
      takePendingFind(path)
      setFindQuery(query)
      setFindOpen(true)
    })
  }, [])

  // Always holds the *current* render's content/title/currentPath, so
  // functions handed off once (to Delta's active-editor registration, or
  // held onto across renders in a mount-once effect below) can read fresh
  // values through the ref instead of closing over whichever render they
  // happened to be created in and going stale the moment content changes.
  const latestRef = useRef({})
  latestRef.current = { content, title, currentPath }

  // Updated on every real keystroke - the external-save-sync effect below
  // uses this to avoid adopting an incoming note:save while the user is
  // still actively mid-edit (a slow/async plugin's rewrite landing a
  // beat after the user has already typed past it shouldn't clobber that).
  const lastLocalEditAtRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    editedSinceLoadRef.current = false

    // Show a cached copy of this note instantly, if we have one (already
    // opened it this session, or just wrote/created it) - no blank editor
    // while an IPC round trip to disk completes. The real read below
    // still runs right after, to catch any change made outside the app.
    const cached = Delta.getCachedNoteContent(notePath)
    setCurrentPath(notePath)
    setTitle(titleFromPath(notePath))
    setAutocomplete(null)

    // Opened via a vault-wide search result (see ContentSearch/
    // pendingFind.js)? Pick up the query it left for this exact path and
    // open straight into it - matches/goToMatch below take it from here
    // once `content` finishes loading (or already has, from cache).
    const pendingQuery = takePendingFind(notePath)
    if (pendingQuery != null) {
      setFindQuery(pendingQuery)
      setFindOpen(true)
    }

    // _setCurrentNote only when this tab is actually in front - restored
    // background tabs (or a hidden tab whose note loads late) shouldn't
    // steal the "current note" from the tab the user is looking at.
    if (cached != null) {
      setContent(cached)
      if (isActiveRef.current) Delta._setCurrentNote({ path: notePath, content: cached, title: titleFromPath(notePath) })
    }

    Delta.readNote(notePath).then((text) => {
      if (cancelled) return
      if (editedSinceLoadRef.current) return // user already typed - don't stomp on it
      if (cached != null && text === cached) return // nothing changed, skip the re-render
      setContent(text)
      if (isActiveRef.current) Delta._setCurrentNote({ path: notePath, content: text, title: titleFromPath(notePath) })
    })
    return () => {
      cancelled = true
    }
  }, [notePath])

  useEffect(() => {
    return Delta.on('toolbar:changed', setToolbarButtons)
  }, [])

  // Registers this editor as the one Delta's cursor/selection API
  // (getSelection/insertAtCursor/etc, see DeltaAPI.js) operates on. The
  // handle's functions all read the *current* content/path/textarea
  // through refs rather than closing over this render's values, so
  // holding onto this one object (instead of re-registering on every
  // render) is safe and never goes stale. Registered only while this
  // editor's tab is active - with keep-alive tabs, every open editor is
  // mounted at once, and whichever mounted *last* would otherwise win,
  // not whichever tab the user is actually looking at. Unregisters on
  // deactivation/unmount so a plugin calling these with no note focused
  // gets a harmless no-op instead of poking a background tab.
  useEffect(() => {
    if (!isActive) return undefined
    // Re-activating this tab also makes its note the "current note"
    // again as far as plugins are concerned (Delta.getCurrentNote(),
    // toolbar button onClick payloads) - without this, the current note
    // would stay pointing at whichever note's editor was in front last,
    // regardless of which tab is in front now. Skipped when the current
    // note already *is* this path: on first mount the load effect above
    // (which runs before this one) has just set it with the note's real
    // content, while latestRef here still holds this render's initial
    // empty string - overwriting would briefly hand plugins a blank note.
    const { currentPath: p, content: c, title: t } = latestRef.current
    if (Delta.getCurrentNote()?.path !== p) {
      Delta._setCurrentNote({ path: p, content: c, title: t })
    }
    const handle = {
      getValue: () => latestRef.current.content,
      getSelection: () => {
        const el = textareaRef.current
        const current = latestRef.current.content
        if (!el) return { start: current.length, end: current.length, text: '' }
        const { selectionStart: start, selectionEnd: end } = el
        return { start, end, text: current.slice(start, end) }
      },
      setSelection: (start, end) => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(start, end)
      },
      insertText: (text) => replaceSelectionWith(text),
      focus: () => textareaRef.current?.focus()
    }
    return Delta._registerActiveEditor(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  // Adopts a note:save event for *this* open note when its content
  // differs from what's currently shown - the case that matters is a
  // plugin's own note:save handler calling writeNote() again to rewrite
  // what it just matched (a text-expansion snippet, say): that write
  // lands on disk fine, but without this, this editor's in-memory content
  // never picks it up - it keeps showing the pre-expansion text until the
  // note is closed and reopened, and the next autosave would silently
  // overwrite the plugin's change right back out. Skipped for a brief
  // window after the user's last keystroke so a slow/async plugin can't
  // clobber typing that happened after the content it's rewriting.
  useEffect(() => {
    return Delta.on('note:save', (saved) => {
      const { content: latestContent, currentPath: latestPath, title: latestTitle } = latestRef.current
      if (saved.path !== latestPath) return
      if (saved.content === latestContent) return
      if (Date.now() - lastLocalEditAtRef.current < 300) return
      editedSinceLoadRef.current = true
      setContent(saved.content)
      if (isActiveRef.current) Delta._setCurrentNote({ path: latestPath, content: saved.content, title: latestTitle })
    })
  }, [])

  // Keep a light list of every note's title around, for the [[ / ![[
  // autocomplete dropdown and for the command palette. note:save fires
  // on every autosave (every ~400ms while typing), so debounce the
  // refetch instead of hitting the vault on every single one of those.
  useEffect(() => {
    const cached = Delta.getCachedNotesList()
    if (cached) setAllNotes(cached)
    Delta.listNotes().then(setAllNotes)

    function refreshDebounced() {
      clearTimeout(refreshTitlesTimer.current)
      refreshTitlesTimer.current = setTimeout(() => {
        Delta.listNotes().then(setAllNotes)
      }, 500)
    }

    const offSave = Delta.on('note:save', refreshDebounced)
    const offCreate = Delta.on('note:create', refreshDebounced)
    const offDelete = Delta.on('note:delete', refreshDebounced)
    return () => {
      clearTimeout(refreshTitlesTimer.current)
      offSave()
      offCreate()
      offDelete()
    }
  }, [])

  // Resolve ![[embeds]] referenced in the current text into their raw
  // markdown, so the preview pane can expand them inline. Only bother
  // once a preview pane is actually visible, and debounce it - typing
  // anywhere in a note that happens to contain an embed shouldn't fire
  // an IPC round trip on every keystroke.
  useEffect(() => {
    if (viewMode === 'edit') return
    let cancelled = false
    clearTimeout(embedTimer.current)

    embedTimer.current = setTimeout(async () => {
      const titles = new Set()
      let m
      EMBED_RE.lastIndex = 0
      while ((m = EMBED_RE.exec(content))) {
        const t = m[1].trim()
        if (t) titles.add(t)
      }
      if (titles.size === 0) {
        if (!cancelled) setEmbedContents(new Map())
        return
      }
      const notes = await Delta.listNotes()
      const map = new Map()
      for (const t of titles) {
        const match = notes.find((n) => n.title.toLowerCase() === t.toLowerCase())
        if (match) {
          try {
            map.set(t.toLowerCase(), await Delta.readNote(match.path))
          } catch {
            /* ignore unreadable note */
          }
        }
      }
      if (!cancelled) setEmbedContents(map)
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(embedTimer.current)
    }
  }, [content, viewMode])

  const scheduleSave = useCallback(
    (nextContent) => {
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        Delta.writeNote(currentPath, nextContent)
        Delta._setCurrentNote({ path: currentPath, content: nextContent, title })
      }, 400)
    },
    [currentPath, title]
  )
  // scheduleSave is recreated (via useCallback) whenever currentPath/title
  // change - stash the current one in latestRef too, so replaceSelectionWith
  // below (held onto once, by the active-editor registration effect) always
  // calls the version that knows the note's current path instead of the
  // one that existed when that registration effect first ran.
  latestRef.current.scheduleSave = scheduleSave

  // Plain-text (no regex) find & replace, operating directly on the
  // textarea's own selection - "next match" is just moving the native
  // text selection, no separate highlight overlay needed.
  const matches = useMemo(() => {
    const q = findQuery.trim()
    if (!q) return []
    const lowerContent = content.toLowerCase()
    const lowerQuery = q.toLowerCase()
    const found = []
    let from = 0
    while (true) {
      const idx = lowerContent.indexOf(lowerQuery, from)
      if (idx === -1) break
      found.push({ start: idx, end: idx + q.length })
      from = idx + q.length
    }
    return found
  }, [content, findQuery])

  useEffect(() => {
    if (!findOpen || matches.length === 0) return
    goToMatch(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, findOpen])

  // Edit-mode find highlighting. The textarea itself can't render
  // highlights, and its native selection (which goToMatch sets) is
  // invisible while the textarea is unfocused - and it stays unfocused
  // deliberately, so Enter/arrows keep working in the find bar. So the
  // matches are drawn on a mirror layer behind the textarea instead:
  // same text, same typography/wrapping (the getCaretCoordinates mirror
  // technique, as a persistent element), with <mark>s around matches and
  // transparent text everywhere - only the mark backgrounds show through
  // behind the textarea's own text. null when find is closed or has no
  // matches, which unmounts the layer entirely.
  const highlightHtml = useMemo(() => {
    if (!findOpen || matches.length === 0) return null
    let out = ''
    let last = 0
    matches.forEach((m, i) => {
      out += escapeHtml(content.slice(last, m.start))
      out += `<mark class="md-find-match${i === matchIndex ? ' md-find-match-active' : ''}">${escapeHtml(content.slice(m.start, m.end))}</mark>`
      last = m.end
    })
    // Trailing newline so a match on the very last line still has a
    // rendered line box to sit on, keeping heights in sync.
    out += escapeHtml(content.slice(last)) + '\n'
    return out
  }, [findOpen, matches, matchIndex, content])

  const highlightsRef = useRef(null)
  // The mirror doesn't scroll on its own (pointer-events: none) - it
  // follows the textarea, both on user scroll (onScroll below) and on
  // programmatic jumps/content changes (this effect).
  function syncHighlightScroll() {
    const el = textareaRef.current
    const hl = highlightsRef.current
    if (!el || !hl) return
    hl.scrollTop = el.scrollTop
    hl.scrollLeft = el.scrollLeft
  }
  useEffect(() => {
    syncHighlightScroll()
  }, [highlightHtml, viewMode])

  function goToMatch(index) {
    if (matches.length === 0) return
    const clamped = ((index % matches.length) + matches.length) % matches.length
    setMatchIndex(clamped)
    const m = matches[clamped]
    const el = textareaRef.current
    if (!el) {
      // Full-screen preview mode - there's no <textarea> mounted at all.
      // That's fine now: MarkdownPreview highlights every match itself
      // (see the findHighlight prop below) and scrolls the active one
      // into view off the matchIndex set above, so find works *in* the
      // preview instead of yanking the user into split mode like before.
      return
    }
    // Deliberately not el.focus() - focusing the textarea here would
    // move keyboard focus out of the find input on every single match
    // jump, breaking repeated Enter/Shift+Enter/arrow navigation in the
    // find bar (Enter would start typing newlines into the note
    // instead). The match is made visible by the mirror highlight layer
    // (see highlightHtml), not by the native selection.
    el.setSelectionRange(m.start, m.end)

    // Scroll the match to mid-viewport. The mirror layer shares the
    // textarea's exact metrics, so the active match's <mark> offsetTop
    // is the precise pixel position of the match - unlike the old
    // "count \n before the match" estimate, which drifted badly as soon
    // as long lines soft-wrapped (each wrapped line threw it off by a
    // visual line, so Enter/arrows often landed nowhere near the match).
    const mark = highlightsRef.current?.querySelectorAll('mark')[clamped]
    if (mark) {
      el.scrollTop = Math.max(0, mark.offsetTop - el.clientHeight / 2)
    } else {
      const linesBefore = content.slice(0, m.start).split('\n').length
      const lineHeight = parseInt(window.getComputedStyle(el).lineHeight, 10) || 22
      el.scrollTop = Math.max(0, (linesBefore - 4) * lineHeight)
    }
  }

  function replaceCurrentMatch() {
    if (matches.length === 0) return
    const m = matches[matchIndex]
    const next = content.slice(0, m.start) + replaceQuery + content.slice(m.end)
    setContent(next)
    scheduleSave(next)
  }

  function replaceAllMatches() {
    const q = findQuery.trim()
    if (!q || matches.length === 0) return
    const re = new RegExp(escapeRegExp(q), 'gi')
    const count = matches.length
    const next = content.replace(re, replaceQuery)
    setContent(next)
    scheduleSave(next)
    Delta.showNotice(`Replaced ${count} occurrence${count === 1 ? '' : 's'}`)
  }

  function closeFindReplace() {
    setFindOpen(false)
    setFindQuery('')
    setReplaceQuery('')
    // Hand focus back to the note text (find kept it in the find bar the
    // whole time so Enter/arrows navigated matches) - the caret is
    // already sitting on the last match goToMatch selected, so closing
    // the bar drops the user right where they searched to.
    // preventScroll: the textarea is already scrolled to that match;
    // a plain focus() could scroll ancestors (see scrollWithin.js).
    textareaRef.current?.focus({ preventScroll: true })
  }

  // Figures out whether the caret currently sits right after an unclosed
  // [[ or ![[, and if so, builds the matching note list + its on-screen
  // position (measured off the real caret, via a mirrored hidden div).
  function updateAutocomplete(value, cursor) {
    const el = textareaRef.current
    if (!el) return
    const uptoCursor = value.slice(0, cursor)
    const match = OPEN_WIKILINK_RE.exec(uptoCursor)
    if (!match) {
      setAutocomplete(null)
      return
    }
    const query = match[2]
    const start = cursor - query.length
    const lowerQuery = query.trim().toLowerCase()
    // Capped generously (the dropdown scrolls, and arrow keys follow the
    // selection into the overflow) - the old cap of 8 made it look like
    // the vault only had 8 notes, with no way to reach the rest.
    const matchingNotes = allNotes
      .filter((n) => n.title.toLowerCase().includes(lowerQuery))
      .slice(0, 50)
      .map((n) => ({ title: n.title, isNew: false }))

    const exact = allNotes.some((n) => n.title.toLowerCase() === lowerQuery)
    const items = query.trim() && !exact ? [...matchingNotes, { title: query.trim(), isNew: true }] : matchingNotes

    if (items.length === 0) {
      setAutocomplete(null)
      return
    }

    const coords = getCaretCoordinates(el, cursor)
    setAutocomplete({ start, query, top: coords.top, left: coords.left, items, selectedIndex: 0 })
  }

  function handleContentChange(e) {
    editedSinceLoadRef.current = true
    lastLocalEditAtRef.current = Date.now()
    const value = e.target.value
    setContent(value)
    scheduleSave(value)
    updateAutocomplete(value, e.target.selectionStart)
  }

  function handleTextareaKeyDown(e) {
    if (autocomplete) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAutocomplete((a) => (a ? { ...a, selectedIndex: (a.selectedIndex + 1) % a.items.length } : a))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAutocomplete((a) => (a ? { ...a, selectedIndex: (a.selectedIndex - 1 + a.items.length) % a.items.length } : a))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectAutocompleteItem(autocomplete.items[autocomplete.selectedIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAutocomplete(null)
        return
      }
    }
    // Let cursor movement (clicks handled separately, arrow keys here)
    // keep the autocomplete position in sync when it's not consuming the key.
    requestAnimationFrame(() => updateAutocomplete(e.target.value, e.target.selectionStart))
  }

  function handleTextareaClick(e) {
    updateAutocomplete(e.target.value, e.target.selectionStart)
  }

  function selectAutocompleteItem(item) {
    if (!item || !autocomplete) return
    const el = textareaRef.current
    const cursor = el ? el.selectionStart : autocomplete.start + autocomplete.query.length
    const before = content.slice(0, autocomplete.start)
    const after = content.slice(cursor)
    const alreadyClosed = after.startsWith(']]')
    const insertion = item.title + (alreadyClosed ? '' : ']]')
    const next = before + insertion + after
    setContent(next)
    scheduleSave(next)
    setAutocomplete(null)

    const caretPos = before.length + item.title.length
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(caretPos, caretPos)
    })
  }

  // Inserts text at the textarea's current cursor (or at the end, if
  // it isn't focused), used both by the wikilink autocomplete-adjacent
  // drop-to-embed flow below.
  function insertAtCursor(text) {
    editedSinceLoadRef.current = true
    const el = textareaRef.current
    const cursor = el ? el.selectionStart : content.length
    const before = content.slice(0, cursor)
    const after = content.slice(cursor)
    const needsLeadingBreak = before.length > 0 && !before.endsWith('\n')
    const insertion = (needsLeadingBreak ? '\n' : '') + text + '\n'
    const next = before + insertion + after
    setContent(next)
    scheduleSave(next)

    const caretPos = before.length + insertion.length
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(caretPos, caretPos)
    })
  }

  // General-purpose "insert/replace at the caret" - unlike insertAtCursor
  // above (which always isolates its insertion on its own line or lines,
  // built specifically for dropping in a file embed), this does exactly
  // what it's told: replaces whatever's currently selected (or inserts at
  // the caret if nothing is) with `text`, verbatim. This is what backs
  // Delta.insertAtCursor()/replaceSelection() for plugins - reads/writes
  // through refs rather than the `content` closure so it stays correct
  // even though the active-editor registration below only grabs one
  // reference to it, once, on mount.
  function replaceSelectionWith(text) {
    const el = textareaRef.current
    const current = latestRef.current.content
    const start = el ? el.selectionStart : current.length
    const end = el ? el.selectionEnd : current.length
    const next = current.slice(0, start) + text + current.slice(end)
    editedSinceLoadRef.current = true
    lastLocalEditAtRef.current = Date.now()
    setContent(next)
    latestRef.current.scheduleSave(next)

    const caretPos = start + text.length
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(caretPos, caretPos)
    })
    return next
  }

  // Called by MarkdownPreview once an inline block edit (click a
  // rendered block in split/preview mode, edit its raw markdown right
  // there, click away) commits - it already spliced the change into the
  // full note text, so this just needs to save it the normal way.
  function handleInlineBlockEdit(nextContent) {
    editedSinceLoadRef.current = true
    setContent(nextContent)
    scheduleSave(nextContent)
  }

  function handleEditorDragOver(e) {
    e.preventDefault()
    setDragging(true)
  }

  // Dropping a file (image/video/audio/anything) from the OS copies it
  // right next to this note - same folder, so the relative embed below
  // resolves exactly the way MarkdownPreview expects - and inserts the
  // matching embed/link snippet at the cursor, Obsidian-style.
  async function handleEditorDrop(e) {
    e.preventDefault()
    setDragging(false)
    const dropped = Array.from(e.dataTransfer.files || [])
    if (dropped.length === 0) return
    const destDir = dirnameOf(currentPath)
    const snippets = []
    for (const f of dropped) {
      const sourcePath = Delta.getDroppedFilePath(f)
      if (!sourcePath) continue
      const newPath = await Delta.importFile(sourcePath, destDir)
      if (!newPath) continue
      const filename = newPath.split(/[\\/]/).pop()
      const ext = filename.includes('.') ? filename.split('.').pop() : ''
      snippets.push(buildEmbedSnippet(filename, ext))
    }
    if (snippets.length > 0) insertAtCursor(snippets.join('\n\n'))
  }

  // Pasting an image (screenshot from the clipboard, copied image from a
  // browser, ...) saves it as a real file right next to this note - same
  // folder, so the relative embed resolves like drop-to-embed's - and
  // inserts the ![](...) embed at the caret. Text pastes are untouched:
  // when the clipboard holds text alongside an image (copying from Word,
  // say, carries both), the text is what the user expects to land.
  async function handleEditorPaste(e) {
    const items = Array.from(e.clipboardData?.items || [])
    if (items.some((it) => it.kind === 'string' && (it.type === 'text/plain' || it.type === 'text/html'))) return
    const imageItems = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    if (imageItems.length === 0) return
    e.preventDefault()

    const destDir = dirnameOf(currentPath)
    const snippets = []
    for (const item of imageItems) {
      const blob = item.getAsFile()
      if (!blob) continue
      const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*$/, '')
      // Space-free on purpose: markdown-it only parses ![](url) when the
      // url has no raw spaces (unless <>-wrapped), and resolveVaultUrl/
      // toDeltaFileUrl encode the relative path themselves - a
      // pre-encoded %20 here would get double-encoded and miss the file.
      // Unique-enough name; files:writeBinary still renames on collision
      // if two pastes land within the same second.
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })
      const newPath = await Delta.writeBinaryFile(destDir, `pasted-image-${stamp}.${ext}`, base64)
      if (!newPath) continue
      const filename = newPath.split(/[\\/]/).pop()
      snippets.push(`![${filename}](${filename})`)
    }
    if (snippets.length > 0) {
      replaceSelectionWith(snippets.join('\n\n'))
      Delta.showNotice(`Pasted image${snippets.length === 1 ? '' : 's'} saved next to this note`)
    }
  }

  // Same remount-loses-everything problem as viewModeByPath above, just
  // for scroll position instead of the view mode itself: switching to
  // another tab and back throws away and rebuilds this whole screen, so
  // a plain scrollTop is gone the moment you leave a note and come back
  // to it - even mid-session, not just across restarts. Keyed by path
  // (and re-run on viewMode change, since the textarea doesn't exist at
  // all in pure preview mode - see the render below).
  useEffect(() => {
    const el = textareaRef.current
    const key = `textarea:${currentPath}`
    restoreScroll(key, el)
    if (!el) return undefined
    const onScroll = () => saveScroll(key, el)
    el.addEventListener('scroll', onScroll)
    return () => {
      saveScroll(key, el)
      el.removeEventListener('scroll', onScroll)
    }
  }, [currentPath, viewMode])

  async function commitTitle() {
    const trimmed = title.trim() || 'Untitled'
    if (titleFromPath(currentPath) === trimmed) return
    const newPath = await Delta.renameNote(currentPath, trimmed)
    setCurrentPath(newPath)
    Delta.emit('note:save', { path: newPath, content })
  }

  async function handleDelete() {
    const ok = await Delta.confirm(`Delete "${title || 'this note'}"? This can't be undone.`, {
      danger: true,
      confirmLabel: 'Delete'
    })
    if (!ok) return
    await Delta.deleteNote(currentPath)
    onDeleted()
  }

  // Where this note lives, as clickable breadcrumb segments: vault name,
  // then each folder down to the note. Clicking a segment replaces this
  // tab with the Notes screen opened at that exact folder (openTab
  // carries folderPath onto the tab - NotesList picks it up as its
  // initialFolder).
  const vaultRoot = (Delta.vaultPath || '').replace(/\\/g, '/')
  const noteDir = dirnameOf(currentPath)
  const breadcrumbs = [{ label: vaultRoot.split('/').pop() || 'Vault', path: Delta.vaultPath }]
  if (noteDir && noteDir !== vaultRoot && noteDir.startsWith(vaultRoot + '/')) {
    let acc = vaultRoot
    for (const seg of noteDir.slice(vaultRoot.length + 1).split('/')) {
      acc += '/' + seg
      breadcrumbs.push({ label: seg, path: acc })
    }
  }

  return (
    <div className="screen editor-screen">
      <header className="top-bar">
        <div className="top-bar-actions">
          <button className="icon-btn" onClick={onBack} title="Back" type="button">
            <ArrowBackIcon />
          </button>
          <button
            className={`icon-btn ${viewMode === 'split' ? 'icon-btn-active' : ''}`}
            onClick={() => setViewMode((v) => (v === 'split' ? 'edit' : 'split'))}
            title="Toggle split preview"
            type="button"
          >
            <VerticalSplitIcon />
          </button>
          <button
            className={`icon-btn ${viewMode === 'preview' ? 'icon-btn-active' : ''}`}
            onClick={() => setViewMode((v) => (v === 'preview' ? 'edit' : 'preview'))}
            title="Toggle full-screen preview"
            type="button"
          >
            {viewMode === 'preview' ? <CloseFullscreenIcon /> : <OpenInFullIcon />}
          </button>
        </div>

        <input
          className="note-title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
        />

        <div className="top-bar-actions">
          {toolbarButtons.map((btn) => {
            const Icon = TOOLBAR_ICONS[(btn.icon || '').toLowerCase()] || ExtensionIcon
            return (
              <button
                key={btn.id}
                className="icon-btn"
                title={btn.label || btn.id}
                type="button"
                onClick={() => btn.onClick?.(Delta.getCurrentNote())}
              >
                <Icon />
              </button>
            )
          })}
          <button className="icon-btn" onClick={handleDelete} title="Delete note" type="button">
            <DeleteOutlineIcon />
          </button>
        </div>
      </header>

      <nav className="editor-breadcrumb">
        {breadcrumbs.map((crumb, i) => (
          <span key={crumb.path} className="notes-breadcrumb-item">
            {i > 0 && <span className="editor-breadcrumb-sep">/</span>}
            <button
              className="notes-breadcrumb-btn"
              onClick={() => Delta.openTab({ type: 'notes', folderPath: crumb.path })}
              title={`Go to ${crumb.label}`}
              type="button"
            >
              {crumb.label}
            </button>
          </span>
        ))}
        <span className="editor-breadcrumb-sep">/</span>
        <span className="editor-breadcrumb-note">{title || 'Untitled'}</span>
      </nav>

      {findOpen && (
        <FindReplaceBar
          findQuery={findQuery}
          onFindChange={setFindQuery}
          replaceQuery={replaceQuery}
          onReplaceChange={setReplaceQuery}
          matchCount={matches.length}
          matchIndex={matchIndex}
          onNext={() => goToMatch(matchIndex + 1)}
          onPrev={() => goToMatch(matchIndex - 1)}
          onReplace={replaceCurrentMatch}
          onReplaceAll={replaceAllMatches}
          onClose={closeFindReplace}
          inputRef={findInputRef}
        />
      )}

      <main
        className={`editor-body ${viewMode === 'split' ? 'split' : ''} ${viewMode === 'preview' ? 'preview-only' : ''} ${dragging ? 'drop-target-active' : ''}`}
        onDragOver={handleEditorDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={handleEditorDrop}
      >
        {viewMode !== 'preview' && (
          <div className="md-editor-pane">
            {highlightHtml != null && (
              <div
                ref={highlightsRef}
                className="md-textarea-highlights"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: highlightHtml }}
              />
            )}
            <textarea
              ref={textareaRef}
              className="md-textarea"
              value={content}
              onChange={handleContentChange}
              onKeyDown={handleTextareaKeyDown}
              onClick={handleTextareaClick}
              onPaste={handleEditorPaste}
              onScroll={syncHighlightScroll}
              onBlur={() => setTimeout(() => setAutocomplete(null), 120)}
              spellCheck={false}
              placeholder="Write in Markdown…"
            />
          </div>
        )}
        {(viewMode === 'split' || viewMode === 'preview') && (
          <MarkdownPreview
            content={content}
            onWikiLinkClick={onNavigateNote}
            embedContents={embedContents}
            basePath={dirnameOf(currentPath)}
            editable
            onEditBlock={handleInlineBlockEdit}
            scrollKey={`preview:${currentPath}`}
            findHighlight={findOpen && findQuery.trim() ? { query: findQuery.trim(), activeIndex: matchIndex } : null}
          />
        )}
      </main>

      {autocomplete && (
        <WikilinkAutocomplete
          items={autocomplete.items}
          selectedIndex={autocomplete.selectedIndex}
          top={autocomplete.top}
          left={autocomplete.left}
          onSelect={selectAutocompleteItem}
        />
      )}
    </div>
  )
}
