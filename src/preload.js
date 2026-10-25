const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('forge', {
  // ── file operations ──
  openFile:    ()       => ipcRenderer.invoke('file:open'),
  saveFile:    payload  => ipcRenderer.invoke('file:save', payload),
  openFolder:  ()       => ipcRenderer.invoke('file:open-folder'),
  readPath:    filePath => ipcRenderer.invoke('file:read-path', filePath),
  searchProject: payload => ipcRenderer.invoke('project:search', payload),
  replaceProject: payload => ipcRenderer.invoke('project:replace', payload),
  checkEnvironment: () => ipcRenderer.invoke('environment:check'),
  gitStatus: () => ipcRenderer.invoke('git:status'),
  gitDiff: () => ipcRenderer.invoke('git:diff'),
  gitBranches: () => ipcRenderer.invoke('git:branches'),
  gitLog: () => ipcRenderer.invoke('git:log'),
  gitStage: p => ipcRenderer.invoke('git:stage', p),
  gitUnstage: p => ipcRenderer.invoke('git:unstage', p),
  gitCommit: m => ipcRenderer.invoke('git:commit', m),
  gitCheckout: b => ipcRenderer.invoke('git:checkout', b),

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
  askAI:         payload => ipcRenderer.invoke('ai:ask', payload),
  keyStatus:     ()      => ipcRenderer.invoke('ai:key-status'),
  synthesize:    payload => ipcRenderer.invoke('ai:synthesize', payload),
  generateTests: payload => ipcRenderer.invoke('ai:generate-tests', payload),

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
    if (['new', 'open', 'save', 'find', 'replace', 'gotoLine', 'commandPalette', 'quickOpen'].includes(command)) cb(command);
  }),
});
