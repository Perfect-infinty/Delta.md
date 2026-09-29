import { useState } from 'react'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import logo from '../assets/logo.png'

/**
 * First screen a new user sees: pick (or create) the folder that becomes
 * the vault. Calls `onVaultSelected(path)` once the main process has
 * accepted the folder - App.jsx then boots settings/plugins/session
 * for it. Cancelling the native dialog resolves to null, which is
 * deliberately a silent no-op rather than an error.
 */
export default function VaultSelect({ onVaultSelected }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Opens the native folder picker (with a "New Folder" button, so a
  // brand-new vault can be created right here). `busy` blocks a second
  // click while the dialog is open; `error` shows setup failures inline.
  async function pickFolder() {
    setBusy(true)
    setError(null)
    try {
      const path = await window.deltaBridge.vault.select()
      if (path) onVaultSelected(path)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen vault-screen">
      <div className="vault-card">
        <img src={logo} alt="" className="vault-logo" />
        <h1 className="vault-title">Delta</h1>
        <p className="vault-subtitle">A simple, hackable notebook. Pick a folder to use as your vault.</p>
        <button className="btn btn-primary" onClick={pickFolder} disabled={busy}>
          <FolderOpenIcon fontSize="small" />
          <span>{busy ? 'Opening…' : 'Select Vault Folder'}</span>
        </button>
        {error && <p className="vault-error">{error}</p>}
        <p className="vault-hint">Notes are saved as plain .md files inside the folder you choose.</p>
      </div>
    </div>
  )
}
