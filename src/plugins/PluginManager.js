import Delta from '../api/DeltaAPI.js'

/**
 * Loads every plugin found in <vault>/Delta/plugins/, and executes
 * its index.js with full access to the Delta API object. There is no
 * sandbox, no permission system, and no npm resolution - a plugin is
 * just a manifest.json + a plain .js file that gets run in the app's
 * own JS context. That is what "no dependency, fully hackable" means
 * in practice for Delta.
 */

function runPluginCode(plugin) {
  if (!plugin.code) return
  try {
    // eslint-disable-next-line no-new-func
    const run = new Function('Delta', 'manifest', `"use strict";\n${plugin.code}`)
    run(Delta, plugin.manifest)
  } catch (err) {
    console.error(`[Delta] plugin "${plugin.id}" failed to load:`, err)
    Delta.showNotice(`Plugin "${plugin.manifest?.name || plugin.id}" failed to load`, { type: 'error' })
  }
}

export async function loadPlugins(enabledIds, preloadedList) {
  // bootVault (App.jsx) kicks off the plugins:list IPC call in parallel
  // with settings:get, since one doesn't depend on the other's result -
  // pass that already-in-flight/resolved list straight through instead
  // of making PluginManager fire a second, redundant one here.
  const list = preloadedList || (await window.deltaBridge.plugins.list(Delta.vaultPath))

  for (const plugin of list) {
    const enabled = !enabledIds || enabledIds.includes(plugin.id)
    if (!enabled) continue
    runPluginCode(plugin)
  }

  return list
}

/**
 * Loads a single plugin right now, in the current session - used when
 * the user flips a plugin on from Settings, so things like a newly
 * registered theme show up immediately instead of requiring a restart.
 * A no-op if that plugin has already been loaded this session (so
 * toggling a plugin off then on again doesn't double-register it -
 * there's no unload/teardown, by design, to keep the plugin API small).
 */
export async function loadPlugin(pluginId) {
  if (Delta.plugins.has(pluginId)) return
  const list = await window.deltaBridge.plugins.list(Delta.vaultPath)
  const plugin = list.find((p) => p.id === pluginId)
  if (plugin) runPluginCode(plugin)
}

/**
 * Unloads (if currently loaded) and re-runs a single plugin from its
 * on-disk source right now - unlike loadPlugin(), this does NOT skip
 * plugins that are already loaded, so it's the one to use after editing
 * a plugin's index.js and wanting to see the change without restarting
 * the whole app. plugins:list on the main-process side is cached on the
 * manifest/code files' mtimes, so this always picks up whatever's
 * currently saved on disk.
 *
 * unloadPlugin() reverses everything a plugin's onLoad() could have set
 * up: toolbar buttons, settings sections, markdown plugins, themes, and
 * (as of the on()/off() tracking added to DeltaAPI) any raw api.on(...)
 * subscriptions it made too - so a plugin that listens for note:save or
 * similar directly doesn't end up with a duplicate listener stacked on
 * top of the old one each time this runs.
 */
export async function reloadPlugin(pluginId) {
  Delta.unloadPlugin(pluginId)
  const list = await window.deltaBridge.plugins.list(Delta.vaultPath)
  const plugin = list.find((p) => p.id === pluginId)
  if (plugin) runPluginCode(plugin)
}
