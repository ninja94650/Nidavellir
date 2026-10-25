const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch { res.writeHead(400).end(); return; }
    const target = path.resolve(root, '.' + pathname);
    if (target !== root && !target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(target, (err, data) => {
      if (err) { res.writeHead(err.code === 'ENOENT' ? 404 : 500).end(); return; }
      res.writeHead(200, { 'content-type': mime[path.extname(target)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: process.env.HEADLESS_UI === '1', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  await page.addInitScript(() => {
    const state = { runner: null, editorCommand: null, keys: { openai: [], gemini: [], claude: [] }, plugins: [{ name: 'sample-plugin', version: '1.0.0', description: 'UI test plugin', enabled: true }] };
    window.__uiCalls = []; window.__uiState = state;
    const record = (name, payload) => window.__uiCalls.push({ name, payload });
    window.prompt = (_message, value) => value || 'javascript';
    window.forge = {
      openFile: async () => { record('openFile'); return { filePath: '/tmp/example.js', content: 'alpha alpha\n' }; },
      openFolder: async () => { record('openFolder'); return { folder: '/tmp/project', tree: [{ name: 'main.js', path: '/tmp/project/main.js', directory: false }, { name: 'other.cpp', path: '/tmp/project/other.cpp', directory: false }, { name: 'destination', path: '/tmp/project/destination', directory: true, children: [] }] }; },
      saveFile: async p => { record('saveFile', p); return { filePath: p.filePath || '/tmp/new-file.js', name: p.name || 'new-file.js' }; },
      revealPath: async filePath => { record('revealPath', filePath); return { success: true }; },
      openWith: async filePath => { record('openWith', filePath); return { canceled: true }; },
      renamePath: async p => { record('renamePath', p); return { filePath: p.filePath.replace(/[^/]+$/, p.newName), name: p.newName }; },
      deletePath: async filePath => { record('deletePath', filePath); return { success: true, filePath }; },
      transferPath: async p => { record('transferPath', p); return { filePath: p.destinationDirectory + '/' + p.sourcePath.split('/').pop(), sourcePath: p.sourcePath, mode: p.mode }; },
      refreshFolder: async folder => { record('refreshFolder', folder); return { folder, tree: [{ name: 'main.js', path: '/tmp/project/main.js', directory: false }, { name: 'other.cpp', path: '/tmp/project/other.cpp', directory: false }, { name: 'destination', path: '/tmp/project/destination', directory: true, children: [] }] }; },
      fileInfo: async filePath => { record('fileInfo', filePath); return { filePath, name: filePath.split('/').pop(), size: 18, modifiedAt: new Date().toISOString(), createdAt: new Date().toISOString() }; },
      relativePath: async p => { record('relativePath', p); return p.filePath.replace(p.root + '/', ''); },
      copyText: async value => { record('copyText', value); return { success: true }; },
      readPath: async filePath => { record('readPath', filePath); return { filePath, content: filePath.endsWith('/main.js') ? 'const mainOnly = true;\n' : filePath.endsWith('/other.cpp') ? 'int other = 1;\n' : 'alpha alpha\n' }; },
      runSafe: async p => { record('runSafe', p); state.runner?.({ running: true }); await new Promise(r => setTimeout(r, 10)); state.runner?.({ running: false }); return { durationMs: 10, code: 0 }; },
      killRun: async () => { record('killRun'); state.runner?.({ running: false }); },
      writeRunInput: async text => { record('writeRunInput', text); return { accepted: true }; },
      runHistory: async () => { record('runHistory'); return [{ fileName: 'main.js', language: 'javascript', exitCode: 0, durationMs: 10, timestamp: Date.now() }]; },
      terminalStart: async p => { record('terminalStart', p); return { cwd: '/tmp/project' }; },
      terminalWrite: async s => { record('terminalWrite', s); return { running: true }; },
      terminalStop: async () => { record('terminalStop'); return { stopped: true }; },
      askAI: async p => { record('askAI', p); return 'Suggested change:\n' + String.fromCharCode(96).repeat(3) + 'javascript\nconst fixed = true;\n' + String.fromCharCode(96).repeat(3); },
      askKey: async p => { record('askKey', p); return 'Agent proposal:\n' + String.fromCharCode(96).repeat(3) + 'javascript\nconst fixed = true;\n' + String.fromCharCode(96).repeat(3); },
      synthesize: async p => { record('synthesize', p); return 'Combined recommendation.'; },
      generateTests: async p => { record('generateTests', p); return 'console.assert(true);'; },
      setKey: async p => { record('setKey', { provider: p.provider, label: p.label, key: '***' }); const list = state.keys[p.provider]; list.push({ id: 'key-' + (list.length + 1), label: p.label || 'Key ' + (list.length + 1), active: list.length === 0, lastFour: String(p.key).slice(-4), agentCount: p.agentCount || 1 }); },
      listKeys: async () => { record('listKeys'); return Object.fromEntries(Object.entries(state.keys).map(([provider, keys]) => [provider, keys.map(k => ({ ...k }))])); },
      setActiveKey: async p => { record('setActiveKey', p); state.keys[p.provider] = state.keys[p.provider].map(k => ({ ...k, active: k.id === p.id })); },
      deleteKey: async p => { record('deleteKey', p); state.keys[p.provider] = state.keys[p.provider].filter(k => k.id !== p.id); if (!state.keys[p.provider].some(k => k.active) && state.keys[p.provider].length) state.keys[p.provider][0].active = true; },
      keyStatus: async () => { record('keyStatus'); return { openai: state.keys.openai.length > 0, gemini: state.keys.gemini.length > 0, claude: state.keys.claude.length > 0 }; },
      listPlugins: async () => { record('listPlugins'); return state.plugins; },
      togglePlugin: async p => { record('togglePlugin', p); state.plugins = state.plugins.map(x => x.name === p.name ? { ...x, enabled: p.enabled } : x); },
      pluginQuickActions: async () => { record('pluginQuickActions'); return [{ label: 'Sample plugin action', prompt: 'Check plugin action' }]; },
      pluginStatusItems: async () => { record('pluginStatusItems'); return [{ id: 'sample', text: 'Plugin ready', tooltip: 'Test plugin' }]; },
      onRunnerOutput: () => {}, onRunnerState: cb => { state.runner = cb; },
      onTerminalOutput: () => {}, onPluginStatusUpdate: () => {},
      onEditorCommand: cb => { state.editorCommand = cb; }
    };
  });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(baseUrl + '/src/index.html');
  await page.waitForSelector('#statusText');
  await page.waitForTimeout(1800);
  const click = async s => { const el = page.locator(s); await el.waitFor({ state: 'visible', timeout: 5000 }); await el.click({ timeout: 5000 }); };
  const called = async name => assert.ok((await page.evaluate(() => window.__uiCalls)).some(c => c.name === name), 'expected call ' + name);
  const results = [];
  const check = async (name, fn) => { try { await fn(); results.push({ control: name, result: 'PASS' }); } catch (e) { results.push({ control: name, result: 'FAIL', error: String(e.message || e) }); } };

  await check('Open file', async () => { await click('#openBtn'); await called('openFile'); assert.match(await page.locator('#statusText').textContent(), /Opened/); });
  await check('Open folder', async () => { await click('#openFolderBtn'); await called('openFolder'); assert.equal(await page.locator('#folderName').textContent(), 'PROJECT'); });
  await check('Explorer file item', async () => { await click('.file-item[data-path="/tmp/project/main.js"]'); await called('readPath'); });
  await check('Multi-file tabs keep independent edits', async () => {
    const tabs = page.locator('#tabs .document-tab');
    assert.equal(await tabs.count(), 3, 'welcome, example.js, and main.js should remain open');
    await tabs.filter({ hasText: 'main.js' }).last().click();
    assert.equal(await page.locator('#tabs .document-tab.active .tab-label').textContent(), 'main.js');
    const edited = await page.evaluate(() => { const model = monaco.editor.getModels().find(m => m.getValue().includes('mainOnly = true')); if (!model) return false; model.setValue('const mainOnly = true;\\nconst retainedAfterSwitch = 42;\\n'); return true; });
    assert.equal(edited, true, 'main.js model should be independently editable');
    assert.equal(await page.locator('#tabs .document-tab.active .tab-dirty').textContent(), '●');
    await tabs.filter({ hasText: 'example.js' }).first().click();
    assert.equal(await page.locator('#tabs .document-tab.active .tab-label').textContent(), 'example.js');
    await tabs.filter({ hasText: 'main.js' }).last().click();
    const retained = await page.evaluate(() => monaco.editor.getModels().some(m => m.getValue().includes('retainedAfterSwitch = 42')));
    assert.equal(retained, true, 'editing main.js should survive switching away and back');
  });
  await check('Tab close X asks before discarding unsaved work', async () => {
    await click('#newFileBtn'); await page.locator('#newFileName').fill('close_me'); await click('#newFileForm button[type="submit"]');
    await page.locator('#tabs .document-tab.active .tab-close').click();
    await page.locator('#fileCloseConfirm').waitFor({ state: 'visible' });
    await click('#fileCloseConfirm [data-close-action="discard"]');
    assert.equal(await page.locator('#tabs .document-tab').filter({ hasText: 'close_me.cpp' }).count(), 0);
  });
  await check('Tab Save & close works for a new unsaved file', async () => {
    await click('#newFileBtn'); await page.locator('#newFileName').fill('save_close_me'); await click('#newFileForm button[type="submit"]');
    await page.locator('#tabs .document-tab.active .tab-close').click();
    await page.locator('#fileCloseConfirm').waitFor({ state: 'visible' });
    await click('#fileCloseConfirm [data-close-action="save"]');
    await called('saveFile');
    assert.equal(await page.locator('#tabs .document-tab').filter({ hasText: 'save_close_me.cpp' }).count(), 0);
  });
  await check('Explorer menu exposes requested file actions', async () => {
    const row = page.locator('.file-item[data-path="/tmp/project/main.js"]');
    await row.locator('.file-actions-trigger').click();
    for (const label of ['Run Code','Open to the Side','Open With…','Reveal in File Explorer','Select for Compare','Open Timeline','Add File to Chat','Cut','Copy','Paste','Copy Path','Copy Relative Path','Rename…','Delete']) {
      assert.ok(await page.locator('#fileContextMenu .file-menu-item').filter({ hasText: label }).count(), 'missing action ' + label);
    }
    await click('#fileContextMenu [data-action="copyPath"]'); await called('copyText');
    await row.locator('.file-actions-trigger').click(); await click('#fileContextMenu [data-action="reveal"]'); await called('revealPath');
    await row.locator('.file-actions-trigger').click(); await click('#fileContextMenu [data-action="openWith"]'); await called('openWith');
  });
  await check('Open to Side displays a second editor', async () => {
    const row = page.locator('.file-item[data-path="/tmp/project/main.js"]');
    await row.locator('.file-actions-trigger').click(); await click('#fileContextMenu [data-action="side"]');
    await page.locator('#sideEditorPanel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#sideEditorTitle').textContent(), 'main.js');
    await click('#sideEditorPanel button[aria-label="Close side editor"]');
    assert.equal(await page.locator('#sideEditorPanel').isVisible(), false);
  });
  await check('Timeline and Add File to Chat work', async () => {
    const row=page.locator('.file-item[data-path="/tmp/project/main.js"]');
    await row.locator('.file-actions-trigger').click(); await click('#fileContextMenu [data-action="timeline"]');
    await page.locator('#fileTimelineOverlay').waitFor({state:'visible'}); await click('#fileTimelineOverlay .file-action-buttons button');
    await row.locator('.file-actions-trigger').click(); await click('#fileContextMenu [data-action="chat"]');
    assert.match(await page.locator('#promptInput').inputValue(), /Additional file context: main\.js/);
  });
  await check('Compare selects two files and opens diff view', async () => {
    await page.locator('.file-item[data-path="/tmp/project/main.js"] .file-actions-trigger').click(); await click('#fileContextMenu [data-action="compare"]');
    await page.locator('.file-item[data-path="/tmp/project/other.cpp"] .file-actions-trigger').click(); await click('#fileContextMenu [data-action="compare"]');
    await page.locator('#fileCompareOverlay').waitFor({state:'visible'}); await click('#fileCompareOverlay .file-action-buttons button');
    assert.equal(await page.locator('#fileCompareOverlay').count(),0);
  });
  await check('Cut/paste, rename and delete call their file APIs', async () => {
    await page.locator('.file-item[data-path="/tmp/project/main.js"] .file-actions-trigger').click(); await click('#fileContextMenu [data-action="cut"]');
    await page.locator('.file-item[data-path="/tmp/project/destination"]').click({ button: 'right' }); await click('#fileContextMenu [data-action="paste"]'); await called('transferPath'); await called('refreshFolder');
    await page.locator('.file-item[data-path="/tmp/project/other.cpp"] .file-actions-trigger').click(); await click('#fileContextMenu [data-action="rename"]');
    await page.locator('#fileRenameDialog input').fill('other-renamed.cpp'); await click('#fileRenameDialog .primary'); await called('renamePath');
    await page.locator('.file-item[data-path="/tmp/project/other.cpp"] .file-actions-trigger').click(); await click('#fileContextMenu [data-action="delete"]'); await called('deletePath');
  });
  await check('Save', async () => { await click('#saveBtn'); await called('saveFile'); });
  await check('New File sidebar button', async () => { await click('#newFileBtn'); assert.equal(await page.locator('#newFileModal').isVisible(), true); await click('#cancelNewFile'); });
  await check('New File banner + C++ create', async () => { await click('#newFileBannerBtn'); await page.locator('#newFileName').fill('click_test'); await page.locator('#newFileType').selectOption('cpp'); assert.equal(await page.locator('#newFilePreview').textContent(), 'click_test.cpp'); await click('#newFileForm button[type="submit"]'); assert.match(await page.locator('#tabs .document-tab.active .tab-label').textContent(), /click_test\.cpp/); });
  await check('New File cancel action', async () => { await click('#newFileBtn'); await click('#cancelNewFileAction'); assert.equal(await page.locator('#newFileModal').isVisible(), false); });
  await check('Run', async () => { await click('#runBtn'); await called('runSafe'); });
  await check('Run history', async () => { await click('#runHistoryBtn'); await called('runHistory'); assert.equal(await page.locator('#runHistoryDropdown').isVisible(), true); await click('#runHistoryBtn'); });
  await check('Clear output', async () => { await page.locator('#terminal').evaluate(e => e.innerHTML = '<div>test</div>'); await click('#clearOutputBtn'); assert.equal(await page.locator('#terminal').textContent(), ''); });
  await check('Start shell', async () => { await click('#terminalStartBtn'); await called('terminalStart'); });
  await check('Terminal send', async () => { await page.locator('#terminalCommand').fill('echo test'); await click('#terminalCommandForm button[type="submit"]'); await called('terminalWrite'); });
  await check('Interactive program input', async () => { await page.evaluate(() => window.__uiState.runner({ running: true })); await page.locator('#terminalCommand').fill('42'); await click('#terminalCommandForm button[type="submit"]'); await called('writeRunInput'); assert.ok((await page.evaluate(() => window.__uiCalls)).some(c => c.name === 'writeRunInput' && c.payload === '42\n')); await page.evaluate(() => window.__uiState.runner({ running: false })); });
  await check('Stop shell', async () => { await click('#terminalStopBtn'); await called('terminalStop'); });
  await check('Problems tab', async () => { await click('[data-panel="problems"]'); assert.equal(await page.locator('#problems').isVisible(), true); });
  await check('Terminal tab + focus button', async () => { await click('[data-panel="terminal"]'); await click('#focusTerminalBtn'); assert.equal(await page.locator('[data-panel="terminal"]').getAttribute('class').then(v => v.includes('active')), true); });
  await check('Explorer toggle', async () => { const before = await page.locator('.sidebar').evaluate(e => e.hidden); await click('#explorerBtn'); assert.notEqual(await page.locator('.sidebar').evaluate(e => e.hidden), before); await click('#explorerBtn'); });
  await check('Focus AI + welcome Ask AI', async () => { await click('#focusAiBtn'); assert.equal(await page.locator('#promptInput').evaluate(e => document.activeElement === e), true); await click('#focusAiBannerBtn'); assert.equal(await page.locator('#promptInput').evaluate(e => document.activeElement === e), true); });
  await check('Find next/previous/replace/close', async () => {
    await click('#openBtn');
    await page.evaluate(() => window.__uiState.editorCommand('find'));
    await page.locator('#findInput').fill('alpha'); assert.match(await page.locator('#findCount').textContent(), /2/);
    await click('#findNext'); await click('#findPrevious');
    await page.evaluate(() => window.__uiState.editorCommand('replace'));
    await page.locator('#findInput').fill('alpha'); await page.locator('#replaceInput').fill('beta');
    await click('#replaceOne'); await click('#replaceAll'); await click('#findClose');
    assert.equal(await page.locator('#findBar').isVisible(), false);
  });
  await check('Unified API key list and floating add-key panel', async () => {
    await click('#settingsBtn');
    await click('#checkKeysBtn');
    await called('listKeys');
    await click('#openApiKeyEditor');
    assert.equal(await page.locator('#apiKeyEditorModal').isVisible(), true);
    await page.locator('#apiKeyName').fill('Personal key');
    await page.locator('#apiKeyAgentCount').fill('2');
    await page.locator('#apiKeyValue').fill('sk-proj-fake-test-key-1111');
    await click('#addApiKeyConfirm');
    await page.waitForFunction(() => document.querySelectorAll('#savedApiKeyList .saved-api-key').length === 1);
    assert.equal(await page.locator('#apiKeyCount').textContent(), '1 saved key');
    assert.equal(await page.locator('#savedApiKeyList .saved-api-key strong').textContent(), 'Personal key');
    assert.match(await page.locator('#savedApiKeyList .saved-api-key span').textContent(), /OpenAI \/ GPT/);
    assert.match(await page.locator('#savedApiKeyList .saved-api-key span').textContent(), /2 agents/);
    await click('#openApiKeyEditor');
    await page.locator('#apiKeyName').fill('Work key');
    await page.locator('#apiKeyAgentCount').fill('1');
    await page.locator('#apiKeyValue').fill('sk-proj-fake-test-key-2222');
    await click('#addApiKeyConfirm');
    await page.waitForFunction(() => document.querySelectorAll('#savedApiKeyList .saved-api-key').length === 2);
    assert.equal(await page.locator('#apiKeyCount').textContent(), '2 saved keys');
    await click('#savedApiKeyList .saved-api-key:nth-child(2) button');
    await page.waitForFunction(() => document.querySelectorAll('#savedApiKeyList .saved-api-key.active').length === 1);
    await click('#closeSettings');
    assert.equal(await page.locator('#settingsModal').isVisible(), false);
  });
  await check('Plugin manager toggle/close', async () => {
    await click('#pluginsBtn'); await called('listPlugins');
    const toggle = page.locator('#pluginList input[type="checkbox"]');
    await toggle.waitFor({ state: 'attached' });
    const before = await toggle.isChecked();
    await page.locator('#pluginList .plugin-toggle').click();
    await page.waitForFunction(expected => document.querySelector('#pluginList input[type="checkbox"]').checked !== expected, before);
    await called('togglePlugin');
    await click('#closePlugins'); assert.equal(await page.locator('#pluginModal').isVisible(), false);
  });
  await check('Ask configured coworking agents', async () => { await page.locator('#promptInput').fill('Explain test'); await click('#askBtn'); await called('askKey'); await page.waitForFunction(() => document.querySelectorAll('.answer-card').length >= 3); });
  await check('AI quick prompts', async () => { for (const label of ['Explain code', 'Find bugs', 'Fix error', 'Write tests']) { await page.locator('.quick-actions button').filter({ hasText: label }).first().click(); } await called('askKey'); });
  await check('Generate tests', async () => { await click('.quick-actions button[data-action="generate-tests"]'); await called('generateTests'); });
  await check('Diff review apply/copy/dismiss', async () => {
    await page.locator('#promptInput').fill('propose a code fix'); await click('#askBtn');
    const review = page.getByRole('button', { name: /Review & Apply/ }).first(); await review.waitFor({ timeout: 5000 }); await review.click();
    await page.locator('#diffOverlay').waitFor({ state: 'visible', timeout: 5000 });
    await click('#diffCopy'); await click('#diffDismiss');
    await review.click(); await page.locator('#diffOverlay').waitFor({ state: 'visible', timeout: 5000 }); await click('#diffApply');
    assert.equal(await page.locator('#diffOverlay').isVisible(), false);
  });
  await check('Language status picker', async () => { await click('#languageStatus'); assert.ok(await page.locator('#languageStatus').textContent()); });
  await check('Plugin quick action', async () => { const b = page.locator('.plugin-qa'); if (await b.count()) { await b.click(); await called('askKey'); } });
  const inventory = await page.locator('button:visible').evaluateAll(bs => bs.map(b => ({ label: (b.innerText || b.getAttribute('aria-label') || b.title || '').trim(), id: b.id, type: b.type })));
  const summary = { totalChecks: results.length, passed: results.filter(x => x.result === 'PASS').length, failed: results.filter(x => x.result === 'FAIL').length, results, visibleButtonsAtEnd: inventory, pageErrors: errors };
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  if (summary.failed || errors.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
