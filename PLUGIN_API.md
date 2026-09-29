# Delta plugin API

Delta has no separate, restricted plugin system - a plugin gets the exact same `Delta` object
the app itself is built on. There's no sandbox, no permission model, and no npm/bundler step.
That's deliberate: the whole point of Delta is that anyone can open `<vault>/Delta/plugins/`,
drop in a folder, and start hacking.

## Where plugins live, and how they load

A plugin is a folder at `<vault>/Delta/plugins/<plugin-id>/` containing:

- **`manifest.json`** - `{ id, name, version, description, main }`. Only `main` (defaults to
  `"index.js"`) and `id` (falls back to the folder name if omitted) actually matter to the app;
  `name`/`description`/`version` just control what shows up in Settings > Plugins.
- **`index.js`** (or whatever `main` points to) - plain JavaScript. No `import`/`require`, no
  npm packages. It's executed with `new Function('Delta', 'manifest', code)`, so `Delta` (the
  global API singleton) and `manifest` (your own parsed manifest.json) are just in scope, nothing
  to wire up yourself.

Click the refresh icon next to "Open plugins folder" in Settings after adding a new plugin
folder - it re-scans without needing a full app restart, *and* re-runs every currently-enabled
plugin's `index.js` straight from disk, so editing an existing plugin's code and hitting refresh
applies the change immediately too (not just newly-added folders). Toggling a plugin on/off in
the checklist there applies immediately, in the current session, no reopen needed.

## Plugin shape

```js
Delta.registerPlugin({
  id: 'my-plugin',
  name: 'My Plugin',
  settings: { greeting: 'Hello' }, // whatever state you want - just a plain object
  onLoad(api) {
    // `api` is the same object as the global `Delta` - it's passed as an
    // argument so plugin code reads naturally, but `Delta.xyz(...)` and
    // `api.xyz(...)` are identical.
    api.registerNoteToolbarButton({
      icon: 'bolt',
      label: 'Say hi',
      onClick(note) {
        api.showNotice(`${this.settings.greeting}, ${note.title}!`)
      }
    })
  }
})
```

Important binding detail: inside `onLoad(api) { ... }`, `this` refers to the object you passed
to `registerPlugin()` - so `this.settings`/`this.state` (or whatever fields you put on it) are
yours to read and mutate for as long as the plugin is loaded, and any arrow functions you define
inside `onLoad` (toolbar `onClick`, `setInterval` callbacks, etc.) keep that same `this`
automatically, since arrow functions close over it lexically. You don't need to pass `api`
around separately from an arrow function defined inside `onLoad` - it's already in scope.

**Disabling a plugin undoes what it *registered*, automatically.** Toggling a plugin off in
Settings (or reloading it, or Delta re-registering the same `id` for any other reason) calls an
internal `unloadPlugin()` that reverses `registerNoteToolbarButton`, `registerSettingsSection`,
`registerMarkdownPlugin`, `registerTheme`, and any `api.on(event, cb)` subscriptions made during
`onLoad`, all automatically - none of that needs its own cleanup code.

For anything else (most commonly a `setInterval`/`setTimeout`), add an **`onUnload()`** method
next to `onLoad` on the object passed to `registerPlugin()`:

```js
Delta.registerPlugin({
  id: 'my-plugin',
  onLoad(api) {
    this._timerId = setInterval(() => { /* ... */ }, 1000)
  },
  onUnload() {
    // Called right before this plugin is torn down (disable, reload, or
    // any other re-registration under the same id) - same `this` as
    // onLoad (the object you passed to registerPlugin), so
    // whatever you stashed on `this` during onLoad is right here.
    clearInterval(this._timerId)
  }
})
```

`onUnload` is optional - if you don't define one, nothing extra happens, same as before.

## The `api` object

### Notes

- `listNotes()` -> `Promise<{path, title}[]>` - every `.md` file in the vault. `path` is always a
  full absolute filesystem path, never a bare filename.
- `readNote(path)` -> `Promise<string>` - the raw markdown. **Returns the string directly**, not
  `{ content }`.
- `writeNote(path, content, opts?)` -> `Promise<void>`. Pass `{ programmatic: true }` if you want
  a `note:save` listener (yours or anyone else's) to be able to tell your write apart from the
  user's own typing.
- `createNote(title)` -> `Promise<string>` (the new absolute path). Takes a **title only** -
  it appends `.md` itself, so passing `"Log.md"` creates a file literally named `Log.md.md`.
  Always use the path it returns for a follow-up `writeNote()`/`readNote()` call, rather than
  reconstructing your own path string.
- `deleteNote(path)`, `renameNote(path, newTitle)` -> `Promise<newPath>`.
- `searchNotes(query)` -> full-text search across every note's title and content.
- `navigateToNoteTitle(title, opts?)` - finds a note by title (creating it empty if missing) and
  opens it, same as clicking a `[[wikilink]]`.
- `getCurrentNote()` -> `{ path, content, title } | null`, synchronous. Note that this is only
  refreshed when a note is opened, written externally, or after the ~400ms autosave debounce -
  it can lag slightly behind whatever the user has typed in the last moment. A toolbar button's
  `onClick(note)` already receives the live note as its first argument (see below); prefer that
  over calling `getCurrentNote()` again inside a handler that needs the freshest content.

### Cursor / selection (the currently-open note editor)

All no-ops (return `null` or do nothing) when no note is open:

- `getEditorValue()` -> every character currently in the editor, including unsaved keystrokes.
- `getSelection()` -> `{ start, end, text }` (character offsets; `text` is `''` if nothing's selected).
- `setSelection(start, end)` / `getCursorPosition()` / `setCursorPosition(pos)`.
- `insertAtCursor(text)` / `replaceSelection(text)` - insert at the caret, replacing the current
  selection if there is one. This is the right tool for "drop a snippet/table where the user is
  typing" - `writeNote()` alone can only replace the whole file.
- `focusEditor()`.

### Toolbar buttons

```js
api.registerNoteToolbarButton({
  id: 'my-button',       // optional, auto-generated if omitted
  icon: 'timer',         // see icon list below - unmatched names fall back to a generic icon
  label: 'Start Focus',  // used as the button's tooltip
  onClick(note) {        // `note` is the currently-open note, passed in directly
    // ...
  }
})
```

Returns an unsubscribe function, though you normally don't need to call it - disabling the
plugin does this for you.

Icon names are matched case-insensitively against a fixed set (so `"Timer"`, `"timer"`, and
`"TIMER"` all work the same): `calculate`, `bolt`, `star`, `extension`, `timer`, `stop`,
`playarrow`/`play`, `pause`, `refresh`, `add`, `close`, `check`, `delete`, `edit`, `search`,
`save`, `contentcopy`/`copy`, `link`, `image`, `tablechart`/`table`, `code`, `calendartoday`/
`calendar`, `notifications`, `settings`, `info`, `warning`, `help`, `visibility`, `lock`,
`person`, `label`, `flag`, `bookmark`, `history`, `sync`, `attachfile`/`attach`,
`formatlistbulleted`/`list`, `terminal`, `folder`, `share`, `hourglassempty`/`hourglass`,
`alarm`, `event`. Anything outside this list renders a generic puzzle-piece icon instead of
nothing - it won't silently vanish, it just won't look like what you asked for.

### Settings UI

Adds a section to the bottom of Settings. Either shape works, and both can be combined:

```js
api.registerSettingsSection({
  id: 'my-plugin-settings',
  title: 'My Plugin',
  fields: [
    { key: 'greeting', label: 'Greeting', type: 'text', default: 'Hello',
      onChange: (val) => { this.settings.greeting = val } }
  ]
})
```

`fields[].type` is `'text' | 'number' | 'boolean' | 'select'` (`select` also takes an `options`
array of strings or `{value, label}` objects). For anything more custom than a flat list of
labelled inputs, supply `render(container, api)` instead of (or alongside) `fields` - it's
called once with an empty `<div>` to build into directly with plain DOM calls, since there's no
JSX/bundler on the plugin side. `render` may return a cleanup function.

### Markdown rendering

`registerMarkdownPlugin(pluginFn, opts)` - `pluginFn` is a standard markdown-it plugin function
(`(md, opts) => { ... }`), applied via `md.use(pluginFn, opts)`. Every open note preview picks up
the change live as soon as you register it.

### Themes

`registerTheme({ id, name, css })` - `css` is just the CSS custom-property declarations
(`--bg`, `--text`, `--accent`, etc.) - Delta wraps it in `[data-theme="id"] { ... }` itself, so
don't include that selector yourself. Shows up in Settings > Theme immediately.

### Dialogs - never use `window.prompt`/`window.confirm`

Electron's `BrowserWindow` never implements `window.prompt()` - it silently returns `null` with
no dialog ever appearing, every time, regardless of what the user would have typed. Use these
instead, both styled to match the rest of the app:

- `prompt(message, defaultValue?)` -> `Promise<string | null>` (`null` if cancelled/dismissed).
- `confirm(message, { danger?, confirmLabel?, cancelLabel? })` -> `Promise<boolean>`.
- `showNotice(message, { type?: 'info'|'error', duration? })` - a toast, not a blocking dialog.
- `showContextMenu(x, y, [{ label, onClick }])` - a right-click-style menu at an arbitrary point.

### Network - use `api.fetch()`, never `window.fetch()`

Plain `window.fetch()`/XHR to an external URL **silently fails in Delta**: the app's CSP has no
`connect-src`, so external requests are blocked, and CORS would apply even without that.
`api.fetch(url, opts?)` forwards the request over IPC to the main process instead, where neither
restriction exists - any http(s) URL works, CORS headers or not.

```js
const res = await api.fetch('https://api.example.com/things', {
  method: 'POST',                 // default 'GET'
  headers: { Authorization: 'Bearer …' },
  body: { name: 'thing' },        // a plain object/array is JSON.stringify'd
                                  // automatically (+ Content-Type: application/json
                                  // unless you set your own); strings pass through as-is
  timeout: 10000                  // ms, default 30000
})
if (!res.ok) { /* HTTP 4xx/5xx does NOT reject - check ok/status yourself */ }
const data = await res.json()     // or res.text()
```

Returns a response-like object: `{ ok, status, statusText, url, headers, text(), json(),
arrayBuffer() }`. The whole body has already arrived by the time the promise resolves -
`text()`/`json()` are async only to stay fetch-shaped. For binary data (an image, say), pass
`{ binary: true }` and read `await res.arrayBuffer()` - without that flag `arrayBuffer()` throws.
The promise rejects only on network failure, timeout, or a non-http(s) URL (`file://` etc. are
refused).

### Tabs / navigation

- `openTab({ type: 'notes'|'editor'|'graph'|'settings', notePath? }, { newTab? })`.
- `closeActiveTab()` - closes the current tab, falling back to whichever tab now sits next to it
  (or a fresh Notes tab if that was the last one open).
- `openFile(file)` - opens a non-`.md` vault file, in-app if Delta can render it (image/video/
  audio), otherwise via the OS's default app for it.

### Vault files (anything that isn't a `.md` note)

`listFiles()`, `readFileSnippet(path, maxChars?)`, `getDroppedFilePath(file)` (only valid on a
real drag-and-drop `File` from the OS), `importFile(sourcePath, destDir)`, `renameFile(path,
newName)`, `deleteFile(path)`.

### Event bus

`on(event, cb)` -> unsubscribe function, `off(event, cb)`, `emit(event, payload)`. Listeners can
be async; a rejected promise from one is caught and logged rather than crashing anything else
listening on the same event.

`emit()` only calls whatever's *already listening* for that event name - it has no other effect.
Every event below already has a real listener somewhere in the app (so a plugin *listening* to
one is always meaningful); that does **not** mean a plugin should *emit* one itself instead of
calling the matching method - for the "UI plumbing" ones especially, the dedicated method exists
because it does the actual work (opening a dialog, switching a tab, etc.), and `emit()`-ing the
event yourself skips that and just replays the event with no dialog/navigation behind it.

**Data events** - safe and useful to listen to, and there's rarely a reason to emit these
yourself (writeNote()/createNote()/etc. already do it for you):

| Event | Payload |
|---|---|
| `note:save` | `{ path, content, programmatic }` |
| `note:create` | `{ path }` |
| `note:delete` | `{ path }` |
| `note:rename` | `{ oldPath, newPath }` |
| `file:import` | `{ path }` |
| `file:rename` | `{ oldPath, newPath }` |
| `file:delete` | `{ path }` |
| `themes:changed` | the full `{ id: theme }` map |
| `themes:removed` | array of removed theme ids |
| `toolbar:changed` | the full toolbar button array |
| `markdown:changed` | the full markdown-it plugin array |
| `settings:changed` | the full settings-section array |
| `notice` | `{ message, type, duration }` |

**UI plumbing events** - each one is only emitted by, and only makes sense through, its matching
method. Call the method; don't emit the event directly (see mistake #8 above for what happens if
you do - it's a silent no-op unless it's one of these exact names with a real listener behind it,
and emitting your own arbitrary payload for one of these can also confuse the real listener):

| Event | Emitted by | Payload |
|---|---|---|
| `tabs:open` | `openTab(target, opts)` | `{ target, newTab }` |
| `tabs:close-active` | `closeActiveTab()` | none |
| `files:open` | `openFile(file)` | the file object |
| `contextmenu:open` | `showContextMenu(x, y, items)` | `{ x, y, items }` |
| `prompt:open` | `prompt(message, defaultValue)` | `{ message, defaultValue, resolve }` |
| `confirm:open` | `confirm(message, opts)` | `{ message, danger, confirmLabel, cancelLabel, resolve }` |

**`note:open`** is the one exception worth calling out on its own: `_setCurrentNote` (internal,
see mistake #7) emits it whenever the active note changes, but nothing in the app currently
listens for it. It's there for future use (or for a plugin that wants to react to "the user
switched notes") - it isn't a way to *trigger* a note switch. To open a note, always use
`openTab({ type: 'editor', notePath })`.

## Full method & property reference

Every method above, plus the handful of read-only escape hatches that don't fit neatly into a
category - this list is exhaustive as of this app version.

**Notes**: `listNotes()`, `readNote(path)`, `searchNotes(query)`, `writeNote(path, content, opts?)`,
`createNote(title)`, `deleteNote(path)`, `renameNote(path, newTitle)`, `getCurrentNote()`,
`navigateToNoteTitle(title, opts?)`.

**Cursor/editor**: `getEditorValue()`, `getSelection()`, `setSelection(start, end)`,
`getCursorPosition()`, `setCursorPosition(pos)`, `insertAtCursor(text)`, `replaceSelection(text)`,
`focusEditor()`.

**Files (non-`.md`)**: `listFiles()`, `readFileSnippet(path, maxChars?)`,
`getDroppedFilePath(file)`, `importFile(sourcePath, destDir)`, `renameFile(path, newName)`,
`deleteFile(path)`.

**Registration**: `registerPlugin(def)`, `registerNoteToolbarButton(button)`,
`registerSettingsSection(section)`, `registerMarkdownPlugin(pluginFn, opts)`,
`registerTheme(theme)`. `unloadPlugin(pluginId)` also exists and works if called directly (it's
what Settings calls when you toggle a plugin off) - a plugin *could* call
`unloadPlugin('some-other-id')`, but there's no corresponding safeguard stopping one plugin from
tearing down another's registrations this way, so treat it as "exists, rarely appropriate to use
yourself."

**UI**: `showNotice(message, opts?)`, `prompt(message, defaultValue?)`, `confirm(message, opts?)`,
`showContextMenu(x, y, items)`, `openTab(target, opts?)`, `closeActiveTab()`, `openFile(file)`.

**Network**: `fetch(url, opts?)` - see above; the only way to make an HTTP request from a plugin.

**Vault/session state**: `getVaultPath()` (same as reading the `vaultPath` property directly),
`getCachedNotesList()`, `getCachedNoteContent(path)`, `getCachedFilesList()` - last-known values
from this session's in-memory cache, returned instantly (possibly `null`/stale) without an IPC
round-trip; useful for painting something immediately while a real `listNotes()`/`readNote()`
call confirms it in the background, not a substitute for calling those when you need to be sure.

**Public properties, not just methods** - these are plain fields on `Delta`, readable (and, if
you're deliberate about it, writable) directly, not wrapped behind a getter: `Delta.vaultPath`,
`Delta.plugins` (a `Map` of every currently-loaded plugin's `id` -> the exact object it passed to
`registerPlugin()` - the closest thing to a `getPlugin(id)` API right now: `Delta.plugins.get('other-plugin-id')`
reaches into another plugin's own `settings`/`state`/methods directly, if you know its shape),
`Delta.toolbarButtons`, `Delta.themes`, `Delta.markdownPlugins`, `Delta.settingsSections` (the
live arrays/maps everything above pushes into - reading them is fine; mutating them directly
instead of going through the matching `register*()` call skips the bookkeeping that lets
`unloadPlugin()` clean up after you later).

**Event bus**: `on(event, cb)`, `off(event, cb)`, `emit(event, payload)` - see above.

## What plugins can and can't do

**Can:** everything above - read/write/create/delete/rename notes and non-`.md` files, add
toolbar buttons and settings UI, extend the markdown renderer, add themes, show notices/prompts/
confirms/context menus, navigate tabs, read and write at the exact cursor position in whichever
note is open, make HTTP requests to any URL via `api.fetch()`, and listen to (or, going through the right method, cause) every state change the
app itself reacts to. There's genuinely no restricted subset - a plugin can also reach past
`Delta` entirely into `window.deltaBridge` (the raw IPC bridge the whole renderer shares) or touch
the DOM/React tree directly, since plugin code runs in the same unsandboxed page as the rest of
the app (`contextIsolation` is on and there's no direct Node/`require`/`fs` access, but nothing
inside the renderer itself is walled off from plugin code).

**Can't:**

- **Reach the filesystem, OS, or Node directly.** `nodeIntegration` is off - there's no `require`,
  `fs`, or `process` available to plugin code, only whatever `window.deltaBridge` exposes (which
  is exactly the same fixed set of IPC calls `Delta`'s own methods wrap - going around `Delta` to
  call `window.deltaBridge` directly doesn't unlock anything new, it just skips the caching/event
  emission `Delta`'s wrappers do for you).
- **Persist their own settings automatically.** `registerSettingsSection`'s `fields` UI calls your
  `onChange(value)` - what you do with that value (e.g. `this.settings.x = value`) is up to you,
  and it only lives in memory for the plugin object's lifetime. There is no
  `api.saveSetting()`/`api.loadSetting()` - restarting the app or toggling the plugin off and back
  on resets every field back to its `default`. If you need real persistence, the only vault-native
  option is writing values into a note yourself (`writeNote`/`readNote` against a dedicated file)
  and parsing them back out on `onLoad`.
- **Register a genuinely new tab/screen type.** Tabs are one of a fixed set
  (`notes`/`editor`/`graph`/`settings`/`file`) enforced in App.jsx - a plugin can open existing
  tab types and add UI *within* the note editor/settings screen, but can't introduce a whole new
  top-level screen of its own.
- **Intercept or cancel a core action.** Every event in the tables above is purely observational -
  there's no `preventDefault()`-style mechanism, so a plugin can react to a note being deleted,
  but can't stop the delete from happening.
- **Reliably clean up after itself beyond the four `register*` calls.** Disabling a plugin only
  reverses toolbar buttons, settings sections, markdown plugins, and themes automatically (see
  mistake #6/#7) - anything else (timers, other listeners you added and didn't unsubscribe) is on
  you.
- **Assume uniqueness of ids.** Two plugins registering a theme or settings section with the same
  `id` silently collide (last one registered wins in `Delta.themes`, for example) - there's no
  validation preventing or warning about this.

## Common mistakes (all seen in real plugins during development)

1. **Using `window.prompt`/`window.confirm` directly.** They don't work the way you'd expect in
   Electron (see above) - use `api.prompt()`/`api.confirm()`.
2. **Passing a filename (with `.md` or slashes) to `createNote()`.** It takes a bare title and
   appends `.md` itself - `createNote("Log.md")` creates `Log.md.md`.
3. **Discarding the path `createNote()` returns**, and writing to a hand-built string instead.
   Only the path `createNote()`/`listNotes()` actually gives you is guaranteed to point at the
   real file.
4. **Comparing a note's path against a bare filename.** `note.path` from `listNotes()` is always
   a full absolute path - match by `note.title` instead if you only have a name to go on.
5. **Treating `readNote()`'s return value as `{ content }`.** It's the raw string itself.
6. **Not clearing your own timers via `onUnload()`.** Disabling/reloading a plugin doesn't know
   about a `setInterval` it started outside of the four `register*` calls - define `onUnload()`
   (see above) to clear it, otherwise it keeps running after the plugin's supposedly off.
7. **Gating a `register*()` call behind a settings value, instead of checking that value live
   inside the thing you registered.** `if (this.settings.showThing) { api.registerX(...) }` only
   ever reflects `showThing`'s value at the moment `onLoad` ran - flipping a settings toggle
   afterward doesn't re-run `onLoad`, so the registration (or lack of one) is frozen from then on.
   Register unconditionally, and check the live setting value *inside* the callback/render
   function every time it actually runs instead - that way toggling the setting takes effect
   immediately (or as soon as whatever triggers a fresh render/click happens), not "never,
   because it was already decided once at load time."
8. **Calling anything prefixed with `_` (`Delta._setCurrentNote`, `Delta._activeEditor`, etc.).**
   The underscore means "internal, used by the app's own screens to keep themselves in sync" -
   not part of the plugin surface, and calling one directly usually doesn't do what it looks
   like it does. `_setCurrentNote`, specifically, only updates the in-memory snapshot
   `getCurrentNote()` returns - it never writes to disk and never updates the actual open
   editor. To really change a note's content from a plugin, call `writeNote(path, newContent)`
   (replaces the whole note, and the open editor picks it up live via `note:save`) or
   `insertAtCursor(text)`/`replaceSelection(text)` (lands right at the user's caret instead).
9. **`emit()`-ing an event to try to trigger navigation, instead of calling the method meant for
   it.** `emit(event, payload)` only calls whatever's already listening for `event` - it doesn't
   make anything happen on its own, and nothing in the app listens for `note:open` (it's fired
   *by* `_setCurrentNote`, purely informational). Emitting it yourself is a silent no-op: no
   error, nothing navigates, and code after it (like a following `showNotice`) still runs, which
   makes it look like it worked when it didn't. To actually open a note, call
   `openTab({ type: 'editor', notePath: path })` - that's what emits the `tabs:open` event
   App.jsx really listens for.

10. **Calling `window.fetch()` for an external URL.** Blocked by the app's CSP (and subject to
    CORS besides) - it rejects without any dialog or visible error unless you're watching the
    devtools console. Use `api.fetch()` (see the Network section above), which runs the request
    in the main process and works for any http(s) URL.

## Example plugins

Two working examples ship in `plugins/` and are copied into every vault automatically (toggle
them on/off from Settings > Plugins):

- **`example-word-count`** - a toolbar button that reports the open note's word/character count.
  The smallest possible complete plugin - a good starting template.
- **`example-forest-theme`** - registers a new color theme via `Delta.registerTheme()`.
- **`example-quote-fetch`** - a toolbar button that fetches a random quote from the internet via
  `Delta.fetch()` and inserts it at the cursor - the template for anything that talks to an
  external API.
