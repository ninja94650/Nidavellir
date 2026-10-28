const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const readHandlerStart = source.indexOf('Permission required: outside workspace');
const readHandlerEnd = source.indexOf("const content = await fs.readFile(resolved, 'utf8')", readHandlerStart);
const permissionFlow = source.slice(readHandlerStart, readHandlerEnd);

test('outside-workspace reads show explicit native permission choices', () => {
  assert.ok(readHandlerStart >= 0, 'native permission prompt exists');
  assert.match(permissionFlow, /'Yes, allow this time'/);
  assert.match(permissionFlow, /'Yes, allow this exact file until Nidavellir closes'/);
  assert.match(permissionFlow, /'No — deny access'/);
  assert.match(permissionFlow, /defaultId: 4[\s\S]*cancelId: 4/);
});

test('permission grants are exact-path, in-memory sets and are not persisted', () => {
  assert.match(source, /const readGrants = \{[\s\S]*once: new Set\(\)[\s\S]*session: new Set\(\)/);
  assert.match(permissionFlow, /readGrants\.conversation\.has\(resolved\)/);
  assert.match(permissionFlow, /readGrants\.session\.add\(resolved\)/);
  assert.doesNotMatch(permissionFlow, /writeFile|safeStorage|localStorage/);
});

test('one-time grants are consumed before reading and denial stops access', () => {
  assert.match(permissionFlow, /readGrants\.once\.delete\(resolved\)/);
  assert.match(permissionFlow, /throw new Error\('Access denied: you did not approve reading this file\.'\)/);
  assert.ok(readHandlerEnd > readHandlerStart, 'file read occurs after permission decision');
});

test('write, list, and reveal handlers continue to reject paths outside the workspace', () => {
  assert.match(source, /Access denied: path is outside the opened workspace/);
  assert.match(source, /Access denied: folder is outside the opened workspace/);
  assert.match(source, /Reveal denied: path is outside the opened workspace/);
});
