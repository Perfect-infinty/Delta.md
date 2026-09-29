/**
 * Obsidian-style note linking for Delta's markdown renderer.
 *
 *   [[Note Name]]          -> a clickable link to another note.
 *                             Clicking it opens the note, or creates
 *                             it (empty) if it doesn't exist yet.
 *   [[Note Name|Label]]    -> same, with custom link text.
 *   ![[Note Name]]         -> an embed: renders the target note's
 *                             content inline (one level deep).
 *   ![[Note Name|Label]]   -> same, with a custom header label.
 *
 * This is registered directly on every markdown-it instance Delta
 * creates (see MarkdownPreview.jsx) - it's core behavior, not a
 * user plugin. Rendering an embed needs the target note's raw text,
 * which is passed in per-render via the markdown-it `env` object as
 * `env.embedContents` (a Map of lowercase title -> raw markdown).
 * When that map isn't supplied (e.g. the compact card preview on the
 * Notes screen), embeds fall back to a small static placeholder
 * instead of expanding.
 */

function parseInner(inner) {
  const pipeIdx = inner.indexOf('|')
  if (pipeIdx === -1) return { title: inner.trim(), label: inner.trim() }
  const title = inner.slice(0, pipeIdx).trim()
  const label = inner.slice(pipeIdx + 1).trim() || title
  return { title, label }
}

function findClosing(src, from, max) {
  let pos = from
  while (pos < max - 1) {
    if (src.charCodeAt(pos) === 0x5d && src.charCodeAt(pos + 1) === 0x5d) return pos
    pos++
  }
  return -1
}

function escAttr(str) {
  return String(str).replace(/"/g, '&quot;')
}

export default function applyWikilinkExtension(md) {
  function wikiEmbedRule(state, silent) {
    const start = state.pos
    const max = state.posMax
    if (state.src.charCodeAt(start) !== 0x21 /* ! */) return false
    if (state.src.charCodeAt(start + 1) !== 0x5b || state.src.charCodeAt(start + 2) !== 0x5b) return false
    const close = findClosing(state.src, start + 3, max)
    if (close === -1) return false
    const inner = state.src.slice(start + 3, close).trim()
    if (!inner) return false
    if (!silent) {
      const { title, label } = parseInner(inner)
      const token = state.push('wikiembed', '', 0)
      token.meta = { title, label }
    }
    state.pos = close + 2
    return true
  }

  function wikiLinkRule(state, silent) {
    const start = state.pos
    const max = state.posMax
    if (state.src.charCodeAt(start) !== 0x5b || state.src.charCodeAt(start + 1) !== 0x5b) return false
    const close = findClosing(state.src, start + 2, max)
    if (close === -1) return false
    const inner = state.src.slice(start + 2, close).trim()
    if (!inner) return false
    if (!silent) {
      const { title, label } = parseInner(inner)
      const token = state.push('wikilink', '', 0)
      token.meta = { title, label }
    }
    state.pos = close + 2
    return true
  }

  md.inline.ruler.before('image', 'wikiembed', wikiEmbedRule)
  md.inline.ruler.before('link', 'wikilink', wikiLinkRule)

  md.renderer.rules.wikilink = (tokens, idx) => {
    const { title, label } = tokens[idx].meta
    return `<a href="#" class="wikilink" data-note-title="${escAttr(title)}">${md.utils.escapeHtml(label)}</a>`
  }

  md.renderer.rules.wikiembed = (tokens, idx, options, env) => {
    const { title, label } = tokens[idx].meta
    const depth = env?.embedDepth || 0
    const map = env?.embedContents

    if (!map) {
      // Context that didn't supply note contents (e.g. card preview) -
      // show a neutral, non-interactive placeholder.
      return `<div class="wikiembed wikiembed-static">📎 ${md.utils.escapeHtml(label)}</div>`
    }

    const raw = map.get(title.toLowerCase())

    if (raw == null) {
      return (
        `<div class="wikiembed wikiembed-missing" data-note-title="${escAttr(title)}">` +
        `<div class="wikiembed-header">${md.utils.escapeHtml(label)}</div>` +
        `<div class="wikiembed-empty">Note not found — click to create</div>` +
        `</div>`
      )
    }

    if (depth >= 1) {
      return `<a href="#" class="wikilink" data-note-title="${escAttr(title)}">${md.utils.escapeHtml(label)}</a>`
    }

    const innerHtml = md.render(raw, { ...env, embedDepth: depth + 1 })
    return (
      `<div class="wikiembed" data-note-title="${escAttr(title)}">` +
      `<div class="wikiembed-header">${md.utils.escapeHtml(label)}</div>` +
      `<div class="wikiembed-body">${innerHtml}</div>` +
      `</div>`
    )
  }
}
