const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

const { createSafeRunner } = require('./safe-runner');
const { synthesizeResponses } = require('./coordinator');
const pluginSystem = require('./plugins');

/* ─── globals ─── */
let win;
const keyCache = {};
const allowedProviders = new Set(['openai', 'gemini', 'claude']);
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

/* ─── window ─── */
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
  createWindow();
  pluginSystem.setWindow(win);
  const pluginsDir = path.join(__dirname, '..', 'plugins');
  await pluginSystem.initPluginSystem(pluginsDir);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
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
  const filePath = result.filePaths[0];
  const content = await fs.readFile(filePath, 'utf8');
  pluginSystem.notifyPlugins('fileOpen', { filePath, fileName: path.basename(filePath), content });
  return { filePath, content };
});

ipcMain.handle('file:save', async (_event, payload) => {
  let filePath = payload.filePath;
  if (!filePath) {
    const result = await dialog.showSaveDialog(win, { defaultPath: payload.name || 'untitled.js' });
    if (result.canceled || !result.filePath) return null;
    filePath = result.filePath;
  }
  await fs.writeFile(filePath, payload.content, 'utf8');
  const saved = { filePath, name: path.basename(filePath) };
  pluginSystem.notifyPlugins('fileSave', { filePath, fileName: saved.name, content: payload.content });
  return saved;
});

ipcMain.handle('file:open-folder', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const folder = result.filePaths[0];
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
  const resolved = path.resolve(filePath);
  const content = await fs.readFile(resolved, 'utf8');
  pluginSystem.notifyPlugins('fileOpen', { filePath: resolved, fileName: path.basename(resolved), content });
  return { filePath: resolved, content };
});

/* ═══════════════════════════════════════════════════════════
   RUNNER IPC
   ═══════════════════════════════════════════════════════════ */

// Legacy handler — delegates to safe runner
ipcMain.handle('runner:run', async (_event, payload) => {
  return runner.run(payload);
});

// Enhanced safe runner with state events and plugin hooks
ipcMain.handle('runner:run-safe', async (_event, payload) => {
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
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`;
    headers = { 'Content-Type': 'application/json' };
    body = { systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  } else {
    url = 'https://api.anthropic.com/v1/messages';
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    body = { model: model || modelDefaults.claude, max_tokens: 4096, system: sys, messages: [{ role: 'user', content: prompt }] };
  }

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
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
ipcMain.handle('plugins:toggle', (_event, { name, enabled }) => pluginSystem.setPluginEnabled(name, enabled));
ipcMain.handle('plugins:quick-actions', () => pluginSystem.getQuickActions());
ipcMain.handle('plugins:status-items', () => pluginSystem.getStatusItems());
