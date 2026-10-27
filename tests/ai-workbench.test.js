const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');

test('AI Workbench exposes local Ollama and a bounded local-agent selector', () => {
  assert.match(html, /id="useOllama"[^>]*checked/);
  assert.match(html, /id="localAgentCount"/);
  for (const count of [1, 2, 3, 4]) {
    assert.match(html, new RegExp('<option value="' + count + '"'));
  }
});

test('local agents share the same request and are dispatched concurrently', () => {
  assert.match(app, /const localCount = localEnabled \? Math\.max\(1, Math\.min\(4, Number\(\$\('localAgentCount'\)\?\.value\) \|\| 1\)\) : 0/);
  assert.match(app, /for \(let index = 0; index < localCount; index\+\+\)/);
  assert.match(app, /await Promise\.all\(cards\.map\(async \(\[agent, card\]\)/);
  assert.match(app, /agent\.provider === 'ollama'[\s\S]{0,100}window\.forge\.askLocal/);
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
