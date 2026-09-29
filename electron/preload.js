const { contextBridge, ipcRenderer, webUtils } = require('electron')

/**
 * Everything the renderer (React app + plugins) can reach on the
 * Electron side. Kept intentionally flat and un-clever so it's easy
 * for anyone hacking on Delta to see the entire surface area at a
 * glance and add to it.
 */
contextBridge.exposeInMainWorld('deltaBridge', {
  platform: process.platform, // 'darwin' | 'win32' | 'linux' - used to reserve space for macOS's traffic lights
  vault: {
    get: () => ipcRenderer.invoke('vault:get'),
    select: () => ipcRenderer.invoke('vault:select'),
    clear: () => ipcRenderer.invoke('vault:clear'),
    // Non-null if setting up the Delta/ folder (settings/plugins/cache)
    // for this vault failed - see ensureVaultStructure in main.js.
    lastSetupError: (vaultPath) => ipcRenderer.invoke('vault:lastSetupError', vaultPath),
    // The Delta/ config folder: list every file in it (settings, session,
    // caches, plugins) and open the folder itself in the OS file manager.
    listDeltaFiles: (vaultPath) => ipcRenderer.invoke('vault:listDeltaFiles', vaultPath),
    openDeltaFolder: (vaultPath) => ipcRenderer.invoke('vault:openDeltaFolder', vaultPath)
  },
  notes: {
    list: (vaultPath) => ipcRenderer.invoke('notes:list', vaultPath),
    read: (filePath) => ipcRenderer.invoke('notes:read', filePath),
    write: (filePath, content) => ipcRenderer.invoke('notes:write', filePath, content),
    create: (vaultPath, title, destDir) => ipcRenderer.invoke('notes:create', vaultPath, title, destDir),
    delete: (filePath) => ipcRenderer.invoke('notes:delete', filePath),
    rename: (filePath, newTitle) => ipcRenderer.invoke('notes:rename', filePath, newTitle),
    search: (vaultPath, query) => ipcRenderer.invoke('notes:search', vaultPath, query)
  },
  settings: {
    get: (vaultPath) => ipcRenderer.invoke('settings:get', vaultPath),
    set: (vaultPath, settings) => ipcRenderer.invoke('settings:set', vaultPath, settings)
  },
  session: {
    // Which tabs were open + which was active - restored the next time
    // this vault is opened, so quitting and relaunching Delta comes back
    // to where you left off instead of always resetting to a blank Notes tab.
    get: (vaultPath) => ipcRenderer.invoke('session:get', vaultPath),
    set: (vaultPath, session) => ipcRenderer.invoke('session:set', vaultPath, session)
  },
  plugins: {
    list: (vaultPath) => ipcRenderer.invoke('plugins:list', vaultPath),
    openFolder: (vaultPath) => ipcRenderer.invoke('plugins:openFolder', vaultPath),
    // Removes the plugin's folder from Delta/plugins/ - `folder` is the
    // directory name from plugins:list, not a path.
    delete: (vaultPath, folder) => ipcRenderer.invoke('plugins:delete', vaultPath, folder)
  },
  files: {
    // Every non-.md file in the vault (images, video, txt, html, ...),
    // so the Notes screen can show them as cards next to real notes.
    list: (vaultPath) => ipcRenderer.invoke('vault:listFiles', vaultPath),
    // Copies a file dragged in from the OS into destDir (an absolute
    // path inside the vault), returning its new path.
    import: (sourcePath, destDir) => ipcRenderer.invoke('vault:importFile', sourcePath, destDir),
    readTextSnippet: (filePath, maxChars) => ipcRenderer.invoke('files:readTextSnippet', filePath, maxChars),
    // Whole-file read/write for text files (txt/html/csv/...), so
    // FileViewer can edit them in place - the snippet read above is
    // only for grid-card previews and is capped.
    readText: (filePath) => ipcRenderer.invoke('files:readText', filePath),
    writeText: (filePath, content) => ipcRenderer.invoke('files:writeText', filePath, content),
    // Writes in-memory bytes (base64) as a new vault file - backs
    // pasting a clipboard image into a note, where there's no source
    // path on disk for import() to copy from.
    writeBinary: (destDir, fileName, base64) => ipcRenderer.invoke('files:writeBinary', destDir, fileName, base64),
    // Plain-text body of a legacy binary .doc (docx renders via mammoth
    // in the renderer instead) - null if unreadable/dep missing.
    readDocText: (filePath) => ipcRenderer.invoke('files:readDocText', filePath),
    rename: (filePath, newName) => ipcRenderer.invoke('files:rename', filePath, newName),
    delete: (filePath) => ipcRenderer.invoke('files:delete', filePath),
    // Moves a vault file (note or not) into another vault folder, then
    // rewrites path references to it across every note - see main.js.
    move: (vaultPath, sourcePath, destDir) => ipcRenderer.invoke('files:move', vaultPath, sourcePath, destDir),
    // A dropped OS File object doesn't carry its real disk path across
    // the context bridge by itself (contextIsolation strips File#path) -
    // webUtils.getPathForFile() is Electron's supported way to recover
    // it, given the exact same File instance from the drop event.
    getDroppedPath: (file) => webUtils.getPathForFile(file)
  },
  folders: {
    // Real subfolders inside the vault - the Notes screen shows them as
    // navigable cards, and note/file cards can be dragged onto them.
    list: (vaultPath) => ipcRenderer.invoke('folders:list', vaultPath),
    create: (parentDir, name) => ipcRenderer.invoke('folders:create', parentDir, name),
    // vaultPath is needed because renaming a folder moves everything in
    // it, and every note referencing those files gets its links fixed up.
    rename: (vaultPath, folderPath, newName) => ipcRenderer.invoke('folders:rename', vaultPath, folderPath, newName),
    delete: (folderPath) => ipcRenderer.invoke('folders:delete', folderPath)
  },
  net: {
    // HTTP(S) requests executed in the main process - immune to the
    // renderer's CSP and to CORS. Wrapped by Delta.fetch() in DeltaAPI.js.
    fetch: (url, opts) => ipcRenderer.invoke('net:fetch', url, opts)
  },
  shell: {
    // Opens a local file (e.g. a PDF or video referenced from a note)
    // with the OS's default app for it.
    openPath: (targetPath) => ipcRenderer.invoke('shell:openPath', targetPath),
    // Opens an http(s) link in the user's actual default browser instead
    // of navigating this window away from the app.
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
  }
})
