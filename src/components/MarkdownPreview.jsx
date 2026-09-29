import { useEffect, useMemo, useRef, useState } from 'react'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js'
import 'highlight.js/styles/atom-one-dark.css'
import mermaid from 'mermaid'
import Delta from '../api/DeltaAPI.js'
import applyWikilinkExtension from '../markdown/wikilinks.js'
import WikilinkAutocomplete from './WikilinkAutocomplete.jsx'
import { toDeltaFileUrl } from '../utils/localFileUrl.js'
import { restoreScroll, saveScroll } from '../utils/scrollMemory.js'
import { getCaretCoordinates } from '../utils/caretPosition.js'
import { scrollItemIntoView } from '../utils/scrollWithin.js'

// Same "unclosed [[ or ![[ right before the caret" matcher NoteEditor's
// main textarea uses - here it powers the identical autocomplete inside
// the preview's click-to-edit inline block editors.
const OPEN_WIKILINK_RE = /(!)?\[\[([^\]|\n]*)$/

let mermaidInitialized = false
function ensureMermaidInit() {
  if (mermaidInitialized) return
  mermaidInitialized = true
  mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' })
}

let cachedMd = null
let cachedPluginVersion = -1

const HTML_ESCAPE_RE = /[&<>"]/g
const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
function escapeHtml(str) {
  return str.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch])
}

// ```js fenced code blocks get real syntax highlighting via highlight.js.
// Unknown/unspecified languages fall back to plain escaped text instead
// of guessing (auto-detect on arbitrary note content is more often wrong
// than right, and can be slow on longer snippets).
function highlightCode(code, lang) {
  if (lang === 'mermaid') {
    // Left as a plain placeholder holding the raw diagram source; the
    // component below finds these after mount/update and hands them to
    // mermaid.run() to turn into actual SVG diagrams. Doing it this way
    // (instead of rendering SVG synchronously here) keeps markdown-it
    // rendering synchronous and cheap - mermaid layout is neither.
    return `<pre class="mermaid">${escapeHtml(code)}</pre>`
  }
  if (lang && hljs.getLanguage(lang)) {
    try {
      return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`
    } catch (err) {
      console.error('[Delta] syntax highlighting failed:', err)
    }
  }
  return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`
}

// Set for the duration of a single sanitize() call (see the component
// below) to the folder the *current* note lives in, so relative paths
// resolve the same way Obsidian does: relative to the note itself, not
// always the vault root.
let currentBasePath = null

// Resolves an image/video/audio/link src against the current note's
// folder (or the vault root for a path starting with "/"), so
// `![](photo.png)` or `<video src="clip.mp4">` referencing a file that
// actually sits next to the note works, instead of resolving against
// the app's own asset root. Already-absolute http(s)/data/mailto/in-page
// URLs pass through untouched; a raw file:// URL (typed directly into a
// note) is instead rewritten to delta-file://, for the same reason.
function resolveVaultUrl(rawUrl) {
  if (!rawUrl) return rawUrl
  if (/^delta-file:/i.test(rawUrl)) return rawUrl
  if (/^file:/i.test(rawUrl)) return toDeltaFileUrl(decodeURI(rawUrl.replace(/^file:\/\//i, '')))
  if (/^(https?:|data:|mailto:|#)/i.test(rawUrl)) return rawUrl
  const vaultPath = Delta.vaultPath
  if (!vaultPath) return rawUrl
  const normalizedVault = vaultPath.replace(/\\/g, '/').replace(/\/+$/, '')

  let base
  let relative
  if (rawUrl.startsWith('/')) {
    // A leading slash means "relative to the vault root."
    base = normalizedVault
    relative = rawUrl.replace(/^\/+/, '')
  } else {
    base = currentBasePath || normalizedVault
    relative = rawUrl.replace(/^\.\//, '')
  }

  const fullPath = `${base}/${relative}`
  const withLeadingSlash = fullPath.startsWith('/') ? fullPath : `/${fullPath}`
  return toDeltaFileUrl(withLeadingSlash)
}

const URL_ATTR_TAGS = new Set(['IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK'])

let domPurifyHooksRegistered = false
function ensureDomPurifyHooks() {
  if (domPurifyHooksRegistered) return
  domPurifyHooksRegistered = true
  // Rewriting the attribute from `uponSanitizeAttribute` (by mutating
  // `data.attrValue`) doesn't actually work for this: DOMPurify still
  // runs its own URI-safety check against the *rewritten* value
  // afterwards, and delta-file:// (like plain file:// before it) isn't
  // in its default safe-scheme list, so it silently drops the attribute
  // - this is exactly why `<source src="…">` was rendering with no src
  // at all. `afterSanitizeAttributes` runs after that check has already
  // passed against the original (relative, so always "safe") value, and
  // setting the attribute directly on the node isn't re-validated.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (URL_ATTR_TAGS.has(node.tagName) && node.hasAttribute('src')) {
      node.setAttribute('src', resolveVaultUrl(node.getAttribute('src')))
    }
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('href', resolveVaultUrl(node.getAttribute('href')))
    }
  })
}

ensureDomPurifyHooks()

function getRenderer() {
  // Rebuild whenever the set of registered markdown-it extensions has
  // changed in *any* way - compared by Delta.markdownVersion (bumped on
  // every register AND unload), not by markdownPlugins.length: a plugin
  // reload removes one entry and adds one back, so the length ends up
  // identical and a length check kept serving a stale renderer still
  // wired to the previous (unloaded) plugin instance.
  if (!cachedMd || cachedPluginVersion !== Delta.markdownVersion) {
    // html: true lets notes contain raw HTML (like Obsidian does) - DOMPurify
    // below is what makes that safe to inject via dangerouslySetInnerHTML.
    const md = new MarkdownIt({
      html: true,
      linkify: true,
      typographer: true,
      breaks: true,
      highlight: highlightCode
    })
    applyWikilinkExtension(md)
    for (const { pluginFn, opts } of Delta.markdownPlugins) {
      try {
        md.use(pluginFn, opts)
      } catch (err) {
        console.error('[Delta] markdown-it plugin failed to apply:', err)
      }
    }
    // Tags every block-level element with the source line range it came
    // from (markdown-it already tracks this internally as `token.map`,
    // just doesn't expose it in the HTML by default). Click-to-edit
    // below uses this to know exactly which lines of the raw markdown
    // to swap out for a textarea.
    md.core.ruler.push('delta_source_lines', (state) => {
      for (const token of state.tokens) {
        if (token.map) {
          token.attrSet('data-line-start', String(token.map[0]))
          token.attrSet('data-line-end', String(token.map[1]))
        }
      }
    })
    cachedMd = md
    cachedPluginVersion = Delta.markdownVersion
  }
  return cachedMd
}

/**
 * @param {string} content - raw markdown source.
 * @param {(title: string) => void} [onWikiLinkClick] - called when the
 *   user clicks a [[wikilink]] or an embed's header/missing-state. Not
 *   supplied in read-only contexts like the Notes card grid.
 * @param {Map<string, string>} [embedContents] - lowercase note title ->
 *   raw markdown, used to expand ![[embeds]] inline. Without it, embeds
 *   render as a static placeholder instead of expanding.
 * @param {string} [basePath] - folder the note being rendered lives in,
 *   used to resolve relative image/video/link paths. Falls back to the
 *   vault root when not supplied.
 * @param {boolean} [editable] - when true, clicking a rendered block
 *   (paragraph, heading, list item, ...) swaps it for a plain textarea
 *   holding its raw markdown, Obsidian Live-Preview style - click away
 *   (or the block loses focus) and it commits back through onEditBlock
 *   and re-renders styled again. Off by default (e.g. the Notes card
 *   grid, which has no onEditBlock to call anyway).
 * @param {(nextContent: string) => void} [onEditBlock] - called with the
 *   full updated markdown source once an inline block edit commits.
 * @param {{ query: string, activeIndex: number }} [findHighlight] - when
 *   set (the note editor's find bar is open with a query), every
 *   occurrence of `query` in the rendered output is wrapped in a
 *   highlight <mark>, and the one matching `activeIndex` is emphasized
 *   and scrolled into view - so Cmd/Ctrl+F works right inside the
 *   rendered preview instead of needing the raw-markdown textarea.
 */
export default function MarkdownPreview({ content, onWikiLinkClick, embedContents, basePath, editable, onEditBlock, scrollKey, findHighlight }) {
  const containerRef = useRef(null)
  // The <textarea> currently swapped in for a block, if any - so a
  // second click elsewhere can close it out first instead of ending up
  // with two live inline editors (and instead of racing the resulting
  // re-render, see beginInlineEdit below).
  const activeInlineEditorRef = useRef(null)

  // [[ wikilink autocomplete for the inline block editors above - the
  // same dropdown NoteEditor's main textarea shows, so linking notes
  // works in full-screen preview editing too, not just in edit/split
  // mode. { textarea, start, query, top, left, items, selectedIndex }
  // or null when closed. The ref mirrors the state so the plain-DOM
  // keydown/input listeners (attached once, at textarea creation) always
  // see the current value instead of the render they were created in.
  const [inlineAc, setInlineAc] = useState(null)
  const inlineAcRef = useRef(null)
  inlineAcRef.current = inlineAc

  // Note titles for the suggestion list - seeded from cache, refreshed
  // in the background whenever this preview becomes editable.
  const allNotesRef = useRef(Delta.getCachedNotesList() || [])
  useEffect(() => {
    if (!editable) return
    Delta.listNotes().then((notes) => {
      allNotesRef.current = notes
    })
  }, [editable])

  function updateInlineAutocomplete(textarea) {
    const cursor = textarea.selectionStart
    const uptoCursor = textarea.value.slice(0, cursor)
    const match = OPEN_WIKILINK_RE.exec(uptoCursor)
    if (!match) {
      setInlineAc(null)
      return
    }
    const query = match[2]
    const start = cursor - query.length
    const lowerQuery = query.trim().toLowerCase()
    const matchingNotes = allNotesRef.current
      .filter((n) => n.title.toLowerCase().includes(lowerQuery))
      .slice(0, 50)
      .map((n) => ({ title: n.title, isNew: false }))
    const exact = allNotesRef.current.some((n) => n.title.toLowerCase() === lowerQuery)
    const items = query.trim() && !exact ? [...matchingNotes, { title: query.trim(), isNew: true }] : matchingNotes
    if (items.length === 0) {
      setInlineAc(null)
      return
    }
    const coords = getCaretCoordinates(textarea, cursor)
    setInlineAc({ textarea, start, query, top: coords.top, left: coords.left, items, selectedIndex: 0 })
  }

  function selectInlineAcItem(item) {
    const ac = inlineAcRef.current
    if (!item || !ac) return
    const textarea = ac.textarea
    const cursor = textarea.selectionStart
    const before = textarea.value.slice(0, ac.start)
    const after = textarea.value.slice(cursor)
    const alreadyClosed = after.startsWith(']]')
    textarea.value = before + item.title + (alreadyClosed ? '' : ']]') + after
    // Fires the textarea's own 'input' listeners (auto-grow) - the
    // autocomplete's is among them and would immediately reopen on the
    // now-"[[Title"-shaped text before the caret, so close it right
    // after; both state updates land in one batch, null wins.
    textarea.dispatchEvent(new Event('input'))
    setInlineAc(null)
    const caretPos = before.length + item.title.length
    textarea.focus({ preventScroll: true })
    textarea.setSelectionRange(caretPos, caretPos)
  }

  // Shared by beginInlineEdit/beginAppendNewBlock below - gives one of
  // their raw-DOM textareas the full autocomplete behavior. Must be
  // attached *before* the textarea's own Escape-blurs keydown listener,
  // so an open dropdown can swallow Escape (close just the dropdown)
  // via stopImmediatePropagation instead of also committing the block.
  function wireInlineAutocomplete(textarea) {
    textarea.addEventListener('input', () => updateInlineAutocomplete(textarea))
    textarea.addEventListener('click', () => updateInlineAutocomplete(textarea))
    textarea.addEventListener('keydown', (e) => {
      const ac = inlineAcRef.current
      if (!ac || ac.textarea !== textarea) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setInlineAc((a) => (a ? { ...a, selectedIndex: (a.selectedIndex + 1) % a.items.length } : a))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setInlineAc((a) => (a ? { ...a, selectedIndex: (a.selectedIndex - 1 + a.items.length) % a.items.length } : a))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectInlineAcItem(ac.items[ac.selectedIndex])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        setInlineAc(null)
      }
    })
  }

  // Optional - the Notes grid's read-only card excerpts don't pass one,
  // and don't need to (they're too short to meaningfully scroll). When a
  // caller does pass one (the note editor's split/full preview), this
  // survives the exact same "screen unmounts when its tab isn't active"
  // problem NoteEditor's own textarea scroll memory does - see
  // src/utils/scrollMemory.js.
  useEffect(() => {
    if (!scrollKey) return undefined
    const el = containerRef.current
    restoreScroll(scrollKey, el)
    if (!el) return undefined
    const onScroll = () => saveScroll(scrollKey, el)
    el.addEventListener('scroll', onScroll)
    return () => {
      saveScroll(scrollKey, el)
      el.removeEventListener('scroll', onScroll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey])

  // getRenderer() itself already rebuilds when Delta.markdownVersion
  // changes - but that only matters if this component actually re-renders
  // and recomputes `html` below. Without this, a preview that's already
  // mounted when a plugin is toggled on/off in Settings (registerMarkdownPlugin/
  // unloadPlugin both emit 'markdown:changed') keeps showing content built
  // with the stale plugin set until content/basePath happens to change.
  // Plugins can also emit 'markdown:changed' themselves when one of their
  // own settings should change rendered output (e.g. daily-zen's
  // showQuotes toggle) - with keep-alive tabs, that re-renders every
  // mounted preview immediately, even ones in background tabs.
  const [mdPluginVersion, setMdPluginVersion] = useState(0)
  useEffect(() => {
    return Delta.on('markdown:changed', () => setMdPluginVersion((v) => v + 1))
  }, [])

  const html = useMemo(() => {
    const md = getRenderer()
    const rendered = md.render(content || '', { embedContents, embedDepth: 0 })
    // DOMPurify hooks aren't parameterized, so stash the base path in a
    // module-level var for the duration of this (synchronous) call.
    currentBasePath = basePath || null
    const sanitized = DOMPurify.sanitize(rendered, { ADD_ATTR: ['data-note-title'] })
    currentBasePath = null
    return sanitized
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, embedContents, basePath, mdPluginVersion])

  // dangerouslySetInnerHTML bypasses React entirely, so every time `html`
  // changes we get fresh <pre class="mermaid"> placeholders that mermaid
  // hasn't seen yet - find and convert them after each DOM update.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const blocks = container.querySelectorAll('pre.mermaid')
    if (blocks.length === 0) return
    ensureMermaidInit()
    mermaid.run({ nodes: Array.from(blocks) }).catch((err) => {
      console.error('[Delta] mermaid render failed:', err)
    })
  }, [html])

  // Find-in-preview highlighting. The preview is one big
  // dangerouslySetInnerHTML blob, so (same as mermaid above) this works
  // by direct DOM surgery after each render: clear any marks from the
  // previous pass, then wrap every text-node occurrence of the query in
  // a <mark>. Case-insensitive, mirroring the raw-text matcher in
  // NoteEditor. The mark wrapping/unwrapping never adds or removes
  // characters, so data-line-* click-to-edit targets stay valid.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Unwrap marks from the previous query/render so highlights never
    // stack or linger after the find bar closes. normalize() re-merges
    // the split text nodes so repeated searches don't fragment the DOM.
    const oldMarks = container.querySelectorAll('mark.md-find-match')
    for (const mark of oldMarks) {
      const parent = mark.parentNode
      mark.replaceWith(document.createTextNode(mark.textContent))
      parent.normalize()
    }

    const query = findHighlight?.query?.toLowerCase()
    if (!query) return

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        // Skip mermaid-rendered SVG internals and any live inline block
        // editor - splitting text nodes inside either would corrupt them.
        if (parent.closest('svg, textarea')) return NodeFilter.FILTER_REJECT
        return node.nodeValue.toLowerCase().includes(query)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP
      }
    })
    // Collect first, then mutate - splitting nodes while the TreeWalker
    // is still iterating over them would revisit the split-off halves.
    const textNodes = []
    while (walker.nextNode()) textNodes.push(walker.currentNode)

    const marks = []
    for (const textNode of textNodes) {
      let node = textNode
      let idx
      while (node && (idx = node.nodeValue.toLowerCase().indexOf(query)) !== -1) {
        const matchNode = node.splitText(idx)
        node = matchNode.splitText(query.length)
        const mark = document.createElement('mark')
        mark.className = 'md-find-match'
        matchNode.replaceWith(mark)
        mark.appendChild(matchNode)
        marks.push(mark)
      }
    }

    if (marks.length > 0) {
      // The raw-markdown match list and the rendered output can disagree
      // on count (markdown syntax is stripped, embeds add text), so the
      // active index is taken modulo what's actually on screen.
      const activeIndex = ((findHighlight.activeIndex % marks.length) + marks.length) % marks.length
      const active = marks[activeIndex]
      active.classList.add('md-find-match-active')
      // Scroll the preview pane only - native scrollIntoView() also
      // scrolls the overflow:hidden .app-root, shifting the entire UI
      // up under the macOS titlebar (see scrollWithin.js).
      scrollItemIntoView(container, active, { center: true })
    }
  }, [html, findHighlight?.query, findHighlight?.activeIndex])

  // Swaps a single rendered block for a plain <textarea> holding its raw
  // markdown lines, in place - done with direct DOM surgery (rather than
  // React state) because the block is part of one big dangerouslySetInnerHTML
  // blob, not an individually-addressable React element.
  function beginInlineEdit(blockEl) {
    const startLine = Number(blockEl.getAttribute('data-line-start'))
    const endLine = Number(blockEl.getAttribute('data-line-end'))
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return

    const lines = (content || '').split('\n')
    const blockText = lines.slice(startLine, endLine).join('\n')
    const originalOuterHTML = blockEl.outerHTML

    const textarea = document.createElement('textarea')
    textarea.className = 'md-preview-inline-editor'
    textarea.value = blockText
    textarea.spellcheck = false

    const grow = () => {
      textarea.style.height = 'auto'
      textarea.style.height = `${textarea.scrollHeight}px`
    }

    function restoreOriginal() {
      const wrapper = document.createElement('div')
      wrapper.innerHTML = originalOuterHTML
      const restored = wrapper.firstElementChild
      if (restored && textarea.parentNode) textarea.replaceWith(restored)
    }

    function commit() {
      textarea.removeEventListener('blur', commit)
      if (activeInlineEditorRef.current === textarea) activeInlineEditorRef.current = null
      setInlineAc(null)
      const nextLines = [...lines]
      nextLines.splice(startLine, endLine - startLine, ...textarea.value.split('\n'))
      const nextContent = nextLines.join('\n')
      if (nextContent === content) {
        // Nothing actually changed - restore the rendered block directly
        // instead of relying on a re-render that won't happen (React
        // bails out on a no-op state update when the string is identical).
        restoreOriginal()
      } else {
        onEditBlock?.(nextContent)
        // content changing re-renders the whole preview (new innerHTML),
        // which throws this textarea away along with everything else -
        // nothing further to do here.
      }
    }

    blockEl.replaceWith(textarea)
    activeInlineEditorRef.current = textarea
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    textarea.addEventListener('input', grow)
    wireInlineAutocomplete(textarea) // before the Escape listener below - see its doc comment
    textarea.addEventListener('blur', commit)
    // Escape isn't a true "discard" (there's no snapshot of just-this-
    // keystroke to roll back to once typed) - it's just a keyboard way
    // to say "done with this block," same as clicking away.
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        textarea.blur()
      }
    })
    grow()
  }

  // Appends a brand-new empty block after everything else in the note
  // (or is the very first content, for an empty note) - the counterpart
  // to beginInlineEdit above for the one case it can't handle: there's
  // no existing rendered block to click on, either because the note is
  // completely empty or because the user clicked the empty space below
  // the last block wanting to add something new (Obsidian does the same
  // thing - clicking below the last line starts a new one there).
  function beginAppendNewBlock() {
    const container = containerRef.current
    if (!container) return
    const textarea = document.createElement('textarea')
    textarea.className = 'md-preview-inline-editor md-preview-inline-editor-new'
    textarea.value = ''
    textarea.spellcheck = false

    const grow = () => {
      textarea.style.height = 'auto'
      textarea.style.height = `${textarea.scrollHeight}px`
    }

    function commit() {
      textarea.removeEventListener('blur', commit)
      if (activeInlineEditorRef.current === textarea) activeInlineEditorRef.current = null
      setInlineAc(null)
      const typed = textarea.value
      if (!typed.trim()) {
        // Nothing was actually typed - just drop the empty textarea,
        // there's nothing to save.
        if (textarea.parentNode) textarea.remove()
        return
      }
      const base = content || ''
      // Two newlines = a new paragraph/block as far as markdown-it is
      // concerned - unless the note was empty, in which case there's
      // nothing above to separate the new text from.
      const nextContent = base && !base.endsWith('\n') ? `${base}\n\n${typed}` : `${base}${typed}`
      onEditBlock?.(nextContent)
      // content changing re-renders the whole preview (new innerHTML),
      // which throws this textarea away along with everything else -
      // nothing further to do here.
    }

    container.appendChild(textarea)
    activeInlineEditorRef.current = textarea
    // preventScroll: the new textarea sits at the very bottom of the
    // note's content, which can be below the fold - a plain focus()
    // would scroll every ancestor (app-root included, see scrollWithin.js)
    // to reveal it. Scroll just the preview pane instead.
    textarea.focus({ preventScroll: true })
    scrollItemIntoView(container, textarea)
    textarea.addEventListener('input', grow)
    wireInlineAutocomplete(textarea) // before the Escape listener below - see its doc comment
    textarea.addEventListener('blur', commit)
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        textarea.blur()
      }
    })
    grow()
  }

  // Shared by click/contextmenu/auxclick below - a [[wikilink]], a
  // missing-embed placeholder, and an expanded embed's header all carry
  // the target note's title on a data attribute, just on three
  // different elements.
  function wikilinkTitleFromTarget(target) {
    const link = target.closest('a.wikilink')
    if (link) return link.getAttribute('data-note-title')
    const missing = target.closest('.wikiembed-missing')
    if (missing) return missing.getAttribute('data-note-title')
    const header = target.closest('.wikiembed-header')
    const wrapper = header?.closest('.wikiembed')
    return wrapper?.getAttribute('data-note-title') || null
  }

  function handleClick(e) {
    // Any link to an external site or a local vault file should open in
    // the OS browser / default app, never navigate this window away.
    const anchor = e.target.closest('a')
    const href = anchor?.getAttribute('href')
    if (anchor && href && href !== '#') {
      if (href.startsWith('delta-file://') || href.startsWith('file://')) {
        e.preventDefault()
        const scheme = href.startsWith('delta-file://') ? 'delta-file://' : 'file://'
        window.deltaBridge.shell.openPath(decodeURI(href.replace(scheme, '')))
        return
      }
      if (href.startsWith('http://') || href.startsWith('https://')) {
        e.preventDefault()
        window.deltaBridge.shell.openExternal(href)
        return
      }
    }

    if (onWikiLinkClick) {
      const title = wikilinkTitleFromTarget(e.target)
      if (title) {
        e.preventDefault()
        // Cmd/Ctrl+click opens in a new tab, same convention browsers use.
        onWikiLinkClick(title, { newTab: e.metaKey || e.ctrlKey })
        return
      }
    }

    if (!editable) return
    // An embed's expanded body was rendered from a *different* note's
    // raw text, so its data-line-* attributes refer to that note, not
    // this one - editing it inline here would splice the wrong lines
    // into the wrong document, so it's excluded entirely.
    if (e.target.closest('.wikiembed')) return
    if (activeInlineEditorRef.current) {
      if (e.target === activeInlineEditorRef.current) {
        // Clicking inside the block that's *already* being edited - this
        // is just the user placing the cursor or selecting text, not a
        // request to switch blocks. Previously this always blurred (and
        // therefore committed/closed) the editor on every click inside
        // it, which made selecting text there feel broken - the first
        // click would close it before a second click could do anything.
        return
      }
      // A different block is already open - close it out first (this
      // commits it) rather than opening a second inline editor; the
      // re-render that may follow would otherwise race with, and blow
      // away, whatever we open next.
      activeInlineEditorRef.current.blur()
      return
    }
    const blockEl = e.target.closest('[data-line-start]')
    if (blockEl && containerRef.current?.contains(blockEl)) {
      beginInlineEdit(blockEl)
      return
    }
    // The click landed inside the preview but not on any rendered block -
    // either the note is completely empty, or this is the empty space
    // below the last block (the container is at least as tall as its
    // scroll area, thanks to flex:1). Either way, that's a request to
    // start typing new content, not a no-op.
    if (e.target === containerRef.current) {
      beginAppendNewBlock()
    }
  }

  function handleContextMenu(e) {
    if (!onWikiLinkClick) return
    const title = wikilinkTitleFromTarget(e.target)
    if (!title) return
    e.preventDefault()
    Delta.showContextMenu(e.clientX, e.clientY, [
      { label: 'Open in new tab', onClick: () => onWikiLinkClick(title, { newTab: true }) }
    ])
  }

  function handleAuxClick(e) {
    // Middle-click - same "open in new tab" convention as a browser.
    if (e.button !== 1 || !onWikiLinkClick) return
    const title = wikilinkTitleFromTarget(e.target)
    if (!title) return
    e.preventDefault()
    onWikiLinkClick(title, { newTab: true })
  }

  return (
    <>
      <div
        ref={containerRef}
        className={`md-preview ${editable ? 'md-preview-editable' : ''}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onAuxClick={handleAuxClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {/* position:fixed, so being a sibling (outside the scrolling
          container) doesn't affect layout - same as NoteEditor's. */}
      {editable && inlineAc && (
        <WikilinkAutocomplete
          items={inlineAc.items}
          selectedIndex={inlineAc.selectedIndex}
          top={inlineAc.top}
          left={inlineAc.left}
          onSelect={selectInlineAcItem}
        />
      )}
    </>
  )
}
