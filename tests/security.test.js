const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSafeRunner, MAX_SOURCE_BYTES, LANGUAGES } = require('../src/safe-runner');
const plugins = require('../src/plugins');

test('runner exposes common language runtimes and compiler targets', () => {
  for (const language of ['javascript', 'python', 'c', 'cpp', 'java', 'go', 'rust', 'ruby', 'php', 'bash', 'powershell']) {
    assert.equal(typeof LANGUAGES[language], 'string', `missing run target: ${language}`);
  }
});

test('runner executes an editor snapshot without overwriting the source file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nidavellir-test-'));
  const sourcePath = path.join(dir, 'example.js');
  const original = 'console.log("disk version");\n';
  await fs.writeFile(sourcePath, original, 'utf8');
  const output = [];
  const runner = createSafeRunner((type, text) => output.push({ type, text }));
  try {
    const result = await runner.run({
      language: 'javascript',
      filePath: sourcePath,
      content: 'console.log("editor snapshot");\n'
    });
    assert.equal(result.code, 0);
    assert.equal(await fs.readFile(sourcePath, 'utf8'), original);
    assert.ok(output.some(item => item.text.includes('editor snapshot')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('JavaScript runner sets Electron Node mode for the child process', async () => {
  const output = [];
  const runner = createSafeRunner((type, text) => output.push({ type, text }));
  const result = await runner.run({
    language: 'javascript',
    content: 'console.log(process.env.ELECTRON_RUN_AS_NODE || "missing");'
  });
  assert.equal(result.code, 0);
  assert.ok(output.some(item => item.text.includes('1')), 'child process should receive ELECTRON_RUN_AS_NODE=1');
});


test('runner forwards interactive stdin to a running JavaScript program', async () => {
  const output = [];
  const runner = createSafeRunner((type, text) => output.push({ type, text }));
  const pending = runner.run({
    language: 'javascript',
    content: 'process.stdin.setEncoding("utf8"); console.log("READY FOR INPUT"); process.stdin.once("data", data => { console.log("received:" + data.trim()); process.exit(0); });'
  });
  try {
    // Send input as soon as the runner reports active, before the child has
    // necessarily attached its stdin pipe. This covers the startup race.
    for (let i = 0; i < 100 && !runner.isRunning(); i++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(runner.isRunning(), true, 'runner should enter startup');
    assert.equal(runner.writeInput('hello from terminal\\n'), true, 'early input should be queued');
    for (let i = 0; i < 100 && !output.some(item => item.text.includes('READY FOR INPUT')); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(output.some(item => item.text.includes('READY FOR INPUT')), 'program should start and request input');
    const result = await pending;
    assert.equal(result.code, 0);
    assert.ok(output.some(item => item.text.includes('received:hello from terminal')), 'program should receive typed input');
  } finally {
    if (runner.isRunning()) runner.kill();
    await pending.catch(() => {});
  }
});

test('runner rejects unsupported languages and oversized source before execution', async () => {
  const runner = createSafeRunner(() => {});
  await assert.rejects(() => runner.run({ language: 'kotlin', content: 'class A {}' }), /Supported run targets/);
  await assert.rejects(() => runner.run({ language: 'javascript', content: 'x'.repeat(MAX_SOURCE_BYTES + 1) }), /2 MB run limit/);
});

test('plugins are discovered disabled and do not execute automatically', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nidavellir-plugin-test-'));
  const pluginDir = path.join(dir, 'unsafe-plugin');
  await fs.mkdir(pluginDir);
  const marker = path.join(dir, 'activated.txt');
  await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    name: 'unsafe-plugin', version: '1.0.0', main: 'index.js', enabled: true
  }));
  await fs.writeFile(path.join(pluginDir, 'index.js'),
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'ran'); exports.activate = () => {};`);
  const traversalDir = path.join(dir, 'traversal-plugin');
  await fs.mkdir(traversalDir);
  await fs.writeFile(path.join(traversalDir, 'plugin.json'), JSON.stringify({
    name: 'traversal-plugin', version: '1.0.0', main: '../outside.js', enabled: true
  }));
  await fs.writeFile(path.join(dir, 'outside.js'), 'throw new Error("must not load");');
  try {
    await plugins.initPluginSystem(dir);
    const discovered = plugins.getPlugins();
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].enabled, false);
    await assert.rejects(() => fs.access(marker));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
