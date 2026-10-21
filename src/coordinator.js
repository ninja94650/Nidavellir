// src/coordinator.js — AI Coordinator for Nidavellir
// Takes responses from multiple AI providers and synthesises a unified
// recommendation that highlights consensus, disagreements, and best advice.

async function synthesizeResponses({ responses, askAIFn }) {
  if (!responses || responses.length < 2) {
    return 'The coordinator needs at least two provider responses to synthesize.';
  }

  const prompt = buildSynthesisPrompt(responses);
  const system =
    'You are an expert AI coordinator reviewing independent answers from multiple coding ' +
    'assistants. Compare them objectively: identify where they agree, where they disagree, ' +
    'and which suggestions are most accurate or beginner-friendly. Produce a single unified ' +
    'recommendation that takes the best from each. Flag any dangerous, incorrect, or ' +
    'misleading advice. Be concise but thorough. Use clear markdown headings.';

  try {
    return await askAIFn(prompt, system);
  } catch (err) {
    return `Coordinator synthesis failed: ${err.message}`;
  }
}

function buildSynthesisPrompt(responses) {
  const labels = {
    openai: 'GPT (OpenAI)',
    gemini: 'Gemini (Google)',
    claude: 'Claude (Anthropic)'
  };

  let prompt =
    'Below are independent answers from multiple AI coding assistants to the same user question. ' +
    'Please compare, synthesize, and produce a unified best answer.\n\n';

  for (const { provider, text } of responses) {
    prompt += `--- ${labels[provider] || provider} ---\n${text}\n\n`;
  }

  prompt +=
    '--- YOUR TASK ---\n' +
    '1. **Consensus** — What do all assistants agree on?\n' +
    '2. **Differences** — Where do they disagree? Who is more likely correct and why?\n' +
    '3. **Warnings** — Any dangerous, incorrect, or misleading suggestions?\n' +
    '4. **Unified recommendation** — The single best answer combining the strongest parts of each.\n' +
    '5. For code changes, show the final recommended code in a fenced code block.\n';

  return prompt;
}

module.exports = { synthesizeResponses };
