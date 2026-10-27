const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

test('C++ runner delivers queued terminal input to std::cin', async t => {
  const compiler = spawnSync('g++', ['--version'], { stdio: 'ignore', shell: false });
  if (compiler.error || compiler.status !== 0) {
    t.skip('g++ is not installed in this test environment');
    return;
  }

  const output = [];
  const runner = createSafeRunner((type, text) => output.push({ type, text }));
  const pending = runner.run({
    language: 'cpp',
    filePath: path.join(os.tmpdir(), 'test.cpp'),
    content: [
      '#include <iostream>',
      'int main() {',
      '  double price = 0;',
      '  int quantity = 0;',
      '  std::cout << "enter price of item:\\n" << std::flush;',
      '  if (!(std::cin >> price)) return 2;',
      '  std::cout << "enter number of item:\\n" << std::flush;',
      '  if (!(std::cin >> quantity)) return 3;',
      '  std::cout << "total cost: " << price * quantity << "\\n";',
      '  return 0;',
      '}'
    ].join('\n')
  });

  try {
    for (let i = 0; i < 200 && !runner.isRunning(); i++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(runner.isRunning(), true, 'C++ runner should enter startup');
    assert.equal(runner.writeInput('2.5\n3\n'), true, 'input entered during compilation should queue');
    const result = await pending;
    assert.equal(result.code, 0, `C++ runner failed: ${output.map(item => item.text).join('')}`);
    assert.ok(output.some(item => item.text.includes('total cost: 7.5')), 'C++ program should read both values and print the correct total');
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


test('runner Stop terminates descendants even if the root process exits first', async () => {
  const output = [];
  const runner = createSafeRunner((type, text) => output.push({ type, text }));
  const pending = runner.run({
    language: 'javascript',
    content: [
      'const { spawn } = require("node:child_process");',
      'const grandchild = spawn(process.execPath, ["-e", \'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\'], { stdio: "ignore" });',
      'console.log("GRANDCHILD_PID:" + grandchild.pid);',
      'setInterval(() => {}, 1000);'
    ].join('\\n')
  });

  let grandchildPid = null;
  let timeoutHandle;
  try {
    for (let i = 0; i < 300 && grandchildPid === null; i++) {
      const match = output.map(item => item.text).join('').match(/GRANDCHILD_PID:(\\d+)/);
      if (match) grandchildPid = Number(match[1]);
      else await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(Number.isInteger(grandchildPid), 'runner should report the spawned descendant PID');
    assert.equal(runner.kill(), true, 'Stop should request process-tree termination');

    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('runner did not finish terminating its process tree')), 10_000);
    });
    await Promise.race([pending, timeout]);

    let descendantAlive = true;
    for (let i = 0; i < 60; i++) {
      try {
        process.kill(grandchildPid, 0);
        descendantAlive = true;
      } catch (error) {
        if (error.code === 'ESRCH') descendantAlive = false;
        else if (error.code === 'EPERM') descendantAlive = true;
        else throw error;
      }
      if (!descendantAlive) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(descendantAlive, false, 'Stop must not leave a child process running');
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (runner.isRunning()) runner.kill();
    await Promise.race([pending.catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
});
