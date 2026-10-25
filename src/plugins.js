// Nidavellir plugin system.
// Plugins are disabled by default. Plugins without native:unrestricted permission
// execute in a restricted vm context with a small API surface. Node's vm module is
// not an OS security boundary: do not load code you do not trust.
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const plugins = new Map();
const hooks = new EventEmitter();
const statusItems = new Map();
const quickActions = [];
const SAFE_DEFAULT_PERMISSIONS = ['editor:readContents', 'ui:status', 'ai:quickActions', 'logging'];
const KNOWN_PERMISSIONS = new Set([...SAFE_DEFAULT_PERMISSIONS, 'native:unrestricted']);
let winRef = null;

function sendToRenderer(channel, data) {
  if (winRef && !winRef.isDestroyed()) winRef.webContents.send(channel, data);
}
function setWindow(win) { winRef = win; }

function makeBridgeFunction(fn) {
  // The API object crosses into a vm realm. Remove the host function prototype so
  // plugin code cannot walk through fn.constructor to the main-process Function.
  try { Object.setPrototypeOf(fn, null); } catch {}
  return Object.freeze(fn);
}
function requirePermission(plugin, permission) {
  if (!plugin.permissions.has('native:unrestricted') && !plugin.permissions.has(permission)) {
    throw new Error('Plugin "' + plugin.manifest.name + '" requires permission "' + permission + '". Add it to plugin.json and review the consequences before enabling.');
  }
}
function createPluginAPI(pluginName) {
  const plugin = plugins.get(pluginName);
  const api = Object.create(null);
  function registerHook(event, listener, permission) {
    requirePermission(plugin, permission);
    if (typeof listener !== 'function') throw new TypeError('Plugin hook must be a function.');
    let wrapped = listener;
    if (plugin.executionModel === 'restricted-vm') {
      wrapped = data => {
        let json;
        try { json = JSON.stringify(data, (_key, value) => typeof value === 'bigint' ? String(value) : value); }
        catch { json = '{}'; }
        if (Buffer.byteLength(json, 'utf8') > 3 * 1024 * 1024) json = JSON.stringify({ error: 'Hook payload exceeded the size limit.' });
        plugin.vmBridge.dispatchHook(listener, json);
      };
    }
    hooks.on(event, wrapped);
    plugin.hookEntries.push({ event, listener: wrapped });
  }
  api.onBeforeRun = makeBridgeFunction(cb => registerHook('beforeRun', cb, 'editor:readContents'));
  api.onAfterRun = makeBridgeFunction(cb => registerHook('afterRun', cb, 'editor:readContents'));
  api.onFileSave = makeBridgeFunction(cb => registerHook('fileSave', cb, 'editor:readContents'));
  api.onFileOpen = makeBridgeFunction(cb => registerHook('fileOpen', cb, 'editor:readContents'));
  api.addStatusItem = makeBridgeFunction(({ id, text, tooltip }) => {
    requirePermission(plugin, 'ui:status');
    if (typeof id !== 'string' || !id.trim() || id.length > 80 || typeof text !== 'string' || text.length > 200) throw new Error('Invalid plugin status item.');
    const fullId = pluginName + ':' + id;
    const safeTooltip = typeof tooltip === 'string' ? tooltip.slice(0, 300) : '';
    statusItems.set(fullId, { id: fullId, text, tooltip: safeTooltip, pluginName });
    sendToRenderer('plugins:status-update', { id: fullId, text, tooltip: safeTooltip });
  });
  api.updateStatusItem = makeBridgeFunction((id, text) => {
    requirePermission(plugin, 'ui:status');
    if (typeof id !== 'string' || id.length > 80 || typeof text !== 'string' || text.length > 200) return;
    const item = statusItems.get(pluginName + ':' + id);
    if (item) {
      item.text = text;
      sendToRenderer('plugins:status-update', { id: item.id, text });
    }
  });
  api.addQuickAction = makeBridgeFunction(({ label, prompt }) => {
    requirePermission(plugin, 'ai:quickActions');
    if (typeof label !== 'string' || !label.trim() || label.length > 100 || typeof prompt !== 'string' || prompt.length > 4000) throw new Error('Invalid plugin quick action.');
    quickActions.push({ label, prompt, pluginName });
  });
  api.log = makeBridgeFunction(text => {
    requirePermission(plugin, 'logging');
    const message = String(text == null ? '' : text).slice(0, 4000);
    sendToRenderer('runner:output', { type: 'info', text: '[' + pluginName + '] ' + message });
  });
  return Object.freeze(api);
}

async function activatePlugin(name) {
  const plugin = plugins.get(name);
  if (!plugin) return false;
  if (plugin.enabled) return true;
  try {
    let mod;
    if (plugin.permissions.has('native:unrestricted')) {
      // Explicit escape hatch for legacy/native plugins. The UI will issue a
      // high-risk confirmation before this path is reached.
      plugin.executionModel = 'native-unrestricted';
      delete require.cache[require.resolve(plugin.mainPath)];
      mod = require(plugin.mainPath);
      plugin.module = mod;
      if (typeof mod.activate === 'function') await mod.activate(createPluginAPI(name));
    } else {
      const stat = await fs.stat(plugin.mainPath);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Restricted plugin entry point must be a text file no larger than 1 MB.');
      const source = await fs.readFile(plugin.mainPath, 'utf8');
      const context = vm.createContext(Object.create(null), {
        name: 'Nidavellir plugin: ' + name,
        codeGeneration: { strings: false, wasm: false }
      });
      const moduleObject = vm.runInContext('({ exports: {} })', context, { timeout: 1000 });
      context.module = moduleObject;
      context.exports = moduleObject.exports;
      new vm.Script(source, { filename: plugin.mainPath, displayErrors: true }).runInContext(context, { timeout: 1000 });
      mod = moduleObject.exports;
      if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) throw new Error('Plugin entry point must export an object.');
      plugin.executionModel = 'restricted-vm';
      plugin.vmContext = context;
      plugin.vmBridge = vm.runInContext('({ dispatchHook: function(listener, json) { return listener(JSON.parse(json)); } })', context, { timeout: 1000 });
      plugin.module = mod;
      if (typeof mod.activate === 'function') {
        context.__nidavellirApi = createPluginAPI(name);
        try {
          new vm.Script('module.exports.activate(__nidavellirApi)', { filename: plugin.mainPath + ':activate' }).runInContext(context, { timeout: 1000 });
        } finally { delete context.__nidavellirApi; }
      }
    }
    plugin.enabled = true;
    return true;
  } catch (err) {
    console.error('Plugin "' + name + '" activation failed:', err && err.message ? err.message : String(err));
    for (const { event, listener } of plugin.hookEntries) hooks.removeListener(event, listener);
    plugin.hookEntries = [];
    for (const [id, item] of statusItems) if (item.pluginName === name) statusItems.delete(id);
    for (let i = quickActions.length - 1; i >= 0; i--) if (quickActions[i].pluginName === name) quickActions.splice(i, 1);
    plugin.module = null;
    plugin.vmContext = null;
    plugin.vmBridge = null;
    plugin.enabled = false;
    return false;
  }
}

function deactivatePlugin(name) {
  const plugin = plugins.get(name);
  if (!plugin || !plugin.module) return;
  try {
    if (plugin.executionModel === 'restricted-vm' && plugin.vmContext) {
      plugin.vmContext.__nidavellirDeactivate = plugin.module.deactivate;
      new vm.Script('if (typeof __nidavellirDeactivate === "function") __nidavellirDeactivate()')
        .runInContext(plugin.vmContext, { timeout: 1000 });
      delete plugin.vmContext.__nidavellirDeactivate;
    } else if (typeof plugin.module.deactivate === 'function') {
      plugin.module.deactivate();
    }
  } catch {}
  for (const { event, listener } of plugin.hookEntries) hooks.removeListener(event, listener);
  plugin.hookEntries = [];
  for (const [id, item] of statusItems) if (item.pluginName === name) statusItems.delete(id);
  for (let i = quickActions.length - 1; i >= 0; i--) if (quickActions[i].pluginName === name) quickActions.splice(i, 1);
  plugin.module = null;
  plugin.vmContext = null;
  plugin.vmBridge = null;
  plugin.enabled = false;
}

async function initPluginSystem(pluginsDir) {
  for (const [name, plugin] of plugins) if (plugin.enabled) deactivatePlugin(name);
  plugins.clear();
  statusItems.clear();
  quickActions.length = 0;
  let entries;
  try { entries = await fs.readdir(pluginsDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(pluginsDir, entry.name);
    const manifestPath = path.join(pluginDir, 'plugin.json');
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (!manifest || typeof manifest.name !== 'string' || !manifest.name.trim() || typeof manifest.main !== 'string' || !manifest.main.trim()) continue;
      if (path.isAbsolute(manifest.main)) continue;
      const realPluginDir = await fs.realpath(pluginDir);
      const realMainPath = await fs.realpath(path.resolve(pluginDir, manifest.main));
      const relativeMain = path.relative(realPluginDir, realMainPath);
      if (!relativeMain || relativeMain.startsWith('..') || path.isAbsolute(relativeMain)) continue;
      await fs.access(realMainPath);
      const declared = Array.isArray(manifest.permissions);
      const requested = declared ? manifest.permissions : SAFE_DEFAULT_PERMISSIONS;
      if (!Array.isArray(requested) || requested.length > 20 || requested.some(p => typeof p !== 'string' || !KNOWN_PERMISSIONS.has(p))) continue;
      const permissions = new Set(requested);
      plugins.set(manifest.name, {
        manifest, mainPath: realMainPath, dirPath: realPluginDir,
        module: null, enabled: false, hookEntries: [], permissions,
        permissionsDeclared: declared, executionModel: 'restricted-vm', vmContext: null, vmBridge: null
      });
    } catch { /* Skip invalid manifests, path traversal and broken symlinks. */ }
  }
}

function getPlugins() {
  return Array.from(plugins.values()).map(plugin => {
    const permissions = Array.from(plugin.permissions);
    const unrestricted = plugin.permissions.has('native:unrestricted');
    return {
      name: plugin.manifest.name,
      version: plugin.manifest.version || '0.0.0',
      description: plugin.manifest.description || '',
      enabled: plugin.enabled,
      permissions,
      permissionsDeclared: plugin.permissionsDeclared,
      sandboxed: false,
      executionModel: unrestricted ? 'native-unrestricted (full Node.js and OS user permissions)' : 'restricted vm context (not a strong OS security boundary)'
    };
  });
}
async function setPluginEnabled(name, enabled) {
  const plugin = plugins.get(name);
  if (!plugin) return false;
  if (enabled && !plugin.enabled) return activatePlugin(name);
  if (!enabled && plugin.enabled) { deactivatePlugin(name); return true; }
  return true;
}
function notifyPlugins(event, data) { hooks.emit(event, data); }
function getQuickActions() {
  return quickActions.filter(action => { const plugin = plugins.get(action.pluginName); return plugin && plugin.enabled; }).map(({ label, prompt }) => ({ label, prompt }));
}
function getStatusItems() {
  return Array.from(statusItems.values()).filter(item => { const plugin = plugins.get(item.pluginName); return plugin && plugin.enabled; });
}
module.exports = { setWindow, initPluginSystem, getPlugins, setPluginEnabled, notifyPlugins, getQuickActions, getStatusItems };
