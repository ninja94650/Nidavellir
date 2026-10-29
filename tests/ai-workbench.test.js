const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');

test('AI Workbench uses configured API-key agents', () => {
  assert.doesNotMatch(html, /qwen2\.5|localAgentCount/i);
  assert.doesNotMatch(app, /localAgentCount/i);
  assert.match(html, /id="openApiKeyEditor"/);
  assert.match(app, /window\.forge\.askKey\(\{ \.\.\.request, provider: agent\.provider, keyId: agent\.keyId \}\)/);
  assert.match(app, /Add an API key in AI Workbench settings/);
});

test('AI project builder uses a separate explicit apply action and workspace-scoped IPC', () => {
  assert.match(html, /id="buildProjectBtn"/);
  assert.match(app, /async function buildProject\(\)/);
  assert.match(app, /Return ONLY valid JSON/);
  assert.match(app, /window\.forge\.applyProjectChanges\(\{ root: workspaceRoot, changes: manifest\.files \}\)/);
  assert.match(main, /project:apply-changes/);
  assert.match(main, /Review AI project changes/);
  assert.ok(main.includes('existing file(s) will be backed up before replacement'));
  assert.match(main, /No shell commands will be run automatically/);
  assert.match(main, /path\.relative\(root, target\)/);
});

test('project builder inspects workspace, renders original/proposed diffs, and gates tests', () => {
  assert.ok(app.includes('window.forge.inspectProject({ root: workspaceRoot })'));
  assert.ok(app.includes('function renderProjectManifestReview'));
  assert.ok(app.includes("className = 'project-diff-panes'"));
  assert.ok(app.includes('Original'));
  assert.ok(app.includes('Proposed'));
  assert.ok(app.includes('function offerProjectRepair'));
  assert.ok(app.includes('Repair limit reached'));
  assert.ok(app.includes('window.forge.runProjectTests({ root: workspaceRoot })'));
  assert.ok(main.includes("ipcMain.handle('project:inspect'"));
  assert.ok(main.includes("ipcMain.handle('project:run-tests'"));
  assert.ok(main.includes('Allow this project to execute its configured test script'));
  assert.ok(preload.includes("inspectProject: payload => ipcRenderer.invoke('project:inspect', payload)"));
  assert.ok(preload.includes("runProjectTests: payload => ipcRenderer.invoke('project:run-tests', payload)"));
});

test('coordinator synthesis remains available for multiple successful agent responses', () => {
  assert.match(app, /\$\('useCoordinator'\)\.checked && responses\.length > 1/);
  assert.match(app, /window\.forge\.synthesize\(\{ responses \}\)/);
});

test('AI Workbench retains scrollable chat and collapse/minimize states', () => {
  assert.match(css, /\.ai-panel > \.chat[^{]*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.ai-panel\.minimized/);
  assert.match(css, /\.ai-panel\.collapsed/);
});


test('AI Workbench makes each section above chat individually collapsible', () => {
  assert.equal((html.match(/class="workbench-fold(?:\s[^"]*)?"/g) || []).length, 3);
  assert.match(html, /<details class="workbench-fold" open>/);
  assert.match(html, /<details class="workbench-fold quick-actions-fold">/);
  assert.match(css, /\.ai-panel > \.workbench-fold > summary/);
  assert.match(css, /\.ai-panel > \.chat\s*\{[^}]*flex:\s*1 1 0;[^}]*min-height:\s*(?:0|72px);/s);
});
