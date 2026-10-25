'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LanguageServerManager, REQUEST_ALLOWLIST } = require('../src/language-server');

const MOCK_SERVER = String.raw`
let buffer = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]));
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const marker = buffer.indexOf('\r\n\r\n');
    if (marker < 0) return;
    const header = buffer.subarray(0, marker).toString('ascii');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.subarray(marker + 4); continue; }
    const length = Number(match[1]), start = marker + 4;
    if (buffer.length < start + length) return;
    const text = buffer.subarray(start, start + length).toString('utf8');
    buffer = buffer.subarray(start + length);
    const message = JSON.parse(text);
    if (message.method === 'initialize') {
      send({ jsonrpc:'2.0', id:message.id, result:{ capabilities:{definitionProvider:true, referencesProvider:true, hoverProvider:true, documentFormattingProvider:true} } });
    } else if (message.method === 'textDocument/definition') {
      send({ jsonrpc:'2.0', id:message.id, result:{ uri:message.params.textDocument.uri, range:{start:{line:0,character:0},end:{line:0,character:4}} } });
    } else if (message.method === 'textDocument/references') {
      send({ jsonrpc:'2.0', id:message.id, result:[{uri:message.params.textDocument.uri,range:{start:{line:0,character:0},end:{line:0,character:4}}}] });
    } else if (message.method === 'textDocument/hover') {
      send({ jsonrpc:'2.0', id:message.id, result:{contents:{kind:'markdown',value:'hover works'}} });
    } else if (message.method === 'textDocument/formatting') {
      send({ jsonrpc:'2.0', id:message.id, result:[] });
    } else if (message.method === 'shutdown') {
      send({ jsonrpc:'2.0', id:message.id, result:null });
    }
  }
});
`;

async function makeProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nidavellir-lsp-'));
  t.after(async () => fs.rm(root, { recursive:true, force:true }));
  const serverFile = path.join(root, 'mock-language-server.js');
  await fs.writeFile(serverFile, MOCK_SERVER, 'utf8');
  const sourceFile = path.join(root, 'main.js');
  await fs.writeFile(sourceFile, 'const value = 42;\n', 'utf8');
  return { root, sourceFile, serverFile };
}

test('language server client starts a real stdio process and serves allowlisted requests', async t => {
  const { root, sourceFile, serverFile } = await makeProject(t);
  const notifications = [];
  const manager = new LanguageServerManager({
    serverConfigs: { javascript:{ command:process.execPath, args:[serverFile], label:'Mock LSP' } },
    onNotification: event => notifications.push(event)
  });
  t.after(() => manager.stop());
  const started = await manager.start({ root, language:'javascript' });
  assert.equal(started.active, true);
  assert.equal(started.label, 'Mock LSP');
  await manager.openDocument({ root, filePath:sourceFile, language:'javascript', text:'const value = 42;\n' });
  const definition = await manager.request({
    root, filePath:sourceFile, language:'javascript', text:'const value = 42;\n',
    method:'textDocument/definition', position:{line:0,character:6}
  });
  assert.equal(definition.uri.startsWith('file:'), true);
  assert.deepEqual(definition.range.start, {line:0,character:0});
  const refs = await manager.request({
    root, filePath:sourceFile, language:'javascript', text:'const value = 42;\n',
    method:'textDocument/references', position:{line:0,character:6}
  });
  assert.equal(refs.length, 1);
  const hover = await manager.request({
    root, filePath:sourceFile, language:'javascript', text:'const value = 42;\n',
    method:'textDocument/hover', position:{line:0,character:6}
  });
  assert.equal(hover.contents.value, 'hover works');
  await assert.rejects(() => manager.request({
    root, filePath:sourceFile, language:'javascript', text:'const value = 42;\n',
    method:'workspace/executeCommand', position:{line:0,character:0}
  }), /not allowed/);
  await manager.stop();
  assert.equal(manager.session, null);
  assert.ok(notifications.some(item => item.method === 'nidavellir/languageServerState'));
});

test('language server client refuses paths outside workspace and source files exceeding limits', async t => {
  const { root, sourceFile, serverFile } = await makeProject(t);
  const manager = new LanguageServerManager({
    serverConfigs: { javascript:{ command:process.execPath, args:[serverFile], label:'Mock LSP' } }
  });
  t.after(() => manager.stop());
  await manager.start({ root, language:'javascript' });
  const outside = path.join(os.tmpdir(), 'outside-nidavellir-lsp.js');
  await fs.writeFile(outside, 'outside', 'utf8');
  t.after(() => fs.rm(outside, { force:true }));
  await assert.rejects(() => manager.openDocument({ root, filePath:outside, language:'javascript', text:'outside' }), /restricted to the opened workspace/);
  await assert.rejects(() => manager.openDocument({ root, filePath:sourceFile, language:'javascript', text:'x'.repeat(2*1024*1024+1) }), /2 MB limit/);
  await manager.stop();
});

test('language server allowlist includes core code-intelligence requests only', () => {
  for (const method of ['textDocument/definition','textDocument/references','textDocument/hover','textDocument/completion','textDocument/formatting']) {
    assert.ok(REQUEST_ALLOWLIST.has(method));
  }
  assert.equal(REQUEST_ALLOWLIST.has('workspace/executeCommand'), false);
});
