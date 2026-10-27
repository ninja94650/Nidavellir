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
    const state = { runner: null, editorCommand: null, keys: {}, plugins: [{ name: 'sample-plugin', version: '1.0.0', description: 'UI test plugin', enabled: true }] };
    window.__uiCalls = []; window.__uiState = state;
    const record = (name, payload) => window.__uiCalls.push({ name, payload });
    window.prompt = (_message, value) => value || 'javascript';
    window.forge = {
      openFile: async () => { record('openFile'); return { filePath: '/tmp/example.js', content: 'alpha alpha\n' }; },
      openFolder: async () => { record('openFolder'); return { folder: '/tmp/project', tree: [{ name: 'main.js', path: '/tmp/project/main.js', directory: false }] }; },
      saveFile: async p => { record('saveFile', p); return { filePath: p.filePath || '/tmp/new-file.js', name: p.name || 'new-file.js' }; },
      readPath: async filePath => { record('readPath', filePath); return { filePath, content: 'alpha alpha\n' }; },
      searchProject: async p => { record('searchProject',p); return {root:'/tmp/project',filesScanned:1,truncated:false,results:[{filePath:'/tmp/project/main.js',relativePath:'main.js',lineNumber:1,line:'alpha alpha',matchIndex:0,matchLength:5}]}; },
      replaceProject: async p => { record('replaceProject',p); return {replacedFiles:1,replacements:2}; },
      checkEnvironment: async () => { record('checkEnvironment'); return {platform:'test',checkedAt:new Date().toISOString(),tools:[{id:'node',label:'Node.js',available:true,command:'node',version:'v22.0.0',purpose:'Run JS',install:'Install Node'}]}; },
      gitStatus: async () => { record('gitStatus'); return {root:'/tmp/project',branch:'main',entries:[{indexStatus:' ',worktreeStatus:'M',path:'main.js',original:' M main.js'}]}; },
      gitDiff: async () => { record('gitDiff'); return 'diff --git a/main.js b/main.js'; },
      gitBranches: async () => { record('gitBranches'); return ['main','feature']; },
      gitLog: async () => { record('gitLog'); return [{hash:'abc123',subject:'Initial commit',date:'just now'}]; },
      gitStage: async p => { record('gitStage',p); return {stdout:'staged'}; },
      gitUnstage: async p => { record('gitUnstage',p); return {stdout:'unstaged'}; },
      gitCommit: async p => { record('gitCommit',p); return {stdout:'[main abc123] test'}; },
      gitCheckout: async p => { record('gitCheckout',p); return {stdout:'switched'}; },
      runSafe: async p => { record('runSafe', p); state.runner?.({ running: true }); await new Promise(r => setTimeout(r, 10)); state.runner?.({ running: false }); return { durationMs: 10, code: 0 }; },
      killRun: async () => { record('killRun'); state.runner?.({ running: false }); },
      writeRunInput: async text => { record('writeRunInput', text); return { accepted: true }; },
      runHistory: async () => { record('runHistory'); return [{ fileName: 'main.js', language: 'javascript', exitCode: 0, durationMs: 10, timestamp: Date.now() }]; },
      terminalStart: async p => { record('terminalStart', p); return { cwd: '/tmp/project' }; },
      terminalWrite: async s => { record('terminalWrite', s); return { running: true }; },
      terminalStop: async () => { record('terminalStop'); return { stopped: true }; },
      askAI: async p => { record('askAI', p); return 'Suggested change:\n' + String.fromCharCode(96).repeat(3) + 'javascript\nconst fixed = true;\n' + String.fromCharCode(96).repeat(3); },
      synthesize: async p => { record('synthesize', p); return 'Combined recommendation.'; },
      generateTests: async p => { record('generateTests', p); return 'console.assert(true);'; },
      setKey: async p => { record('setKey', { provider: p.provider, key: '***' }); state.keys[p.provider] = true; },
      keyStatus: async () => { record('keyStatus'); return { openai: !!state.keys.openai, gemini: !!state.keys.gemini, claude: !!state.keys.claude }; },
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
  await check('Explorer file item', async () => { await click('.file-item'); await called('readPath'); });
  await check('Project search dialog returns results', async () => {
    await click('#projectSearchBtn'); await page.locator('#projectSearchQuery').fill('alpha'); await click('#projectSearchRun'); await called('searchProject');
    assert.match(await page.locator('#projectSearchSummary').textContent(), /match/); await click('#closeProjectSearch');
  });
  await check('Environment Doctor renders tool status', async () => {
    await click('#environmentDoctorBtn'); await called('checkEnvironment'); assert.match(await page.locator('#environmentResults').textContent(), /Node.js/); await click('#closeEnvironment');
  });
  await check('Git workspace shows status and stages files', async () => {
    await click('#gitBtn'); await called('gitStatus'); assert.match(await page.locator('#gitBranchLabel').textContent(), /main/); await page.locator('#gitEntries button').first().click(); await called('gitStage'); await click('#closeGit');
  });
  await check('New documents get independent tabs', async () => {
    await click('#newFileBtn');
    await page.locator('#newFileName').fill('scratch');
    await page.locator('#newFileType').selectOption('javascript');
    await page.locator('#newFileForm button[type="submit"]').click();
    assert.ok(await page.locator('.tab').count() >= 2);
    assert.ok(await page.locator('.tab').allTextContents().then(t => t.some(v => v.includes('scratch.js'))));
  });
  await check('Quick Open filters and opens workspace file', async () => {
    await page.keyboard.press('Control+P');
    assert.equal(await page.locator('#commandPalette').isVisible(), true);
    await page.locator('#commandPaletteInput').fill('main.js');
    assert.equal(await page.locator('.palette-item').count(), 1);
    assert.match(await page.locator('.palette-item').first().textContent(), /main\.js/);
    await page.locator('.palette-item').first().click();
    await called('readPath');
    assert.equal(await page.locator('#commandPalette').isVisible(), false);
  });
  await check('Save', async () => { await click('#saveBtn'); await called('saveFile'); });
  await check('Save As opens destination picker request', async () => {
    await click('#saveAsBtn');
    const calls = await page.evaluate(() => window.__uiCalls.filter(c => c.name === 'saveFile'));
    assert.equal(calls.at(-1).payload.forceDialog, true);
    assert.equal(calls.at(-1).payload.filePath, null);
  });
  await check('Ctrl+Shift+S invokes Save As', async () => {
    await page.locator('#editor').click({ position: { x: 30, y: 30 } }).catch(() => {});
    await page.keyboard.press('Control+Shift+S');
    const calls = await page.evaluate(() => window.__uiCalls.filter(c => c.name === 'saveFile'));
    assert.equal(calls.at(-1).payload.forceDialog, true);
  });
  await check('Command Palette filters and runs actions', async () => {
    await page.keyboard.press('Control+Shift+P');
    assert.equal(await page.locator('#commandPalette').isVisible(), true);
    await page.locator('#commandPaletteInput').fill('run current file');
    assert.equal(await page.locator('.palette-item').count(), 1);
    assert.match(await page.locator('.palette-item').first().textContent(), /Run Current File/);
    await page.keyboard.press('Enter');
    await called('runSafe');
    assert.equal(await page.locator('#commandPalette').isVisible(), false);
  });
  await check('Word Wrap can be toggled from the palette', async () => {
    await click('#commandPaletteBtn');
    await page.locator('#commandPaletteInput').fill('toggle word wrap');
    assert.equal(await page.locator('.palette-item').count(), 1);
    assert.match(await page.locator('.palette-item').first().textContent(), /Currently on/);
    await page.locator('.palette-item').first().click();
    await click('#commandPaletteBtn');
    await page.locator('#commandPaletteInput').fill('toggle word wrap');
    assert.match(await page.locator('.palette-item').first().textContent(), /Currently off/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#commandPalette').isVisible(), false);
  });
  await check('New File sidebar button', async () => { await click('#newFileBtn'); assert.equal(await page.locator('#newFileModal').isVisible(), true); await click('#cancelNewFile'); });
  await check('New File banner + C++ create', async () => { await click('#newFileBannerBtn'); await page.locator('#newFileName').fill('click_test'); await page.locator('#newFileType').selectOption('cpp'); assert.equal(await page.locator('#newFilePreview').textContent(), 'click_test.cpp'); await click('#newFileForm button[type="submit"]'); assert.match(await page.locator('#tabs .tab').textContent(), /click_test\.cpp/); });
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
  await check('Settings open/check/save/close', async () => {
    await click('#settingsBtn'); await click('#checkKeysBtn'); await called('keyStatus');
    await page.locator('#openaiKey').fill('fake-test-key'); await click('#saveKeysBtn'); await called('setKey');
    await click('#closeSettings'); assert.equal(await page.locator('#settingsModal').isVisible(), false);
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
  await check('Ask team', async () => { await page.locator('#useGemini').uncheck(); await page.locator('#useClaude').uncheck(); await page.locator('#promptInput').fill('Explain test'); await click('#askBtn'); await called('askAI'); });
  await check('AI quick prompts', async () => { for (const label of ['Explain code', 'Find bugs', 'Fix error', 'Write tests']) { await page.locator('.quick-actions button').filter({ hasText: label }).first().click(); } await called('askAI'); });
  await check('Generate tests', async () => { await click('.quick-actions button[data-action="generate-tests"]'); await called('generateTests'); });
  await check('Diff review apply/copy/dismiss', async () => {
    await page.locator('#useOpenAI').check(); await page.locator('#useGemini').uncheck(); await page.locator('#useClaude').uncheck();
    await page.locator('#promptInput').fill('propose a code fix'); await click('#askBtn');
    const review = page.getByRole('button', { name: /Review & Apply/ }).first(); await review.waitFor({ timeout: 5000 }); await review.click();
    await page.locator('#diffOverlay').waitFor({ state: 'visible', timeout: 5000 });
    await click('#diffCopy'); await click('#diffDismiss');
    await review.click(); await page.locator('#diffOverlay').waitFor({ state: 'visible', timeout: 5000 }); await click('#diffApply');
    assert.equal(await page.locator('#diffOverlay').isVisible(), false);
  });
  await check('Language status picker', async () => { await click('#languageStatus'); assert.ok(await page.locator('#languageStatus').textContent()); });
  await check('Plugin quick action', async () => { const b = page.locator('.plugin-qa'); if (await b.count()) { await b.click(); await called('askAI'); } });
  const inventory = await page.locator('button:visible').evaluateAll(bs => bs.map(b => ({ label: (b.innerText || b.getAttribute('aria-label') || b.title || '').trim(), id: b.id, type: b.type })));
  const summary = { totalChecks: results.length, passed: results.filter(x => x.result === 'PASS').length, failed: results.filter(x => x.result === 'FAIL').length, results, visibleButtonsAtEnd: inventory, pageErrors: errors };
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  if (summary.failed || errors.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
