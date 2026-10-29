const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('forge', {
  // ── file operations ──
  openFile:    ()       => ipcRenderer.invoke('file:open'),
  saveFile:    payload  => ipcRenderer.invoke('file:save', payload),
  openFolder:  ()       => ipcRenderer.invoke('file:open-folder'),
  readPath:    filePath => ipcRenderer.invoke('file:read-path', filePath),
  revealPath: filePath => ipcRenderer.invoke('file:reveal', filePath),
  openWith: filePath => ipcRenderer.invoke('file:open-with', filePath),
  renamePath: payload => ipcRenderer.invoke('file:rename', payload),
  deletePath: filePath => ipcRenderer.invoke('file:delete', filePath),
  transferPath: payload => ipcRenderer.invoke('file:transfer', payload),
  refreshFolder: folderPath => ipcRenderer.invoke('file:refresh-folder', folderPath),
  fileInfo: filePath => ipcRenderer.invoke('file:info', filePath),
  relativePath: payload => ipcRenderer.invoke('file:relative-path', payload),
  copyText: value => ipcRenderer.invoke('file:copy-text', value),

  // ── runner ──
  run:         payload  => ipcRenderer.invoke('runner:run', payload),
  runSafe:     payload  => ipcRenderer.invoke('runner:run-safe', payload),
  killRun:     ()       => ipcRenderer.invoke('runner:kill'),
  writeRunInput: text => ipcRenderer.invoke('runner:input', text),
  runHistory:  ()       => ipcRenderer.invoke('runner:history'),
  terminalStart: payload => ipcRenderer.invoke('terminal:start', payload),
  terminalWrite: text => ipcRenderer.invoke('terminal:write', text),
  terminalStop: () => ipcRenderer.invoke('terminal:stop'),

  // ── AI ──
  setKey:        payload => ipcRenderer.invoke('ai:set-key', payload),
  listKeys:      ()      => ipcRenderer.invoke('ai:list-keys'),
  setActiveKey:  payload => ipcRenderer.invoke('ai:set-active-key', payload),
  deleteKey:     payload => ipcRenderer.invoke('ai:delete-key', payload),
  askAI:         payload => ipcRenderer.invoke('ai:ask', payload),
  askKey:        payload => ipcRenderer.invoke('ai:ask-key', payload),
  askLocal:      payload => ipcRenderer.invoke('ai:ask-local', payload),
  keyStatus:     ()      => ipcRenderer.invoke('ai:key-status'),
  synthesize:    payload => ipcRenderer.invoke('ai:synthesize', payload),
  generateTests: payload => ipcRenderer.invoke('ai:generate-tests', payload),
  applyProjectChanges: payload => ipcRenderer.invoke('project:apply-changes', payload),
  inspectProject: payload => ipcRenderer.invoke('project:inspect', payload),
  runProjectTests: payload => ipcRenderer.invoke('project:run-tests', payload),

  // ── plugins ──
  initPlugins:        ()      => ipcRenderer.invoke('plugins:init'),
  listPlugins:        ()      => ipcRenderer.invoke('plugins:list'),
  togglePlugin:       payload => ipcRenderer.invoke('plugins:toggle', payload),
  pluginQuickActions: ()      => ipcRenderer.invoke('plugins:quick-actions'),
  pluginStatusItems:  ()      => ipcRenderer.invoke('plugins:status-items'),
  openUserPluginsFolder: ()   => ipcRenderer.invoke('plugins:open-user-folder'),

  // ── automatic updates ──
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  getUpdateStatus: () => ipcRenderer.invoke('updates:status'),
  setUpdatesEnabled: enabled => ipcRenderer.invoke('updates:set-enabled', enabled),

  // ── events (renderer listens) ──
  onRunnerOutput:       cb => ipcRenderer.on('runner:output',         (_e, v) => cb(v)),
  onRunnerState:        cb => ipcRenderer.on('runner:state',          (_e, v) => cb(v)),
  onTerminalOutput: cb => ipcRenderer.on('terminal:output', (_e, v) => cb(v)),
  onPluginStatusUpdate: cb => ipcRenderer.on('plugins:status-update', (_e, v) => cb(v)),
  onUpdateStatus: cb => ipcRenderer.on('updates:status', (_e, value) => cb(value)),
  onEditorCommand: cb => ipcRenderer.on('editor:command', (_e, command) => {
    if (['new', 'open', 'save', 'find', 'replace', 'gotoLine'].includes(command)) cb(command);
  }),
});
