import { useEffect, useMemo, useRef, useState } from 'react'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong'
import Delta from '../api/DeltaAPI.js'
import NoteEditor from './NoteEditor.jsx'

// Fixed ideal distance between nodes, in px - independent of canvas size
// or node count. Deriving it from canvas-area/node-count (as a classic
// Fruchterman-Reingold layout usually does) blows up for small graphs -
// with only 2 nodes on a 1600x1000 canvas that math wants ~900px
// between them. A constant spring length plus a canvas that only grows
// gently with node count keeps things tight regardless of graph size.
const IDEAL_DISTANCE = 130

/**
 * A small, dependency-free force-directed layout (Fruchterman-Reingold
 * style). No graph library needed - just repel every node from every
 * other node, pull linked nodes together, cool down over time.
 */
function computeLayout(nodes, edges, width, height, iterations = 300) {
  const k = IDEAL_DISTANCE
  const idIndex = new Map(nodes.map((n, i) => [n.id, i]))
  const pos = nodes.map(() => ({
    x: width / 2 + (Math.random() - 0.5) * width * 0.6,
    y: height / 2 + (Math.random() - 0.5) * height * 0.6
  }))

  for (let iter = 0; iter < iterations; iter++) {
    const disp = nodes.map(() => ({ x: 0, y: 0 }))

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = pos[i].x - pos[j].x
        let dy = pos[i].y - pos[j].y
        let dist = Math.sqrt(dx * dx + dy * dy) || 0.01
        const force = (k * k) / dist
        const ux = dx / dist
        const uy = dy / dist
        disp[i].x += ux * force
        disp[i].y += uy * force
        disp[j].x -= ux * force
        disp[j].y -= uy * force
      }
    }

    for (const e of edges) {
      const i = idIndex.get(e.source)
      const j = idIndex.get(e.target)
      if (i == null || j == null || i === j) continue
      let dx = pos[i].x - pos[j].x
      let dy = pos[i].y - pos[j].y
      let dist = Math.sqrt(dx * dx + dy * dy) || 0.01
      const force = (dist * dist) / k
      const ux = dx / dist
      const uy = dy / dist
      disp[i].x -= ux * force
      disp[i].y -= uy * force
      disp[j].x += ux * force
      disp[j].y += uy * force
    }

    const temp = (width / 10) * (1 - iter / iterations)
    for (let i = 0; i < nodes.length; i++) {
      const dx = disp[i].x
      const dy = disp[i].y
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01
      const capped = Math.min(dist, Math.max(temp, 0.5))
      pos[i].x += (dx / dist) * capped
      pos[i].y += (dy / dist) * capped
      pos[i].x = Math.min(width - 30, Math.max(30, pos[i].x))
      pos[i].y = Math.min(height - 30, Math.max(30, pos[i].y))
    }
  }

  return pos
}

async function buildGraph() {
  const notes = await Delta.listNotes()
  const nodesByKey = new Map()

  for (const n of notes) {
    nodesByKey.set(n.title.toLowerCase(), { id: n.title, title: n.title, path: n.path, exists: true })
  }

  const edges = []
  for (const n of notes) {
    for (const targetTitle of n.links || []) {
      const key = targetTitle.toLowerCase()
      if (!nodesByKey.has(key)) {
        nodesByKey.set(key, { id: targetTitle, title: targetTitle, path: null, exists: false })
      }
      const target = nodesByKey.get(key).id
      if (target !== n.title) edges.push({ source: n.title, target })
    }
  }

  return { nodes: Array.from(nodesByKey.values()), edges }
}

const DEFAULT_SCALE = 0.85

// The layout canvas only needs to grow gently with node count - just
// enough room for everything to spread out and stay clamped inside it.
function canvasSizeFor(nodeCount) {
  const side = Math.max(500, Math.sqrt(Math.max(nodeCount, 1)) * 220)
  return { width: side * 1.4, height: side }
}

// Per-node drift parameters for the idle "electron" motion - each node
// orbits its layout position on its own small ellipse, with its own
// speed and phase, so the whole graph shimmers instead of marching in
// lockstep. Amplitudes stay small enough that clicking/dragging what
// you see still hits the node.
function makeMotion() {
  return {
    ax: 2 + Math.random() * 2.5,
    ay: 2 + Math.random() * 2.5,
    wx: 0.4 + Math.random() * 0.7,
    wy: 0.4 + Math.random() * 0.7,
    px: Math.random() * Math.PI * 2,
    py: Math.random() * Math.PI * 2
  }
}

// Static background star field for the galaxy look - tiny dots scattered
// across the layout canvas, panning/zooming with it so they read as part
// of the same space. Twinkle comes from CSS, not per-frame JS.
function makeStars(width, height, count = 110) {
  const stars = []
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random() * width * 1.6 - width * 0.3,
      y: Math.random() * height * 1.6 - height * 0.3,
      r: 0.6 + Math.random() * 1.1,
      opacity: 0.15 + Math.random() * 0.5,
      delay: -(Math.random() * 6).toFixed(2)
    })
  }
  return stars
}

// `isActive` mirrors NoteEditor's prop of the same name (see App.jsx's
// keep-alive tab rendering) - forwarded to the nested note pane so a
// note opened inside a *background* graph tab doesn't claim the global
// cursor API / Cmd+F away from the tab actually in front.
export default function GraphView({ onBack = () => Delta.openTab({ type: 'notes' }), isActive = true }) {
  const [graph, setGraph] = useState({ nodes: [], edges: [] })
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState({ x: 0, y: 0, scale: DEFAULT_SCALE })
  const [openNotePath, setOpenNotePath] = useState(null)
  const [stars, setStars] = useState([])
  const svgRef = useRef(null)
  const dragRef = useRef(null) // { type: 'node'|'pan', index, startX, startY, ... }
  const wasDraggedRef = useRef(false) // survives the mouseup->click sequence

  // Imperative handles for the idle-drift animation loop below: it runs
  // at frame rate outside React (re-rendering the whole tree 60x/s just
  // to nudge transforms would be wasteful), so it needs direct refs to
  // every node <g> and edge <line>, plus the current base positions.
  const nodeElsRef = useRef([])
  const edgeElsRef = useRef([])
  const motionRef = useRef([])
  const positionsRef = useRef([])
  useEffect(() => {
    positionsRef.current = positions
  }, [positions])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    buildGraph().then(({ nodes, edges }) => {
      if (cancelled) return
      const { width, height } = canvasSizeFor(nodes.length)
      const laidOut = computeLayout(nodes, edges, width, height)
      motionRef.current = nodes.map(makeMotion)
      setStars(makeStars(width, height))
      setGraph({ nodes, edges })
      setPositions(laidOut)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // The idle "electron" drift: every node floats on its own little
  // ellipse around its layout position, and edges follow the drifted
  // endpoints so lines never detach from their dots. Direct DOM writes
  // each frame; React's own renders (drag, etc.) may momentarily reset
  // an attribute to the base position, and the next frame re-applies
  // the drift on top. Only runs while this tab is actually visible -
  // keep-alive keeps background graph tabs mounted, and animating a
  // display:none subtree would burn CPU for nothing.
  useEffect(() => {
    if (!isActive || loading || graph.nodes.length === 0) return undefined
    let raf
    const tick = () => {
      const t = performance.now() / 1000
      const pos = positionsRef.current
      const motion = motionRef.current
      const n = Math.min(pos.length, motion.length)
      const jittered = new Array(n)
      for (let i = 0; i < n; i++) {
        const m = motion[i]
        jittered[i] = {
          x: pos[i].x + m.ax * Math.sin(t * m.wx + m.px),
          y: pos[i].y + m.ay * Math.cos(t * m.wy + m.py)
        }
        const el = nodeElsRef.current[i]
        if (el) el.setAttribute('transform', `translate(${jittered[i].x} ${jittered[i].y})`)
      }
      graph.edges.forEach((e, i) => {
        const line = edgeElsRef.current[i]
        if (!line) return
        const si = idIndex.get(e.source)
        const ti = idIndex.get(e.target)
        if (si == null || ti == null || !jittered[si] || !jittered[ti]) return
        line.setAttribute('x1', jittered[si].x)
        line.setAttribute('y1', jittered[si].y)
        line.setAttribute('x2', jittered[ti].x)
        line.setAttribute('y2', jittered[ti].y)
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, loading, graph])

  const degree = useMemo(() => {
    const d = new Map()
    for (const e of graph.edges) {
      d.set(e.source, (d.get(e.source) || 0) + 1)
      d.set(e.target, (d.get(e.target) || 0) + 1)
    }
    return d
  }, [graph.edges])

  const idIndex = useMemo(() => new Map(graph.nodes.map((n, i) => [n.id, i])), [graph.nodes])

  function toLocal(clientX, clientY) {
    const rect = svgRef.current.getBoundingClientRect()
    return {
      x: (clientX - rect.left - view.x) / view.scale,
      y: (clientY - rect.top - view.y) / view.scale
    }
  }

  function handleNodeMouseDown(e, index) {
    e.stopPropagation()
    const { x, y } = toLocal(e.clientX, e.clientY)
    dragRef.current = {
      type: 'node',
      index,
      offsetX: positions[index].x - x,
      offsetY: positions[index].y - y,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false
    }
  }

  function handleBackgroundMouseDown(e) {
    dragRef.current = { type: 'pan', startClientX: e.clientX, startClientY: e.clientY, startViewX: view.x, startViewY: view.y }
  }

  function handleMouseMove(e) {
    const drag = dragRef.current
    if (!drag) return
    if (drag.type === 'node') {
      if (!drag.moved) {
        const dx = e.clientX - drag.startClientX
        const dy = e.clientY - drag.startClientY
        if (Math.hypot(dx, dy) > 4) drag.moved = true
      }
      const { x, y } = toLocal(e.clientX, e.clientY)
      setPositions((prev) => {
        const next = prev.slice()
        next[drag.index] = { x: x + drag.offsetX, y: y + drag.offsetY }
        return next
      })
    } else if (drag.type === 'pan') {
      setView((v) => ({
        ...v,
        x: drag.startViewX + (e.clientX - drag.startClientX),
        y: drag.startViewY + (e.clientY - drag.startClientY)
      }))
    }
  }

  function handleMouseUp() {
    if (dragRef.current?.type === 'node') {
      wasDraggedRef.current = dragRef.current.moved
    }
    dragRef.current = null
  }

  function handleWheel(e) {
    e.preventDefault()
    const delta = -e.deltaY * 0.001
    setView((v) => ({ ...v, scale: Math.min(2.5, Math.max(0.15, v.scale + delta)) }))
  }

  function resetView() {
    setView({ x: 0, y: 0, scale: DEFAULT_SCALE })
  }

  function nodeRadius(node) {
    const d = degree.get(node.id) || 0
    return 7 + Math.min(d * 2, 16)
  }

  // Opens a note in the split pane beside the graph, instead of leaving
  // this screen - same "find or create" behavior as the rest of the app.
  // opts.newTab escapes that side pane instead, opening the note as a
  // real top-level tab (handy since the graph tab itself stays put).
  async function openTitle(title, opts = {}) {
    if (!title) return
    if (opts.newTab) {
      await Delta.navigateToNoteTitle(title, { newTab: true })
      return
    }
    const notes = await Delta.listNotes()
    const match = notes.find((n) => n.title.toLowerCase() === title.toLowerCase())
    const path = match ? match.path : await Delta.createNote(title)
    setOpenNotePath(path)
  }

  function handleNodeContextMenu(e, title) {
    e.preventDefault()
    e.stopPropagation()
    Delta.showContextMenu(e.clientX, e.clientY, [{ label: 'Open in new tab', onClick: () => openTitle(title, { newTab: true }) }])
  }

  return (
    <div className="screen graph-screen">
      <header className="top-bar">
        <div className="top-bar-actions">
          <button className="icon-btn" onClick={onBack} title="Back" type="button">
            <ArrowBackIcon />
          </button>
        </div>
        <h1 className="app-name">Graph</h1>
        <div className="top-bar-actions">
          <button className="icon-btn" onClick={resetView} title="Reset view" type="button">
            <CenterFocusStrongIcon />
          </button>
        </div>
      </header>

      <main className="graph-body">
        {loading ? (
          <p className="empty-hint">Loading graph…</p>
        ) : graph.nodes.length === 0 ? (
          <div className="empty-state">
            <p>No notes to graph yet. Link notes with [[Note Name]] to see them connected here.</p>
          </div>
        ) : (
          <svg
            ref={svgRef}
            className={`graph-canvas ${openNotePath ? 'split' : ''}`}
            data-zoom={view.scale < 0.55 ? 'far' : 'near'}
            onMouseDown={handleBackgroundMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onWheel={handleWheel}
          >
            <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
              {/* Background star field - pans/zooms with the graph so it
                  reads as the space the notes float in. Twinkle is pure
                  CSS (see .graph-star), staggered per star. */}
              {stars.map((s, i) => (
                <circle
                  key={`star-${i}`}
                  className="graph-star"
                  cx={s.x}
                  cy={s.y}
                  r={s.r}
                  style={{ '--star-opacity': s.opacity, animationDelay: `${s.delay}s` }}
                />
              ))}

              {graph.edges.map((e, i) => {
                const si = idIndex.get(e.source)
                const ti = idIndex.get(e.target)
                if (si == null || ti == null || !positions[si] || !positions[ti]) return null
                return (
                  <line
                    key={i}
                    ref={(el) => {
                      edgeElsRef.current[i] = el
                    }}
                    className="graph-edge"
                    x1={positions[si].x}
                    y1={positions[si].y}
                    x2={positions[ti].x}
                    y2={positions[ti].y}
                  />
                )
              })}

              {graph.nodes.map((node, i) => {
                const p = positions[i]
                if (!p) return null
                const r = nodeRadius(node)
                return (
                  <g
                    key={node.id}
                    ref={(el) => {
                      nodeElsRef.current[i] = el
                    }}
                    className={`graph-node ${node.exists ? '' : 'graph-node-ghost'}`}
                    transform={`translate(${p.x} ${p.y})`}
                    onMouseDown={(e) => handleNodeMouseDown(e, i)}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (wasDraggedRef.current) {
                        wasDraggedRef.current = false
                        return
                      }
                      openTitle(node.title, { newTab: e.metaKey || e.ctrlKey })
                    }}
                    onContextMenu={(e) => handleNodeContextMenu(e, node.title)}
                    onAuxClick={(e) => {
                      if (e.button !== 1) return
                      e.stopPropagation()
                      openTitle(node.title, { newTab: true })
                    }}
                  >
    <circle r={r} />
                    <text y={r + 16}>{node.title}</text>
                  </g>
                )
              })}
            </g>
          </svg>
        )}

        {openNotePath && (
          <div className="graph-note-pane">
            <NoteEditor
              notePath={openNotePath}
              isActive={isActive}
              onBack={() => setOpenNotePath(null)}
              onNavigateNote={openTitle}
              onDeleted={() => setOpenNotePath(null)}
            />
          </div>
        )}
      </main>
    </div>
  )
}
