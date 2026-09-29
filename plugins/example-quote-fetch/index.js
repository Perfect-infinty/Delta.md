/**
 * Delta example plugin: Quote Fetch
 * -----------------------------------------------------------------
 * Demonstrates Delta.fetch() - HTTP requests from a plugin.
 *
 * Plain window.fetch() does NOT work for external URLs in Delta (the
 * app's CSP blocks it, and CORS would apply even if it didn't).
 * Delta.fetch(url, opts) instead forwards the request over IPC to the
 * Electron main process, where neither restriction exists - any
 * http(s) URL works, CORS headers or not.
 *
 * The result is a response-like object: { ok, status, statusText,
 * url, headers, text(), json(), arrayBuffer() }. Unlike browser
 * fetch, an HTTP error status does NOT reject - check `ok` yourself.
 * The promise rejects only on network failure / timeout / bad URL.
 */

Delta.registerPlugin({
  id: 'example-quote-fetch',
  name: 'Quote Fetch',

  onLoad(api) {
    api.registerNoteToolbarButton({
      id: 'quote-fetch-button',
      icon: 'bolt',
      label: 'Insert random quote',
      async onClick() {
        api.showNotice('Fetching a quote…')
        try {
          // Any public API works here - CORS-less endpoints included.
          const res = await api.fetch('https://zenquotes.io/api/random', {
            timeout: 10000
          })
          if (!res.ok) {
            api.showNotice(`Quote API returned HTTP ${res.status}`, { type: 'error' })
            return
          }
          const data = await res.json() // [{ q: "...", a: "author" }]
          const { q, a } = data[0]
          // Insert right at the caret; falls back to a notice if no note is open.
          const inserted = api.insertAtCursor(`> ${q}\n> — ${a}\n`)
          if (inserted === null) {
            api.showNotice(`"${q}" — ${a}`, { duration: 6000 })
          }
        } catch (err) {
          // Network down, timeout, or invalid URL land here.
          api.showNotice(`Fetch failed: ${err.message}`, { type: 'error' })
        }
      }
    })
  }
})
