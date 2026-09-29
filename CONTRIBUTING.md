# Contributing to Delta

Thanks for wanting to help. Delta is deliberately small and hackable, so the best contributions keep it that way.

## Before you start

- **Small fix or bug?** Just open a pull request.
- **New feature?** Open an issue first so we can agree on the approach before you spend time on it.
- **Could it be a plugin?** If the feature doesn't need to live in the core app, build it as a plugin instead (see [`PLUGIN_API.md`](./PLUGIN_API.md)). Missing an extension point? That is a great reason to open an issue or PR.

## Setup

Requires Node.js 18+ and [pnpm](https://pnpm.io).

```bash
git clone <your-fork-url>
cd delta
pnpm install
pnpm dev        # Vite + Electron with hot reload
```

Other scripts: `pnpm build` (renderer into `dist/`), `pnpm start` (Electron against `dist/`), `pnpm dist` (installers via electron-builder).

Tip: `Cmd/Ctrl+Shift+I` (or `F12`) opens DevTools, and `window.Delta` is the same API plugins use, so you can try things from the console.

## Project layout

```
electron/main.js       Main process: all disk access lives here (IPC handlers)
electron/preload.js    The complete renderer <-> main surface (window.deltaBridge)
src/App.jsx            Tabs, session restore, global shortcuts
src/api/DeltaAPI.js    The `Delta` object shared by the app and plugins
src/screens/           Notes grid, note editor, graph, settings, file viewer
src/components/        Cards, dialogs, command palette, markdown preview
src/plugins/           Plugin loader
plugins/               Bundled example plugins
```

## Code guidelines

- **Plain JavaScript.** No TypeScript, no new build steps.
- **Few dependencies.** Think twice before adding one; a small hand-written helper is often better.
- **Comment the why.** The codebase explains reasons and edge cases in comments, not just what a line does. Please keep doing that.
- **Notes stay plain `.md` files.** No database, no hidden formats.
- **Disk access goes through `electron/main.js`.** When you add an IPC handler:
  - validate every path with `resolveInVault()` so nothing outside the vault can be touched,
  - write files with `writeFileAtomic()`,
  - clean user-supplied names with `sanitizeName()`,
  - expose it in `preload.js` and, if plugins should use it, wrap it in `DeltaAPI.js` and document it in `PLUGIN_API.md`.
- **Plugin API changes** must update `PLUGIN_API.md` in the same PR.
- Match the surrounding style (no semicolons and single quotes in `src/`, double quotes in `electron/`).

## Testing your change

There is no automated test suite yet, so please check by hand before opening a PR:

- [ ] `pnpm dev` starts without console errors
- [ ] Create, edit, rename and delete a note; autosave keeps your text
- [ ] `[[links]]`, `![[embeds]]` and the graph view still work
- [ ] Move a note or file into a folder; links and images in other notes still resolve
- [ ] Enable and disable a plugin from Settings
- [ ] `pnpm build` succeeds

Adding tests (for example for the helpers in `main.js`) is very welcome.

## Pull requests

- Keep each PR focused on one change.
- Describe what changed and why, and add a screenshot or short clip for UI changes.
- Make sure the checklist above passes.

## Reporting bugs

Open an issue with your OS, what you did, what you expected, and what happened. Console output from DevTools helps a lot.

For security problems, please don't open a public issue. Contact the maintainers privately through the repository's security advisory feature instead.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
