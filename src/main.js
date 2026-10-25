const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { createSafeRunner } = require('./safe-runner');
const { synthesizeResponses } = require('./coordinator');
const pluginSystem = require('./plugins');
const { autoUpdater } = require('electron-updater');
const { createUpdater } = require('./updater');
const { prepareUserPluginsDir } = require('./user-plugins');
const { registerStudioIpc } = require('./studio-ipc');
const { NodeInspectorClient, normalizeBreakpointLines } = require('./node-inspector');

/* ─── globals ─── */
let win;
let updateService = null;
const keyCache = {};
const allowedProviders = new Set(['openai', 'gemini', 'claude']);
const approvedRoots = new Set();
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SAVE_BYTES = 5 * 1024 * 1024;
let activeWorkspaceRoot = null;
let debugRunRequested = false, debugSourceSnapshot = null, debugScriptUrl = null;
let debugClient = null, debugBreakpointLines = [], debugBreakpointIds = [], debugPaused = false;
let debugCallFrames = [], debugScopes = [];
function sendDebuggerNotification(event) {
  if (win && !win.isDestroyed()) win.webContents.send('debugger:notification', event);
}
function inspectorUrlToPath(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return null;
    let value = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
    return process.platform === 'win32' ? value.replace(/\//g, '\\') : value;
  } catch { return null; }
}
function sameLocalPath(left, right) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
async function applyDebugBreakpoints(client = debugClient) {
  if (!client || !debugScriptUrl) return { queued: true, lines: debugBreakpointLines };
  for (const id of debugBreakpointIds) {
    await client.send('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => {});
  }
  debugBreakpointIds = [];
  for (const line of debugBreakpointLines) {
    const result = await client.send('Debugger.setBreakpointByUrl', { url: debugScriptUrl, lineNumber: line - 1, columnNumber: 0 });
    if (result && result.breakpointId) debugBreakpointIds.push(result.breakpointId);
  }
  sendDebuggerNotification({ type: 'breakpoints-set', lines: debugBreakpointLines, count: debugBreakpointIds.length });
  return { queued: false, lines: debugBreakpointLines, count: debugBreakpointIds.length };
}
async function handleDebuggerProtocolMessage(client, message) {
  if (client !== debugClient || !message || !message.method) return;
  const params = message.params || {};
  if (message.method === 'Debugger.scriptParsed') {
    const sourcePath = inspectorUrlToPath(params.url || '');
    if (debugSourceSnapshot && sourcePath && sameLocalPath(sourcePath, debugSourceSnapshot)) {
      debugScriptUrl = params.url;
      await applyDebugBreakpoints(client).catch(error => sendDebuggerNotification({ type:'error', message:error.message }));
      sendDebuggerNotification({ type:'script', url:params.url, sourcePath });
    }
  } else if (message.method === 'Debugger.paused') {
    debugPaused = true;
    const frames = Array.isArray(params.callFrames) ? params.callFrames.slice(0, 40) : [];
    debugCallFrames = frames;
    const safeFrames = frames.map(frame => ({
      callFrameId: frame.callFrameId,
      functionName: frame.functionName || '(anonymous)',
      url: frame.url || '',
      lineNumber: Number.isInteger(frame.location && frame.location.lineNumber) ? frame.location.lineNumber + 1 : null,
      columnNumber: Number.isInteger(frame.location && frame.location.columnNumber) ? frame.location.columnNumber + 1 : null
    }));
    const scopes = [];
    const topFrame = frames[0];
    for (const scope of (topFrame && topFrame.scopeChain || []).slice(0, 6)) {
      const variables = [];
      const objectId = scope.object && scope.object.objectId;
      if (objectId) {
        try {
          const result = await client.send('Runtime.getProperties', { objectId, ownProperties: true, accessorPropertiesOnly: false, generatePreview: true }, 5000);
          for (const item of (result.result || []).slice(0, 100)) {
            if (!item || typeof item.name !== 'string' || item.name.startsWith('[[Prototype]]')) continue;
            const value = item.value ? (Object.hasOwn(item.value, 'value') ? JSON.stringify(item.value.value) : item.value.description || item.value.type) : item.get ? '(getter)' : 'undefined';
            variables.push({ name:item.name.slice(0,160), value:String(value).slice(0,500) });
          }
        } catch {}
      }
      scopes.push({ name:scope.name || scope.type || 'scope', type:scope.type, variables });
    }
    debugScopes = scopes;
    sendDebuggerNotification({ type:'paused', reason:String(params.reason || 'paused'), description:String(params.data && params.data.description || ''), frames:safeFrames, scopes });
  } else if (message.method === 'Debugger.resumed') {
    debugPaused = false;
    sendDebuggerNotification({ type:'resumed' });
  } else if (message.method === 'Runtime.exceptionThrown') {
    const detail = params.exceptionDetails || {};
    sendDebuggerNotification({ type:'exception', message:String(detail.text || 'JavaScript exception'), lineNumber:Number.isInteger(detail.lineNumber) ? detail.lineNumber + 1 : null });
  }
}
async function connectNodeInspector(address) {
  if (debugClient) debugClient.close();
  const client = new NodeInspectorClient({ onEvent: message => { void handleDebuggerProtocolMessage(client, message); } });
  debugClient = client;
  try {
    await client.connect(address);
    await client.send('Runtime.enable');
    await client.send('Debugger.enable');
    sendDebuggerNotification({ type:'connected', sourcePath:debugSourceSnapshot || '', breakpoints:debugBreakpointLines });
  } catch (error) {
    if (debugClient === client) debugClient = null;
    client.close();
    sendDebuggerNotification({ type:'error', message:error.message || String(error) });
  }
}

async function isWithinApprovedRoot(filePath) {
  if (typeof filePath !== 'string' || filePath.length > 4096) return false;
  const resolved = path.resolve(filePath);
  for (const root of approvedRoots) {
    try {
      const realRoot = await fs.realpath(root);
      let realTarget;
      try { realTarget = await fs.realpath(resolved); }
      catch {
        // Permit a new save target only when its existing parent is inside the approved root.
        const realParent = await fs.realpath(path.dirname(resolved));
        realTarget = path.join(realParent, path.basename(resolved));
      }
      const relative = path.relative(realRoot, realTarget);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return true;
    } catch {}
  }
  return false;
}

function validateTextPayload(value, maxBytes, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error(`${label} exceeds the size limit.`);
}
const modelDefaults = {
  openai: 'gpt-4.1-mini',
  gemini: 'gemini-2.5-flash',
  claude: 'claude-sonnet-4-20250514'
};

/* ─── output helpers ─── */
function sendOutput(type, text) {
  let value = String(text);
  if (debugRunRequested) {
    const sourceMatch = value.match(/NIDAVELLIR_DEBUG_SOURCE:([^\r\n]+)/);
    if (sourceMatch) {
      debugSourceSnapshot = path.resolve(sourceMatch[1].trim());
      value = value.replace(sourceMatch[0], '').trim();
    }
    const urlMatch = value.match(/ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/[A-Za-z0-9-]+/);
    if (urlMatch && !debugClient) void connectNodeInspector(urlMatch[0]);
  }
  if (value && win && !win.isDestroyed()) win.webContents.send('runner:output', { type, text: value });
}
function sendRunnerState(running) {
  if (win && !win.isDestroyed()) win.webContents.send('runner:state', { running });
}

/* ─── safe runner instance ─── */
const runner = createSafeRunner(sendOutput);
let terminalProcess = null;
let terminalOutputBytes = 0;
function sendTerminalOutput(type, text) {
  if (!win || win.isDestroyed()) return;
  const value = String(text);
  terminalOutputBytes += Buffer.byteLength(value, 'utf8');
  if (terminalOutputBytes > 2 * 1024 * 1024) {
    win.webContents.send('terminal:output', { type: 'stderr', text: '\\n[Terminal output limit reached; shell stopped.]' });
    stopIntegratedTerminal();
    return;
  }
  win.webContents.send('terminal:output', { type, text: value });
}
function stopIntegratedTerminal() {
  if (!terminalProcess) return false;
  const child = terminalProcess;
  terminalProcess = null;
  try { child.kill('SIGTERM'); } catch {}
  return true;
}

/* ─── window ─── */
function sendEditorCommand(command) {
  if (win && !win.isDestroyed()) win.webContents.send('editor:command', command);
}

function installApplicationMenu() {
  const { Menu } = require('electron');
  const template = [
    { label: 'File', submenu: [
      { label: 'New File', accelerator: 'CmdOrCtrl+N', click: () => sendEditorCommand('new') },
      { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: () => sendEditorCommand('open') },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendEditorCommand('save') },
      { type: 'separator' }, { role: 'quit' }
    ]},
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'delete' },
      { type: 'separator' }, { role: 'selectAll' }, { type: 'separator' },
      { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => sendEditorCommand('find') },
      { label: 'Replace', accelerator: 'CmdOrCtrl+H', click: () => sendEditorCommand('replace') },
      { label: 'Go to Line', accelerator: 'CmdOrCtrl+G', click: () => sendEditorCommand('gotoLine') }
    ]},
    { label: 'View', submenu: [
      { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendEditorCommand('commandPalette') },
      { label: 'Quick Open…', accelerator: 'CmdOrCtrl+P', click: () => sendEditorCommand('quickOpen') },
      { type: 'separator' },
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }
    ]},
    { label: 'Help', submenu: [
      { label: 'Check for Updates…', click: () => { if (updateService) void updateService.checkNow(); } },
      { type: 'separator' },
      { label: 'About Nidavellir', click: () => dialog.showMessageBox(win, { type: 'info', title: 'About Nidavellir', message: 'Nidavellir ' + app.getVersion(), detail: 'An independent AI-assisted desktop coding environment.' }) }
    ]}
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1450, height: 920, minWidth: 980, minHeight: 650,
    backgroundColor: '#10131b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(async () => {
  installApplicationMenu();
  createWindow();
  pluginSystem.setWindow(win);

  // Start the updater before loading user plugins. A broken or slow plugin must
  // never prevent the installed app from checking for security and bug-fix updates.
  updateService = createUpdater({ app, autoUpdater, dialog, getWindow: () => win });
  void updateService.initialize().catch(error => {
    console.error('[updater] Failed to initialize:', error);
  });

  // Plugins are user-controlled code. Fail gracefully so a broken plugin does
  // not prevent the editor, terminal, or update service from opening.
  try {
    const pluginsDir = await prepareUserPluginsDir(app.getPath('userData'), path.join(__dirname, '..', 'plugins'));
    await pluginSystem.initPluginSystem(pluginsDir);
  } catch (error) {
    console.error('[plugins] Failed to initialize:', error);
    if (win && !win.isDestroyed()) {
      void dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Plugin startup issue',
        message: 'Nidavellir opened, but plugins could not be initialized.',
        detail: 'The editor and automatic update service remain available. Check the application logs for details.',
        buttons: ['OK'],
        noLink: true
      }).catch(() => {});
    }
  }
});
app.on('before-quit', () => { stopIntegratedTerminal(); if (updateService) updateService.dispose(); });
app.on('window-all-closed', () => { stopIntegratedTerminal(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    pluginSystem.setWindow(win);
  }
});


ipcMain.handle('updates:check', async () => updateService ? updateService.checkNow() : { state: 'starting', message: 'Update service is starting.', enabled: true });
ipcMain.handle('updates:status', () => updateService ? updateService.getStatus() : { state: 'starting', message: 'Update service is starting.', enabled: true });
ipcMain.handle('updates:set-enabled', async (_event, enabled) => {
  if (typeof enabled !== 'boolean') throw new Error('Update preference must be a boolean.');
  if (!updateService) throw new Error('Update service is not ready.');
  return updateService.setEnabled(enabled);
});

/* ═══════════════════════════════════════════════════════════
   FILE IPC
   ═══════════════════════════════════════════════════════════ */

ipcMain.handle('file:open', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Code and text', extensions: ['js','mjs','cjs','py','cpp','c','h','hpp','java','html','css','json','md','txt','ts','tsx','jsx','rs','go'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = path.resolve(result.filePaths[0]);
  activeWorkspaceRoot = path.dirname(filePath);
  approvedRoots.add(activeWorkspaceRoot);
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('File must be a regular file no larger than 2 MB.');
  const content = await fs.readFile(filePath, 'utf8');
  pluginSystem.notifyPlugins('fileOpen', { filePath, fileName: path.basename(filePath), content });
  return { filePath, content };
});

ipcMain.handle('file:save', async (_event, payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid save request.');
  validateTextPayload(payload.content, MAX_SAVE_BYTES, 'File content');
  // Save As always asks the user to choose a destination, even for an opened file.
  let filePath = payload.forceDialog === true ? null : payload.filePath;
  const userChosePath = !filePath;
  if (!filePath) {
    const result = await dialog.showSaveDialog(win, { defaultPath: payload.name || 'untitled.js' });
    if (result.canceled || !result.filePath) return null;
    filePath = result.filePath;
  }
  if (typeof filePath !== 'string' || filePath.length > 4096) throw new Error('Invalid file path.');
  filePath = path.resolve(filePath);
  if (userChosePath) approvedRoots.add(path.dirname(filePath));
  else if (!await isWithinApprovedRoot(filePath)) throw new Error('Save denied: choose a file through the Nidavellir file picker first.');
  // New files must never overwrite an existing path. Existing documents may
  // still be saved back to their own path after they have been opened explicitly.
  if (userChosePath) {
    try {
      await fs.lstat(filePath);
      throw new Error('A file with that name already exists. Choose a different filename.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  // Do not follow a symlink at the destination when saving editor content.
  try {
    const destinationStat = await fs.lstat(filePath);
    if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
      throw new Error('Save denied: destination must be a regular file, not a symlink or special file.');
    }
    if (!userChosePath && !await isWithinApprovedRoot(filePath)) {
      throw new Error('Save denied: destination resolves outside the approved folder.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await fs.writeFile(filePath, payload.content, {
      encoding: 'utf8',
      mode: 0o600,
      // wx is atomic and refuses a file created between the duplicate check and write.
      flag: userChosePath ? 'wx' : 'w'
    });
  } catch (error) {
    if (userChosePath && error.code === 'EEXIST') {
      throw new Error('A file with that name already exists. Choose a different filename.');
    }
    throw error;
  }
  const saved = { filePath, name: path.basename(filePath) };
  pluginSystem.notifyPlugins('fileSave', { filePath, fileName: saved.name, content: payload.content });
  return saved;
});

ipcMain.handle('file:open-folder', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const folder = path.resolve(result.filePaths[0]);
  activeWorkspaceRoot = folder;
  approvedRoots.add(folder);
  async function tree(dir, depth = 0) {
    if (depth > 3) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const output = [];
    for (const entry of entries.slice(0, 200)) {
      if (entry.name.startsWith('.') || ['node_modules','dist','.git'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) output.push({ name: entry.name, path: full, directory: true, children: await tree(full, depth + 1) });
      else output.push({ name: entry.name, path: full, directory: false });
    }
    return output;
  }
  return { folder, tree: await tree(folder) };
});

ipcMain.handle('file:read-path', async (_event, filePath) => {
  if (typeof filePath !== 'string' || filePath.length > 4096) throw new Error('Invalid file path.');
  const resolved = path.resolve(filePath);
  if (!await isWithinApprovedRoot(resolved)) throw new Error('Access denied: open a file or folder through the Nidavellir file picker first.');
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('File must be a regular file no larger than 2 MB.');
  const content = await fs.readFile(resolved, 'utf8');
  pluginSystem.notifyPlugins('fileOpen', { filePath: resolved, fileName: path.basename(resolved), content });
  return { filePath: resolved, content };
});

/* ═══════════════════════════════════════════════════════════
   RUNNER IPC
   ═══════════════════════════════════════════════════════════ */

// Legacy handler — delegates to safe runner
ipcMain.handle('runner:run', async (_event, payload) => {
  validateTextPayload(payload?.content, 2 * 1024 * 1024, 'Source code');
  if (payload?.filePath && !await isWithinApprovedRoot(payload.filePath)) throw new Error('Run denied: source path is outside an approved folder.');
  return runner.run(payload);
});

// Enhanced safe runner with state events and plugin hooks
ipcMain.handle('runner:run-safe', async (_event, payload) => {
  validateTextPayload(payload?.content, 2 * 1024 * 1024, 'Source code');
  if (payload?.filePath && !await isWithinApprovedRoot(payload.filePath)) throw new Error('Run denied: source path is outside an approved folder.');
  debugRunRequested = payload?.debug === true;
  if (debugRunRequested) {
    debugSourceSnapshot = null; debugScriptUrl = null; debugPaused = false;
    debugCallFrames = []; debugScopes = []; debugBreakpointIds = [];
    try { debugBreakpointLines = normalizeBreakpointLines(payload.breakpointLines || []); }
    catch (error) { debugRunRequested = false; throw error; }
    sendDebuggerNotification({ type:'starting', language:payload.language, breakpoints:debugBreakpointLines });
  }
  sendRunnerState(true);
  try {
    pluginSystem.notifyPlugins('beforeRun', {
      language: payload.language,
      fileName: payload.filePath ? path.basename(payload.filePath) : 'untitled',
      content: payload.content
    });
    const result = await runner.run(payload);
    pluginSystem.notifyPlugins('afterRun', {
      language: payload.language,
      fileName: payload.filePath ? path.basename(payload.filePath) : 'untitled',
      exitCode: result.code, durationMs: result.durationMs
    });
    return result;
  } catch (err) {
    sendOutput('stderr', err.message);
    return { code: 1, durationMs: 0 };
  } finally {
    sendRunnerState(false);
    if (debugRunRequested) {
      debugRunRequested = false;
      if (debugClient) debugClient.close();
      debugClient = null; debugScriptUrl = null; debugPaused = false;
      sendDebuggerNotification({ type:'stopped' });
    }
  }
});

ipcMain.handle('debugger:set-breakpoints', async (_event, lines) => {
  debugBreakpointLines = normalizeBreakpointLines(lines);
  return applyDebugBreakpoints();
});
ipcMain.handle('debugger:command', async (_event, payload = {}) => {
  if (typeof payload.command !== 'string') throw new Error('Invalid debugger command.');
  if (!debugClient) throw new Error('Start a debug run first.');
  const commands = {
    continue:'Debugger.resume', pause:'Debugger.pause',
    stepOver:'Debugger.stepOver', stepInto:'Debugger.stepInto', stepOut:'Debugger.stepOut'
  };
  if (payload.command === 'evaluate') {
    if (!debugPaused || !debugCallFrames[0]) throw new Error('Pause execution before evaluating an expression.');
    if (typeof payload.expression !== 'string' || !payload.expression.trim() || payload.expression.length > 500) throw new Error('Expression must contain 1–500 characters.');
    const result = await debugClient.send('Debugger.evaluateOnCallFrame', {
      callFrameId:debugCallFrames[0].callFrameId,
      expression:payload.expression,
      returnByValue:true, silent:true, throwOnSideEffect:true, timeout:1000
    });
    if (result && result.exceptionDetails) return { error:result.exceptionDetails.text || 'Expression evaluation failed.' };
    return { result: result && result.result ? (Object.hasOwn(result.result,'value') ? result.result.value : result.result.description || result.result.type) : null };
  }
  const method = commands[payload.command];
  if (!method) throw new Error('Debugger command is not allowed.');
  return debugClient.send(method, {});
});
ipcMain.handle('debugger:stop', async () => {
  try { if (debugClient) debugClient.close(); } catch {}
  debugClient = null; debugRunRequested = false; debugPaused = false;
  const result = await runner.kill();
  sendDebuggerNotification({ type:'stopped' });
  return result;
});

ipcMain.handle('runner:input', (_event, text) => {
  if (typeof text !== 'string' || text.length > 16_384) throw new Error('Input must be text no longer than 16 KB.');
  return { accepted: runner.writeInput(text) };
});
ipcMain.handle('runner:kill', () => runner.kill());
ipcMain.handle('runner:history', () => runner.getHistory());

/* Integrated terminal: explicit user-launched shell, scoped to an approved project folder. */
ipcMain.handle('terminal:start', async (_event, payload = {}) => {
  if (terminalProcess && !terminalProcess.killed) throw new Error('The integrated shell is already running.');
  let cwd = payload.cwd;
  if (cwd == null || cwd === '') cwd = [...approvedRoots].at(-1);
  if (typeof cwd !== 'string' || cwd.length > 4096) throw new Error('Open a project folder or file before starting the terminal.');
  cwd = path.resolve(cwd);
  if (!await isWithinApprovedRoot(cwd)) throw new Error('Terminal denied: open the project folder through Nidavellir first.');
  const stat = await fs.stat(cwd);
  if (!stat.isDirectory()) throw new Error('Terminal working directory must be a folder.');
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/bash');
  const args = process.platform === 'win32' ? ['/Q'] : ['--noprofile', '--norc', '-i'];
  terminalOutputBytes = 0;
  const child = spawn(command, args, {
    cwd, env: process.env, shell: false, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  terminalProcess = child;
  child.stdout.on('data', chunk => sendTerminalOutput('stdout', chunk.toString()));
  child.stderr.on('data', chunk => sendTerminalOutput('stderr', chunk.toString()));
  child.on('error', error => {
    sendTerminalOutput('stderr', error.message);
    if (terminalProcess === child) terminalProcess = null;
  });
  child.on('close', code => {
    sendTerminalOutput('muted', `\\n[Shell exited with code ${code ?? 1}]\\n`);
    if (terminalProcess === child) terminalProcess = null;
  });
  sendTerminalOutput('info', `\\n[Shell started: ${command} — ${cwd}]\\n[Commands execute with your operating-system user permissions.]\\n`);
  return { running: true, cwd };
});
ipcMain.handle('terminal:write', (_event, input) => {
  if (typeof input !== 'string' || input.length > 8192 || input.includes('\\0')) throw new Error('Invalid terminal input (maximum 8,192 characters).');
  if (!terminalProcess || terminalProcess.killed || !terminalProcess.stdin.writable) return { running: false };
  terminalProcess.stdin.write(input);
  return { running: true };
});
ipcMain.handle('terminal:stop', () => ({ stopped: stopIntegratedTerminal() }));

/* ═══════════════════════════════════════════════════════════
   AI — KEY STORAGE
   ═══════════════════════════════════════════════════════════ */

ipcMain.handle('ai:set-key', async (_event, { provider, key }) => {
  if (!allowedProviders.has(provider)) throw new Error('Unknown AI provider.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this system.');
  const encrypted = safeStorage.encryptString(String(key || ''));
  const keyPath = path.join(app.getPath('userData'), `key-${provider}.bin`);
  await fs.writeFile(keyPath, encrypted);
  keyCache[provider] = String(key || '');
  return { saved: true };
});

async function getKey(provider) {
  if (keyCache[provider]) return keyCache[provider];
  const keyPath = path.join(app.getPath('userData'), `key-${provider}.bin`);
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    const encrypted = await fs.readFile(keyPath);
    const key = safeStorage.decryptString(encrypted);
    keyCache[provider] = key;
    return key;
  } catch { return ''; }
}

ipcMain.handle('ai:key-status', async () => {
  const result = {};
  for (const p of allowedProviders) result[p] = Boolean(await getKey(p));
  return result;
});

/* ═══════════════════════════════════════════════════════════
   AI — PROVIDER HELPER
   ═══════════════════════════════════════════════════════════ */

async function callProvider(provider, key, userPrompt, systemPrompt, model) {
  const prompt = String(userPrompt || '').slice(0, 50000);
  const sys = String(systemPrompt || 'You are a helpful coding assistant. Explain changes clearly for a beginner.').slice(0, 10000);
  let url, headers, body;

  if (provider === 'openai') {
    url = 'https://api.openai.com/v1/chat/completions';
    headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    body = { model: model || modelDefaults.openai, messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }] };
  } else if (provider === 'gemini') {
    const m = model || modelDefaults.gemini;
    // Keep credentials out of URLs, which can be retained in logs and diagnostics.
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`;
    headers = { 'Content-Type': 'application/json', 'x-goog-api-key': key };
    body = { systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  } else {
    url = 'https://api.anthropic.com/v1/messages';
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    body = { model: model || modelDefaults.claude, max_tokens: 4096, system: sys, messages: [{ role: 'user', content: prompt }] };
  }

  const response = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `${provider} API request failed (${response.status}). Check the key, model, network, and provider billing.`);
  if (provider === 'openai') return data.choices?.[0]?.message?.content || 'No text returned.';
  if (provider === 'gemini') return data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n') || 'No text returned.';
  return data.content?.map(p => p.text || '').join('\n') || 'No text returned.';
}

/* ═══════════════════════════════════════════════════════════
   AI — ASK (original multi-provider endpoint)
   ═══════════════════════════════════════════════════════════ */

ipcMain.handle('ai:ask', async (_event, { provider, prompt, system, model }) => {
  if (!allowedProviders.has(provider)) throw new Error('Unknown provider.');
  const key = await getKey(provider);
  if (!key) throw new Error(`Add your ${provider} API key in Settings first.`);
  return callProvider(provider, key, prompt, system, model);
});

/* ═══════════════════════════════════════════════════════════
   AI — COORDINATOR (synthesis)
   ═══════════════════════════════════════════════════════════ */

ipcMain.handle('ai:synthesize', async (_event, { responses }) => {
  const askAIFn = async (prompt, system) => {
    // Pick the first provider that has a key configured
    for (const provider of ['gemini', 'openai', 'claude']) {
      const key = await getKey(provider);
      if (key) return callProvider(provider, key, prompt, system);
    }
    throw new Error('No AI provider configured for synthesis.');
  };
  return synthesizeResponses({ responses, askAIFn });
});

/* ═══════════════════════════════════════════════════════════
   AI — TEST GENERATION
   ═══════════════════════════════════════════════════════════ */

ipcMain.handle('ai:generate-tests', async (_event, { code, language, fileName }) => {
  for (const provider of ['gemini', 'openai', 'claude']) {
    const key = await getKey(provider);
    if (key) {
      const prompt =
        `Generate comprehensive unit tests for the following ${language} code.\n\n` +
        `File: ${fileName}\n\n` +
        `\`\`\`${language}\n${(code || '').slice(0, 30000)}\n\`\`\`\n\n` +
        `Provide the complete test file content ready to save and run. ` +
        `Use the standard testing framework for ${language} (e.g., node:test for JavaScript, pytest for Python). ` +
        `Include edge cases and error cases. Make the tests beginner-friendly with clear descriptions.`;
      const system =
        'You are an expert test engineer. Generate well-structured, runnable test code. ' +
        'Output ONLY the test file content inside a single fenced code block. ' +
        'Do not include explanatory text outside the code block.';
      return callProvider(provider, key, prompt, system);
    }
  }
  throw new Error('Add at least one AI provider API key in Settings to generate tests.');
});

registerStudioIpc({
  ipcMain, app, dialog, getWindow: () => win, approvedRoots, isWithinApprovedRoot,
  getActiveWorkspaceRoot: () => activeWorkspaceRoot, getKey, callProvider
});

/* ═══════════════════════════════════════════════════════════
   PLUGINS IPC
   ═══════════════════════════════════════════════════════════ */

ipcMain.handle('plugins:init', async () => {
  const pluginsDir = await prepareUserPluginsDir(app.getPath('userData'), path.join(__dirname, '..', 'plugins'));
  await pluginSystem.initPluginSystem(pluginsDir);
});
ipcMain.handle('plugins:open-user-folder', async () => {
  const pluginsDir = await prepareUserPluginsDir(app.getPath('userData'), path.join(__dirname, '..', 'plugins'));
  const error = await shell.openPath(pluginsDir);
  if (error) throw new Error(error);
  return { path: pluginsDir };
});
ipcMain.handle('plugins:list', () => pluginSystem.getPlugins());
ipcMain.handle('plugins:toggle', async (_event, payload) => {
  if (!payload || typeof payload.name !== 'string' || typeof payload.enabled !== 'boolean') throw new Error('Invalid plugin toggle request.');
  if (payload.enabled) {
    const info = pluginSystem.getPlugins().find(plugin => plugin.name === payload.name);
    const unrestricted = Boolean(info && info.permissions.includes('native:unrestricted'));
    const answer = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', unrestricted ? 'Enable unrestricted plugin' : 'Enable restricted plugin'],
      defaultId: 0, cancelId: 0,
      title: unrestricted ? 'Enable unrestricted native plugin?' : 'Enable restricted plugin?',
      message: unrestricted
        ? 'This plugin explicitly requests unrestricted Node.js and operating-system user permissions.'
        : 'This plugin runs in a restricted JavaScript context with only declared Nidavellir capabilities.',
      detail: (unrestricted
        ? 'Native plugins can read and modify files, execute commands, and access resources available to your user account. Enable only after reviewing every source file.'
        : 'Restricted execution is defense in depth, not a strong OS security boundary. Do not enable untrusted code. Review its requested capabilities and source before continuing.') +
        '\n\nPlugin: ' + payload.name + '\nCapabilities: ' + (info && info.permissions.length ? info.permissions.join(', ') : 'none')
    });
    if (answer.response !== 1) return false;
  }
  return pluginSystem.setPluginEnabled(payload.name, payload.enabled);
});
ipcMain.handle('plugins:quick-actions', () => pluginSystem.getQuickActions());
ipcMain.handle('plugins:status-items', () => pluginSystem.getStatusItems());
