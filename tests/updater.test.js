const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createUpdater, UPDATE_INTERVAL_MS } = require('../src/updater');

async function harness({ packaged = true, dialogResponse = 1 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nidavellir-updater-'));
  const emitter = new EventEmitter();
  emitter.checks = 0; emitter.installs = 0;
  emitter.checkForUpdates = async () => { emitter.checks += 1; return {}; };
  emitter.quitAndInstall = () => { emitter.installs += 1; };
  const messages = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, value) => messages.push({ channel, value }) } };
  let intervalMs = 0, cleared = false;
  const dialog = { showMessageBox: async () => ({ response: dialogResponse }) };
  const app = { isPackaged: packaged, getPath: () => directory, getVersion: () => '0.4.3' };
  const service = createUpdater({ app, autoUpdater: emitter, dialog, getWindow: () => win,
    setIntervalFn: (_callback, ms) => { intervalMs = ms; return { unref() {} }; }, clearIntervalFn: () => { cleared = true; } });
  return { app, service, directory, emitter, messages, dialog, get intervalMs() { return intervalMs; }, get cleared() { return cleared; } };
}

test('source runs do not contact the update service', async () => {
  const h = await harness({ packaged: false });
  await h.service.initialize();
  assert.equal(h.emitter.checks, 0);
  assert.equal(h.service.getStatus().state, 'development');
  h.service.dispose();
  await fs.rm(h.directory, { recursive: true, force: true });
});

test('installed builds check updates and stage downloads automatically', async () => {
  const h = await harness();
  await h.service.initialize();
  assert.equal(h.emitter.checks, 1);
  assert.equal(h.intervalMs, UPDATE_INTERVAL_MS);
  assert.equal(h.emitter.autoDownload, true);
  assert.equal(h.emitter.autoInstallOnAppQuit, true);
  h.emitter.emit('update-available', { version: '0.4.3' });
  assert.equal(h.service.getStatus().state, 'downloading');
  h.emitter.emit('download-progress', { percent: 27.8 });
  assert.equal(h.service.getStatus().progress, 28);
  h.emitter.emit('update-downloaded', { version: '0.4.3' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.getStatus().state, 'ready');
  assert.ok(h.messages.some(item => item.channel === 'updates:status'));
  h.service.dispose();
  await fs.rm(h.directory, { recursive: true, force: true });
});

test('automatic update preference persists across restarts', async () => {
  const h = await harness();
  await h.service.initialize();
  const before = h.emitter.checks;
  await h.service.setEnabled(false);
  assert.equal(h.service.getStatus().state, 'disabled');
  assert.equal(h.cleared, true);
  const second = createUpdater({ app: h.app, autoUpdater: h.emitter, dialog: h.dialog, getWindow: () => null,
    setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} });
  await second.initialize();
  assert.equal(h.emitter.checks, before);
  assert.equal(second.getStatus().enabled, false);
  second.dispose(); h.service.dispose();
  await fs.rm(h.directory, { recursive: true, force: true });
});
