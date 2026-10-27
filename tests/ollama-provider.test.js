const test = require('node:test');
const assert = require('node:assert/strict');
const { createOllamaProvider, normalizeBaseUrl, DEFAULT_MODEL } = require('../src/ollama-provider');

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('Ollama provider defaults to loopback and a coding model without an API key', () => {
  const provider = createOllamaProvider({ fetchImpl: async () => response(200, { message: { content: 'ok' } }) });
  assert.equal(provider.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(provider.defaultModel, DEFAULT_MODEL);
});

test('Ollama provider sends non-streaming chat requests and returns model text', async () => {
  let request;
  const provider = createOllamaProvider({
    model: 'qwen2.5-coder:7b',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { message: { content: 'Use a bounds check.' } });
    }
  });
  const answer = await provider.ask({ prompt: 'Review this code', system: 'You are a coding assistant.' });
  assert.equal(answer, 'Use a bounds check.');
  assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(request.options.method, 'POST');
  const body = JSON.parse(request.options.body);
  assert.equal(body.stream, false);
  assert.equal(body.model, 'qwen2.5-coder:7b');
  assert.deepEqual(body.messages.map(m => m.role), ['system', 'user']);
});

test('Ollama provider rejects remote endpoints to keep local project code local', () => {
  assert.throws(() => normalizeBaseUrl('https://example.com'), /loopback/);
  assert.throws(() => normalizeBaseUrl('http://192.168.1.10:11434'), /loopback/);
  assert.throws(() => normalizeBaseUrl('http://user:pass@localhost:11434'), /loopback/);
});

test('Ollama provider reports missing model and connection failures clearly', async () => {
  const missing = createOllamaProvider({ fetchImpl: async () => response(404, { error: 'model not found' }) });
  await assert.rejects(() => missing.ask({ prompt: 'hello' }), /ollama pull qwen2.5-coder:7b/i);
  const offline = createOllamaProvider({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => offline.ask({ prompt: 'hello' }), /Cannot reach local Ollama/);
});

test('Ollama provider validates prompts and empty model responses', async () => {
  const provider = createOllamaProvider({ fetchImpl: async () => response(200, { message: { content: '' } }) });
  await assert.rejects(() => provider.ask({ prompt: '  ' }), /Enter a prompt/);
  await assert.rejects(() => provider.ask({ prompt: 'hello' }), /returned no answer/);
});
