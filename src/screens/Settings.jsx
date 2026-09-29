import { useEffect, useRef, useState } from 'react'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import RefreshIcon from '@mui/icons-material/Refresh'
import SwapHorizIcon from '@mui/icons-material/SwapHoriz'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import Delta from '../api/DeltaAPI.js'
import { loadPlugin, reloadPlugin } from '../plugins/PluginManager.js'
import CustomSelect from '../components/CustomSelect.jsx'
import PluginSettingsSection from '../components/PluginSettingsSection.jsx'
import { restoreScroll, saveScroll } from '../utils/scrollMemory.js'

const BUILTIN_THEMES = [
  { id: 'violet-light', name: 'Violet Light (default)' },
  { id: 'violet-dark', name: 'Violet Dark' },
  { id: 'nord', name: 'Nord' }
]

const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'config', label: 'Config files' }
]

// Remembers which settings tab was open across unmounts (Settings fully
// unmounts when its tab isn't active) - same session-only idea as
// NoteEditor's viewModeByPath.
let lastSettingsTab = 'general'

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function Settings({ settings, onSettingsChange, onBack = () => Delta.openTab({ type: 'notes' }), onChangeVault }) {
  const [tab, setTab] = useState(lastSettingsTab)
  const [pluginList, setPluginList] = useState([])
  const [refreshingPlugins, setRefreshingPlugins] = useState(false)
  const [deltaFiles, setDeltaFiles] = useState([])
  // Bumped whenever a plugin registers a new theme, so the Theme list
  // below (which reads Delta.themes directly) re-renders to show it.
  const [themeVersion, setThemeVersion] = useState(0)
  // Same idea for Delta.settingsSections - registerSettingsSection()
  // doesn't itself trigger a React render anywhere, since it just pushes
  // into a plain array on the Delta singleton.
  const [settingsSectionsVersion, setSettingsSectionsVersion] = useState(0)
  const bodyRef = useRef(null)

  useEffect(() => {
    lastSettingsTab = tab
  }, [tab])

  useEffect(() => {
    window.deltaBridge.plugins.list(Delta.vaultPath).then(setPluginList)
    Delta.listDeltaFiles().then(setDeltaFiles)
  }, [])

  // Settings fully unmounts when its tab isn't active (see App.jsx) -
  // switching to another tab and back would otherwise always reopen it
  // scrolled to the top, no matter how far down (a long plugin list, a
  // plugin's own settings section) the user had scrolled before leaving.
  useEffect(() => {
    restoreScroll('settings-body', bodyRef.current)
    const el = bodyRef.current
    if (!el) return
    const onScroll = () => saveScroll('settings-body', el)
    el.addEventListener('scroll', onScroll)
    return () => {
      saveScroll('settings-body', el)
      el.removeEventListener('scroll', onScroll)
    }
  }, [])

  // plugins:list only ever gets fetched once above (on mount) - a plugin
  // folder dropped into Delta/plugins/ *after* Settings is already open
  // (or from a previous session) doesn't show up in the checklist below
  // until something re-fetches it. On top of that, this also re-runs
  // every currently-enabled plugin's index.js from scratch (reloadPlugin,
  // not the already-loaded-skips loadPlugin) - so editing a plugin's
  // code and hitting refresh actually applies the change immediately.
  async function refreshPluginList() {
    setRefreshingPlugins(true)
    try {
      const list = await window.deltaBridge.plugins.list(Delta.vaultPath)
      setPluginList(list)
      const enabled = settings.enabledPlugins || []
      for (const p of list) {
        if (enabled.includes(p.id)) await reloadPlugin(p.id)
      }
    } finally {
      setRefreshingPlugins(false)
    }
  }

  useEffect(() => {
    return Delta.on('themes:changed', () => setThemeVersion((v) => v + 1))
  }, [])

  useEffect(() => {
    return Delta.on('settings:changed', () => setSettingsSectionsVersion((v) => v + 1))
  }, [])

  function setTheme(themeId) {
    onSettingsChange({ ...settings, theme: themeId })
  }

  async function togglePlugin(pluginId) {
    const enabled = new Set(settings.enabledPlugins || [])
    const enabling = !enabled.has(pluginId)
    let nextTheme = settings.theme
    if (enabling) {
      enabled.add(pluginId)
      // Load it right now, in this session, instead of only on the next
      // vault reopen - so a theme/toolbar button it registers shows up
      // immediately.
      await loadPlugin(pluginId)
    } else {
      enabled.delete(pluginId)
      // Actually undo whatever this plugin registered (theme, toolbar
      // button, etc.) right now, instead of leaving it active until the
      // vault is reopened.
      Delta.unloadPlugin(pluginId)
      // If the currently-selected theme was the one this plugin just
      // removed, fall back to the default rather than leaving the app
      // on a data-theme value with no matching CSS anymore.
      const stillExists = BUILTIN_THEMES.some((t) => t.id === settings.theme) || Delta.themes[settings.theme]
      if (!stillExists) nextTheme = 'violet-light'
    }
    onSettingsChange({ ...settings, theme: nextTheme, enabledPlugins: Array.from(enabled) })
  }

  async function openPluginsFolder() {
    await window.deltaBridge.plugins.openFolder(Delta.vaultPath)
  }

  // Removes the plugin's folder from Delta/plugins/ entirely - not just
  // disabling it. Unloads it from the running app first, then cleans it
  // out of enabledPlugins so it doesn't linger in settings.json.
  async function deletePlugin(p) {
    const ok = await Delta.confirm(
      `Delete plugin "${p.manifest?.name || p.id}"? Its folder will be removed from the vault. This can't be undone.`,
      { danger: true, confirmLabel: 'Delete' }
    )
    if (!ok) return
    Delta.unloadPlugin(p.id)
    const removed = await window.deltaBridge.plugins.delete(Delta.vaultPath, p.folder)
    if (!removed) {
      Delta.showNotice('Could not delete the plugin folder', { type: 'error' })
      return
    }
    const enabled = new Set(settings.enabledPlugins || [])
    enabled.delete(p.id)
    // Same fallback as togglePlugin: if the active theme belonged to the
    // just-deleted plugin, don't leave the app on a theme with no CSS.
    let nextTheme = settings.theme
    const stillExists = BUILTIN_THEMES.some((t) => t.id === settings.theme) || Delta.themes[settings.theme]
    if (!stillExists) nextTheme = 'violet-light'
    onSettingsChange({ ...settings, theme: nextTheme, enabledPlugins: Array.from(enabled) })
    setPluginList(await window.deltaBridge.plugins.list(Delta.vaultPath))
    Delta.showNotice(`Deleted plugin "${p.manifest?.name || p.id}"`)
  }

  // Config files open right inside the app, as a normal file tab - and
  // since FileViewer edits text files in place now, settings.json &
  // friends are directly editable without leaving Delta.
  function openConfigFile(f) {
    Delta.openTab({ type: 'file', filePath: f.path, fileName: f.name, fileExt: f.ext }, { newTab: true })
  }

  const allThemes = [...BUILTIN_THEMES, ...Object.values(Delta.themes)]

  return (
    <div className="screen settings-screen">
      <header className="top-bar">
        <div className="top-bar-actions">
          <button className="icon-btn" onClick={onBack} title="Back" type="button">
            <ArrowBackIcon />
          </button>
        </div>
        <h1 className="app-name">Settings</h1>
        <div className="top-bar-actions" />
      </header>

      <nav className="settings-tabs">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            className={`settings-tab ${tab === t.id ? 'settings-tab-active' : ''}`}
            onClick={() => setTab(t.id)}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="settings-body" ref={bodyRef}>
        {tab === 'general' && (
          <>
            <section className="settings-section">
              <h2>Theme</h2>
              <CustomSelect
                value={settings.theme}
                options={allThemes.map((t) => ({ value: t.id, label: t.name }))}
                onChange={setTheme}
              />
            </section>

            <section className="settings-section">
              <h2>Notes layout</h2>
              <p className="settings-hint">
                How the Notes screen shows things by default. The toggle on the Notes screen itself only changes it
                for the current session - this is what every launch starts on.
              </p>
              <CustomSelect
                value={settings.notesView === 'list' ? 'list' : 'grid'}
                options={[
                  { value: 'grid', label: 'Cards' },
                  { value: 'list', label: 'List' }
                ]}
                onChange={(v) => onSettingsChange({ ...settings, notesView: v })}
              />
            </section>

            <section className="settings-section">
              <h2>Default note view</h2>
              <p className="settings-hint">
                What a freshly-opened note starts in. Switching modes inside a note still remembers your choice for
                that note for the rest of the session.
              </p>
              <CustomSelect
                value={settings.defaultEditorView || 'preview'}
                options={[
                  { value: 'preview', label: 'Full preview' },
                  { value: 'split', label: 'Split (edit + preview)' },
                  { value: 'edit', label: 'Edit' }
                ]}
                onChange={(v) => onSettingsChange({ ...settings, defaultEditorView: v })}
              />
            </section>

            <section className="settings-section">
              <h2>Vault</h2>
              <p className="settings-hint">{Delta.vaultPath}</p>
              <button className="btn btn-ghost" onClick={onChangeVault} type="button">
                <SwapHorizIcon fontSize="small" />
                <span>Change vault</span>
              </button>
            </section>
          </>
        )}

        {tab === 'plugins' && (
          <>
            <section className="settings-section">
              <div className="settings-section-header">
                <h2>Plugins</h2>
                <div className="settings-section-header-actions">
                  <button
                    className="icon-btn"
                    onClick={refreshPluginList}
                    title="Rescan for new plugin folders"
                    type="button"
                    disabled={refreshingPlugins}
                  >
                    <RefreshIcon fontSize="small" className={refreshingPlugins ? 'icon-spin' : ''} />
                  </button>
                  <button className="btn btn-ghost" onClick={openPluginsFolder} type="button">
                    <FolderOpenIcon fontSize="small" />
                    <span>Open plugins folder</span>
                  </button>
                </div>
              </div>
              <p className="settings-hint">
                Drop any folder containing a <code>manifest.json</code> + <code>index.js</code> in there, then hit
                refresh (button above). Toggling a plugin already in the list on/off applies immediately. Refresh also
                re-runs every currently-enabled plugin's code from disk, so editing an existing plugin's
                <code>index.js</code> and hitting refresh applies the change too, not just new folders.
              </p>
              {pluginList.length === 0 ? (
                <p className="empty-hint">No plugins installed yet.</p>
              ) : (
                <ul className="plugin-list">
                  {pluginList.map((p) => (
                    <li key={p.id} className="plugin-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={(settings.enabledPlugins || []).includes(p.id)}
                          onChange={() => togglePlugin(p.id)}
                        />
                        <div>
                          <div className="plugin-name">{p.manifest?.name || p.id}</div>
                          <div className="plugin-desc">{p.manifest?.description || ''}</div>
                        </div>
                      </label>
                      <button
                        className="icon-btn plugin-delete-btn"
                        onClick={() => deletePlugin(p)}
                        title="Delete plugin (removes its folder)"
                        type="button"
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* settingsSectionsVersion itself isn't used here - just bumping
                it (see the 'settings:changed' listener above) forces a
                re-render to pick up changes to Delta.settingsSections. */}
            {Delta.settingsSections.map((section) => (
              <PluginSettingsSection key={section.id} section={section} />
            ))}

            <p className="settings-note-changes">
              Enabling/disabling a plugin here applies immediately - no restart needed.
            </p>
          </>
        )}

        {tab === 'config' && (
          <section className="settings-section">
            <div className="settings-section-header">
              <h2>Config files</h2>
              <div className="settings-section-header-actions">
                <button className="btn btn-ghost" onClick={() => Delta.openDeltaFolder()} type="button">
                  <FolderOpenIcon fontSize="small" />
                  <span>Open Delta folder</span>
                </button>
                <button
                  className="icon-btn"
                  onClick={() => Delta.listDeltaFiles().then(setDeltaFiles)}
                  title="Refresh list"
                  type="button"
                >
                  <RefreshIcon fontSize="small" />
                </button>
              </div>
            </div>
            <p className="settings-hint">
              Everything Delta stores about this vault (settings, session, caches, plugin code) lives in the vault's{' '}
              <code>Delta/</code> folder. Click a file to open it in a tab - text files are editable right in the app.
            </p>
            {deltaFiles.length === 0 ? (
              <p className="empty-hint">No config files found.</p>
            ) : (
              <ul className="config-file-list">
                {deltaFiles.map((f) => (
                  <li key={f.path}>
                    <button className="config-file-item" onClick={() => openConfigFile(f)} type="button">
                      <DescriptionOutlinedIcon fontSize="small" />
                      <span className="config-file-path">{f.relativePath}</span>
                      <span className="config-file-size">{formatSize(f.size)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </main>
    </div>
  )
}
