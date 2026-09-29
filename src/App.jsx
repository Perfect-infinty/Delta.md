import { useEffect, useState, useCallback, useRef } from 'react'
import VaultSelect from './screens/VaultSelect.jsx'
import NotesList from './screens/NotesList.jsx'
import NoteEditor from './screens/NoteEditor.jsx'
import Settings from './screens/Settings.jsx'
import GraphView from './screens/GraphView.jsx'
import FileViewer from './screens/FileViewer.jsx'
import Toasts from './components/Toasts.jsx'
import TabBar from './components/TabBar.jsx'
import ContextMenu from './components/ContextMenu.jsx'
import CommandPalette from './components/CommandPalette.jsx'
import ContentSearch from './components/ContentSearch.jsx'
import FileViewerModal from './components/FileViewerModal.jsx'
import PromptDialog from './components/PromptDialog.jsx'
import ConfirmDialog from './components/ConfirmDialog.jsx'
import Delta from './api/DeltaAPI.js'
import { loadPlugins } from './plugins/PluginManager.js'
import { IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, TEXT_EXTS, DOCX_EXTS } from './utils/fileKind.js'

const DEFAULT_SETTINGS = { theme: 'violet-light', enabledPlugins: [], pinnedNotes: [], pinnedFolders: [] }

// Is `p` the folder itself, or a path anywhere inside it? Separator
// checked both ways since these strings come from the main process with
// the platform's native separator.
function isUnderFolder(p, folder) {
  return p === folder || p.startsWith(folder + '/') || p.startsWith(folder + '\\')
}

// Graph/Settings are singletons - only one of each ever exists, clicking
// their icon again just switches to the existing tab instead of opening
// a duplicate. Editor/file tabs are deduped per path. The Notes grid
// itself is deliberately NOT deduped - like a browser's "new tab"
// button, you can have as many blank/grid tabs open as you want.
function keyForTarget(target) {
  if (target.type === 'editor') return `editor:${target.notePath}`
  if (target.type === 'file') return `file:${target.filePath}`
  if (target.type === 'graph') return 'graph'
  if (target.type === 'settings') return 'settings'
  return null
}

function makeNotesTab(id) {
  return { id, key: null, type: 'notes' }
}

const VALID_TAB_TYPES = new Set(['notes', 'editor', 'graph', 'settings', 'file'])

// Only the bits of a tab that matter for restoring it later - `id` is
// re-generated fresh every boot, and `key` is just derived from the rest.
function serializeTab(tab) {
  const entry = { type: tab.type }
  if (tab.notePath) entry.notePath = tab.notePath
  if (tab.filePath) entry.filePath = tab.filePath
  if (tab.fileName) entry.fileName = tab.fileName
  if (tab.fileExt) entry.fileExt = tab.fileExt
  // Which folder a Notes tab was browsing - restored so the tab reopens
  // right there, with the folder's name back on the tab label.
  if (tab.folderPath) entry.folderPath = tab.folderPath
  if (tab.folderName) entry.folderName = tab.folderName
  return entry
}

// Guards against a corrupt/stale session.json (or one from a future
// Delta version with tab types this build doesn't know about yet)
// quietly producing a broken, unopenable tab.
function isRestorableTab(entry) {
  if (!entry || typeof entry !== 'object' || !VALID_TAB_TYPES.has(entry.type)) return false
  if (entry.type === 'editor' && !entry.notePath) return false
  if (entry.type === 'file' && !entry.filePath) return false
  return true
}

export default function App() {
  const [vaultPath, setVaultPath] = useState(null)
  const [ready, setReady] = useState(false)
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [viewerFile, setViewerFile] = useState(null)
  const [contextMenu, setContextMenu] = useState(null)

  const [tabs, setTabs] = useState([makeNotesTab('tab-0')])
  const [activeTabId, setActiveTabId] = useState('tab-0')
  const nextTabId = useRef(1)
  const rootRef = useRef(null)

  // `overflow: hidden` only blocks *user* scrolling - programmatic
  // scrolling (a stray scrollIntoView(), or focus() revealing an
  // offscreen element) can still scroll .app-root, which slides the
  // entire UI up underneath the macOS traffic-light strip with no way
  // for the user to drag it back. Pin it at 0 so no code path can ever
  // leave the app stuck half-hidden under the titlebar.
  // Depends on `ready` because .app-root isn't rendered at all until
  // ready flips true (see the `if (!ready) return null` below) - an
  // empty-deps effect would run once against a null ref and never
  // attach the listener.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return undefined
    const reset = () => {
      el.scrollTop = 0
      el.scrollLeft = 0
    }
    el.addEventListener('scroll', reset)
    return () => el.removeEventListener('scroll', reset)
  }, [ready])
  // Tab-navigation events (see DeltaAPI's openTab/closeActiveTab) are
  // handled by listeners registered once on mount - they read this ref
  // instead of `activeTabId` directly so they always see the current
  // value instead of whatever was active when the listener was set up.
  const activeTabIdRef = useRef(activeTabId)
  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])
  // Same idea, but the whole active tab object - the global Cmd/Ctrl+F
  // handler below needs to know the active tab's *type* (editor vs.
  // anything else) at the moment the key is pressed, and it's set up
  // once on mount same as everything else that reads activeTabIdRef.
  const activeTabRef = useRef(null)
  useEffect(() => {
    activeTabRef.current = tabs.find((t) => t.id === activeTabId) || null
  }, [tabs, activeTabId])
  // The whole tab list, for the Cmd/Ctrl+1..9 tab-jump shortcuts - the
  // keydown handler is registered once per vault, so it reads the
  // current list through this ref instead of a stale closure.
  const tabsRef = useRef(tabs)
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  const bootVault = useCallback(async (path) => {
    Delta.vaultPath = path
    setVaultPath(path)
    // settings:get, plugins:list and session:get each read something
    // independent (a small JSON file, a directory of plugin folders, a
    // different small JSON file) - firing them together instead of one
    // after the other shaves IPC round trips off every app launch.
    // loadPlugins() only needs the settings' enabledPlugins list to
    // filter the already-fetched plugin list, so there's no real
    // dependency between any of these three reads.
    const [loadedSettings, pluginList, session] = await Promise.all([
      window.deltaBridge.settings.get(path),
      window.deltaBridge.plugins.list(path),
      window.deltaBridge.session.get(path)
    ])
    setSettings(loadedSettings)
    applyTheme(loadedSettings.theme)
    await loadPlugins(loadedSettings.enabledPlugins, pluginList)

    // ensureVaultStructure (main.js) can fail to set up the Delta/ folder
    // (permission errors, read-only mounts, ...) without that ever
    // surfacing anywhere - it happens before any React screen exists to
    // show it in. Check once per vault open and surface it as a toast
    // instead of leaving plugins/settings silently broken with no clue why.
    const setupError = await window.deltaBridge.vault.lastSetupError(path)
    if (setupError) Delta.showNotice(setupError, { type: 'error', duration: 10000 })

    // Restore whatever tabs were open last time this vault was closed,
    // instead of always resetting to a single blank Notes tab.
    nextTabId.current = 0
    const restored = (session?.tabs || [])
      .filter(isRestorableTab)
      .map((entry) => ({ id: `tab-${nextTabId.current++}`, key: keyForTarget(entry), ...entry }))

    if (restored.length > 0) {
      const activeIdx = Math.min(Math.max(session.activeIndex || 0, 0), restored.length - 1)
      setTabs(restored)
      setActiveTabId(restored[activeIdx].id)
    } else {
      nextTabId.current = 1
      setTabs([makeNotesTab('tab-0')])
      setActiveTabId('tab-0')
    }
  }, [])

  // Persist the open tab list any time it (or the active tab) changes,
  // so quitting and relaunching Delta comes back to where it left off.
  // Debounced since several tab changes can land in quick succession
  // (e.g. closing several tabs back to back).
  const sessionSaveTimer = useRef(null)
  useEffect(() => {
    if (!vaultPath) return
    clearTimeout(sessionSaveTimer.current)
    sessionSaveTimer.current = setTimeout(() => {
      const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === activeTabId))
      window.deltaBridge.session.set(vaultPath, { tabs: tabs.map(serializeTab), activeIndex })
    }, 300)
    return () => clearTimeout(sessionSaveTimer.current)
  }, [tabs, activeTabId, vaultPath])

  useEffect(() => {
    // Apply a theme immediately so the vault-select screen itself is
    // themed correctly, instead of rendering unstyled until a vault
    // (and its saved settings) has been loaded.
    applyTheme(DEFAULT_SETTINGS.theme)
    ;(async () => {
      const existing = await window.deltaBridge.vault.get()
      if (existing) await bootVault(existing)
      setReady(true)
    })()
  }, [bootVault])

  // Global shortcuts, available once a vault is open: Cmd/Ctrl+K = quick
  // switcher (titles + actions), Cmd/Ctrl+F = full-text search across
  // every note's content, Cmd/Ctrl+W = close the active tab, Cmd/Ctrl+T =
  // open a new tab (same as clicking TabBar's "+").
  useEffect(() => {
    function handleKeyDown(e) {
      const isMeta = e.metaKey || e.ctrlKey
      if (!isMeta || !vaultPath) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        setSearchOpen(false)
        setPaletteOpen((v) => !v)
      } else if (key === 'f') {
        e.preventDefault()
        // A note editor's own find/replace bar takes over Cmd/Ctrl+F
        // while it's the active tab - the vault-wide content search
        // stays on the same shortcut everywhere else, since there's no
        // in-note bar to speak of on those screens.
        if (activeTabRef.current?.type === 'editor') {
          Delta.emit('editor:find-open')
        } else {
          setPaletteOpen(false)
          setSearchOpen((v) => !v)
        }
      } else if (key === 'w') {
        e.preventDefault()
        Delta.closeActiveTab()
      } else if (key === 't') {
        e.preventDefault()
        Delta.openTab({ type: 'notes' }, { newTab: true })
      } else if (key >= '1' && key <= '9') {
        // Cmd/Ctrl+1..8 jump to that tab; Cmd/Ctrl+9 always means the
        // LAST tab - same convention as every browser.
        e.preventDefault()
        const list = tabsRef.current
        if (!list || list.length === 0) return
        const idx = key === '9' ? list.length - 1 : Number(key) - 1
        if (idx < list.length) setActiveTabId(list[idx].id)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [vaultPath])

  // Let plugins register brand-new themes at runtime and have them
  // show up immediately as injected stylesheets.
  useEffect(() => {
    return Delta.on('themes:changed', (themes) => {
      Object.values(themes).forEach((theme) => {
        const styleId = `delta-theme-${theme.id}`
        let styleEl = document.getElementById(styleId)
        if (!styleEl) {
          styleEl = document.createElement('style')
          styleEl.id = styleId
          document.head.appendChild(styleEl)
        }
        styleEl.textContent = `[data-theme="${theme.id}"] {\n${theme.css}\n}`
      })
    })
  }, [])

  // ...and the reverse: when a plugin is disabled, Delta.unloadPlugin()
  // removes its theme(s) from Delta.themes and emits this - actually
  // tear out the injected <style> tag(s) so a disabled theme's CSS
  // doesn't just keep quietly applying.
  useEffect(() => {
    return Delta.on('themes:removed', (removedIds) => {
      removedIds.forEach((id) => {
        document.getElementById(`delta-theme-${id}`)?.remove()
      })
    })
  }, [])

  // ---- tabs: everything below drives the tab list purely off events
  // from Delta (see DeltaAPI.js) - nothing renders a tab-aware prop
  // down through NotesList/NoteEditor/GraphView/etc. anymore, they all
  // just call Delta.openTab()/closeActiveTab() directly. ----

  useEffect(() => {
    return Delta.on('tabs:open', ({ target, newTab }) => {
      const key = keyForTarget(target)
      setTabs((prevTabs) => {
        if (key) {
          const existing = prevTabs.find((t) => t.key === key)
          if (existing) {
            setActiveTabId(existing.id)
            return prevTabs
          }
        }
        const tab = { id: `tab-${nextTabId.current++}`, key, ...target }
        if (newTab) {
          setActiveTabId(tab.id)
          return [...prevTabs, tab]
        }
        // Replace the active tab's content in place - same as clicking
        // a link normally navigates the current tab/page.
        setActiveTabId(tab.id)
        return prevTabs.map((t) => (t.id === activeTabIdRef.current ? tab : t))
      })
    })
  }, [])

  useEffect(() => {
    return Delta.on('tabs:close-active', () => {
      const id = activeTabIdRef.current
      setTabs((prevTabs) => {
        const idx = prevTabs.findIndex((t) => t.id === id)
        if (idx === -1) return prevTabs
        const next = prevTabs.filter((t) => t.id !== id)
        if (next.length === 0) {
          const fresh = makeNotesTab(`tab-${nextTabId.current++}`)
          setActiveTabId(fresh.id)
          return [fresh]
        }
        setActiveTabId(next[Math.min(idx, next.length - 1)].id)
        return next
      })
    })
  }, [])

  // A renamed note's path changes - keep any tab pointed at it in sync
  // instead of it quietly pointing at a file that no longer exists.
  useEffect(() => {
    return Delta.on('note:rename', ({ oldPath, newPath }) => {
      setTabs((prev) =>
        prev.map((t) => (t.type === 'editor' && t.notePath === oldPath ? { ...t, notePath: newPath, key: `editor:${newPath}` } : t))
      )
    })
  }, [])

  // Same idea for a renamed non-.md file - a "file" tab pointed at it
  // (opened via FileCard's "Open in new tab") should follow the rename
  // instead of pointing at a path that no longer exists.
  useEffect(() => {
    return Delta.on('file:rename', ({ oldPath, newPath }) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.type === 'file' && t.filePath === oldPath
            ? { ...t, filePath: newPath, fileName: newPath.split(/[\\/]/).pop(), key: `file:${newPath}` }
            : t
        )
      )
    })
  }, [])

  // The listeners below are registered once on mount but need current
  // settings/vault to remap pinned paths - read through refs, same
  // pattern as activeTabIdRef above.
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])
  const vaultPathRef = useRef(vaultPath)
  useEffect(() => {
    vaultPathRef.current = vaultPath
  }, [vaultPath])

  // Rewrites pinned note/folder paths AND the per-folder grid order
  // through `remap`, persisting only if something actually changed -
  // both are stored by absolute path, so moves/renames would otherwise
  // silently unpin things and forget hand-made card ordering.
  const remapPins = useCallback((remap) => {
    const s = settingsRef.current
    const nextNotes = (s.pinnedNotes || []).map(remap)
    const nextFolders = (s.pinnedFolders || []).map(remap)
    // gridOrder keys are folder paths and values are lists of child
    // paths - a folder rename can shift either side.
    const nextOrder = {}
    for (const [dir, list] of Object.entries(s.gridOrder || {})) {
      nextOrder[remap(dir)] = (list || []).map(remap)
    }
    const changed =
      nextNotes.some((p, i) => p !== (s.pinnedNotes || [])[i]) ||
      nextFolders.some((p, i) => p !== (s.pinnedFolders || [])[i]) ||
      JSON.stringify(nextOrder) !== JSON.stringify(s.gridOrder || {})
    if (!changed) return
    const next = { ...s, pinnedNotes: nextNotes, pinnedFolders: nextFolders, gridOrder: nextOrder }
    setSettings(next)
    if (vaultPathRef.current) window.deltaBridge.settings.set(vaultPathRef.current, next)
  }, [])

  // A moved note keeps its pin - moveFile() reuses the note:rename event,
  // so this covers plain renames and moves alike.
  useEffect(() => {
    return Delta.on('note:rename', ({ oldPath, newPath }) => {
      remapPins((p) => (p === oldPath ? newPath : p))
    })
  }, [remapPins])

  // Renaming a folder shifts the path of *everything* inside it - remap
  // any tab and any pin that pointed into it (the folder itself included,
  // for pinned folders).
  useEffect(() => {
    return Delta.on('folder:rename', ({ oldPath, newPath }) => {
      const remap = (p) => (isUnderFolder(p, oldPath) ? newPath + p.slice(oldPath.length) : p)
      setTabs((prev) =>
        prev.map((t) => {
          if (t.type === 'editor' && t.notePath && isUnderFolder(t.notePath, oldPath)) {
            const np = remap(t.notePath)
            return { ...t, notePath: np, key: `editor:${np}` }
          }
          if (t.type === 'file' && t.filePath && isUnderFolder(t.filePath, oldPath)) {
            const np = remap(t.filePath)
            return { ...t, filePath: np, fileName: np.split(/[\\/]/).pop(), key: `file:${np}` }
          }
          return t
        })
      )
      remapPins(remap)
    })
  }, [remapPins])

  // Deleting a folder takes everything inside it along - close any tab
  // that pointed in there (it would just show a dead file), and drop the
  // now-meaningless pins.
  useEffect(() => {
    return Delta.on('folder:delete', ({ path }) => {
      setTabs((prevTabs) => {
        const survivors = prevTabs.filter((t) => {
          const p = t.type === 'editor' ? t.notePath : t.type === 'file' ? t.filePath : null
          return !p || !isUnderFolder(p, path)
        })
        if (survivors.length === prevTabs.length) return prevTabs
        if (survivors.length === 0) {
          const fresh = makeNotesTab(`tab-${nextTabId.current++}`)
          setActiveTabId(fresh.id)
          return [fresh]
        }
        if (!survivors.some((t) => t.id === activeTabIdRef.current)) {
          setActiveTabId(survivors[survivors.length - 1].id)
        }
        return survivors
      })
      const s = settingsRef.current
      const nextNotes = (s.pinnedNotes || []).filter((p) => !isUnderFolder(p, path))
      const nextFolders = (s.pinnedFolders || []).filter((p) => !isUnderFolder(p, path))
      if (nextNotes.length !== (s.pinnedNotes || []).length || nextFolders.length !== (s.pinnedFolders || []).length) {
        const next = { ...s, pinnedNotes: nextNotes, pinnedFolders: nextFolders }
        setSettings(next)
        if (vaultPathRef.current) window.deltaBridge.settings.set(vaultPathRef.current, next)
      }
    })
  }, [])

  function closeTab(id) {
    setTabs((prevTabs) => {
      const idx = prevTabs.findIndex((t) => t.id === id)
      if (idx === -1) return prevTabs
      const next = prevTabs.filter((t) => t.id !== id)
      if (next.length === 0) {
        const fresh = makeNotesTab(`tab-${nextTabId.current++}`)
        setActiveTabId(fresh.id)
        return [fresh]
      }
      if (activeTabIdRef.current === id) {
        setActiveTabId(next[Math.min(idx, next.length - 1)].id)
      }
      return next
    })
  }

  // Drag-and-drop tab reordering (TabBar) - moves draggedId to sit right
  // where targetId currently is. Purely a display-order change, doesn't
  // touch which tab is active or anything about their content.
  function reorderTabs(draggedId, targetId) {
    if (draggedId === targetId) return
    setTabs((prevTabs) => {
      const fromIdx = prevTabs.findIndex((t) => t.id === draggedId)
      const toIdx = prevTabs.findIndex((t) => t.id === targetId)
      if (fromIdx === -1 || toIdx === -1) return prevTabs
      const next = [...prevTabs]
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      return next
    })
  }

  // Opens a non-.md vault file - the quick modal for media (image/video/
  // audio, same as FileCard's preview), a real file tab for anything
  // Delta can view/edit itself (txt/html/csv/... and .docx, see
  // FileViewer), and only hands off to the OS's default app for the rest.
  useEffect(() => {
    return Delta.on('files:open', (file) => {
      const previewable = IMAGE_EXTS.has(file.ext) || VIDEO_EXTS.has(file.ext) || AUDIO_EXTS.has(file.ext)
      if (previewable) {
        setViewerFile(file)
      } else if (TEXT_EXTS.has(file.ext) || DOCX_EXTS.has(file.ext) || file.ext === 'pdf' || file.ext === 'doc') {
        Delta.openTab(
          { type: 'file', filePath: file.path, fileName: file.name, fileExt: file.ext },
          { newTab: true }
        )
      } else {
        window.deltaBridge.shell.openPath(file.path)
      }
    })
  }, [])

  useEffect(() => {
    return Delta.on('contextmenu:open', (menu) => setContextMenu(menu))
  }, [])

  function applyTheme(themeId) {
    document.documentElement.setAttribute('data-theme', themeId || 'violet-light')
  }

  async function handleVaultSelected(path) {
    await bootVault(path)
  }

  async function handleChangeVault() {
    await window.deltaBridge.vault.clear()
    Delta.vaultPath = null
    setVaultPath(null)
    nextTabId.current = 1
    setTabs([makeNotesTab('tab-0')])
    setActiveTabId('tab-0')
  }

  // A Notes tab reports which folder it's browsing (see NotesList's
  // onFolderChange) - stash it on the tab so TabBar can label the tab
  // with the folder's name, and session restore reopens it there.
  const handleNotesFolderChange = useCallback((tabId, folderPath) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId || t.type !== 'notes') return t
        const root = (vaultPathRef.current || '').replace(/\\/g, '/')
        const n = (folderPath || '').replace(/\\/g, '/')
        const folderName = n && n !== root ? n.split('/').pop() : null
        if (t.folderPath === folderPath && t.folderName === folderName) return t
        return { ...t, folderPath, folderName }
      })
    )
  }, [])

  async function handleSettingsChange(next) {
    setSettings(next)
    applyTheme(next.theme)
    await window.deltaBridge.settings.set(vaultPath, next)
  }

  if (!ready) return null

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0]

  return (
    <div className="app-root" ref={rootRef}>
      {/* Dedicated row for macOS's traffic-light buttons (see titleBarStyle:
          'hiddenInset' in main.js) so they get their own strip above the
          content instead of sharing a row with a screen's back button. */}
      <div className="titlebar-spacer" />
      <Toasts />
      {!vaultPath && <VaultSelect onVaultSelected={handleVaultSelected} />}

      {vaultPath && (
        <>
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onActivate={setActiveTabId}
            onClose={closeTab}
            onReorder={reorderTabs}
            onNewTab={() => Delta.openTab({ type: 'notes' }, { newTab: true })}
          />

          {/* Every open tab stays mounted; inactive ones are just hidden
              (display:none via .tab-panel[hidden]). Switching tabs used to
              unmount/remount the whole screen, which threw away all of its
              state - scroll position, in-progress edits state, find bar,
              settings scroll - and re-fetched everything from scratch on
              every single switch. Keeping them mounted makes tab switching
              instant and lossless, like a browser. `isActive` tells screens
              that care (NoteEditor) whether they own global things like
              Cmd+F and the plugin cursor API right now. */}
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab.id
            return (
              <div key={tab.id} className="tab-panel" hidden={!isActive}>
                {tab.type === 'notes' && (
                  <NotesList
                    settings={settings}
                    onSettingsChange={handleSettingsChange}
                    initialFolder={tab.folderPath || null}
                    onFolderChange={(fp) => handleNotesFolderChange(tab.id, fp)}
                  />
                )}
                {tab.type === 'editor' && tab.notePath && (
                  <NoteEditor
                    notePath={tab.notePath}
                    isActive={isActive}
                    defaultViewMode={settings.defaultEditorView || 'preview'}
                  />
                )}
                {tab.type === 'graph' && <GraphView isActive={isActive} />}
                {tab.type === 'settings' && (
                  <Settings settings={settings} onSettingsChange={handleSettingsChange} onChangeVault={handleChangeVault} />
                )}
                {tab.type === 'file' && tab.filePath && (
                  <FileViewer
                    file={{ path: tab.filePath, name: tab.fileName, ext: tab.fileExt }}
                  />
                )}
              </div>
            )
          })}
        </>
      )}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      <ContentSearch open={searchOpen} onClose={() => setSearchOpen(false)} />

      <FileViewerModal file={viewerFile} onClose={() => setViewerFile(null)} />

      <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />

      <PromptDialog />
      <ConfirmDialog />
    </div>
  )
}
