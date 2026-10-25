const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('forge', {
  // ── file operations ──
  openFile:    ()       => ipcRenderer.invoke('file:open'),
  saveFile:    payload  => ipcRenderer.invoke('file:save', payload),
  openFolder:  ()       => ipcRenderer.invoke('file:open-folder'),
  readPath:    filePath => ipcRenderer.invoke('file:read-path', filePath),

  // ── recovery and workspace tools ──
  getRecoveryDrafts: () => ipcRenderer.invoke('recovery:get'),
  saveRecoveryDrafts: payload => ipcRenderer.invoke('recovery:save', payload),
  clearRecoveryDrafts: () => ipcRenderer.invoke('recovery:clear'),
  searchWorkspace: payload => ipcRenderer.invoke('workspace:search', payload),
  previewWorkspaceReplace: payload => ipcRenderer.invoke('workspace:preview-replace', payload),
  replaceWorkspace: payload => ipcRenderer.invoke('workspace:replace', payload),
  detectEnvironment: () => ipcRenderer.invoke('studio:environment'),
  diagnoseSource: payload => ipcRenderer.invoke('studio:diagnose', payload),
  startLanguageServer: payload => ipcRenderer.invoke('lsp:start', payload),
  stopLanguageServer: () => ipcRenderer.invoke('lsp:stop'),
  openLanguageServerDocument: payload => ipcRenderer.invoke('lsp:open-document', payload),
  changeLanguageServerDocument: payload => ipcRenderer.invoke('lsp:change-document', payload),
  languageServerRequest: payload => ipcRenderer.invoke('lsp:request', payload),
  gitStatus: root => ipcRenderer.invoke('git:status', root),
  gitDiff: payload => ipcRenderer.invoke('git:diff', payload),
  gitBranches: root => ipcRenderer.invoke('git:branches', root),
  gitSwitchBranch: payload => ipcRenderer.invoke('git:switch-branch', payload),
  gitCreateBranch: payload => ipcRenderer.invoke('git:create-branch', payload),
  gitLog: root => ipcRenderer.invoke('git:log', root),
  gitStage: payload => ipcRenderer.invoke('git:stage', payload),
  gitUnstage: payload => ipcRenderer.invoke('git:unstage', payload),
  gitCommit: payload => ipcRenderer.invoke('git:commit', payload),
  gitPull: root => ipcRenderer.invoke('git:pull', root),
  gitPush: root => ipcRenderer.invoke('git:push', root),
  planProjectChanges: payload => ipcRenderer.invoke('ai:plan-project-changes', payload),
  applyProjectChanges: payload => ipcRenderer.invoke('project:apply-changes', payload),

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
  onLanguageServerNotification: cb => ipcRenderer.on('lsp:notification', (_e, notification) => cb(notification)),
  debuggerCommand: payload => ipcRenderer.invoke('debugger:command', payload),
  setDebuggerBreakpoints: lines => ipcRenderer.invoke('debugger:set-breakpoints', lines),
  stopDebugger: () => ipcRenderer.invoke('debugger:stop'),
  onDebuggerNotification: cb => ipcRenderer.on('debugger:notification', (_e, event) => cb(event)),
  onEditorCommand: cb => ipcRenderer.on('editor:command', (_e, command) => {
    if (['new', 'open', 'save', 'find', 'replace', 'gotoLine', 'commandPalette', 'quickOpen'].includes(command)) cb(command);
  }),
});
