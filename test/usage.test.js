import test from 'node:test';
import assert from 'node:assert/strict';
import { extractProviderUsage } from '../src/adapters.js';

test('provider usage parser handles JSON and JSONL without depending on one vendor schema', () => {
  assert.deepEqual(extractProviderUsage(JSON.stringify({
    usage: { input_tokens: 120, output_tokens: 30 },
    total_cost_usd: 0.42,
  })), {
    inputTokens: 120,
    outputTokens: 30,
    costUsd: 0.42,
    totalTokens: 150,
    source: 'provider-output',
  });

  const jsonl = [
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'turn.completed', usage: { promptTokenCount: 200, candidatesTokenCount: 50, totalTokenCount: 250 } }),
  ].join('\n');
  assert.equal(extractProviderUsage(jsonl).totalTokens, 250);
});

test('provider usage parser returns null for unstructured prose', () => {
  assert.equal(extractProviderUsage('Work completed successfully.'), null);
});

test('provider usage parser aggregates OpenCode step_finish token and cost parts', () => {
  const jsonl = [
    { type: 'step_finish', part: { type: 'step-finish', tokens: { input: 100, output: 20, reasoning: 5, total: 125, cache: { read: 30, write: 2 } }, cost: 0.12 } },
    { type: 'part.updated', properties: { part: { type: 'step_finish', tokens: { input: 40, output: 10, reasoning: 0, total: 50, cache: { read: 8 } }, cost: 0.03 } } },
  ].map(JSON.stringify).join('\n');
  assert.deepEqual(extractProviderUsage(jsonl), {
    inputTokens: 140,
    outputTokens: 30,
    reasoningTokens: 5,
    cachedInputTokens: 38,
    cacheWriteTokens: 2,
    totalTokens: 175,
    costUsd: 0.15,
    source: 'opencode-step-finish',
    steps: 2,
  });
});
