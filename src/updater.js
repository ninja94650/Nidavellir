const fs = require('node:fs/promises');
const path = require('node:path');

const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;

function createUpdater({ app, autoUpdater, dialog, getWindow = () => null, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  if (!app || !autoUpdater || !dialog) throw new TypeError('Updater requires app, autoUpdater, and dialog.');
  const settingsPath = path.join(app.getPath('userData'), 'updates.json');
  let interval = null;
  let initialized = false;
  let checking = false;
  let restartPromptOpen = false;
  let status = { state: 'starting', message: 'Preparing update service…', enabled: true, currentVersion: app.getVersion(), progress: 0 };
  function getStatus() { return { ...status }; }
  function publish(next) {
    status = { ...status, ...next, currentVersion: app.getVersion() };
    const window = getWindow();
    try { if (window && !window.isDestroyed()) window.webContents.send('updates:status', getStatus()); } catch {}
    return getStatus();
  }
  async function loadPreference() {
    try {
      const saved = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      status.enabled = saved.enabled !== false;
    } catch (error) { if (!error || error.code !== 'ENOENT') status.enabled = true; }
  }
  async function persistPreference(enabled) {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const temporaryPath = settingsPath + '.tmp';
    await fs.writeFile(temporaryPath, JSON.stringify({ enabled, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    await fs.rename(temporaryPath, settingsPath);
  }
  function stopTimer() { if (interval !== null) { clearIntervalFn(interval); interval = null; } }
  function startTimer() {
    if (interval !== null || !status.enabled || !app.isPackaged) return;
    interval = setIntervalFn(() => { if (status.enabled) void checkNow(); }, UPDATE_INTERVAL_MS);
    if (interval && typeof interval.unref === 'function') interval.unref();
  }
  async function showRestartPrompt(info) {
    if (restartPromptOpen) return;
    restartPromptOpen = true;
    try {
      const window = getWindow();
      const options = {
        type: 'info', title: 'Nidavellir update ready',
        message: 'Nidavellir ' + String(info && info.version || '') + ' has downloaded.',
        detail: 'Restart now to finish installing the update, or choose Later. The update will install when you quit the app.',
        buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1, noLink: true
      };
      const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      if (result && result.response === 0 && typeof autoUpdater.quitAndInstall === 'function') autoUpdater.quitAndInstall();
    } catch {
      // Keep the staged update; electron-updater installs it on quit.
    } finally { restartPromptOpen = false; }
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on('checking-for-update', () => { checking = true; publish({ state: 'checking', message: 'Checking for updates…', progress: 0, error: '' }); });
  autoUpdater.on('update-available', info => {
    checking = false;
    const version = String(info && info.version || 'new version');
    publish({ state: 'downloading', message: 'Downloading update ' + version + '…', availableVersion: version, progress: 0, error: '' });
  });
  autoUpdater.on('update-not-available', info => {
    checking = false;
    const version = String(info && info.version || app.getVersion());
    publish({ state: 'up-to-date', message: 'Nidavellir is up to date (' + version + ').', availableVersion: version, progress: 0, error: '' });
  });
  autoUpdater.on('download-progress', progress => {
    const percent = Math.max(0, Math.min(100, Math.round(Number(progress && progress.percent) || 0)));
    publish({ state: 'downloading', message: 'Downloading update: ' + percent + '%', progress: percent });
  });
  autoUpdater.on('update-downloaded', info => {
    checking = false;
    const version = String(info && info.version || 'new version');
    publish({ state: 'ready', message: 'Update ' + version + ' ready — restart to install.', availableVersion: version, progress: 100 });
    void showRestartPrompt(info);
  });
  autoUpdater.on('error', error => {
    checking = false;
    const detail = String(error && error.message || error || 'Unknown updater error').slice(0, 240);
    publish({ state: 'error', message: 'Update check failed; it will retry automatically.', error: detail });
  });
  async function checkNow() {
    if (!status.enabled) return publish({ state: 'disabled', message: 'Automatic updates are disabled in Settings.' });
    if (!app.isPackaged) return publish({ state: 'development', message: 'Automatic updates are available in installed builds.' });
    if (checking || status.state === 'downloading' || status.state === 'ready') return getStatus();
    checking = true;
    publish({ state: 'checking', message: 'Checking for updates…', progress: 0, error: '' });
    try { await autoUpdater.checkForUpdates(); }
    catch (error) {
      checking = false;
      publish({ state: 'error', message: 'Update check failed; it will retry automatically.', error: String(error && error.message || error || 'Unknown updater error').slice(0, 240) });
    }
    return getStatus();
  }
  async function initialize() {
    if (initialized) return getStatus();
    initialized = true;
    await loadPreference();
    if (!status.enabled) return publish({ state: 'disabled', message: 'Automatic updates are disabled in Settings.' });
    if (!app.isPackaged) return publish({ state: 'development', message: 'Automatic updates are available in installed builds.' });
    startTimer();
    return checkNow();
  }
  async function setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Update preference must be a boolean.');
    await persistPreference(enabled);
    status.enabled = enabled;
    if (!enabled) { stopTimer(); return publish({ state: 'disabled', message: 'Automatic updates are disabled in Settings.' }); }
    if (!app.isPackaged) return publish({ state: 'development', message: 'Automatic updates are available in installed builds.' });
    startTimer();
    return checkNow();
  }
  function dispose() { stopTimer(); }
  return { initialize, checkNow, setEnabled, getStatus, dispose };
}
module.exports = { createUpdater, UPDATE_INTERVAL_MS };
