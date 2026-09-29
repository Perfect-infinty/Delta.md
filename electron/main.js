const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  shell,
  protocol,
  net,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const isDev = process.env.NODE_ENV === "development";

// Delta's own per-vault data (settings, session, plugins, caches) lives in
// this folder inside the vault. It used to be named ".delta" (hidden, dot-
// prefixed) - some setups (certain external/network drives, some file
// managers/sync tools) are flaky about writing into dot-folders, and it
// also meant the folder was invisible unless "show hidden files" was on.
// Plain "Delta" avoids both problems. LEGACY_DELTA_DIR_NAME is only kept
// around so ensureVaultStructure() can migrate an existing vault's old
// ".delta" folder over automatically instead of orphaning it.
const DELTA_DIR_NAME = "Delta";
const LEGACY_DELTA_DIR_NAME = ".delta";

/* ---------------------------------------------------------------- */
/* Safety helpers                                                    */
/*                                                                    */
/* Every IPC handler below receives raw paths from the renderer. The  */
/* renderer (and any plugin, which runs in it) is trusted to *ask*,   */
/* but these helpers make sure a bad or buggy path can never touch    */
/* anything outside the vault the user actually opened, and that a    */
/* crash mid-save can't leave a half-written note behind.             */
/* ---------------------------------------------------------------- */

// The vault the user currently has open. Set by ensureVaultStructure(),
// which runs on every vault:get / vault:select, i.e. before the
// renderer can make any other file call.
let activeVaultPath = null;

// Resolves `p` to an absolute path and throws unless it is inside the
// active vault. `allowRoot: true` also accepts the vault folder itself
// (e.g. as a destination folder); destructive handlers leave it false so
// the vault root can never be deleted or renamed by mistake.
function resolveInVault(p, { allowRoot = false } = {}) {
  if (typeof p !== "string" || !p) throw new Error("Invalid path");
  if (!activeVaultPath) throw new Error("No vault is open");
  const root = path.resolve(activeVaultPath);
  const target = path.resolve(p);
  const isRoot = target === root;
  const isInside = target.startsWith(root + path.sep);
  if (!isInside && !(allowRoot && isRoot)) {
    throw new Error(`Path is outside the vault: ${p}`);
  }
  return target;
}

// Writes via a temp file + rename, so the target is either the complete
// old content or the complete new content - never truncated if the app
// crashes or the disk fills up mid-write. The temp file is a dotfile,
// which every vault listing skips, so it never flashes up as a note.
function writeFileAtomic(filePath, data) {
  // Follow symlinks so a symlinked note is updated in place instead of
  // being replaced by a regular file.
  const target = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp file was never created - nothing to clean up */
    }
    throw err;
  }
}

// Turns user-supplied text into a safe single file/folder name: strips
// path separators and characters Windows forbids, control characters,
// leading dots (dotfiles are hidden from every vault listing, so a note
// named ".x" would silently vanish) and trailing dots/spaces (Windows
// drops those). Returns "" if nothing usable is left, so callers can
// apply their own fallback ("Untitled", ...).
function sanitizeName(name) {
  return String(name ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
}

// Local vault files (images/video/audio referenced from notes) are served
// through this dedicated scheme instead of a raw file:// URL. Chromium
// won't reliably stream/seek a <video>/<audio> src loaded cross-origin
// from file:// when the page itself isn't also file:// (true in dev,
// where the renderer is served from http://localhost:5173) - images work
// around this fine since a plain GET doesn't need Range support, but
// media elements do. This must run before the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "delta-file",
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
]);

/* ---------------------------------------------------------------- */
/* App-level config (remembers which vault/folder was last opened)  */
/* ---------------------------------------------------------------- */
const userDataPath = () => app.getPath("userData");
const configPath = () => path.join(userDataPath(), "delta-config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(userDataPath(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf-8");
}

let mainWindow;
// Only used in dev - "build/icon.png" isn't shipped inside a packaged
// app (electron-builder bakes it into the exe/.app bundle at build
// time instead), so this simply won't exist there and every use below
// is guarded accordingly.
const iconPath = path.join(__dirname, "..", "build", "icon.png");
const devIconPath = isDev && fs.existsSync(iconPath) ? iconPath : undefined;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: "#121212",
    autoHideMenuBar: true,
    icon: devIconPath,
    // Hide the native title bar (and its redundant "Delta" text) on
    // macOS but keep the traffic-light buttons. They get their own
    // dedicated strip above the content - see .titlebar-spacer in
    // index.css and the App.jsx root.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 10 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null);

  // The app menu above is fully removed, which also removes Electron's
  // default "Toggle Developer Tools" menu item - wire the shortcut up
  // directly instead, so there's still a way to open it. DevTools sees
  // the exact same `window` the app runs in, so `window.Delta` (the
  // hackable plugin API surface) is fully reachable from its console.
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    const key = input.key.toLowerCase();
    const isToggleShortcut = (input.meta || input.control) && input.shift && key === "i";
    if (isToggleShortcut || key === "f12") {
      mainWindow.webContents.toggleDevTools();
    }
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

// In dev mode there's no packaged .app bundle to carry an Info.plist
// icon, so the Dock shows the generic Electron icon unless we set it
// explicitly here. Packaged builds already get the right icon from
// electron-builder, baked into the .app itself.
if (devIconPath && process.platform === "darwin" && app.dock) {
  app.dock.setIcon(devIconPath);
}

app.whenReady().then(() => {
  // Serve delta-file://<absolute-path> by forwarding to net.fetch() on
  // the equivalent file:// URL - net.fetch() understands file:// URLs
  // (including Range headers) natively, which is exactly the streaming
  // support a <video>/<audio> element needs and a plain file:// src
  // loaded from a non-file:// origin doesn't reliably get.
  //
  // NOTE: deliberately not restricted to the vault - notes may embed a raw
  // file:// URL to any local image/video and MarkdownPreview rewrites it to
  // this scheme. It is read-only, and only ever reachable from note content
  // that DOMPurify has already sanitized.
  protocol.handle("delta-file", (request) => {
    try {
      const url = new URL(request.url);
      let filePath = decodeURIComponent(url.pathname);
      // On Windows, "delta-file:///C:/foo" parses to a pathname of
      // "/C:/foo" - pathToFileURL wants the drive letter up front.
      if (process.platform === "win32" && /^\/[a-zA-Z]:/.test(filePath)) {
        filePath = filePath.slice(1);
      }
      return net.fetch(pathToFileURL(filePath).toString(), {
        headers: request.headers,
      });
    } catch (err) {
      return new Response("Not found", { status: 404 });
    }
  });

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

/* ---------------------------------------------------------------- */
/* Vault                                                              */
/* ---------------------------------------------------------------- */
// vault:get calls this on every single app launch (it's the very first
// IPC round trip Electron makes), and bootVault() then immediately turns
// around and asks settings:get for the exact same settings.json this
// just read - cache the parsed result here, keyed by vault path, so that
// second read is a memory hit instead of a second disk read + JSON.parse.
let lastSettingsCache = null; // { vaultPath, settings }

// Set whenever ensureVaultStructure fails to create/maintain the Delta/
// folder for a vault (permission errors, read-only mounts, etc.) - the
// renderer polls this once right after opening a vault (see App.jsx) and
// surfaces it as a toast, since the failure itself happens too early
// (before any React screen is mounted) to show one directly.
let lastVaultSetupError = null; // { vaultPath, message }

function ensureVaultStructure(vaultPath) {
  activeVaultPath = vaultPath;
  const deltaDir = path.join(vaultPath, DELTA_DIR_NAME);

  // One-time migration: a vault opened by an older build of Delta has its
  // data under ".delta" instead - move it over instead of leaving it
  // behind (which would silently reset settings/plugins/session) or
  // creating a second, empty "Delta" folder alongside it.
  const legacyDir = path.join(vaultPath, LEGACY_DELTA_DIR_NAME);
  if (!fs.existsSync(deltaDir) && fs.existsSync(legacyDir)) {
    try {
      fs.renameSync(legacyDir, deltaDir);
    } catch (err) {
      console.error("[Delta] failed to migrate .delta -> Delta:", err);
    }
  }

  // Everything below used to run unguarded - if any single step here threw
  // (most commonly an EACCES/EPERM creating a folder inside a vault the OS
  // won't let this process write to, e.g. a location gated by macOS's
  // Files-and-Folders privacy permission), the exception propagated all
  // the way up through the "vault:get"/"vault:select" IPC handler, which
  // made the whole vault silently fail to open - no Delta/ folder, no
  // plugins/, no error shown anywhere, just nothing. Wrapping the whole
  // thing means a failure here is loud (logged with the real OS error,
  // which names the exact path and reason) instead of a silent dead end,
  // and doesn't take the rest of the app down with it.
  try {
    const pluginsDir = path.join(deltaDir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });

    // This folder is scanned out of the Notes/Files grid entirely (see the
    // DELTA_DIR_NAME check in listMarkdownFiles/listVaultFiles below) - it's
    // Delta's own settings/plugins/cache, not vault content. Since it's now
    // a plain visible folder (not hidden ".delta") it's easy to mistake for
    // a normal folder and drop notes/subfolders into it, which then never
    // show up anywhere in the app (they're not deleted - just never listed,
    // since this whole folder is skipped before recursion even reaches
    // whatever's inside it). Leave a note explaining that, once, so it's
    // obvious from Finder without having to ask.
    const noticeFile = path.join(deltaDir, "DO NOT PUT NOTES HERE.txt");
    if (!fs.existsSync(noticeFile)) {
      try {
        fs.writeFileSync(
          noticeFile,
          "This folder belongs to the Delta app itself (settings, plugins, cache).\n" +
            "Anything you put inside it - notes, files, subfolders - will never show up\n" +
            "in Delta's Notes screen, because this whole folder is intentionally skipped\n" +
            "when it scans the vault. Nothing you put here gets deleted, it's just invisible\n" +
            "to the app.\n\n" +
            "Put your own notes and files anywhere else in the vault instead - the vault's\n" +
            "root folder, or any other subfolder you create.\n",
          "utf-8",
        );
      } catch {
        /* not critical if this can't be written */
      }
    }

    const settingsFile = path.join(deltaDir, "settings.json");
    let settings;
    const settingsExisted = fs.existsSync(settingsFile);
    if (settingsExisted) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
      } catch {
        settings = { theme: "violet-light", enabledPlugins: [], pinnedNotes: [] };
      }
    } else {
      settings = { theme: "violet-light", enabledPlugins: [], pinnedNotes: [] };
    }
    if (!Array.isArray(settings.enabledPlugins)) settings.enabledPlugins = [];
    if (!Array.isArray(settings.pinnedNotes)) settings.pinnedNotes = [];
    if (!Array.isArray(settings.pinnedFolders)) settings.pinnedFolders = [];

    // Seed every bundled example plugin (plugins/<id>/manifest.json + index.js
    // shipped with the app) into the vault the first time it's opened, and
    // auto-enable each newly-added one - so Settings > Plugins/Theme always
    // has real, working examples to look at, tweak, or copy from.
    let settingsChanged = !settingsExisted;
    const bundledPluginsDir = path.join(__dirname, "..", "plugins");
    if (fs.existsSync(bundledPluginsDir)) {
      for (const pluginId of fs.readdirSync(bundledPluginsDir)) {
        const src = path.join(bundledPluginsDir, pluginId);
        if (!fs.statSync(src).isDirectory()) continue;
        const dest = path.join(pluginsDir, pluginId);
        if (fs.existsSync(dest)) continue;

        fs.mkdirSync(dest, { recursive: true });
        for (const file of fs.readdirSync(src)) {
          fs.copyFileSync(path.join(src, file), path.join(dest, file));
        }
        if (!settings.enabledPlugins.includes(pluginId)) {
          settings.enabledPlugins.push(pluginId);
          settingsChanged = true;
        }
      }
    }

    if (settingsChanged) {
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf-8");
    }
    lastSettingsCache = { vaultPath, settings };
    if (lastVaultSetupError && lastVaultSetupError.vaultPath === vaultPath) {
      lastVaultSetupError = null;
    }
  } catch (err) {
    const message = `Couldn't set up the "${DELTA_DIR_NAME}" folder (settings/plugins) in this vault: ${err.code || err.message}. Plugins and settings won't work until this is fixed - check the vault folder's permissions.`;
    console.error(`[Delta] ${message}`, err);
    lastVaultSetupError = { vaultPath, message };
  }
}

ipcMain.handle("vault:get", () => {
  const cfg = readConfig();
  if (cfg.vaultPath && fs.existsSync(cfg.vaultPath)) {
    // Re-sync in case new example plugins/themes shipped since the vault
    // was last opened (e.g. app update) - safe to call every time since
    // it only ever adds what's missing. This also happens to read+parse
    // settings.json, which populates lastSettingsCache above so the
    // settings:get call that immediately follows this one (bootVault in
    // App.jsx) doesn't have to hit the disk again for the same file.
    ensureVaultStructure(cfg.vaultPath);
    return cfg.vaultPath;
  }
  return null;
});

ipcMain.handle("vault:select", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select or create a vault folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const vaultPath = result.filePaths[0];
  ensureVaultStructure(vaultPath);
  const cfg = readConfig();
  cfg.vaultPath = vaultPath;
  writeConfig(cfg);
  return vaultPath;
});

ipcMain.handle("vault:clear", () => {
  const cfg = readConfig();
  delete cfg.vaultPath;
  writeConfig(cfg);
  return true;
});

// Polled once by App.jsx right after a vault finishes opening - lets the
// renderer show a real error toast for an ensureVaultStructure failure
// that happened during vault:get/vault:select, instead of that failure
// only ever showing up in the (usually unwatched) main-process console.
ipcMain.handle("vault:lastSetupError", (_e, vaultPath) => {
  if (lastVaultSetupError && lastVaultSetupError.vaultPath === vaultPath) {
    return lastVaultSetupError.message;
  }
  return null;
});

/* ---------------------------------------------------------------- */
/* Notes (plain .md files on disk - no database, no hidden format)  */
/* ---------------------------------------------------------------- */
function listMarkdownFiles(dir, baseDir) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    // Dotfiles/dot-folders (.git, .DS_Store, ...) and Delta's own
    // Delta/ data folder are never real vault content.
    if (entry.name.startsWith(".") || entry.name === DELTA_DIR_NAME) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(listMarkdownFiles(full, baseDir));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const stat = fs.statSync(full);
      results.push({
        path: full,
        relativePath: path.relative(baseDir, full),
        title: entry.name.replace(/\.md$/i, ""),
        mtime: stat.mtimeMs,
      });
    }
  }
  return results;
}

const WIKILINK_RE = /!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

// notes:list is called often (every autosave, every keystroke while an
// embed is on screen, quick switcher, search, graph view...). Reading
// and regex-scanning every .md file's full content on every single call
// is the expensive part - so cache the derived (excerpt, links) per
// file path, keyed by that file's mtime, and only redo the work for
// files that actually changed since the last call.
//
// This in-memory Map by itself only helps *within* one running session -
// it starts out empty on every fresh app launch, so a cold start would
// still re-read and re-regex-scan every single note from scratch, which
// is exactly the "first launch is slow" complaint for any vault with a
// meaningful number of notes. Fix: persist it to a small JSON file under
// Delta/cache/ and hydrate the in-memory Map from that file the first
// time a given vault is touched this process - so a relaunch only has to
// do the cheap mtime comparison per file, not the expensive read+regex.
const noteContentCache = new Map(); // path -> { mtime, excerpt, links }
let noteCacheVault = null; // which vault noteContentCache was hydrated from
let noteCacheDirty = false;
let noteCacheSaveTimer = null;

function noteCacheFilePath(vaultPath) {
  return path.join(vaultPath, DELTA_DIR_NAME, "cache", "notes.json");
}

function hydrateNoteCache(vaultPath) {
  noteContentCache.clear();
  try {
    const raw = fs.readFileSync(noteCacheFilePath(vaultPath), "utf-8");
    const data = JSON.parse(raw);
    for (const [p, v] of Object.entries(data)) noteContentCache.set(p, v);
  } catch {
    /* no cache file yet (first time this vault is opened), or it's
       unreadable/corrupt - start empty, it'll rebuild as notes:list runs */
  }
  noteCacheVault = vaultPath;
}

function persistNoteCache(vaultPath) {
  try {
    fs.mkdirSync(path.join(vaultPath, DELTA_DIR_NAME, "cache"), { recursive: true });
    writeFileAtomic(
      noteCacheFilePath(vaultPath),
      JSON.stringify(Object.fromEntries(noteContentCache)),
    );
  } catch (err) {
    console.error("[Delta] failed to persist notes cache:", err);
  }
  noteCacheDirty = false;
}

// Debounced - notes:list can fire many times in quick succession (every
// keystroke while an embed/preview is on screen), so don't hit disk on
// every single call, just settle a moment after things stop changing.
function scheduleNoteCacheSave(vaultPath) {
  noteCacheDirty = true;
  clearTimeout(noteCacheSaveTimer);
  noteCacheSaveTimer = setTimeout(() => persistNoteCache(vaultPath), 1000);
}

app.on("before-quit", () => {
  // Flush any pending debounced save immediately instead of losing it -
  // otherwise quitting within that ~1s window would silently discard the
  // last batch of cache updates, forcing next launch to redo that work.
  if (noteCacheDirty && noteCacheVault) {
    clearTimeout(noteCacheSaveTimer);
    persistNoteCache(noteCacheVault);
  }
});

ipcMain.handle("notes:list", (_e, vaultPath) => {
  if (!vaultPath) return [];
  if (noteCacheVault !== vaultPath) hydrateNoteCache(vaultPath);

  const files = listMarkdownFiles(vaultPath, vaultPath);
  let cacheChanged = false;
  const result = files
    .map((f) => {
      const cached = noteContentCache.get(f.path);
      if (cached && cached.mtime === f.mtime) {
        return { ...f, excerpt: cached.excerpt, links: cached.links };
      }

      let excerpt = "";
      let links = [];
      try {
        const content = fs.readFileSync(f.path, "utf-8");
        // Keep this as raw markdown (not plain text) - the card grid
        // renders it through the same markdown-it renderer as the
        // editor preview, then clips it visually with CSS.
        excerpt = content.replace(/^#.*$/m, "").trim();
        if (excerpt.length > 600) {
          let cut = 600;
          // Never slice inside an HTML tag - if the cut point lands after
          // an unclosed "<", back up to just before it so the excerpt
          // (rendered as HTML in the card grid) never contains a broken
          // tag that fails to parse/sanitize correctly.
          const lastOpen = excerpt.lastIndexOf("<", cut);
          const lastClose = excerpt.lastIndexOf(">", cut);
          if (lastOpen > lastClose) cut = lastOpen;
          excerpt = excerpt.slice(0, cut);
        }

        // [[Other Note]] and ![[Other Note]] both count as a link,
        // for graph-view purposes and for the "Notes" screen.
        const seen = new Set();
        let m;
        WIKILINK_RE.lastIndex = 0;
        while ((m = WIKILINK_RE.exec(content))) {
          const title = m[1].trim();
          if (title) seen.add(title);
        }
        links = Array.from(seen);
      } catch {
        /* ignore unreadable file */
      }

      noteContentCache.set(f.path, { mtime: f.mtime, excerpt, links });
      cacheChanged = true;
      return { ...f, excerpt, links };
    })
    .sort((a, b) => b.mtime - a.mtime);

  // Drop cache entries for notes that were renamed/deleted since the
  // last save, so the persisted cache file doesn't grow forever.
  const currentPaths = new Set(files.map((f) => f.path));
  for (const cachedPath of noteContentCache.keys()) {
    if (!currentPaths.has(cachedPath)) {
      noteContentCache.delete(cachedPath);
      cacheChanged = true;
    }
  }

  if (cacheChanged) scheduleNoteCacheSave(vaultPath);
  return result;
});

ipcMain.handle("notes:read", (_e, filePath) => {
  try {
    return fs.readFileSync(resolveInVault(filePath), "utf-8");
  } catch {
    // Missing/unreadable note reads as empty - callers treat "" as "new".
    return "";
  }
});

ipcMain.handle("notes:write", (_e, filePath, content) => {
  // Atomic: autosave fires every ~400ms, so a crash mid-write is far
  // more likely here than anywhere else in the app.
  writeFileAtomic(resolveInVault(filePath), content);
  return true;
});

// `destDir` (optional) creates the note inside a specific vault folder
// instead of the root - the Notes screen passes the folder it's
// currently browsing.
ipcMain.handle("notes:create", (_e, vaultPath, title, destDir) => {
  const dir = resolveInVault(destDir || vaultPath, { allowRoot: true });
  const safeTitle = sanitizeName(title) || "Untitled";
  let fileName = `${safeTitle}.md`;
  let filePath = path.join(dir, fileName);
  let i = 1;
  while (fs.existsSync(filePath)) {
    fileName = `${safeTitle} ${i}.md`;
    filePath = path.join(dir, fileName);
    i++;
  }
  fs.writeFileSync(filePath, `# ${safeTitle}\n\n`, "utf-8");
  return filePath;
});

ipcMain.handle("notes:delete", (_e, filePath) => {
  try {
    fs.unlinkSync(resolveInVault(filePath));
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("notes:search", (_e, vaultPath, query) => {
  const q = (query || "").trim().toLowerCase();
  if (!vaultPath || !q) return [];
  const files = listMarkdownFiles(vaultPath, vaultPath);
  const results = [];

  for (const f of files) {
    let content;
    try {
      content = fs.readFileSync(f.path, "utf-8");
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    const titleMatch = f.title.toLowerCase().includes(q);
    const firstIdx = lower.indexOf(q);
    if (firstIdx === -1 && !titleMatch) continue;

    let matchCount = 0;
    let pos = 0;
    while ((pos = lower.indexOf(q, pos)) !== -1) {
      matchCount++;
      pos += q.length;
    }

    let snippet = "";
    if (firstIdx !== -1) {
      const start = Math.max(0, firstIdx - 40);
      const end = Math.min(content.length, firstIdx + q.length + 60);
      snippet =
        (start > 0 ? "…" : "") +
        content.slice(start, end).replace(/\s+/g, " ").trim() +
        (end < content.length ? "…" : "");
    }

    results.push({ path: f.path, title: f.title, snippet, matchCount, titleMatch });
  }

  results.sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch) || b.matchCount - a.matchCount);
  return results.slice(0, 50);
});

ipcMain.handle("notes:rename", (_e, rawFilePath, newTitle) => {
  const filePath = resolveInVault(rawFilePath);
  const dir = path.dirname(filePath);
  const safeTitle = sanitizeName(newTitle) || "Untitled";
  let newPath = path.join(dir, `${safeTitle}.md`);
  if (newPath !== filePath) {
    let i = 1;
    while (fs.existsSync(newPath)) {
      newPath = path.join(dir, `${safeTitle} ${i}.md`);
      i++;
    }
    fs.renameSync(filePath, newPath);
    return newPath;
  }
  return filePath;
});

/* ---------------------------------------------------------------- */
/* Settings (per-vault, stored as plain json in Delta/settings.json)*/
/* ---------------------------------------------------------------- */
ipcMain.handle("settings:get", (_e, vaultPath) => {
  // vault:get already read+parsed this exact file a moment ago via
  // ensureVaultStructure (see lastSettingsCache above) - reuse that
  // instead of doing the same disk read + JSON.parse a second time on
  // every single app boot.
  if (lastSettingsCache && lastSettingsCache.vaultPath === vaultPath) {
    return lastSettingsCache.settings;
  }
  const file = path.join(vaultPath, DELTA_DIR_NAME, "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!Array.isArray(settings.pinnedNotes)) settings.pinnedNotes = [];
    if (!Array.isArray(settings.pinnedFolders)) settings.pinnedFolders = [];
    lastSettingsCache = { vaultPath, settings };
    return settings;
  } catch {
    return { theme: "violet-light", enabledPlugins: [], pinnedNotes: [], pinnedFolders: [] };
  }
});

ipcMain.handle("settings:set", (_e, vaultPath, settings) => {
  const deltaDir = path.join(vaultPath, DELTA_DIR_NAME);
  fs.mkdirSync(deltaDir, { recursive: true });
  writeFileAtomic(
    path.join(deltaDir, "settings.json"),
    JSON.stringify(settings, null, 2),
  );
  // Keep the cache in sync so a later settings:get in the same session
  // (e.g. re-opening the same vault without restarting) doesn't return
  // stale data from before this write.
  lastSettingsCache = { vaultPath, settings };
  return true;
});

/* ---------------------------------------------------------------- */
/* Session (which tabs were open, restored on the next app launch)  */
/* ---------------------------------------------------------------- */
// Deliberately a separate file from settings.json - settings are things
// the user explicitly chooses in the Settings screen, whereas this is
// ambient window state that changes on nearly every click (opening a
// note, closing a tab...). Keeping them apart means a debounced tab-list
// write can never race with or clobber an explicit settings save.
ipcMain.handle("session:get", (_e, vaultPath) => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(vaultPath, DELTA_DIR_NAME, "session.json"), "utf-8"),
    );
  } catch {
    return null;
  }
});

ipcMain.handle("session:set", (_e, vaultPath, session) => {
  try {
    const deltaDir = path.join(vaultPath, DELTA_DIR_NAME);
    fs.mkdirSync(deltaDir, { recursive: true });
    writeFileAtomic(path.join(deltaDir, "session.json"), JSON.stringify(session));
    return true;
  } catch (err) {
    console.error("[Delta] failed to persist session:", err);
    return false;
  }
});

/* ---------------------------------------------------------------- */
/* Plugins (folders of manifest.json + index.js, no npm packages)   */
/* ---------------------------------------------------------------- */
// plugins:list is called at least twice on every single vault boot
// (loadPlugins() at startup, then again the moment Settings mounts) and
// re-reads + re-parses every plugin's manifest.json AND its full
// index.js source every time, even though plugin files essentially
// never change between reads. Cache each plugin's parsed entry keyed by
// the mtimes of the two files it was built from - a cheap fs.statSync
// (no content read) is enough to confirm the cached entry is still
// valid, skipping the readFileSync+JSON.parse entirely when nothing
// changed. In-memory only (process-lifetime), since a relaunch reads
// each plugin's files at least once anyway.
const pluginEntryCache = new Map(); // folderPath -> { manifestMtime, codeMtime, entry }

ipcMain.handle("plugins:list", (_e, vaultPath) => {
  const pluginsDir = path.join(vaultPath, DELTA_DIR_NAME, "plugins");
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderPath = path.join(pluginsDir, entry.name);
    const manifestPath = path.join(folderPath, "manifest.json");
    let manifestStat;
    try {
      manifestStat = fs.statSync(manifestPath);
    } catch {
      continue;
    }

    const cached = pluginEntryCache.get(folderPath);
    if (cached && cached.manifestMtime === manifestStat.mtimeMs) {
      // Manifest unchanged - the plugin's main file path only ever comes
      // from the manifest, so if that file's mtime also still matches,
      // the whole cached entry (manifest + code) is safe to reuse as-is.
      try {
        const mainFile = path.join(
          folderPath,
          cached.entry.manifest.main || "index.js",
        );
        const codeStat = fs.existsSync(mainFile) ? fs.statSync(mainFile) : null;
        const codeMtime = codeStat ? codeStat.mtimeMs : null;
        if (codeMtime === cached.codeMtime) {
          results.push(cached.entry);
          continue;
        }
      } catch {
        /* fall through and re-read below */
      }
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      const mainFile = path.join(folderPath, manifest.main || "index.js");
      let codeMtime = null;
      let code = "";
      try {
        codeMtime = fs.statSync(mainFile).mtimeMs;
        code = fs.readFileSync(mainFile, "utf-8");
      } catch {
        /* main file missing - code stays empty */
      }
      const pluginEntry = {
        id: manifest.id || entry.name,
        manifest,
        code,
        folder: entry.name,
      };
      pluginEntryCache.set(folderPath, {
        manifestMtime: manifestStat.mtimeMs,
        codeMtime,
        entry: pluginEntry,
      });
      results.push(pluginEntry);
    } catch (err) {
      results.push({
        id: entry.name,
        manifest: { id: entry.name, name: entry.name },
        code: "",
        folder: entry.name,
        error: String(err),
      });
    }
  }
  return results;
});

// Deletes a plugin's whole folder from Delta/plugins/. `folder` is the
// plugin's directory name (as reported by plugins:list), never a path -
// resolved and verified to stay inside the plugins dir, so a malformed
// value can't reach anything else on disk.
ipcMain.handle("plugins:delete", (_e, vaultPath, folder) => {
  try {
    const pluginsDir = path.join(vaultPath, DELTA_DIR_NAME, "plugins");
    const target = path.resolve(pluginsDir, folder || "");
    if (target === path.resolve(pluginsDir) || !target.startsWith(path.resolve(pluginsDir) + path.sep)) {
      return false;
    }
    fs.rmSync(target, { recursive: true, force: true });
    pluginEntryCache.delete(target);
    return true;
  } catch (err) {
    console.error("[Delta] plugins:delete failed:", err);
    return false;
  }
});

ipcMain.handle("plugins:openFolder", (_e, vaultPath) => {
  const pluginsDir = path.join(vaultPath, DELTA_DIR_NAME, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  shell.openPath(pluginsDir);
  return true;
});

/* ---------------------------------------------------------------- */
/* Shell (opening files/links referenced from note previews)        */
/* ---------------------------------------------------------------- */
ipcMain.handle("shell:openPath", async (_e, targetPath) => {
  // shell.openPath resolves with an error string on failure, "" on success.
  return shell.openPath(targetPath);
});

ipcMain.handle("shell:openExternal", async (_e, url) => {
  // Only hand real web/mail links to the OS. openExternal will happily
  // launch any registered protocol handler (ms-msdt:, custom app
  // schemes, ...), which a note or plugin must never be able to trigger.
  if (typeof url !== "string" || !/^(https?:|mailto:)/i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

/* ---------------------------------------------------------------- */
/* Network (Delta.fetch for plugins) - runs the request here in the  */
/* main process via net.fetch(), so neither the renderer's CSP nor   */
/* CORS applies: any http(s) URL works, with or without CORS headers.*/
/* ---------------------------------------------------------------- */
ipcMain.handle("net:fetch", async (_e, url, opts = {}) => {
  const {
    method = "GET",
    headers = {},
    body = null,
    binary = false,
    timeout = 30000,
  } = opts || {};

  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new Error("Delta.fetch: only http(s) URLs are supported");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await net.fetch(url, {
      method,
      headers,
      body: body == null ? undefined : body,
      signal: controller.signal,
    });

    const resHeaders = {};
    res.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });

    const payload = {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      headers: resHeaders,
    };
    if (binary) {
      payload.bodyBase64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    } else {
      payload.body = await res.text();
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
});

/* ---------------------------------------------------------------- */
/* Vault files (anything that isn't a .md note - images, video, txt, */
/* html, whatever the user drags in) - lets the Notes screen show    */
/* them as cards alongside notes, and the editor drop-to-embed them. */
/* ---------------------------------------------------------------- */
function listVaultFiles(dir, baseDir) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    // Dotfiles/dot-folders (.git, .DS_Store, ...) and Delta's own
    // Delta/ data folder are never real vault content.
    if (entry.name.startsWith(".") || entry.name === DELTA_DIR_NAME) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(listVaultFiles(full, baseDir));
    } else if (entry.isFile() && !entry.name.toLowerCase().endsWith(".md")) {
      const stat = fs.statSync(full);
      results.push({
        path: full,
        relativePath: path.relative(baseDir, full),
        name: entry.name,
        ext: path.extname(entry.name).replace(/^\./, "").toLowerCase(),
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    }
  }
  return results;
}

ipcMain.handle("vault:listFiles", (_e, vaultPath) => {
  if (!vaultPath) return [];
  return listVaultFiles(vaultPath, vaultPath).sort((a, b) => b.mtime - a.mtime);
});

// Copies a file dragged in from the OS into the vault (or a specific
// folder inside it - e.g. right next to the note being edited),
// renaming it on collision instead of ever overwriting something that's
// already there. Returns the new absolute path, or null on failure.
ipcMain.handle("vault:importFile", (_e, sourcePath, rawDestDir) => {
  try {
    // sourcePath is intentionally NOT vault-checked: it's a file the
    // user dragged in from anywhere on their machine. The destination is.
    const destDir = resolveInVault(rawDestDir, { allowRoot: true });
    fs.mkdirSync(destDir, { recursive: true });
    const ext = path.extname(sourcePath);
    const base = path.basename(sourcePath, ext);
    let destPath = path.join(destDir, `${base}${ext}`);
    let i = 1;
    while (fs.existsSync(destPath)) {
      destPath = path.join(destDir, `${base} ${i}${ext}`);
      i++;
    }
    fs.copyFileSync(sourcePath, destPath);
    return destPath;
  } catch (err) {
    console.error("[Delta] vault:importFile failed:", err);
    return null;
  }
});

// Small, capped text preview for the Notes-screen file cards (txt/html/
// csv/json/etc.) - reads only the first chunk of the file instead of
// the whole thing, so a huge file dropped into the vault can't stall
// the grid.
ipcMain.handle("files:readTextSnippet", (_e, filePath, maxChars = 600) => {
  try {
    const fd = fs.openSync(resolveInVault(filePath), "r");
    const buffer = Buffer.alloc(Math.max(maxChars * 4, 2048)); // headroom for multi-byte utf-8
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    return buffer.toString("utf-8", 0, bytesRead).slice(0, maxChars);
  } catch {
    return "";
  }
});

// Full text read for a non-.md vault file - unlike files:readTextSnippet
// above, this reads the *whole* file, because FileViewer now lets the
// user edit txt/html/etc. files in place, and editing a truncated
// snippet would silently chop off everything past the cap on save.
ipcMain.handle("files:readText", (_e, filePath) => {
  try {
    return fs.readFileSync(resolveInVault(filePath), "utf-8");
  } catch {
    return null;
  }
});

// Saves edited text back to a non-.md vault file - same mechanics as
// notes:write, kept separate so the notes and files surfaces stay
// symmetrical (read/write pairs on both).
ipcMain.handle("files:writeText", (_e, filePath, content) => {
  try {
    writeFileAtomic(resolveInVault(filePath), content);
    return true;
  } catch (err) {
    console.error("[Delta] files:writeText failed:", err);
    return false;
  }
});

// Writes binary data (base64) as a new file inside destDir, renaming on
// collision like vault:importFile - but from in-memory bytes instead of
// an existing path on disk. This is what backs pasting an image from
// the clipboard straight into a note: the clipboard hands the renderer
// raw bytes with no source file to copy, so importFile can't help.
ipcMain.handle("files:writeBinary", (_e, rawDestDir, fileName, base64) => {
  try {
    const destDir = resolveInVault(rawDestDir, { allowRoot: true });
    fs.mkdirSync(destDir, { recursive: true });
    const safeName = sanitizeName(fileName) || "file";
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    let destPath = path.join(destDir, safeName);
    let i = 1;
    while (fs.existsSync(destPath)) {
      // Hyphen (not space) on collision - these names get embedded into
      // markdown as ![](name), and a raw space would break the parse.
      destPath = path.join(destDir, `${base}-${i}${ext}`);
      i++;
    }
    fs.writeFileSync(destPath, Buffer.from(base64, "base64"));
    return destPath;
  } catch (err) {
    console.error("[Delta] files:writeBinary failed:", err);
    return null;
  }
});

// Plain-text body of a legacy .doc (binary Word) file, via the
// word-extractor package - .docx is handled renderer-side by mammoth,
// but mammoth can't read the old binary format. Lazy-required so the
// app still boots fine if the dependency isn't installed yet; the
// renderer falls back to "open externally" on null.
ipcMain.handle("files:readDocText", async (_e, filePath) => {
  try {
    const WordExtractor = require("word-extractor");
    const doc = await new WordExtractor().extract(resolveInVault(filePath));
    return doc.getBody();
  } catch (err) {
    console.error("[Delta] files:readDocText failed:", err);
    return null;
  }
});

// Every file inside the vault's Delta/ folder (settings.json, session,
// caches, plugin files...) - the one folder the normal vault listings
// deliberately skip. Settings shows these so config files can be
// opened/edited in-app without hunting them down in a file manager.
ipcMain.handle("vault:listDeltaFiles", (_e, vaultPath) => {
  const deltaDir = path.join(vaultPath, DELTA_DIR_NAME);
  function walk(dir) {
    let results = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(walk(full));
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* keep 0 */
        }
        results.push({
          path: full,
          relativePath: path.relative(deltaDir, full),
          name: entry.name,
          ext: path.extname(entry.name).replace(/^\./, "").toLowerCase(),
          size,
        });
      }
    }
    return results;
  }
  return walk(deltaDir).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
});

ipcMain.handle("vault:openDeltaFolder", (_e, vaultPath) => {
  shell.openPath(path.join(vaultPath, DELTA_DIR_NAME));
  return true;
});

// Renames a non-.md vault file in place (same folder), collision-safe -
// unlike notes:rename, the caller supplies the *whole* new filename
// (extension included), since a generic file's extension isn't implied
// the way ".md" is for a note.
ipcMain.handle("files:rename", (_e, rawFilePath, newName) => {
  try {
    const filePath = resolveInVault(rawFilePath);
    const dir = path.dirname(filePath);
    const safeName = sanitizeName(newName);
    if (!safeName) return null;
    let newPath = path.join(dir, safeName);
    if (newPath === filePath) return filePath;
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    let i = 1;
    while (fs.existsSync(newPath)) {
      newPath = path.join(dir, `${base} ${i}${ext}`);
      i++;
    }
    fs.renameSync(filePath, newPath);
    return newPath;
  } catch (err) {
    console.error("[Delta] files:rename failed:", err);
    return null;
  }
});

ipcMain.handle("files:delete", (_e, filePath) => {
  try {
    fs.unlinkSync(resolveInVault(filePath));
    return true;
  } catch (err) {
    console.error("[Delta] files:delete failed:", err);
    return false;
  }
});

/* ---------------------------------------------------------------- */
/* Folders + moving files between them.                              */
/*                                                                    */
/* Moving a file (or renaming a folder, which moves everything in     */
/* it) breaks two kinds of references notes hold by *path*:           */
/*   - markdown links/images:  ![x](img.png)  /  [doc](/sub/a.txt)    */
/*   - raw html embeds:        <img src="...">, <source src="...">    */
/* (Wikilinks [[Title]] are resolved by title vault-wide, so moves    */
/* never break them - they're deliberately left untouched here.)      */
/* updateVaultReferences() below rewrites those path references in    */
/* every note so nothing goes dark after a move - including inside    */
/* the moved note itself, whose *own* relative links all shift        */
/* meaning when its folder changes.                                   */
/* ---------------------------------------------------------------- */

function listVaultFolders(dir, baseDir) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === DELTA_DIR_NAME) continue;
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    let mtime = 0;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      /* keep 0 */
    }
    results.push({
      path: full,
      relativePath: path.relative(baseDir, full),
      name: entry.name,
      mtime,
    });
    results = results.concat(listVaultFolders(full, baseDir));
  }
  return results;
}

ipcMain.handle("folders:list", (_e, vaultPath) => {
  if (!vaultPath) return [];
  return listVaultFolders(vaultPath, vaultPath);
});

// Every file (md and not) under dir, recursively - used to build the
// old-path -> new-path map when a whole folder is renamed.
function walkAllFiles(dir) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === DELTA_DIR_NAME) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(walkAllFiles(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

// A ref we should never touch: real URLs (any scheme), anchors, and
// anything empty. Everything else is treated as a vault-relative path.
const EXTERNAL_REF_RE = /^([a-z][a-z0-9+.-]*:|#)/i;

function resolveRefToAbsolute(ref, noteDir, vaultPath) {
  // Leading slash = relative to the vault root (the same convention
  // MarkdownPreview's resolveVaultUrl uses); anything else is relative
  // to the note's own folder.
  if (ref.startsWith("/")) return path.normalize(path.join(vaultPath, ref.slice(1)));
  return path.normalize(path.join(noteDir, ref));
}

function absoluteToRef(targetAbs, noteDir, vaultPath) {
  const rel = path.relative(noteDir, targetAbs);
  if (rel.startsWith("..")) {
    // Outside the note's folder - use the vault-root-relative form,
    // which stays valid no matter where the note itself sits.
    return "/" + path.relative(vaultPath, targetAbs).split(path.sep).join("/");
  }
  return rel.split(path.sep).join("/");
}

// Rewrites one note's content: `oldNoteDir` is where the note's
// relative refs were valid *before* the move, `newNoteDir` where the
// note lives now (identical unless the note itself moved).
function rewriteNoteRefs(content, oldNoteDir, newNoteDir, vaultPath, moveMap) {
  let changed = false;

  const fix = (ref) => {
    if (!ref || EXTERNAL_REF_RE.test(ref) || ref.startsWith("[[")) return ref;
    const abs = resolveRefToAbsolute(ref, oldNoteDir, vaultPath);
    const mapped = moveMap.get(abs) || abs;
    if (mapped === abs) {
      // Target didn't move. Only re-relativize if the *note* moved, and
      // only for refs that actually point at something real - a broken
      // or exotic ref is left exactly as the user wrote it.
      if (oldNoteDir === newNoteDir) return ref;
      if (!fs.existsSync(abs)) return ref;
    }
    const next = absoluteToRef(mapped, newNoteDir, vaultPath);
    if (next !== ref) changed = true;
    return next;
  };

  // ![alt](target) and [text](target) - conservative: a target with
  // spaces/parens never matches, which also means it's never corrupted.
  let out = content.replace(
    /(!?\[[^\]\n]*\]\()([^()\s]+)(\))/g,
    (_m, a, ref, c) => a + fix(ref) + c,
  );
  // src/href attributes in raw html blocks (video/audio/img embeds the
  // editor's drop-to-embed generates, or hand-written ones).
  out = out.replace(
    /((?:src|href)=")([^"\n]+)(")/gi,
    (_m, a, ref, c) => a + fix(ref) + c,
  );
  out = out.replace(
    /((?:src|href)=')([^'\n]+)(')/gi,
    (_m, a, ref, c) => a + fix(ref) + c,
  );
  return { out, changed };
}

// moveMap: absolute old path -> absolute new path, for every file that
// just moved. Scans every note in the vault (at its current, post-move
// location) and rewrites any reference affected by the move.
function updateVaultReferences(vaultPath, moveMap) {
  const reverse = new Map();
  for (const [oldAbs, newAbs] of moveMap) reverse.set(newAbs, oldAbs);

  for (const note of listMarkdownFiles(vaultPath, vaultPath)) {
    const oldPath = reverse.get(note.path) || note.path;
    const oldDir = path.dirname(oldPath);
    const newDir = path.dirname(note.path);
    let content;
    try {
      content = fs.readFileSync(note.path, "utf-8");
    } catch {
      continue;
    }
    const { out, changed } = rewriteNoteRefs(content, oldDir, newDir, vaultPath, moveMap);
    if (changed) {
      try {
        writeFileAtomic(note.path, out);
      } catch (err) {
        console.error("[Delta] failed to update references in", note.path, err);
      }
    }
  }
}

// Moves any vault file (note or not) into destDir, collision-safe, then
// fixes up every path reference to it across the vault. Returns the new
// absolute path (== sourcePath when it already lives there), or null.
ipcMain.handle("files:move", (_e, vaultPath, rawSourcePath, rawDestDir) => {
  try {
    const sourcePath = resolveInVault(rawSourcePath);
    const destDir = resolveInVault(rawDestDir, { allowRoot: true });
    if (path.dirname(sourcePath) === path.normalize(destDir)) return sourcePath;
    fs.mkdirSync(destDir, { recursive: true });
    const ext = path.extname(sourcePath);
    const base = path.basename(sourcePath, ext);
    let destPath = path.join(destDir, `${base}${ext}`);
    let i = 1;
    while (fs.existsSync(destPath)) {
      // Hyphen, not space - the new name flows into ![](name) references,
      // and a raw space would break the markdown parse.
      destPath = path.join(destDir, `${base}-${i}${ext}`);
      i++;
    }
    fs.renameSync(sourcePath, destPath);
    updateVaultReferences(vaultPath, new Map([[sourcePath, destPath]]));
    return destPath;
  } catch (err) {
    console.error("[Delta] files:move failed:", err);
    return null;
  }
});

ipcMain.handle("folders:create", (_e, rawParentDir, name) => {
  try {
    const parentDir = resolveInVault(rawParentDir, { allowRoot: true });
    const safeName = (name || "").replace(/[\\/:*?"<>|]/g, "-").trim();
    if (!safeName || safeName.startsWith(".") || safeName === DELTA_DIR_NAME) return null;
    let dirPath = path.join(parentDir, safeName);
    let i = 1;
    while (fs.existsSync(dirPath)) {
      dirPath = path.join(parentDir, `${safeName} ${i}`);
      i++;
    }
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
  } catch (err) {
    console.error("[Delta] folders:create failed:", err);
    return null;
  }
});

// Renaming a folder moves everything inside it at once - build the full
// old -> new map for every file under it and run the same reference
// fix-up a single-file move gets. Returns the folder's new path, or null.
ipcMain.handle("folders:rename", (_e, vaultPath, rawFolderPath, newName) => {
  try {
    const folderPath = resolveInVault(rawFolderPath); // never the vault root itself
    const safeName = (newName || "").replace(/[\\/:*?"<>|]/g, "-").trim();
    if (!safeName || safeName.startsWith(".") || safeName === DELTA_DIR_NAME) return null;
    const parent = path.dirname(folderPath);
    let newPath = path.join(parent, safeName);
    if (newPath === folderPath) return folderPath;
    let i = 1;
    while (fs.existsSync(newPath)) {
      newPath = path.join(parent, `${safeName} ${i}`);
      i++;
    }
    fs.renameSync(folderPath, newPath);

    const moveMap = new Map();
    for (const newAbs of walkAllFiles(newPath)) {
      moveMap.set(path.join(folderPath, path.relative(newPath, newAbs)), newAbs);
    }
    updateVaultReferences(vaultPath, moveMap);
    return newPath;
  } catch (err) {
    console.error("[Delta] folders:rename failed:", err);
    return null;
  }
});

// Deletes a folder and everything in it. The renderer confirms first
// (Delta.confirm with danger styling) - by the time this runs, the user
// has already said yes to losing the contents.
ipcMain.handle("folders:delete", (_e, rawFolderPath) => {
  try {
    // resolveInVault without allowRoot: deleting the vault folder itself
    // (or anything outside it) is refused outright.
    const folderPath = resolveInVault(rawFolderPath);
    fs.rmSync(folderPath, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.error("[Delta] folders:delete failed:", err);
    return false;
  }
});
