const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { createSafeRunner } = require('./safe-runner');
const { synthesizeResponses } = require('./coordinator');
const pluginSystem = require('./plugins');

/* ─── globals ─── */
let win;
const keyCache = {};
const allowedProviders = new Set(['openai', 'gemini', 'claude']);
const approvedRoots = new Set();
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SAVE_BYTES = 5 * 1024 * 1024;

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
  if (win && !win.isDestroyed()) win.webContents.send('runner:output', { type, text: String(text) });
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
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }
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
  const pluginsDir = path.join(__dirname, '..', 'plugins');
  await pluginSystem.initPluginSystem(pluginsDir);
});
app.on('before-quit', () => { stopIntegratedTerminal(); });
app.on('window-all-closed', () => { stopIntegratedTerminal(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

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
  approvedRoots.add(path.dirname(filePath));
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('File must be a regular file no larger than 2 MB.');
  const content = await fs.readFile(filePath, 'utf8');
  pluginSystem.notifyPlugins('fileOpen', { filePath, fileName: path.basename(filePath), content });
  return { filePath, content };
});

ipcMain.handle('file:save', async (_event, payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid save request.');
  validateTextPayload(payload.content, MAX_SAVE_BYTES, 'File content');
  let filePath = payload.filePath;
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
  }
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

/* ═══════════════════════════════════════════════════════════
   PLUGINS IPC
   ═══════════════════════════════════════════════════════════ */

ipcMain.handle('plugins:init', async () => {
  const pluginsDir = path.join(__dirname, '..', 'plugins');
  await pluginSystem.initPluginSystem(pluginsDir);
});
ipcMain.handle('plugins:list', () => pluginSystem.getPlugins());
ipcMain.handle('plugins:toggle', async (_event, payload) => {
  if (!payload || typeof payload.name !== 'string' || typeof payload.enabled !== 'boolean') throw new Error('Invalid plugin toggle request.');
  if (payload.enabled) {
    const answer = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Enable plugin'],
      defaultId: 0, cancelId: 0,
      title: 'Enable trusted plugin?',
      message: 'Plugins execute JavaScript with Nidavellir’s operating-system permissions.',
      detail: `Only enable plugins whose source you have reviewed and trust. A plugin can read or modify files and access resources available to this app. This confirmation is not a sandbox.\n\nPlugin: ${payload.name}`
    });
    if (answer.response !== 1) return false;
  }
  return pluginSystem.setPluginEnabled(payload.name, payload.enabled);
});
ipcMain.handle('plugins:quick-actions', () => pluginSystem.getQuickActions());
ipcMain.handle('plugins:status-items', () => pluginSystem.getStatusItems());
