const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');
const lines = workflow.split('\n');
function jobBlock(name) {
  const start = lines.indexOf('  ' + name + ':');
  assert.notEqual(start, -1, 'missing workflow job: ' + name);
  let end = lines.findIndex((line, index) => index > start && /^  [a-z][a-z-]*:$/.test(line));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join('\n');
}

test('release workflow defaults to read-only repository permissions', () => {
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.equal((workflow.match(/contents: write/g) || []).length, 1, 'only the publication job may request contents: write');
});

test('verification and platform build jobs do not receive write permissions', () => {
  for (const name of ['verify', 'build-windows', 'build-linux']) {
    const block = jobBlock(name);
    assert.match(block, /permissions:\n      contents: read/);
    assert.doesNotMatch(block, /contents: write/);
    assert.match(block, /persist-credentials: false/);
  }
});

test('the publication job alone receives write permission and creates the tag', () => {
  const publish = jobBlock('publish-release');
  assert.match(publish, /permissions:\n      contents: write/);
  assert.ok(publish.includes('git push origin "$tag"'));
  assert.match(publish, /Create the release tag with the write-scoped token/);
  assert.doesNotMatch(publish, /npm (install|test)/);
});

test('the verification job never pushes a release tag while running tests', () => {
  const verify = jobBlock('verify');
  assert.match(verify, /npm install[\s\S]*npm test/);
  assert.doesNotMatch(verify, /git push origin/);
});
