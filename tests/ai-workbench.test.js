const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');

test('AI Workbench uses configured API-key agents', () => {
  assert.doesNotMatch(html, /qwen2\.5|localAgentCount/i);
  assert.doesNotMatch(app, /localAgentCount|askLocal/i);
  assert.match(html, /id="openApiKeyEditor"/);
  assert.match(app, /window\.forge\.askKey\(\{ \.\.\.request, provider: agent\.provider, keyId: agent\.keyId \}\)/);
  assert.match(app, /Add an API key in AI Workbench settings/);
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
