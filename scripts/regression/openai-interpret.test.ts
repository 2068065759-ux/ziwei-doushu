import assert from 'node:assert/strict';
import {
  DEFAULT_OPENAI_MODEL,
  buildOpenAIRequest,
  parseOpenAISseLine,
} from '../../lib/ai/interpret';

const chart = {
  name: '测试命盘',
  gender: 'male',
  solarDate: '2000-01-01',
  palaces: [{ name: '命宫', stars: ['紫微'] }],
};

const request = buildOpenAIRequest({
  chart,
  messages: [
    { role: 'user', content: '先看事业' },
    { role: 'assistant', content: '先看命宫与官禄宫。' },
    { role: 'user', content: '那明年呢？' },
  ],
});

assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-6.1-terra');
assert.equal(request.model, 'gpt-6.1-terra');
assert.equal(request.stream, true);
assert.match(request.instructions, /紫微斗数/);
assert.ok(Array.isArray(request.input));
assert.match(JSON.stringify(request.input), /测试命盘/);
assert.match(JSON.stringify(request.input), /先看事业/);
assert.match(JSON.stringify(request.input), /那明年呢/);

assert.deepEqual(
  parseOpenAISseLine(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '命宫' })}`),
  { kind: 'delta', text: '命宫' },
);
assert.deepEqual(
  parseOpenAISseLine(`data: ${JSON.stringify({ type: 'response.completed' })}`),
  { kind: 'done' },
);
assert.equal(
  parseOpenAISseLine(`data: ${JSON.stringify({ type: 'response.created' })}`),
  null,
);

console.log('[openai-interpret] request construction and SSE parsing contract passed');
