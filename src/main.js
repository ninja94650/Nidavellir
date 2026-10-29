const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, clipboard } = require('electron');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const { createSafeRunner } = require('./safe-runner');
const { synthesizeResponses } = require('./coordinator');
const pluginSystem = require('./plugins');
const { autoUpdater } = require('electron-updater');
const { createUpdater } = require('./updater');
const { prepareUserPluginsDir } = require('./user-plugins');

/* ─── globals ─── */
let win;
let updateService = null;
const providerKeyCache = {};
const allowedProviders = new Set(['openai', 'gemini', 'claude', 'openrouter']);
// OpenAI-compatible endpoint for the IDE's GPT-style agent. Override only if needed.
const openAiCompatibleBaseUrl = (process.env.NIDAVELLIR_OPENAI_BASE_URL || 'https://omni.inamoriyama.com/v1').replace(/\/+$/, '');
const approvedRoots = new Set();
// Explicit grants are limited to this app process. No grant is written to disk.
// Keys are exact normalized file paths; a grant never expands workspace roots.
const readGrants = {
  once: new Set(),
  conversation: new Set(),
  outsideWorkspace: new Set(),
  session: new Set()
};
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
  claude: 'claude-sonnet-4-20250514',
  openrouter: 'openai/gpt-4o-mini'
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
    autoHideMenuBar: true,
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

async function buildFolderTree(dir, depth = 0) {
  if (depth > 3) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const output = [];
  for (const entry of entries.slice(0, 200)) {
    if (entry.name.startsWith('.') || ['node_modules','dist','.git'].includes(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push({ name: entry.name, path: full, directory: true, children: await buildFolderTree(full, depth + 1) });
    else if (entry.isFile()) output.push({ name: entry.name, path: full, directory: false });
  }
  return output;
}
ipcMain.handle('file:open-folder', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const folder = path.resolve(result.filePaths[0]);
  approvedRoots.add(folder);
  return { folder, tree: await buildFolderTree(folder) };
});

ipcMain.handle('file:read-path', async (_event, filePath) => {
  if (typeof filePath !== 'string' || filePath.length > 4096) throw new Error('Invalid file path.');
  const resolved = path.resolve(filePath);
  if (!await isWithinApprovedRoot(resolved)) {
    // Check exact-path grants before prompting. Grants never authorize sibling files,
    // directories, commands, or other applications.
    const hasGrant = readGrants.conversation.has(resolved) ||
      readGrants.outsideWorkspace.has(resolved) || readGrants.session.has(resolved);
    if (!hasGrant) {
      const answer = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: [
          'Yes, allow this time',
          'Yes, allow this exact file until Nidavellir closes',
          'Yes, allow this exact file for this session (outside workspace only)',
          'Yes, always allow this exact file until Nidavellir closes',
          'No — deny access'
        ],
        defaultId: 4,
        cancelId: 4,
        noLink: true,
        title: 'Permission required: outside workspace',
        message: 'The AI is requesting access outside the approved workspace.',
        detail: 'Requested action: Read file contents\nRequested file: ' + resolved +
          '\n\nChoose the narrowest permission. Permissions apply only to this exact file path and never grant access to folders, other files, commands, or applications. Session grants are cleared when Nidavellir closes.'
      });
      if (answer.response === 0) {
        readGrants.once.add(resolved);
      } else if (answer.response === 1) {
        readGrants.conversation.add(resolved);
      } else if (answer.response === 2) {
        readGrants.outsideWorkspace.add(resolved);
      } else if (answer.response === 3) {
        readGrants.session.add(resolved);
      } else {
        throw new Error('Access denied: you did not approve reading this file.');
      }
    }
    // A one-time grant is consumed before reading so errors/retries cannot silently
    // broaden or reuse it.
    if (readGrants.once.has(resolved)) readGrants.once.delete(resolved);
  }
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('File must be a regular, non-symbolic-link file no larger than 2 MB.');
  const content = await fs.readFile(resolved, 'utf8');
  pluginSystem.notifyPlugins('fileOpen', { filePath: resolved, fileName: path.basename(resolved), content });
  return { filePath: resolved, content };
});


async function resolveApprovedFile(filePath, label = 'File') {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 4096) throw new Error('Invalid file path.');
  const resolved = path.resolve(filePath);
  if (!await isWithinApprovedRoot(resolved)) throw new Error('Access denied: path is outside the opened workspace.');
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(label + ' must be a regular file.');
  return { resolved, stat };
}
async function resolveApprovedDirectory(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath || dirPath.length > 4096) throw new Error('Invalid folder path.');
  const resolved = path.resolve(dirPath);
  if (!await isWithinApprovedRoot(resolved)) throw new Error('Access denied: folder is outside the opened workspace.');
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Destination must be a regular folder.');
  return { resolved, stat };
}
ipcMain.handle('file:reveal', async (_event, filePath) => {
  if (typeof filePath !== 'string') throw new Error('Invalid file path.');
  const resolved = path.resolve(filePath);
  if (!await isWithinApprovedRoot(resolved)) throw new Error('Reveal denied: path is outside the opened workspace.');
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) throw new Error('Reveal denied: symbolic links are not supported.');
  if (stat.isDirectory()) { const error = await shell.openPath(resolved); if (error) throw new Error(error); }
  else shell.showItemInFolder(resolved);
  return { success: true };
});
ipcMain.handle('file:open-with', async (_event, filePath) => {
  const { resolved } = await resolveApprovedFile(filePath, 'File to open');
  const filters = process.platform === 'win32' ? [{ name: 'Applications', extensions: ['exe'] }]
    : process.platform === 'darwin' ? [{ name: 'Applications', extensions: ['app'] }, { name: 'All files', extensions: ['*'] }]
    : [{ name: 'Applications and executables', extensions: ['AppImage','bin','sh','desktop','exe'] }, { name: 'All files', extensions: ['*'] }];
  const result = await dialog.showOpenDialog(win, { title: 'Choose an application to open ' + path.basename(resolved), properties: ['openFile'], filters });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const executable = path.resolve(result.filePaths[0]);
  if (process.platform === 'win32' && path.extname(executable).toLowerCase() !== '.exe') throw new Error('Choose a Windows .exe application.');
  await new Promise((resolve, reject) => {
    const macApp = process.platform === 'darwin' && executable.toLowerCase().endsWith('.app');
    const child = spawn(macApp ? 'open' : executable, macApp ? ['-a', executable, resolved] : [resolved], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { success: true };
});
ipcMain.handle('file:rename', async (_event, payload) => {
  const { resolved: source } = await resolveApprovedFile(payload && payload.filePath, 'Source');
  const newName = payload && payload.newName, forbidden = '/\\:*?"<>|';
  if (typeof newName !== 'string' || !newName.trim() || newName.length > 255 || newName === '.' || newName === '..' ||
      path.basename(newName) !== newName || [...newName].some(ch => forbidden.includes(ch) || ch.charCodeAt(0) < 32)) {
    throw new Error('Enter a valid filename without folder paths or reserved characters.');
  }
  const target = path.join(path.dirname(source), newName.trim());
  if (!await isWithinApprovedRoot(target)) throw new Error('Rename denied: target is outside the opened workspace.');
  try { await fs.lstat(target); throw new Error('A file with that name already exists.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
  try { await fs.unlink(source); } catch (error) { await fs.unlink(target).catch(() => {}); throw error; }
  return { filePath: target, name: path.basename(target) };
});
ipcMain.handle('file:delete', async (_event, filePath) => {
  const { resolved } = await resolveApprovedFile(filePath, 'File to delete');
  const result = await dialog.showMessageBox(win, { type:'warning', title:'Delete file?', message:'Delete '+path.basename(resolved)+'?', detail:'This permanently deletes the file from disk. This action cannot be undone.', buttons:['Delete','Cancel'], defaultId:1, cancelId:1, noLink:true });
  if (result.response !== 0) return { canceled: true };
  await fs.unlink(resolved);
  return { success: true, filePath: resolved };
});
ipcMain.handle('file:transfer', async (_event, payload) => {
  if (!payload || !['copy','move'].includes(payload.mode)) throw new Error('Transfer mode must be copy or move.');
  const { resolved: source } = await resolveApprovedFile(payload.sourcePath, 'Source');
  const { resolved: directory } = await resolveApprovedDirectory(payload.destinationDirectory);
  const target = path.join(directory, path.basename(source));
  if (source === target) throw new Error('The source and destination are the same file.');
  if (!await isWithinApprovedRoot(target)) throw new Error('Transfer denied: destination is outside the opened workspace.');
  await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
  if (payload.mode === 'move') { try { await fs.unlink(source); } catch (error) { await fs.unlink(target).catch(() => {}); throw error; } }
  return { filePath: target, sourcePath: source, mode: payload.mode };
});
ipcMain.handle('file:refresh-folder', async (_event, folderPath) => {
  const { resolved } = await resolveApprovedDirectory(folderPath);
  return { folder: resolved, tree: await buildFolderTree(resolved) };
});
ipcMain.handle('file:info', async (_event, filePath) => {
  const { resolved, stat } = await resolveApprovedFile(filePath);
  return { filePath:resolved, name:path.basename(resolved), size:stat.size, modifiedAt:stat.mtime.toISOString(), createdAt:stat.birthtime.toISOString() };
});
ipcMain.handle('file:relative-path', async (_event, payload) => {
  if (!payload || typeof payload.root !== 'string' || typeof payload.filePath !== 'string') throw new Error('Invalid relative-path request.');
  const root = path.resolve(payload.root), filePath = path.resolve(payload.filePath);
  if (!await isWithinApprovedRoot(root) || !await isWithinApprovedRoot(filePath)) throw new Error('Path is outside the opened workspace.');
  const relative = path.relative(root,filePath);
  if (!relative || relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw new Error('File is not inside the workspace root.');
  return relative;
});
ipcMain.handle('file:copy-text', async (_event, value) => {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Clipboard text is invalid or too long.');
  clipboard.writeText(value); return { success:true };
});

/* ═══════════════════════════════════════════════════════════
   AI PROJECT BUILDER — workspace inspection and approved tests
   ═══════════════════════════════════════════════════════════ */
ipcMain.handle('project:inspect', async (_event, payload) => {
  if (!payload || typeof payload.root !== 'string') throw new Error('Choose a workspace first.');
  const { resolved: root } = await resolveApprovedDirectory(payload.root);
  const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.venv', 'venv', 'vendor', 'target', 'out']);
  const secretName = /(?:^|[._-])(?:env|pem|key|p12|pfx|keystore|credentials?)(?:[._-]|$)/i;
  const files = [];
  let totalBytes = 0;
  const MAX_FILES = 60, MAX_TOTAL = 300 * 1024, MAX_FILE = 32 * 1024;
  async function walk(dir, depth) {
    if (depth > 8 || files.length >= MAX_FILES || totalBytes >= MAX_TOTAL) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_FILES || totalBytes >= MAX_TOTAL) break;
      if (entry.name === '.git' || entry.name.startsWith('.nidavellir-')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name) && !entry.name.startsWith('.')) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || secretName.test(entry.name) || /(^|\\/)(\.env($|\.)|id_rsa|id_ed25519)/i.test(full)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const allowed = new Set(['.js','.jsx','.ts','.tsx','.mjs','.cjs','.json','.html','.css','.scss','.md','.txt','.py','.cpp','.c','.h','.hpp','.java','.go','.rs','.rb','.php','.yml','.yaml','.toml','.xml','.sql','.sh','.ps1','.vue','.svelte']);
      if (!allowed.has(ext)) continue;
      try {
        const stat = await fs.lstat(full);
        if (stat.size > MAX_FILE || stat.size === 0) continue;
        const content = await fs.readFile(full, 'utf8');
        if (content.includes('\\0')) continue;
        const relative = path.relative(root, full).split(path.sep).join('/');
        files.push({ path: relative, content });
        totalBytes += Buffer.byteLength(content, 'utf8');
      } catch {}
    }
  }
  await walk(root, 0);
  return { root, files, truncated: files.length >= MAX_FILES || totalBytes >= MAX_TOTAL, totalBytes };
});

ipcMain.handle('project:run-tests', async (_event, payload) => {
  if (!payload || typeof payload.root !== 'string') throw new Error('Choose a workspace first.');
  const { resolved: root } = await resolveApprovedDirectory(payload.root);
  const packagePath = path.join(root, 'package.json');
  let packageJson;
  try { packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8')); }
  catch { throw new Error('No valid package.json was found. Automatic test execution currently requires a package.json with a test script.'); }
  if (!packageJson.scripts || typeof packageJson.scripts.test !== 'string' || !packageJson.scripts.test.trim()) {
    throw new Error('This project does not define scripts.test in package.json.');
  }
  const commandLabel = process.platform === 'win32' ? 'npm.cmd test' : 'npm test';
  const approval = await dialog.showMessageBox(win, {
    type: 'warning', title: 'Run project tests?',
    message: 'Allow this project to execute its configured test script?',
    detail: 'Workspace: ' + root + '\nCommand: ' + commandLabel +
      '\npackage.json scripts.test: ' + packageJson.scripts.test.slice(0, 500) +
      '\n\nProject scripts can execute arbitrary code with your account permissions. Continue only if you trust this workspace.',
    buttons: ['Run tests', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
  });
  if (approval.response !== 0) return { canceled: true, code: null, stdout: '', stderr: '' };
  return await new Promise(resolve => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], {
      cwd: root, shell: process.platform === 'win32', windowsHide: true,
      env: (() => {
        const safeEnv = {};
        const allow = process.platform === 'win32'
          ? ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT']
          : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'];
        for (const key of allow) if (process.env[key]) safeEnv[key] = process.env[key];
        return safeEnv;
      })(), stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', settled = false, outputBytes = 0;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const collect = (type, chunk) => {
      outputBytes += chunk.length;
      const text = chunk.toString();
      if (outputBytes <= 256 * 1024) {
        if (type === 'stdout') stdout += text; else stderr += text;
      }
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.once('error', error => finish({ canceled: false, code: 127, stdout, stderr: stderr + error.message, truncated: outputBytes > 256 * 1024 }));
    child.once('close', code => finish({ canceled: false, code: code ?? 1, stdout, stderr, truncated: outputBytes > 256 * 1024 }));
    const timer = setTimeout(() => { child.kill(); finish({ canceled: false, code: 124, stdout, stderr: stderr + '\nTest command timed out after 120 seconds.', timedOut: true, truncated: outputBytes > 256 * 1024 }); }, 120_000);
    timer.unref?.();
  });
});

/* ═══════════════════════════════════════════════════════════
   AI PROJECT BUILDER — bounded, user-approved workspace writes
   ═══════════════════════════════════════════════════════════ */
ipcMain.handle('project:apply-changes', async (_event, payload) => {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.changes)) throw new Error('Invalid project change set.');
  const { resolved: root } = await resolveApprovedDirectory(payload.root);
  if (payload.changes.length < 1 || payload.changes.length > 30) throw new Error('A project build must contain between 1 and 30 files.');
  const prepared = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const change of payload.changes) {
    if (!change || typeof change.path !== 'string' || typeof change.content !== 'string') throw new Error('Every project file needs a relative path and text content.');
    validateTextPayload(change.content, 1024 * 1024, 'Project file');
    const rel = change.path.replace(/\\/g, '/');
    if (!rel || rel.length > 240 || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) ||
        rel.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) {
      throw new Error('Unsafe project path: ' + change.path);
    }
    const target = path.resolve(root, ...rel.split('/'));
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Project path escapes the opened workspace.');
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    if (seen.has(key)) throw new Error('Duplicate project path: ' + rel);
    seen.add(key);
    totalBytes += Buffer.byteLength(change.content, 'utf8');
    if (totalBytes > 5 * 1024 * 1024) throw new Error('Project changes exceed the 5 MB total limit.');
    prepared.push({ relative: rel, target, content: change.content });
  }
  const existing = [];
  for (const item of prepared) {
    const segments = item.relative.split('/');
    let cursor = root;
    let parentMissing = false;
    for (const segment of segments.slice(0, -1)) {
      cursor = path.join(cursor, segment);
      try {
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe project directory: ' + segment);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        parentMissing = true;
        break;
      }
    }
    // Missing parent directories are created only after the user approves the complete file plan.
    item.parentMissing = parentMissing;
    try {
      const stat = await fs.lstat(item.target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Refusing to overwrite a symbolic link or non-file: ' + item.relative);
      existing.push(item.relative);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const preview = prepared.slice(0, 12).map(item => (existing.includes(item.relative) ? 'UPDATE  ' : 'CREATE  ') + item.relative).join('\n');
  const result = await dialog.showMessageBox(win, {
    type: 'warning', title: 'Review AI project changes',
    message: 'Apply ' + prepared.length + ' AI-generated file changes?',
    detail: preview + (prepared.length > 12 ? '\n…and ' + (prepared.length - 12) + ' more file(s).' : '') +
      (existing.length ? '\n\n' + existing.length + ' existing file(s) will be backed up before replacement.' : '') +
      '\n\nOnly the listed files will be changed. No shell commands will be run automatically.',
    buttons: ['Apply changes', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
  });
  if (result.response !== 0) return { canceled: true, applied: 0 };
  const backupRoot = path.join(app.getPath('userData'), 'project-backups', Date.now() + '-' + randomUUID());
  let applied = 0;
  try {
    for (const item of prepared) {
      await fs.mkdir(path.dirname(item.target), { recursive: true });
      try {
        const stat = await fs.lstat(item.target);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Destination changed after approval: ' + item.relative);
        await fs.mkdir(backupRoot, { recursive: true });
        const backupPath = path.join(backupRoot, ...item.relative.split('/'));
        await fs.mkdir(path.dirname(backupPath), { recursive: true });
        await fs.copyFile(item.target, backupPath, fsConstants.COPYFILE_EXCL);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const tempPath = item.target + '.nidavellir-' + randomUUID() + '.tmp';
      await fs.writeFile(tempPath, item.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try { await fs.rename(tempPath, item.target); }
      catch (error) { await fs.unlink(tempPath).catch(() => {}); throw error; }
      applied++;
    }
  } catch (error) {
    throw new Error('Project build stopped after ' + applied + ' file(s). Existing files were backed up in the application data folder. Cause: ' + error.message);
  }
  return { canceled: false, applied, files: prepared.map(item => item.relative), backupRoot: existing.length ? backupRoot : null };
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

async function persistProviderKeys(provider, keys) {
  if (!allowedProviders.has(provider)) throw new Error('Unknown AI provider.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this system.');
  const encrypted = safeStorage.encryptString(JSON.stringify(keys));
  await fs.writeFile(path.join(app.getPath('userData'), `keys-${provider}.bin`), encrypted, { mode: 0o600 });
  providerKeyCache[provider] = keys;
}
async function loadProviderKeys(provider) {
  if (!allowedProviders.has(provider)) throw new Error('Unknown AI provider.');
  if (providerKeyCache[provider]) return providerKeyCache[provider];
  if (!safeStorage.isEncryptionAvailable()) return [];
  try {
    const parsed = JSON.parse(safeStorage.decryptString(await fs.readFile(path.join(app.getPath('userData'), `keys-${provider}.bin`))));
    if (Array.isArray(parsed)) {
      providerKeyCache[provider] = parsed.filter(item => item && typeof item.id === 'string' && typeof item.key === 'string');
      return providerKeyCache[provider];
    }
  } catch {}
  // Migrate existing encrypted single-key storage.
  try {
    const oldKey = safeStorage.decryptString(await fs.readFile(path.join(app.getPath('userData'), `key-${provider}.bin`)));
    if (oldKey) {
      const migrated = [{ id: randomUUID(), label: 'Existing key', key: oldKey, active: true, createdAt: Date.now() }];
      await persistProviderKeys(provider, migrated);
      return migrated;
    }
  } catch {}
  providerKeyCache[provider] = [];
  return providerKeyCache[provider];
}
ipcMain.handle('ai:set-key', async (_event, payload = {}) => {
  const provider = payload.provider, key = typeof payload.key === 'string' ? payload.key.trim() : '';
  const label = typeof payload.label === 'string' ? payload.label.trim().slice(0, 80) : '';
  const agentCount = Number.isInteger(payload.agentCount) ? Math.max(1, Math.min(8, payload.agentCount)) : 1;
  if (!allowedProviders.has(provider)) throw new Error('Unknown AI provider.');
  if (!key || key.length > 8192) throw new Error('Enter an API key between 1 and 8,192 characters.');
  const keys = await loadProviderKeys(provider), id = randomUUID();
  await persistProviderKeys(provider, [...keys, { id, label: label || `Key ${keys.length + 1}`, key, active: keys.length === 0, agentCount, createdAt: Date.now() }]);
  return { saved: true, id };
});
ipcMain.handle('ai:list-keys', async () => {
  const result = {};
  for (const provider of allowedProviders) result[provider] = (await loadProviderKeys(provider)).map(({ id, label, active, createdAt, agentCount, key }) => ({ id, label, active: Boolean(active), createdAt, agentCount: Math.max(1, Math.min(8, Number(agentCount) || 1)), lastFour: key.slice(-4) }));
  return result;
});
ipcMain.handle('ai:set-active-key', async (_event, { provider, id } = {}) => {
  if (!allowedProviders.has(provider) || typeof id !== 'string') throw new Error('Invalid API key selection.');
  const keys = await loadProviderKeys(provider);
  if (!keys.some(item => item.id === id)) throw new Error('That API key no longer exists.');
  await persistProviderKeys(provider, keys.map(item => ({ ...item, active: item.id === id })));
  return { active: id };
});
ipcMain.handle('ai:delete-key', async (_event, { provider, id } = {}) => {
  if (!allowedProviders.has(provider) || typeof id !== 'string') throw new Error('Invalid API key removal request.');
  const keys = await loadProviderKeys(provider);
  if (!keys.some(item => item.id === id)) throw new Error('That API key no longer exists.');
  let next = keys.filter(item => item.id !== id);
  if (keys.find(item => item.id === id)?.active && next.length) next = next.map((item, index) => ({ ...item, active: index === 0 }));
  await persistProviderKeys(provider, next);
  return { deleted: true };
});
async function getKey(provider) {
  const keys = await loadProviderKeys(provider);
  return keys.find(item => item.active)?.key || keys[0]?.key || '';
}
ipcMain.handle('ai:ask-key', async (_event, { provider, keyId, prompt, system, model } = {}) => {
  if (!allowedProviders.has(provider) || typeof keyId !== 'string') throw new Error('Invalid agent key selection.');
  if (typeof prompt !== 'string' || prompt.length > 100000) throw new Error('Prompt is empty or too large.');
  const keys = await loadProviderKeys(provider);
  const item = keys.find(entry => entry.id === keyId);
  if (!item) throw new Error('The API key for this agent no longer exists.');
  return callProvider(provider, item.key, prompt, system, model);
});
ipcMain.handle('ai:key-status', async () => {
  const result = {};
  for (const provider of allowedProviders) result[provider] = (await loadProviderKeys(provider)).length > 0;
  return result;
});

/* ═══════════════════════════════════════════════════════════
   AI — PROVIDER HELPER
   ═══════════════════════════════════════════════════════════ */

async function callProvider(provider, key, userPrompt, systemPrompt, model) {
  const prompt = String(userPrompt || '').slice(0, 50000);
  const sys = String(systemPrompt || 'You are a helpful coding assistant. Explain changes clearly for a beginner.').slice(0, 10000);
  let url, headers, body;

  if (provider === 'openai' || provider === 'openrouter') {
    url = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : `${openAiCompatibleBaseUrl}/chat/completions`;
    headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    if (provider === 'openrouter') { headers['HTTP-Referer'] = 'https://github.com/ninja94650/Nidavellir'; headers['X-Title'] = 'Nidavellir IDE'; }
    body = { model: model || modelDefaults[provider], messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }] };
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
  if (provider === 'openai' || provider === 'openrouter') return data.choices?.[0]?.message?.content || 'No text returned.';
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
    throw new Error('Add a supported AI provider API key in AI Workbench settings to synthesize responses.');
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
  const prompt = [
    `Generate comprehensive unit tests for the following ${language} code.`,
    `File: ${fileName}`,
    '```' + language + '\n' + String(code || '').slice(0, 30000) + '\n```',
    `Provide the complete test file content ready to save and run. Use the standard testing framework for ${language}, including edge cases and error cases.`
  ].join('\n\n');
  throw new Error('Add a supported AI provider API key in AI Workbench settings to generate tests.');
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
