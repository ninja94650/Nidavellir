const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n');
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

test('no checkout persists a credential, including in the publication job', () => {
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 4);
  assert.doesNotMatch(workflow, /persist-credentials:\s*true/);
});

test('the publication job alone receives write permission', () => {
  const publish = jobBlock('publish-release');
  assert.match(publish, /permissions:\n      contents: write/);
  assert.doesNotMatch(publish, /npm (install|test)/);
});

test('write token is exposed only to tag creation and release publication steps', () => {
  const publish = jobBlock('publish-release');
  assert.equal((publish.match(/GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/g) || []).length, 2);
  const beforeTag = publish.split('- name: Create the release tag with a step-scoped write token')[0];
  assert.doesNotMatch(beforeTag, /GH_TOKEN:/);
  const tagStep = publish.split('- name: Create the release tag with a step-scoped write token')[1].split('- name: Create one GitHub Release')[0];
  assert.match(tagStep, /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  assert.match(tagStep, /gh api --method POST[\s\S]*git\/refs/);
  assert.match(tagStep, /-f "sha=\$GITHUB_SHA"/);
  assert.doesNotMatch(tagStep, /git push origin/);
  const releaseStep = publish.split('- name: Create one GitHub Release')[1];
  assert.match(releaseStep, /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
});

test('verification never pushes a release tag while running tests', () => {
  const verify = jobBlock('verify');
  assert.match(verify, /npm install[\s\S]*npm test/);
  assert.doesNotMatch(verify, /git push origin/);
  assert.doesNotMatch(verify, /GH_TOKEN:/);
});
