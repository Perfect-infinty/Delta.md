/**
 * Delta example plugin: Word Count
 * -----------------------------------------------------------------
 * This file is loaded and executed as-is, with the full `Delta` API
 * object passed in. No bundler, no npm install, no build step. Copy
 * this folder into <vault>/Delta/plugins/ (or drop a new folder
 * next to it) with your own manifest.json + index.js to write your
 * own plugin, then enable it from Settings > Plugins.
 *
 * Available on `Delta`, among other things:
 *  - Delta.listNotes() / readNote(path) / writeNote(path, content)
 *  - Delta.createNote(title) / deleteNote(path)
 *  - Delta.getCurrentNote() -> { path, content, title }
 *  - Delta.registerNoteToolbarButton({ icon, label, onClick })
 *  - Delta.registerSettingsSection(section)
 *  - Delta.registerMarkdownPlugin(markdownItPluginFn, opts)
 *  - Delta.registerTheme({ id, name, css })
 *  - Delta.showNotice(message)
 *  - Delta.on(event, cb) / Delta.emit(event, payload)
 */

Delta.registerPlugin({
  id: 'example-word-count',
  name: 'Word Count',

  onLoad(api) {
    api.registerNoteToolbarButton({
      id: 'word-count-button',
      icon: 'Calculate',
      label: 'Word count',
      onClick(note) {
        const text = (note?.content || '').trim()
        const words = text.length ? text.split(/\s+/).length : 0
        const chars = text.length
        api.showNotice(`${words} words, ${chars} characters`)
      }
    })
  }
})
