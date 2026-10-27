// Local Ollama provider for Nidavellir. No API key is required.
// Security: only loopback HTTP endpoints are accepted to avoid sending project code
// to an arbitrary remote host through this local-provider path.
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5-coder:7b';

function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Ollama URL must be a valid URL, such as http://127.0.0.1:11434.'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'];
  if (parsed.protocol !== 'http:' || !loopback.includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('For safety, Ollama must use a local loopback HTTP URL (127.0.0.1, localhost, or ::1).');
  }
  return parsed.toString().replace(/\/$/, '');
}

function createOllamaProvider(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
  const defaultModel = String(options.model || DEFAULT_MODEL).trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120_000;

  async function ask({ prompt, system, model } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Enter a prompt for the local Ollama model.');
    if (prompt.length > 100_000) throw new Error('Prompt exceeds the 100,000 character limit.');
    const chosenModel = String(model || defaultModel).trim();
    if (!chosenModel || chosenModel.length > 200) throw new Error('Ollama model name is invalid.');
    const messages = [];
    if (typeof system === 'string' && system.trim()) messages.push({ role: 'system', content: system.slice(0, 10_000) });
    messages.push({ role: 'user', content: prompt });
    let response;
    try {
      response = await fetchImpl(baseUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: chosenModel, messages, stream: false }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (error && error.name === 'TimeoutError') throw new Error('Ollama timed out. Try a smaller model or increase available RAM.');
      throw new Error('Cannot reach local Ollama at ' + baseUrl + '. Install/start Ollama and pull model "' + chosenModel + '". Details: ' + (error?.message || 'connection failed'));
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.error || ('HTTP ' + response.status);
      if (response.status === 404) throw new Error('Ollama model "' + chosenModel + '" was not found. Run: ollama pull ' + chosenModel);
      throw new Error('Ollama request failed: ' + detail);
    }
    const answer = data?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('Ollama returned no answer. Check the model and try again.');
    return answer;
  }

  return { ask, baseUrl, defaultModel };
}

module.exports = { createOllamaProvider, normalizeBaseUrl, DEFAULT_BASE_URL, DEFAULT_MODEL };
