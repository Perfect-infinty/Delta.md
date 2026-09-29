/**
 * DeltaAPI is the single, global surface that both the React app and
 * every plugin talk to. It is deliberately exposed on `window.Delta`
 * so it can be poked at from devtools and so plugin scripts (plain
 * .js files, no bundler, no npm) can reach every capability the app
 * itself uses. This is what makes Delta "hackable": there is no
 * separate, restricted plugin API - plugins get the real thing.
 */
class DeltaAPI {
  constructor() {
    this._listeners = new Map(); // event -> Set<fn>
    this.toolbarButtons = []; // note-editor toolbar buttons registered by plugins
    this.settingsSections = []; // extra settings sections registered by plugins
    this.markdownPlugins = []; // markdown-it plugins registered by plugins
    // Bumped on *every* change to markdownPlugins (register and unload
    // alike). MarkdownPreview's cached markdown-it instance invalidates
    // off this instead of markdownPlugins.length: a plugin reload
    // (toggle off/on, Settings' refresh button) removes one entry and
    // adds one back, leaving the length identical - a length check
    // can't see that, so the cached renderer kept running the *previous*
    // plugin instance's extension (closed over the old, orphaned plugin
    // object) and the freshly-registered one never applied. That's why
    // a reloaded plugin's settings (e.g. a "show quotes" toggle read
    // live inside its markdown hook) looked like they did nothing.
    this.markdownVersion = 0;
    this.themes = {}; // id -> { id, name, css }
    this.plugins = new Map(); // id -> plugin definition
    this.vaultPath = null;
    this.bridge = typeof window !== "undefined" ? window.deltaBridge : null;

    // In-memory caches so switching screens (Notes <-> editor <-> back)
    // never has to sit through a blank/loading state waiting on an IPC
    // round trip for data we already fetched this session. Both are
    // populated as a side effect of the normal listNotes()/readNote()
    // calls below, and kept fresh by writeNote()/createNote()/deleteNote().
    this._notesListCache = null; // Note[] | null - null means "never fetched yet"
    this._noteContentCache = new Map(); // path -> raw markdown content
    this._filesListCache = null; // VaultFile[] | null - every non-.md file in the vault

    // Tracks which plugin registered what, so disabling a plugin from
    // Settings can actually undo its registrations (theme, toolbar
    // button, markdown-it extension, settings section) instead of them
    // silently sticking around until the app restarts. Keyed by plugin
    // id -> Set of the thing(s) it registered.
    this._currentLoadingPluginId = null;
    this._pluginThemeIds = new Map();
    this._pluginToolbarEntries = new Map();
    this._pluginMarkdownEntries = new Map();
    this._pluginSettingsEntries = new Map();
    // Same idea for raw on() subscriptions made *during* a plugin's
    // onLoad() - without this, reloading a plugin (Settings' refresh
    // button, or toggling it off/on) left every previous api.on() call
    // it ever made still attached, stacking a duplicate listener on top
    // of the old one each time instead of replacing it.
    this._pluginListenerEntries = new Map();

    // Whichever NoteEditor is currently mounted registers itself here
    // (see NoteEditor.jsx) so the cursor/selection methods below have
    // something to actually operate on - null when no note is open
    // (Notes grid, Graph, Settings), in which case they're harmless no-ops
    // rather than throwing on a plugin that fires a toolbar button with
    // no note open.
    this._activeEditor = null;
  }

  _trackContribution(map, key) {
    const pluginId = this._currentLoadingPluginId;
    if (!pluginId) return;
    if (!map.has(pluginId)) map.set(pluginId, new Set());
    map.get(pluginId).add(key);
  }

  /** Last-known notes list, if any - safe to render immediately while a
   * real listNotes() call confirms/refreshes it in the background. */
  getCachedNotesList() {
    return this._notesListCache;
  }

  /** Last-known content for a note, if any - same idea as above, used so
   * opening a note you've already viewed this session shows instantly. */
  getCachedNoteContent(path) {
    return this._noteContentCache.has(path)
      ? this._noteContentCache.get(path)
      : null;
  }

  /** Last-known non-.md vault files list, if any. */
  getCachedFilesList() {
    return this._filesListCache;
  }

  /* ---------------- event bus ---------------- */
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    // Only tracked while a plugin's onLoad() is actively running (see
    // registerPlugin/_trackContribution) - subscriptions the app's own
    // screens make are untouched by this. Without it, unloadPlugin()
    // (disabling a plugin, or Settings' refresh button reloading one)
    // had no way to know this listener belonged to that plugin, so the
    // old one just kept firing forever alongside every new one the next
    // onLoad() added on top of it.
    this._trackContribution(this._pluginListenerEntries, { event, cb });
    return () => this.off(event, cb);
  }

  off(event, cb) {
    this._listeners.get(event)?.delete(cb);
  }

  emit(event, payload) {
    this._listeners.get(event)?.forEach((cb) => {
      try {
        // A listener can be `async (payload) => {...}` (plenty are, e.g.
        // a plugin's note:save handler awaiting writeNote()) - a throw
        // *before* its first await lands here same as a sync function,
        // but a rejection *after* that already happened inside a settled
        // Promise this try/catch can't see. Attach a .catch to log those
        // too instead of letting them surface only as an unhandled
        // rejection nothing ever reports.
        const result = cb(payload);
        if (result && typeof result.catch === "function") {
          result.catch((err) =>
            console.error(
              `[Delta] async listener for "${event}" rejected:`,
              err,
            ),
          );
        }
      } catch (err) {
        console.error(`[Delta] listener for "${event}" threw:`, err);
      }
    });
  }

  /* ---------------- plugin registration ---------------- */
  registerPlugin(def) {
    if (!def || !def.id) {
      console.error("[Delta] registerPlugin requires an { id } field", def);
      return;
    }
    if (this.plugins.has(def.id)) {
      // Re-registering an id that's already loaded - a reload (Settings'
      // refresh button, or toggling a plugin off then straight back on)
      // re-runs the exact same index.js, which calls registerPlugin()
      // again with the same id. Without this, every register*() call in
      // onLoad (toolbar buttons, settings sections, themes, markdown
      // plugins, on() listeners) just piled a duplicate on top of the
      // previous run's, since nothing had torn the old ones down first.
      // Tearing down the previous instance under this id before
      // continuing makes registerPlugin() safe to call repeatedly for
      // the same plugin, regardless of which code path triggered it.
      this.unloadPlugin(def.id);
    }
    this.plugins.set(def.id, def);
    if (typeof def.onLoad === "function") {
      // Attribute anything this plugin registers (theme, toolbar button,
      // etc.) to it while its onLoad() runs, so unloadPlugin() below
      // knows what to undo later.
      const previousLoadingId = this._currentLoadingPluginId;
      this._currentLoadingPluginId = def.id;
      try {
        def.onLoad(this);
      } catch (err) {
        console.error(`[Delta] plugin "${def.id}" onLoad failed:`, err);
      } finally {
        this._currentLoadingPluginId = previousLoadingId;
      }
    }
  }

  /**
   * Reverses everything a plugin's onLoad() registered - theme(s),
   * toolbar button(s), markdown-it extension(s), settings section(s),
   * on() listener(s) - and forgets the plugin itself. Called when a
   * plugin is toggled off from Settings (or reloaded, or re-registered
   * under the same id - see registerPlugin() above), so disabling it
   * actually removes it from the running app right away instead of only
   * taking effect on the next vault open.
   */
  unloadPlugin(pluginId) {
    const def = this.plugins.get(pluginId);
    if (def && typeof def.onUnload === "function") {
      // A plugin's own chance to clean up anything Delta can't know
      // about by itself - a setInterval/setTimeout it started, mainly.
      // Called the same method-call way as onLoad(), so `this` inside
      // onUnload() is the plugin's own object, same as onLoad().
      try {
        def.onUnload();
      } catch (err) {
        console.error(`[Delta] plugin "${pluginId}" onUnload failed:`, err);
      }
    }

    const themeIds = this._pluginThemeIds.get(pluginId);
    if (themeIds && themeIds.size > 0) {
      for (const id of themeIds) delete this.themes[id];
      this._pluginThemeIds.delete(pluginId);
      this.emit("themes:changed", this.themes);
      this.emit("themes:removed", Array.from(themeIds));
    }

    const toolbarEntries = this._pluginToolbarEntries.get(pluginId);
    if (toolbarEntries && toolbarEntries.size > 0) {
      this.toolbarButtons = this.toolbarButtons.filter(
        (b) => !toolbarEntries.has(b),
      );
      this._pluginToolbarEntries.delete(pluginId);
      this.emit("toolbar:changed", this.toolbarButtons);
    }

    const markdownEntries = this._pluginMarkdownEntries.get(pluginId);
    if (markdownEntries && markdownEntries.size > 0) {
      this.markdownPlugins = this.markdownPlugins.filter(
        (e) => !markdownEntries.has(e),
      );
      this.markdownVersion++;
      this._pluginMarkdownEntries.delete(pluginId);
      this.emit("markdown:changed", this.markdownPlugins);
    }

    const settingsEntries = this._pluginSettingsEntries.get(pluginId);
    if (settingsEntries && settingsEntries.size > 0) {
      this.settingsSections = this.settingsSections.filter(
        (e) => !settingsEntries.has(e),
      );
      this._pluginSettingsEntries.delete(pluginId);
      this.emit("settings:changed", this.settingsSections);
    }

    const listenerEntries = this._pluginListenerEntries.get(pluginId);
    if (listenerEntries && listenerEntries.size > 0) {
      for (const { event, cb } of listenerEntries) this.off(event, cb);
      this._pluginListenerEntries.delete(pluginId);
    }

    this.plugins.delete(pluginId);
  }

  registerNoteToolbarButton(button) {
    const entry = {
      id: button.id || `btn-${Math.random().toString(36).slice(2)}`,
      ...button,
    };
    this.toolbarButtons.push(entry);
    this._trackContribution(this._pluginToolbarEntries, entry);
    this.emit("toolbar:changed", this.toolbarButtons);
    return () => {
      this.toolbarButtons = this.toolbarButtons.filter((b) => b !== entry);
      this.emit("toolbar:changed", this.toolbarButtons);
    };
  }

  /** Adds a custom section to the bottom of the Settings screen.
   * `section` is `{ id?, title, render(container, api) }` - `render` is
   * called once with an empty <div> to build into directly (plugins are
   * plain JS with no bundler, so no JSX to return here - same reasoning
   * as onClick callbacks elsewhere), and may optionally return a cleanup
   * function, called when the section is torn down (plugin disabled) or
   * before it's re-rendered. See PluginSettingsSection.jsx for the host
   * side of this. */
  registerSettingsSection(section) {
    const entry = {
      id: section.id || `settings-${Math.random().toString(36).slice(2)}`,
      ...section,
    };
    this.settingsSections.push(entry);
    this._trackContribution(this._pluginSettingsEntries, entry);
    this.emit("settings:changed", this.settingsSections);
  }

  registerMarkdownPlugin(pluginFn, opts) {
    const entry = { pluginFn, opts };
    this.markdownPlugins.push(entry);
    this.markdownVersion++;
    this._trackContribution(this._pluginMarkdownEntries, entry);
    this.emit("markdown:changed", this.markdownPlugins);
  }

  registerTheme(theme) {
    this.themes[theme.id] = theme;
    this._trackContribution(this._pluginThemeIds, theme.id);
    this.emit("themes:changed", this.themes);
  }

  showNotice(message, opts = {}) {
    this.emit("notice", {
      message,
      type: opts.type || "info",
      duration: opts.duration || 3000,
    });
  }

  /* ---------------- notes convenience wrappers ---------------- */
  async listNotes() {
    const list = await this.bridge.notes.list(this.vaultPath);
    this._notesListCache = list;
    return list;
  }

  async readNote(path) {
    const content = await this.bridge.notes.read(path);
    this._noteContentCache.set(path, content);
    return content;
  }

  /** Full-text search across every note's content (and title) in the vault. */
  async searchNotes(query) {
    return this.bridge.notes.search(this.vaultPath, query);
  }

  /** `opts.programmatic` marks this as a write Delta itself/a plugin made
   * (rather than the user's own autosave-after-typing) - not enforced by
   * anything, just passed straight through onto the note:save event, so
   * a note:save listener that calls writeNote() again (a text-expansion
   * plugin rewriting what it just matched, say) can tell its own
   * resulting save apart from a real user edit and avoid looping on it. */
  async writeNote(path, content, opts = {}) {
    await this.bridge.notes.write(path, content);
    this._noteContentCache.set(path, content);
    this.emit("note:save", {
      path,
      content,
      programmatic: !!opts.programmatic,
    });
  }

  /** `destDir` (optional, absolute path inside the vault) creates the
   * note in that folder instead of the vault root. */
  async createNote(title, destDir) {
    const path = await this.bridge.notes.create(this.vaultPath, title, destDir);
    this._notesListCache = null; // stale until the next listNotes() refresh
    this.emit("note:create", { path });
    return path;
  }

  async deleteNote(path) {
    await this.bridge.notes.delete(path);
    this._noteContentCache.delete(path);
    this._notesListCache = null;
    this.emit("note:delete", { path });
  }

  async renameNote(path, newTitle) {
    const newPath = await this.bridge.notes.rename(path, newTitle);
    // Carry the cached content over to its new key instead of just
    // dropping it, so re-opening the just-renamed note is still instant.
    if (this._noteContentCache.has(path)) {
      this._noteContentCache.set(newPath, this._noteContentCache.get(path));
      this._noteContentCache.delete(path);
    }
    this._notesListCache = null;
    // Lets App.jsx keep any open tab pointed at this note in sync (same
    // tab, new path) instead of it silently pointing at a file that no
    // longer exists.
    this.emit("note:rename", { oldPath: path, newPath });
    return newPath;
  }

  /* ---------------- tabs / navigation ------------------------------
   * App.jsx owns the actual tab list/state; everything else (note
   * cards, wikilinks, the graph view, the command palette...) just
   * asks for navigation through this event bus instead of needing a
   * callback prop threaded all the way down to it. Keeps deeply nested
   * components (a wikilink three components deep in a rendered note
   * preview, say) able to trigger real navigation without every layer
   * in between needing to know or care.
   * ------------------------------------------------------------------ */

  /** @param {{type: 'notes'|'editor'|'graph'|'settings', notePath?: string}} target
   *  @param {{newTab?: boolean}} [opts] */
  openTab(target, opts = {}) {
    this.emit("tabs:open", { target, newTab: !!opts.newTab });
  }

  /** Closes whichever tab is currently active - App.jsx resolves "which
   * one is active" itself, since only it tracks that. */
  closeActiveTab() {
    this.emit("tabs:close-active");
  }

  /** Opens a non-.md vault file - in-app if it's something Delta can
   * render itself (image/video/audio), otherwise via the OS's default
   * app for it. See App.jsx's 'files:open' listener for the split. */
  openFile(file) {
    this.emit("files:open", file);
  }

  /** A generic right-click context menu, positioned at (x, y), showing
   * `items` (each `{ label, onClick }`). Used for "Open in new tab" on
   * note cards, wikilinks, graph nodes - but nothing here is specific
   * to that, any component (or plugin) can show its own menu this way. */
  showContextMenu(x, y, items) {
    this.emit("contextmenu:open", { x, y, items });
  }

  /** An in-app replacement for window.prompt() - Electron's BrowserWindow
   * never implements the browser's native prompt() (unlike alert/confirm,
   * which do show a real OS dialog), so calling it directly just silently
   * returns null with no dialog ever appearing. This shows PromptDialog
   * (mounted once in App.jsx) instead and resolves with the entered text,
   * or null if cancelled/dismissed. */
  prompt(message, defaultValue = "") {
    return new Promise((resolve) => {
      this.emit("prompt:open", { message, defaultValue, resolve });
    });
  }

  /** An in-app replacement for window.confirm() - unlike prompt(), Electron
   * does show a real dialog for confirm(), but it's an unstyled native OS
   * popup that breaks the illusion that Delta is one consistent app. Shows
   * ConfirmDialog (mounted once in App.jsx) instead and resolves true/false. */
  confirm(message, opts = {}) {
    return new Promise((resolve) => {
      this.emit("confirm:open", {
        message,
        danger: !!opts.danger,
        confirmLabel: opts.confirmLabel || "Confirm",
        cancelLabel: opts.cancelLabel || "Cancel",
        resolve,
      });
    });
  }

  /** Finds a note by title (case-insensitive), creating it empty if it
   * doesn't exist yet, then opens it - the same "click a [[wikilink]]"
   * behavior used by the note preview and the graph view, now shared
   * in one place instead of being reimplemented in both. */
  async navigateToNoteTitle(title, opts = {}) {
    if (!title) return;
    const notes = await this.listNotes();
    const match = notes.find(
      (n) => n.title.toLowerCase() === title.toLowerCase(),
    );
    const path = match ? match.path : await this.createNote(title);
    this.openTab({ type: "editor", notePath: path }, opts);
  }

  /* ---------------- vault files (anything that isn't a .md note) --- */
  async listFiles() {
    const list = await this.bridge.files.list(this.vaultPath);
    this._filesListCache = list;
    return list;
  }

  /** A short, capped text preview of a file's contents - used for txt/
   * html/csv/etc. file cards on the Notes screen. Never reads the whole
   * file, so a huge log dropped into the vault can't stall the grid. */
  async readFileSnippet(path, maxChars = 600) {
    return this.bridge.files.readTextSnippet(path, maxChars);
  }

  /** The *entire* text content of a non-.md vault file (txt/html/csv/
   * ...), or null if it can't be read - unlike readFileSnippet above,
   * which is capped and only meant for grid-card previews. Used by
   * FileViewer, which lets these files be edited in place. */
  async readFileText(path) {
    return this.bridge.files.readText(path);
  }

  /** Saves edited text back to a non-.md vault file - the write half of
   * readFileText(). Emits file:save so anything showing this file
   * (another tab, a plugin) can react, mirroring note:save for notes. */
  async writeFileText(path, content) {
    const ok = await this.bridge.files.writeText(path, content);
    if (ok) this.emit("file:save", { path, content });
    return ok;
  }

  /** Writes raw bytes (base64 string) as a new file inside destDir,
   * renaming on collision - returns the new absolute path, or null.
   * This is how a clipboard-pasted image (which exists only in memory,
   * so importFile() has no source path to copy) lands in the vault. */
  async writeBinaryFile(destDir, fileName, base64) {
    const newPath = await this.bridge.files.writeBinary(destDir, fileName, base64);
    if (newPath) {
      this._filesListCache = null; // stale until the next listFiles() refresh
      this.emit("file:import", { path: newPath });
    }
    return newPath;
  }

  /** Plain-text body of a legacy binary .doc file (main-process
   * word-extractor), or null if it can't be parsed. .docx doesn't come
   * through here - FileViewer renders those with mammoth directly. */
  async readDocText(path) {
    return this.bridge.files.readDocText(path);
  }

  /** Every file inside the vault's Delta/ config folder - settings.json,
   * session.json, caches, plugin sources. The normal listFiles() skips
   * this folder entirely; Settings uses this to expose them. */
  async listDeltaFiles() {
    return this.bridge.vault.listDeltaFiles(this.vaultPath);
  }

  /** Opens the Delta/ config folder in the OS file manager. */
  async openDeltaFolder() {
    return this.bridge.vault.openDeltaFolder(this.vaultPath);
  }

  /** Recovers the real on-disk path for a File dropped from the OS -
   * must be called with the exact File instance from the drop event. */
  getDroppedFilePath(file) {
    return this.bridge.files.getDroppedPath(file);
  }

  /** Copies a file (from an OS drag-and-drop, given its real path) into
   * destDir - an absolute folder path inside the vault, e.g. the vault
   * root or the folder a particular note lives in - renaming on
   * collision. Returns the new absolute path, or null on failure. */
  async importFile(sourcePath, destDir) {
    const newPath = await this.bridge.files.import(sourcePath, destDir);
    this._filesListCache = null; // stale until the next listFiles() refresh
    this.emit("file:import", { path: newPath });
    return newPath;
  }

  /** Renames a non-.md vault file in place - newName is the whole
   * filename (extension included), since a generic file's extension
   * isn't implied the way ".md" is for a note. Returns the new path, or
   * null if the rename failed. */
  async renameFile(path, newName) {
    const newPath = await this.bridge.files.rename(path, newName);
    if (newPath) {
      this._filesListCache = null;
      this.emit("file:rename", { oldPath: path, newPath });
    }
    return newPath;
  }

  async deleteFile(path) {
    const ok = await this.bridge.files.delete(path);
    if (ok) {
      this._filesListCache = null;
      this.emit("file:delete", { path });
    }
    return ok;
  }

  /* ---------------- folders ----------------------------------------
   * Real subfolders inside the vault. Moving/renaming here also fixes
   * up every path-based reference (markdown links/images, html src=)
   * across the vault on the main-process side - which can rewrite any
   * number of notes on disk, so the note-content cache is dropped
   * wholesale after each of these instead of guessing what changed.
   * ------------------------------------------------------------------ */

  /** Every subfolder in the vault: { path, relativePath, name, mtime }. */
  async listFolders() {
    return this.bridge.folders.list(this.vaultPath);
  }

  async createFolder(parentDir, name) {
    const newPath = await this.bridge.folders.create(parentDir || this.vaultPath, name);
    if (newPath) this.emit("folder:create", { path: newPath });
    return newPath;
  }

  /** Moves a note or file into another vault folder (collision-safe on
   * the main side). Emits note:rename/file:rename with the old and new
   * paths - the same events a plain rename fires - so open tabs, the
   * grid and plugins all follow the move for free. */
  async moveFile(sourcePath, destDir) {
    const newPath = await this.bridge.files.move(this.vaultPath, sourcePath, destDir);
    if (!newPath || newPath === sourcePath) return newPath;
    this._notesListCache = null;
    this._filesListCache = null;
    this._noteContentCache.clear(); // reference fix-up may have rewritten any note
    if (/\.md$/i.test(sourcePath)) {
      this.emit("note:rename", { oldPath: sourcePath, newPath });
    } else {
      this.emit("file:rename", { oldPath: sourcePath, newPath });
    }
    return newPath;
  }

  /** Renames a folder in place - everything inside moves with it, and
   * references across the vault are fixed up. Emits folder:rename so
   * App.jsx can remap open tabs/pins that pointed inside it. */
  async renameFolder(folderPath, newName) {
    const newPath = await this.bridge.folders.rename(this.vaultPath, folderPath, newName);
    if (newPath && newPath !== folderPath) {
      this._notesListCache = null;
      this._filesListCache = null;
      this._noteContentCache.clear();
      this.emit("folder:rename", { oldPath: folderPath, newPath });
    }
    return newPath;
  }

  /** Deletes a folder and everything inside it. Callers confirm first. */
  async deleteFolder(folderPath) {
    const ok = await this.bridge.folders.delete(folderPath);
    if (ok) {
      this._notesListCache = null;
      this._filesListCache = null;
      this._noteContentCache.clear();
      this.emit("folder:delete", { path: folderPath });
    }
    return ok;
  }

  /* ---------------- network ----------------------------------------
   * fetch() that actually works from plugins. The renderer's own
   * window.fetch is blocked by the app's CSP for external URLs, and
   * even without that it's subject to CORS. This one is forwarded over
   * IPC to the main process (Electron's net.fetch), where neither
   * applies - any http(s) URL works.
   * ------------------------------------------------------------------ */

  /** `opts`: `{ method?, headers?, body?, binary?, timeout? }`.
   * - `body` may be a string, or a plain object/array - the latter is
   *   JSON.stringify'd automatically (with Content-Type: application/json
   *   added, unless you set your own).
   * - `binary: true` skips text decoding - use `arrayBuffer()` on the result.
   * - `timeout` is in ms (default 30000); the promise rejects on timeout,
   *   network failure, or a non-http(s) URL. Note: unlike browser fetch, it
   *   does NOT reject on HTTP error statuses - check `ok`/`status` yourself.
   *
   * Returns a response-like object: `{ ok, status, statusText, url,
   * headers, text(), json(), arrayBuffer() }`. The body already arrived
   * by the time you have this object - text()/json()/arrayBuffer() are
   * just async accessors kept fetch-shaped so code reads familiarly. */
  async fetch(url, opts = {}) {
    const sendOpts = { ...opts };
    if (
      sendOpts.body != null &&
      typeof sendOpts.body !== "string" &&
      typeof sendOpts.body === "object"
    ) {
      sendOpts.body = JSON.stringify(sendOpts.body);
      const headers = { ...(sendOpts.headers || {}) };
      const hasContentType = Object.keys(headers).some(
        (k) => k.toLowerCase() === "content-type",
      );
      if (!hasContentType) headers["Content-Type"] = "application/json";
      sendOpts.headers = headers;
    }

    const raw = await this.bridge.net.fetch(url, sendOpts);
    return {
      ok: raw.ok,
      status: raw.status,
      statusText: raw.statusText,
      url: raw.url,
      headers: raw.headers,
      text: async () => raw.body ?? "",
      json: async () => JSON.parse(raw.body ?? "null"),
      arrayBuffer: async () => {
        if (raw.bodyBase64 == null) {
          throw new Error(
            "Delta.fetch: pass { binary: true } to get an arrayBuffer",
          );
        }
        const bin = atob(raw.bodyBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
      },
    };
  }

  getVaultPath() {
    return this.vaultPath;
  }

  getCurrentNote() {
    return this._currentNote || null;
  }

  _setCurrentNote(note) {
    this._currentNote = note;
    this.emit("note:open", note);
  }

  /* ---------------- editor: cursor/selection -------------------------
   * Registered by NoteEditor.jsx on mount - `handle` is
   * `{ getValue, getSelection, setSelection, insertText, focus }`, all
   * reading/writing through refs internally so they never go stale even
   * though this same `handle` object sticks around for the note editor's
   * whole lifetime. Without this, a plugin's only option for adding text
   * is "write the whole note, appending to the end" (writeNote()) -
   * fine for a log, useless for anything meant to land where the user's
   * caret actually is (a table, a snippet, an autocomplete-style insert).
   * ------------------------------------------------------------------ */
  _registerActiveEditor(handle) {
    this._activeEditor = handle;
    return () => {
      if (this._activeEditor === handle) this._activeEditor = null;
    };
  }

  /** Every raw markdown character currently in the open note's editor -
   * including keystrokes not yet autosaved to disk - or null if no note
   * is open right now. */
  getEditorValue() {
    return this._activeEditor ? this._activeEditor.getValue() : null;
  }

  /** `{ start, end, text }` (`text` is `''` when nothing's selected), or
   * null if no note is open. Offsets are plain character indices into
   * getEditorValue(), same units getCursorPosition()/insertAtCursor() use. */
  getSelection() {
    return this._activeEditor ? this._activeEditor.getSelection() : null;
  }

  /** Selects the given character range without changing any content -
   * pass the same value twice to just move the caret there. */
  setSelection(start, end) {
    this._activeEditor?.setSelection(start, end);
  }

  /** The caret's position as a plain character offset, or null if no
   * note is open. When a range is selected this is the *start* of it -
   * check getSelection() if you need the full range. */
  getCursorPosition() {
    return this._activeEditor?.getSelection()?.start ?? null;
  }

  /** Moves the caret to a character offset, collapsing any selection. */
  setCursorPosition(pos) {
    this._activeEditor?.setSelection(pos, pos);
  }

  /** Inserts `text` right where the caret is, replacing the current
   * selection if there is one (same as typing while text is selected) -
   * the caret ends up right after what was inserted. This is the actual
   * "put a table/snippet/whatever where the user's cursor is" primitive
   * plugins were missing; writeNote() alone can only replace the whole
   * note. No-op (returns null) if no note is open. */
  insertAtCursor(text) {
    return this._activeEditor ? this._activeEditor.insertText(text) : null;
  }

  /** Alias for insertAtCursor() - same operation, kept under the name
   * some plugin authors will look for first when the goal is specifically
   * "replace whatever's selected" rather than "insert at the caret". */
  replaceSelection(text) {
    return this._activeEditor ? this._activeEditor.insertText(text) : null;
  }

  /** Gives the open note's textarea keyboard focus. */
  focusEditor() {
    this._activeEditor?.focus();
  }
}

const Delta = new DeltaAPI();
if (typeof window !== "undefined") {
  window.Delta = Delta;
}

export default Delta;
