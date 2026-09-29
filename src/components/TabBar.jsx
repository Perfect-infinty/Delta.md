import { useState } from 'react'
import CloseIcon from '@mui/icons-material/Close'
import AddIcon from '@mui/icons-material/Add'
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined'
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined'
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import HubIcon from '@mui/icons-material/Hub'
import SettingsIcon from '@mui/icons-material/Settings'
import Delta from '../api/DeltaAPI.js'

const TAB_ICONS = {
  notes: GridViewOutlinedIcon,
  editor: DescriptionOutlinedIcon,
  graph: HubIcon,
  settings: SettingsIcon
}

function titleFromPath(p) {
  return (p || '').split(/[\\/]/).pop().replace(/\.md$/i, '')
}

function labelFor(tab) {
  if (tab.type === 'editor') return titleFromPath(tab.notePath) || 'Untitled'
  if (tab.type === 'graph') return 'Graph'
  if (tab.type === 'settings') return 'Settings'
  // A Notes tab browsing inside a folder shows that folder's name (set
  // by App via NotesList's onFolderChange), the vault root just "Notes".
  return tab.folderName || 'Notes'
}

/**
 * The tab strip - every open note/graph/settings/notes-grid view gets
 * one of these. Only the active tab's content is actually mounted (see
 * App.jsx) - switching tabs works the same way the old single-screen
 * navigation did, just remembering more than one destination at a time.
 */
export default function TabBar({ tabs, activeTabId, onActivate, onClose, onReorder, onNewTab }) {
  // Plain HTML5 drag-and-drop (no library) - draggedId is the tab being
  // picked up, overId is whichever tab it's currently hovering, purely
  // for the drop-target highlight below. The actual reorder only happens
  // once on drop; dragging over other tabs doesn't move anything live.
  const [draggedId, setDraggedId] = useState(null)
  const [overId, setOverId] = useState(null)

  function handleContextMenu(e, tab) {
    e.preventDefault()
    const otherIds = tabs.filter((t) => t.id !== tab.id).map((t) => t.id)
    Delta.showContextMenu(e.clientX, e.clientY, [
      { label: 'Open new tab', onClick: onNewTab },
      { label: 'Close tab', onClick: () => onClose(tab.id) },
      { label: 'Close other tabs', onClick: () => otherIds.forEach(onClose) }
    ])
  }

  // Lives here (rather than on the Notes screen) so it's reachable from
  // any tab, not just while a Notes grid happens to be the active one -
  // same reasoning as Graph/Settings below. Both land in the folder the
  // Notes grid is currently browsing (Delta.currentFolder, kept up to
  // date by NotesList), falling back to the vault root.
  async function createNote() {
    const path = await Delta.createNote('Untitled', Delta.currentFolder || undefined)
    Delta.openTab({ type: 'editor', notePath: path })
  }

  async function createFolder() {
    const name = await Delta.prompt('New folder name', '')
    if (!name || !name.trim()) return
    await Delta.createFolder(Delta.currentFolder || Delta.vaultPath, name.trim())
  }

  return (
    <div className="tab-bar">
      <div className="tab-bar-scroll">
        {tabs.map((tab) => {
          const Icon =
            tab.type === 'notes' && tab.folderName
              ? FolderOutlinedIcon
              : TAB_ICONS[tab.type] || DescriptionOutlinedIcon
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={`tab-item ${active ? 'active' : ''} ${draggedId === tab.id ? 'dragging' : ''} ${
                overId === tab.id && draggedId && draggedId !== tab.id ? 'drag-over' : ''
              }`}
              draggable
              onDragStart={(e) => {
                setDraggedId(tab.id)
                e.dataTransfer.effectAllowed = 'move'
                // Firefox (and some Electron builds) refuse to fire further
                // drag events at all without data actually being set.
                e.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragEnd={() => {
                setDraggedId(null)
                setOverId(null)
              }}
              onDragOver={(e) => {
                if (!draggedId || draggedId === tab.id) return
                e.preventDefault()
                setOverId(tab.id)
              }}
              onDragLeave={() => setOverId((o) => (o === tab.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault()
                const fromId = e.dataTransfer.getData('text/plain') || draggedId
                if (fromId && fromId !== tab.id) onReorder?.(fromId, tab.id)
                setDraggedId(null)
                setOverId(null)
              }}
              onClick={() => onActivate(tab.id)}
              onAuxClick={(e) => {
                // Middle-click closes the tab, same convention as a browser.
                if (e.button === 1) onClose(tab.id)
              }}
              onContextMenu={(e) => handleContextMenu(e, tab)}
              title={labelFor(tab)}
            >
              <Icon fontSize="inherit" className="tab-item-icon" />
              <span className="tab-item-label">{labelFor(tab)}</span>
              <button
                className="tab-item-close"
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.id)
                }}
                title="Close tab"
              >
                <CloseIcon fontSize="inherit" />
              </button>
            </div>
          )
        })}
      </div>

      {/* Sits immediately next to the last tab (browser convention - "+"
          always means "open next to what I'm looking at"), not stranded
          at the far right past a cluster of unrelated actions. */}
      <button className="tab-bar-new" type="button" onClick={onNewTab} title="New tab">
        <AddIcon fontSize="small" />
      </button>

      {/* Absorbs all the leftover width between the tabs and the actions
          cluster below - still the window's drag region (see .tab-bar),
          just no longer visually reading as "unfinished dead space" now
          that the tab strip itself hugs its own content instead of
          stretching to fill this same area. */}
      <div className="tab-bar-spacer" />

      <div className="tab-bar-actions">
        <button className="icon-btn" onClick={createNote} title="New note" type="button">
          <AddIcon fontSize="small" />
        </button>
        <button className="icon-btn" onClick={createFolder} title="New folder" type="button">
          <CreateNewFolderOutlinedIcon fontSize="small" />
        </button>
        <span className="bar-divider" />
        <button
          className="icon-btn"
          onClick={() => Delta.openTab({ type: 'graph' }, { newTab: true })}
          title="Graph view"
          type="button"
        >
          <HubIcon fontSize="small" />
        </button>
        <button
          className="icon-btn"
          onClick={() => Delta.openTab({ type: 'settings' }, { newTab: true })}
          title="Settings"
          type="button"
        >
          <SettingsIcon fontSize="small" />
        </button>
      </div>
    </div>
  )
}
