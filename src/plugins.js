// src/plugins.js — Plugin system for Nidavellir (main process)
// Plugins are folders inside the `plugins/` directory.
// Each plugin has a plugin.json manifest and a JS entry point.
// The entry point exports { activate(api), deactivate() }.

const path = require('node:path');
const fs = require('node:fs/promises');
const { EventEmitter } = require('node:events');
const fsPath = require('node:path');

const plugins = new Map();        // name → { manifest, mainPath, dirPath, module, enabled, hookEntries }
const hooks = new EventEmitter();
const statusItems = new Map();    // fullId → { id, text, tooltip, pluginName }
const quickActions = [];          // [{ label, prompt, pluginName }]
let winRef = null;
let pluginSystemInitializing = false;

/* ───── helpers ───── */

function sendToRenderer(channel, data) {
  if (winRef && !winRef.isDestroyed()) winRef.webContents.send(channel, data);
}

function setWindow(win) { winRef = win; }

/* ───── per-plugin API facade (NOT a security sandbox) ───── */

function createPluginAPI(pluginName) {
  const plugin = plugins.get(pluginName);

  function registerHook(event, listener) {
    if (!plugin || !plugin.acceptingContributions || typeof listener !== 'function') return;
    hooks.on(event, listener);
    plugin.hookEntries.push({ event, listener });
  }

  return {
    // lifecycle hooks
    onBeforeRun:  cb => registerHook('beforeRun', cb),
    onAfterRun:   cb => registerHook('afterRun', cb),
    onFileSave:   cb => registerHook('fileSave', cb),
    onFileOpen:   cb => registerHook('fileOpen', cb),

    // UI contributions
    addStatusItem: ({ id, text, tooltip } = {}) => {
      if (!plugin || !plugin.acceptingContributions) return;
      const fullId = `${pluginName}:${id}`;
      statusItems.set(fullId, { id: fullId, text, tooltip: tooltip || '', pluginName });
      sendToRenderer('plugins:status-update', { id: fullId, text, tooltip: tooltip || '' });
    },
    updateStatusItem: (id, text) => {
      if (!plugin || !plugin.acceptingContributions) return;
      const fullId = `${pluginName}:${id}`;
      const item = statusItems.get(fullId);
      if (item) { item.text = text; sendToRenderer('plugins:status-update', { id: fullId, text }); }
    },
    addQuickAction: ({ label, prompt } = {}) => {
      if (!plugin || !plugin.acceptingContributions) return;
      quickActions.push({ label, prompt, pluginName });
    },

    // output
    log: text => {
      sendToRenderer('runner:output', { type: 'info', text: `[${pluginName}] ${text}` });
    }
  };
}

/* ───── activate / deactivate ───── */

function enqueuePluginOperation(plugin, operation) {
  const previous = plugin.operation || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  plugin.operation = next;
  return next.finally(() => {
    if (plugin.operation === next) plugin.operation = null;
  });
}

async function deactivatePluginRecord(plugin) {
  if (!plugin) return;
  const mod = plugin.module;
  plugin.enabled = false;
  plugin.acceptingContributions = false;
  // Remove app-managed callbacks and UI immediately, before awaiting plugin cleanup.
  for (const { event, listener } of plugin.hookEntries) hooks.removeListener(event, listener);
  plugin.hookEntries = [];
  for (const [id, item] of statusItems) {
    if (item.pluginName === plugin.manifest.name) statusItems.delete(id);
  }
  for (let i = quickActions.length - 1; i >= 0; i--) {
    if (quickActions[i].pluginName === plugin.manifest.name) quickActions.splice(i, 1);
  }
  plugin.module = null;
  try {
    if (mod && typeof mod.deactivate === 'function') await mod.deactivate();
  } catch {}
}

async function activatePlugin(name) {
  const plugin = plugins.get(name);
  if (!plugin) return false;
  try {
    delete require.cache[require.resolve(plugin.mainPath)];
    const mod = require(plugin.mainPath);
    plugin.module = mod;
    plugin.acceptingContributions = true;
    if (typeof mod.activate === 'function') await mod.activate(createPluginAPI(name));
    plugin.enabled = true;
    return true;
  } catch (err) {
    // activate() may have registered hooks or UI contributions before throwing.
    // Remove every app-managed contribution before reporting the plugin disabled.
    await deactivatePluginRecord(plugin);
    console.error(`Plugin "${name}" activation failed:`, err.message);
    return false;
  }
}

/* ───── public API ───── */

async function initPluginSystem(pluginsDir) {
  pluginSystemInitializing = true;
  try {
    // Queue teardown behind any in-flight activation before clearing plugin records.
    const existing = Array.from(plugins.values());
    await Promise.all(existing.map(plugin =>
      enqueuePluginOperation(plugin, () => deactivatePluginRecord(plugin))
    ));
    plugins.clear(); statusItems.clear(); quickActions.length = 0;

    let entries;
    try { entries = await fs.readdir(pluginsDir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(pluginsDir, entry.name);
      const manifestPath = path.join(pluginDir, 'plugin.json');
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (!manifest.name || !manifest.main) continue;
        if (typeof manifest.main !== 'string' || path.isAbsolute(manifest.main)) continue;
        const realPluginDir = await fs.realpath(pluginDir);
        const mainPath = path.resolve(pluginDir, manifest.main);
        const realMainPath = await fs.realpath(mainPath);
        const relMain = path.relative(realPluginDir, realMainPath);
        if (!relMain || relMain.startsWith('..') || path.isAbsolute(relMain)) continue;
        await fs.access(realMainPath);
        // Third-party plugin code runs with the app's OS permissions. Never auto-run it.
        plugins.set(manifest.name, {
          manifest, mainPath: realMainPath, dirPath: realPluginDir,
          module: null, enabled: false, acceptingContributions: false,
          hookEntries: [], operation: null
        });
      } catch { /* skip invalid plugins */ }
    }

    // Plugins remain disabled until the user explicitly enables them in the UI.
    // Enabling is a trust decision; this is not a process sandbox.
  } finally {
    pluginSystemInitializing = false;
  }
}

function getPlugins() {
  return Array.from(plugins.values()).map(p => ({
    name: p.manifest.name,
    version: p.manifest.version || '0.0.0',
    description: p.manifest.description || '',
    enabled: p.enabled
  }));
}

async function setPluginEnabled(name, enabled) {
  const plugin = plugins.get(name);
  if (!plugin || pluginSystemInitializing) return false;
  return enqueuePluginOperation(plugin, async () => {
    if (enabled) {
      if (plugin.enabled) return true;
      return activatePlugin(name);
    }
    if (plugin.enabled || plugin.module || plugin.hookEntries.length) {
      await deactivatePluginRecord(plugin);
    }
    return true;
  });
}

function notifyPlugins(event, data) { hooks.emit(event, data); }

function getQuickActions() {
  return quickActions
    .filter(a => { const p = plugins.get(a.pluginName); return p && p.enabled; })
    .map(({ label, prompt }) => ({ label, prompt }));
}

function getStatusItems() {
  return Array.from(statusItems.values())
    .filter(i => { const p = plugins.get(i.pluginName); return p && p.enabled; });
}

module.exports = {
  setWindow, initPluginSystem, getPlugins, setPluginEnabled,
  notifyPlugins, getQuickActions, getStatusItems
};
