const { chromium } = require('playwright');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: process.env.HEADLESS_UI === '1', args: ['--allow-file-access-from-files', '--no-sandbox'] });
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
      runSafe: async p => { record('runSafe', p); state.runner?.({ running: true }); await new Promise(r => setTimeout(r, 10)); state.runner?.({ running: false }); return { durationMs: 10, code: 0 }; },
      killRun: async () => { record('killRun'); state.runner?.({ running: false }); },
      runHistory: async () => { record('runHistory'); return [{ fileName: 'main.js', language: 'javascript', exitCode: 0, durationMs: 10, timestamp: Date.now() }]; },
      terminalStart: async p => { record('terminalStart', p); return { cwd: '/tmp/project' }; },
      terminalWrite: async s => { record('terminalWrite', s); return { running: true }; },
      terminalStop: async () => { record('terminalStop'); return { stopped: true }; },
      askAI: async p => { record('askAI', p); return 'Suggested change: const fixed = true;'; },
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
  const file = pathToFileURL(path.resolve(__dirname, '../src/index.html')).href;
  await page.goto(file);
  await page.waitForSelector('#statusText');
  await page.waitForTimeout(1800);
  const click = async s => { const el = page.locator(s); await el.waitFor({ state: 'visible', timeout: 5000 }); await el.click({ timeout: 5000 }); };
  const called = async name => assert.ok((await page.evaluate(() => window.__uiCalls)).some(c => c.name === name), 'expected call ' + name);
  const results = [];
  const check = async (name, fn) => { try { await fn(); results.push({ control: name, result: 'PASS' }); } catch (e) { results.push({ control: name, result: 'FAIL', error: String(e.message || e) }); } };

  await check('Open file', async () => { await click('#openBtn'); await called('openFile'); assert.match(await page.locator('#statusText').textContent(), /Opened/); });
  await check('Open folder', async () => { await click('#openFolderBtn'); await called('openFolder'); assert.equal(await page.locator('#folderName').textContent(), 'PROJECT'); });
  await check('Explorer file item', async () => { await click('.file-item'); await called('readPath'); });
  await check('Save', async () => { await click('#saveBtn'); await called('saveFile'); });
  await check('New File sidebar button', async () => { await click('#newFileBtn'); assert.equal(await page.locator('#newFileModal').isVisible(), true); await click('#cancelNewFile'); });
  await check('New File banner + C++ create', async () => { await click('#newFileBannerBtn'); await page.locator('#newFileName').fill('click_test'); await page.locator('#newFileType').selectOption('cpp'); assert.equal(await page.locator('#newFilePreview').textContent(), 'click_test.cpp'); await click('#newFileForm button[type="submit"]'); assert.match(await page.locator('#tabs .tab').textContent(), /click_test\.cpp/); });
  await check('New File cancel action', async () => { await click('#newFileBtn'); await click('#cancelNewFileAction'); assert.equal(await page.locator('#newFileModal').isVisible(), false); });
  await check('Run', async () => { await click('#runBtn'); await called('runSafe'); });
  await check('Run history', async () => { await click('#runHistoryBtn'); await called('runHistory'); assert.equal(await page.locator('#runHistoryDropdown').isVisible(), true); await click('#runHistoryBtn'); });
  await check('Clear output', async () => { await page.locator('#terminal').evaluate(e => e.innerHTML = '<div>test</div>'); await click('#clearOutputBtn'); assert.equal(await page.locator('#terminal').textContent(), ''); });
  await check('Start shell', async () => { await click('#terminalStartBtn'); await called('terminalStart'); });
  await check('Terminal send', async () => { await page.locator('#terminalCommand').fill('echo test'); await click('#terminalCommandForm button[type="submit"]'); await called('terminalWrite'); });
  await check('Stop shell', async () => { await click('#terminalStopBtn'); await called('terminalStop'); });
  await check('Problems tab', async () => { await click('[data-panel="problems"]'); assert.equal(await page.locator('#problems').isVisible(), true); });
  await check('Terminal tab + focus button', async () => { await click('[data-panel="terminal"]'); await click('#focusTerminalBtn'); assert.equal(await page.locator('[data-panel="terminal"]').getAttribute('class').then(v => v.includes('active')), true); });
  await check('Explorer toggle', async () => { const before = await page.locator('.sidebar').evaluate(e => e.hidden); await click('#explorerBtn'); assert.notEqual(await page.locator('.sidebar').evaluate(e => e.hidden), before); await click('#explorerBtn'); });
  await check('Focus AI + welcome Ask AI', async () => { await click('#focusAiBtn'); assert.equal(await page.locator('#promptInput').evaluate(e => document.activeElement === e), true); await click('#focusAiBannerBtn'); assert.equal(await page.locator('#promptInput').evaluate(e => document.activeElement === e), true); });
  await check('Find next/previous/replace/close', async () => {
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
    const toggle = page.locator('#pluginList input[type="checkbox"]'); await toggle.waitFor(); await toggle.uncheck(); await called('togglePlugin');
    await click('#closePlugins'); assert.equal(await page.locator('#pluginModal').isVisible(), false);
  });
  await check('Ask team', async () => { await page.locator('#useGemini').uncheck(); await page.locator('#useClaude').uncheck(); await page.locator('#promptInput').fill('Explain test'); await click('#askBtn'); await called('askAI'); });
  await check('AI quick prompts', async () => { for (const label of ['Explain code', 'Find bugs', 'Fix error', 'Write tests']) { await page.locator('.quick-actions button').filter({ hasText: label }).first().click(); } await called('askAI'); });
  await check('Generate tests', async () => { await click('.quick-actions button[data-action="generate-tests"]'); await called('generateTests'); });
  await check('Language status picker', async () => { await click('#languageStatus'); assert.ok(await page.locator('#languageStatus').textContent()); });
  await check('Plugin quick action', async () => { const b = page.locator('.plugin-qa'); if (await b.count()) { await b.click(); await called('askAI'); } });
  const inventory = await page.locator('button:visible').evaluateAll(bs => bs.map(b => ({ label: (b.innerText || b.getAttribute('aria-label') || b.title || '').trim(), id: b.id, type: b.type })));
  const summary = { totalChecks: results.length, passed: results.filter(x => x.result === 'PASS').length, failed: results.filter(x => x.result === 'FAIL').length, results, visibleButtonsAtEnd: inventory, pageErrors: errors };
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
  if (summary.failed || errors.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
