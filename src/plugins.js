// src/plugins.js — Plugin system for Nidavellir (main process)
// Plugins are folders inside the `plugins/` directory.
// Each plugin has a plugin.json manifest and a JS entry point.
// The entry point exports { activate(api), deactivate() }.

const path = require('node:path');
const fs = require('node:fs/promises');
const { EventEmitter } = require('node:events');

const plugins = new Map();        // name → { manifest, mainPath, dirPath, module, enabled, hookEntries }
const hooks = new EventEmitter();
const statusItems = new Map();    // fullId → { id, text, tooltip, pluginName }
const quickActions = [];          // [{ label, prompt, pluginName }]
let winRef = null;

/* ───── helpers ───── */

function sendToRenderer(channel, data) {
  if (winRef && !winRef.isDestroyed()) winRef.webContents.send(channel, data);
}

function setWindow(win) { winRef = win; }

/* ───── per-plugin sandboxed API ───── */

function createPluginAPI(pluginName) {
  const plugin = plugins.get(pluginName);

  function registerHook(event, listener) {
    hooks.on(event, listener);
    if (plugin) plugin.hookEntries.push({ event, listener });
  }

  return {
    // lifecycle hooks
    onBeforeRun:  cb => registerHook('beforeRun', cb),
    onAfterRun:   cb => registerHook('afterRun', cb),
    onFileSave:   cb => registerHook('fileSave', cb),
    onFileOpen:   cb => registerHook('fileOpen', cb),

    // UI contributions
    addStatusItem: ({ id, text, tooltip }) => {
      const fullId = `${pluginName}:${id}`;
      statusItems.set(fullId, { id: fullId, text, tooltip: tooltip || '', pluginName });
      sendToRenderer('plugins:status-update', { id: fullId, text, tooltip: tooltip || '' });
    },
    updateStatusItem: (id, text) => {
      const fullId = `${pluginName}:${id}`;
      const item = statusItems.get(fullId);
      if (item) { item.text = text; sendToRenderer('plugins:status-update', { id: fullId, text }); }
    },
    addQuickAction: ({ label, prompt }) => {
      quickActions.push({ label, prompt, pluginName });
    },

    // output
    log: text => {
      sendToRenderer('runner:output', { type: 'info', text: `[${pluginName}] ${text}` });
    }
  };
}

/* ───── activate / deactivate ───── */

function activatePlugin(name) {
  const plugin = plugins.get(name);
  if (!plugin) return false;
  try {
    delete require.cache[require.resolve(plugin.mainPath)];
    const mod = require(plugin.mainPath);
    plugin.module = mod;
    if (typeof mod.activate === 'function') mod.activate(createPluginAPI(name));
    plugin.enabled = true;
    return true;
  } catch (err) {
    console.error(`Plugin "${name}" activation failed:`, err.message);
    plugin.enabled = false;
    return false;
  }
}

function deactivatePlugin(name) {
  const plugin = plugins.get(name);
  if (!plugin || !plugin.module) return;
  try { if (typeof plugin.module.deactivate === 'function') plugin.module.deactivate(); } catch {}
  // tear down hooks
  for (const { event, listener } of plugin.hookEntries) hooks.removeListener(event, listener);
  plugin.hookEntries = [];
  // remove UI contributions
  for (const [id, item] of statusItems) { if (item.pluginName === name) statusItems.delete(id); }
  for (let i = quickActions.length - 1; i >= 0; i--) {
    if (quickActions[i].pluginName === name) quickActions.splice(i, 1);
  }
  plugin.module = null;
  plugin.enabled = false;
}

/* ───── public API ───── */

async function initPluginSystem(pluginsDir) {
  // deactivate everything first
  for (const [name, p] of plugins) { if (p.enabled) deactivatePlugin(name); }
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
      const mainPath = path.join(pluginDir, manifest.main);
      await fs.access(mainPath);
      plugins.set(manifest.name, {
        manifest, mainPath, dirPath: pluginDir,
        module: null, enabled: manifest.enabled !== false, hookEntries: []
      });
    } catch { /* skip invalid plugins */ }
  }

  for (const [name, plugin] of plugins) {
    if (plugin.enabled) activatePlugin(name);
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

function setPluginEnabled(name, enabled) {
  const plugin = plugins.get(name);
  if (!plugin) return false;
  if (enabled && !plugin.enabled) return activatePlugin(name);
  if (!enabled && plugin.enabled) { deactivatePlugin(name); return true; }
  return true;
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
