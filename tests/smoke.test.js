const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('project has core app files', () => {
  for (const f of [
    'package.json', 'src/main.js', 'src/preload.js',
    'src/index.html', 'src/app.js', 'src/styles.css', 'src/updater.js', 'scripts/copy-monaco.js', 'README.md'
  ]) {
    assert.ok(fs.existsSync(path.join(root, f)), `missing ${f}`);
  }
});

test('project has new v0.2 module files', () => {
  for (const f of [
    'src/plugins.js', 'src/coordinator.js', 'src/safe-runner.js'
  ]) {
    assert.ok(fs.existsSync(path.join(root, f)), `missing ${f}`);
  }
});

test('example plugins are bundled', () => {
  for (const name of ['word-counter', 'timestamp-inserter']) {
    const dir = path.join(root, 'plugins', name);
    assert.ok(fs.existsSync(dir), `missing plugin dir: ${name}`);
    assert.ok(fs.existsSync(path.join(dir, 'plugin.json')), `missing ${name}/plugin.json`);
    assert.ok(fs.existsSync(path.join(dir, 'index.js')), `missing ${name}/index.js`);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    assert.ok(manifest.name, `plugin ${name} has no name in manifest`);
    assert.ok(manifest.main, `plugin ${name} has no main entry`);
  }
});

test('Electron renderer is isolated from Node APIs', () => {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(html, /Content-Security-Policy/);
});

test('AI provider adapters exist', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  for (const provider of ['openai', 'gemini', 'claude']) assert.ok(main.includes(provider));
});

test('preload exposes safe runner and plugin channels', () => {
  const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
  for (const channel of ['runSafe', 'killRun', 'runHistory', 'synthesize', 'generateTests', 'listPlugins', 'togglePlugin']) {
    assert.ok(preload.includes(channel), `preload missing ${channel}`);
  }
});

test('main process imports new modules', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  assert.match(main, /require\(['"]\.\/safe-runner['"]\)/);
  assert.match(main, /require\(['"]\.\/coordinator['"]\)/);
  assert.match(main, /require\(['"]\.\/plugins['"]\)/);
});

test('coordinator module exports synthesizeResponses', () => {
  const coordinator = require(path.join(root, 'src/coordinator.js'));
  assert.strictEqual(typeof coordinator.synthesizeResponses, 'function');
});

test('safe-runner module exports createSafeRunner', () => {
  const runner = require(path.join(root, 'src/safe-runner.js'));
  assert.strictEqual(typeof runner.createSafeRunner, 'function');
  // Verify the runner factory returns the expected API
  const instance = runner.createSafeRunner(() => {});
  assert.strictEqual(typeof instance.run, 'function');
  assert.strictEqual(typeof instance.kill, 'function');
  assert.strictEqual(typeof instance.getHistory, 'function');
  assert.strictEqual(typeof instance.isRunning, 'function');
  assert.strictEqual(instance.isRunning(), false);
  assert.deepStrictEqual(instance.getHistory(), []);
});

test('plugin system module exports expected API', () => {
  const plugins = require(path.join(root, 'src/plugins.js'));
  for (const fn of ['setWindow', 'initPluginSystem', 'getPlugins', 'setPluginEnabled', 'notifyPlugins', 'getQuickActions', 'getStatusItems']) {
    assert.strictEqual(typeof plugins[fn], 'function', `missing export: ${fn}`);
  }
});

test('package.json is configured for the installable 0.4 release', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.version, '0.4.3');
  assert.equal(pkg.build.publish[0].owner, 'ninja94650');
  assert.equal(pkg.build.publish[0].repo, 'Nidavellir');
  assert.ok(pkg.dependencies['electron-updater']);
  assert.match(pkg.devDependencies.electron, /^\^45\./);
});


test('packaged app loads Monaco from local vendor paths', () => {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  assert.match(html, /vendor\/monaco\/vs\/loader\.js/);
  assert.match(app, /new URL\('vendor\/monaco\/'/);
  assert.doesNotMatch(html, /node_modules\/monaco-editor/);
});

test('automatic update release workflow publishes required platform metadata', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.equal(pkg.build.publish[0].provider, 'github');
  assert.match(workflow, /tags:[\s\S]*'v\*'/);
  assert.match(workflow, /contents: write/);
  assert.ok(workflow.includes('tag="v${version}"'));
  assert.match(workflow, /electron-builder --win nsis --publish never/);
  assert.match(workflow, /electron-builder --linux AppImage --publish never/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /generate-update-manifest\.js/);
});


test('persistent user plugins are wired through the main process and preload', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  assert.match(main, /prepareUserPluginsDir/);
  assert.match(main, /plugins:open-user-folder/);
  assert.match(preload, /openUserPluginsFolder/);
  assert.match(html, /Open User Plugins Folder/);
});


test('Linux update manifest contains a verifiable artifact checksum and size', async t => {
  const { generateUpdateManifest } = require('../scripts/generate-update-manifest');
  const crypto = require('node:crypto');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nidavellir-manifest-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const artifact = path.join(tmp, 'Nidavellir-0.4.3.AppImage');
  const output = path.join(tmp, 'latest-linux.yml');
  const bytes = Buffer.from('test AppImage bytes');
  fs.writeFileSync(artifact, bytes);
  const result = await generateUpdateManifest('linux', '0.4.3', artifact, output);
  const yaml = fs.readFileSync(output, 'utf8');
  assert.equal(result.size, bytes.length);
  assert.equal(result.sha512, crypto.createHash('sha512').update(bytes).digest('base64'));
  assert.match(yaml, /version: 0\.4\.3/);
  assert.match(yaml, /path: Nidavellir-0\.4\.3\.AppImage/);
  assert.match(yaml, new RegExp('sha512: ' + result.sha512.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')));
});


test('updater starts before plugins and plugin startup failures are non-fatal', () => {
  const source = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  const updaterStart = source.indexOf('updateService = createUpdater');
  const pluginInit = source.indexOf('await pluginSystem.initPluginSystem');
  assert.ok(updaterStart >= 0, 'updater initialization must exist');
  assert.ok(pluginInit >= 0, 'plugin initialization must exist');
  assert.ok(updaterStart < pluginInit, 'updater must initialize before user plugins');
  assert.match(source, /\\[plugins\\] Failed to initialize:/, 'plugin initialization failures must be logged');
  assert.match(source, /pluginSystem\\.setWindow\\(win\\)/, 'plugin system must receive the current window');
});
