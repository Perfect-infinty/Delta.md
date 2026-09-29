import Delta from '../api/DeltaAPI.js'
import { dirnameOf } from './path.js'

/**
 * Second-stage context menu for "Move to…" on a note/file card: lists
 * the vault root + every folder (except the one the item is already
 * in) and moves the item there on click. Async on purpose - the await
 * on listFolders() means the new menu is emitted *after* ContextMenu
 * has finished closing the first one, instead of being clobbered by it.
 */
export async function showMoveToMenu(x, y, sourcePath) {
  const folders = await Delta.listFolders()
  const currentDir = dirnameOf(sourcePath)
  const targets = [
    { label: '/ (vault root)', path: Delta.vaultPath },
    ...folders.map((f) => ({ label: '/' + f.relativePath.replace(/\\/g, '/'), path: f.path }))
  ].filter((t) => (t.path || '').replace(/\\/g, '/') !== currentDir)

  if (targets.length === 0) {
    Delta.showNotice('No other folder to move this into')
    return
  }
  Delta.showContextMenu(
    x,
    y,
    targets.map((t) => ({ label: t.label, onClick: () => Delta.moveFile(sourcePath, t.path) }))
  )
}
