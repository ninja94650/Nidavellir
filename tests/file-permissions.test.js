const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

test('outside-workspace reads require an explicit native permission choice', () => {
  assert.match(source, /if \(!await isWithinApprovedRoot\(resolved\)\) \{/);
  assert.match(source, /'Yes, allow this time'/);
  assert.match(source, /'Yes, allow this exact file for this app session'/);
  assert.match(source, /'No — deny access'/);
  assert.match(source, /defaultId: 4[\s\S]*cancelId: 4/);
});

test('outside-workspace grants are in-memory and scoped to exact file paths', () => {
  assert.match(source, /const readGrants = \{[\s\S]*once: new Set\(\)[\s\S]*session: new Set\(\)/);
  assert.match(source, /readGrants\.conversation\.has\(resolved\)/);
  assert.match(source, /readGrants\.session\.add\(resolved\)/);
  assert.match(source, /Session grants are cleared when Nidavellir closes/);
  assert.doesNotMatch(source, /readGrants[\s\S]{0,500}writeFile/);
});

test('declining the permission request stops the file read', () => {
  assert.match(source, /throw new Error\('Access denied: you did not approve reading this file\.'\)/);
  assert.match(source, /const content = await fs\.readFile\(resolved, 'utf8'\)/);
});
