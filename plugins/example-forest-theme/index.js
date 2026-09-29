/**
 * Delta example plugin: Forest Theme
 * -----------------------------------------------------------------
 * Shows off `Delta.registerTheme()`: registering a theme just injects
 * a small stylesheet scoped to `[data-theme="<id>"]` and adds an
 * entry to Settings > Theme - the same mechanism Delta's own built-in
 * Material, Nord, Violet Dark and Violet Light themes use.
 *
 * Copy this folder to make your own theme: change the id/name, and
 * set whichever of these CSS custom properties you want. Every value
 * below is required for the rest of the app's CSS to look right;
 * missing ones just fall through unstyled.
 */

Delta.registerPlugin({
  id: 'example-forest-theme',
  name: 'Forest Theme',

  onLoad(api) {
    api.registerTheme({
      id: 'forest',
      name: 'Forest',
      css: `
        --bg: #182620;
        --bg-elevated: #12201b;
        --bg-card: #1f3129;
        --bg-hover: #243830;
        --text: #e3ede8;
        --text-muted: #93a89d;
        --border: #2c4038;
        --accent: #4caf7d;
        --accent-contrast: #0b1310;
        --danger: #e06456;
      `
    })
  }
})
