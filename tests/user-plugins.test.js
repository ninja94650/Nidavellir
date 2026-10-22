const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareUserPluginsDir } = require('../src/user-plugins');

test('bundled plugins copy once and user edits survive later launches/updates', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nidavellir-user-plugins-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userData = path.join(root, 'user-data');
  const bundled = path.join(root, 'bundled-plugins');
  const first = path.join(bundled, 'line-tools');
  await fs.mkdir(first, { recursive: true });
  await fs.writeFile(path.join(first, 'plugin.json'), JSON.stringify({ name: 'Line Tools' }));
  await fs.writeFile(path.join(first, 'index.js'), 'module.exports = "bundled";');

  const userFolder = await prepareUserPluginsDir(userData, bundled);
  const userPlugin = path.join(userFolder, 'line-tools', 'index.js');
  assert.equal(await fs.readFile(userPlugin, 'utf8'), 'module.exports = "bundled";');

  await fs.writeFile(userPlugin, 'module.exports = "user customization";');
  const newBundled = path.join(bundled, 'new-example');
  await fs.mkdir(newBundled, { recursive: true });
  await fs.writeFile(path.join(newBundled, 'plugin.json'), JSON.stringify({ name: 'New Example' }));
  await fs.writeFile(path.join(newBundled, 'index.js'), 'module.exports = "new";');

  const secondFolder = await prepareUserPluginsDir(userData, bundled);
  assert.equal(secondFolder, userFolder);
  assert.equal(await fs.readFile(userPlugin, 'utf8'), 'module.exports = "user customization";');
  assert.equal(await fs.readFile(path.join(userFolder, 'new-example', 'index.js'), 'utf8'), 'module.exports = "new";');
});

test('user plugin directory can be initialized without bundled examples', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nidavellir-no-default-plugins-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pathReturned = await prepareUserPluginsDir(path.join(root, 'user'), path.join(root, 'missing'));
  assert.equal(pathReturned, path.join(root, 'user', 'plugins'));
  assert.deepEqual(await fs.readdir(pathReturned), []);
});
