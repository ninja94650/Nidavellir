'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const studio = require('../src/studio-services');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nidavellir-studio-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('workspace path validation rejects traversal, absolute paths, and secret files', () => {
  assert.equal(studio.normalizeRelativePath('src/main.js'), path.join('src', 'main.js'));
  assert.throws(() => studio.normalizeRelativePath('../outside.txt'), /parent-directory/);
  assert.throws(() => studio.normalizeRelativePath('/etc/passwd'), /Absolute paths/);
  assert.throws(() => studio.normalizeRelativePath('.env'), /excluded/);
  assert.throws(() => studio.normalizeRelativePath('config/private.key'), /excluded/);
});

test('project search is bounded, line-based, and skips ignored and sensitive directories', async t => {
  const root = await tempDir(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'example'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'main.js'), 'const value = "hello";\nhello();\n');
  await fs.writeFile(path.join(root, '.env'), 'API_KEY=hello-secret\n');
  await fs.writeFile(path.join(root, 'node_modules', 'example', 'skip.js'), 'hello\n');
  const result = await studio.searchWorkspace(root, { query: 'hello' });
  assert.equal(result.filesScanned, 1);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].path, 'src/main.js');
  assert.equal(result.matches[1].line, 2);
  assert.equal(result.truncated, false);
});

test('workspace search supports case-insensitive and explicit regex modes while rejecting unsafe patterns', async t => {
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'example.txt'), 'Alpha\nalpha2\nALPHA\n');
  const plain = await studio.searchWorkspace(root, { query: 'alpha' });
  assert.equal(plain.totalMatches, 3);
  const regex = await studio.searchWorkspace(root, { query: '^alpha\\d$', regex: true, matchCase: false });
  assert.equal(regex.totalMatches, 1);
  await assert.rejects(() => studio.searchWorkspace(root, { query: '(a+)+$', regex: true }), /unsafe backtracking/);
});

test('project-wide replace creates a recovery backup before changing files', async t => {
  const root = await tempDir(t);
  const backupRoot = path.join(root, 'recovery-store');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.js'), 'value value\n');
  await fs.writeFile(path.join(root, 'src', 'b.js'), 'value\n');
  const result = await studio.replaceWorkspace(root, {
    paths: ['src/a.js', 'src/b.js'], query: 'value', replacement: 'updated', matchCase: true
  }, backupRoot);
  assert.equal(result.filesChanged, 2);
  assert.equal(result.replacements, 3);
  assert.equal(await fs.readFile(path.join(root, 'src', 'a.js'), 'utf8'), 'updated updated\n');
  assert.equal(await fs.readFile(path.join(result.backups[0].backupPath), 'utf8'), 'value value\n');
});

test('project-wide replace refuses paths outside the workspace and does not change source files', async t => {
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'original');
  await assert.rejects(() => studio.replaceWorkspace(root, {
    paths: ['../outside.txt'], query: 'original', replacement: 'changed'
  }, path.join(root, 'backups')), /parent-directory/);
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'original');
});

test('multi-file AI change application preflights paths and backs up modified/deleted files', async t => {
  const root = await tempDir(t), backups = path.join(root, 'app-backups');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'old.txt'), 'keep this');
  await fs.writeFile(path.join(root, 'remove.txt'), 'recover me');
  const result = await studio.applyProjectChanges(root, [
    { path: 'src/old.txt', action: 'modify', content: 'new content' },
    { path: 'src/new.txt', action: 'create', content: 'created' },
    { path: 'remove.txt', action: 'delete' }
  ], backups);
  assert.equal(result.count, 3);
  assert.equal(await fs.readFile(path.join(root, 'src', 'old.txt'), 'utf8'), 'new content');
  assert.equal(await fs.readFile(path.join(root, 'src', 'new.txt'), 'utf8'), 'created');
  await assert.rejects(() => fs.access(path.join(root, 'remove.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(result.backupDir, 'src', 'old.txt'), 'utf8'), 'keep this');
  assert.equal(await fs.readFile(path.join(result.backupDir, 'remove.txt'), 'utf8'), 'recover me');
});

test('multi-file AI change application rejects accidental overwrite and traversal before writing any files', async t => {
  const root = await tempDir(t), backups = path.join(root, 'backups');
  await fs.writeFile(path.join(root, 'already.txt'), 'original');
  await assert.rejects(() => studio.applyProjectChanges(root, [
    { path: 'already.txt', action: 'create', content: 'overwrite' },
    { path: 'new.txt', action: 'create', content: 'new' }
  ], backups), /already exists/);
  await assert.rejects(() => studio.applyProjectChanges(root, [
    { path: '../outside.txt', action: 'create', content: 'bad' }
  ], backups), /parent-directory/);
  assert.equal(await fs.readFile(path.join(root, 'already.txt'), 'utf8'), 'original');
  await assert.rejects(() => fs.access(path.join(root, 'new.txt')), { code: 'ENOENT' });
});

test('Git service supports status, stage, commit, history and diff without shell interpolation', async t => {
  const root = await tempDir(t);
  await execFileAsync('git', ['init', root], { timeout: 10000 });
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Nidavellir Test']);
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(root, 'sample.txt'), 'first\n');
  let status = await studio.gitStatus(root);
  assert.equal(status.changes.length, 1);
  assert.equal(status.changes[0].path, 'sample.txt');
  status = await studio.gitStage(root, ['sample.txt']);
  assert.ok(status.changes[0].index.trim());
  const commit = await studio.gitCommit(root, 'Add sample');
  assert.match(commit.output, /sample/);
  assert.equal((await studio.gitLog(root)).length, 1);
  await fs.writeFile(path.join(root, 'sample.txt'), 'second\n');
  assert.match(await studio.gitDiff(root), /second/);
  await assert.rejects(() => studio.gitStage(root, ['../outside.txt']), /parent-directory/);
});

test('project context excludes credentials, hidden paths, and ignored build output', async t => {
  const root = await tempDir(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'src', 'app.js'), 'export const ok = true;');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=do-not-send');
  await fs.writeFile(path.join(root, 'dist', 'bundle.js'), 'ignored output');
  const context = await studio.readProjectContext(root);
  assert.deepEqual(context.files.map(f => f.path), ['src/app.js']);
  assert.doesNotMatch(JSON.stringify(context), /do-not-send|ignored output/);
});

test('environment doctor reports capabilities with explicit available flags', async () => {
  const result = await studio.detectEnvironment();
  assert.ok(Array.isArray(result.tools) && result.tools.length >= 10);
  assert.ok(result.platform);
  assert.ok(result.nodeRuntime);
  assert.ok(result.tools.every(tool => typeof tool.available === 'boolean' && typeof tool.name === 'string'));
});


test('current-file syntax diagnostics use JSON parser and report malformed JSON', async () => {
  const good = await studio.diagnoseSource({ language:'json', fileName:'config.json', content:'{"valid":true}' });
  assert.equal(good.status, 'passed');
  const bad = await studio.diagnoseSource({ language:'json', fileName:'config.json', content:'{"valid":}' });
  assert.equal(bad.status, 'issues');
  assert.ok(bad.diagnostics);
});

test('JavaScript diagnostics run a local syntax check without touching the source file', async t => {
  const root = await tempDir(t);
  const filePath = path.join(root, 'input.js');
  await fs.writeFile(filePath, 'const original = true;', 'utf8');
  const good = await studio.diagnoseSource({ language:'javascript', fileName:'input.js', filePath, content:'const valid = 1;' });
  assert.equal(good.status, 'passed');
  const bad = await studio.diagnoseSource({ language:'javascript', fileName:'input.js', filePath, content:'const = ;' });
  assert.equal(bad.status, 'issues');
  assert.equal(await fs.readFile(filePath, 'utf8'), 'const original = true;');
});
