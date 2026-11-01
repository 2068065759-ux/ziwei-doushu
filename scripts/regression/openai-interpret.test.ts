import assert from 'node:assert/strict';
import {
  DEFAULT_OPENAI_MODEL,
  MAX_INTERPRET_BODY_CHARS,
  buildOpenAIRequest,
  formatClientSse,
  parseInterpretBody,
  parseOpenAISseLine,
} from '../../lib/ai/interpret';

const chart = {
  name: '测试命盘',
  gender: 'male',
  solarDate: '2000-01-01',
  palaces: [{ name: '命宫', stars: ['紫微'] }],
};

const messages = [
  { role: 'user' as const, content: '先看事业' },
  { role: 'assistant' as const, content: '先看命宫与官禄宫。' },
  { role: 'user' as const, content: '那明年呢？' },
];

const request = buildOpenAIRequest({ chart, messages });
assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-6.1-terra');
assert.equal(request.model, 'gpt-6.1-terra');
assert.equal(request.stream, true);
assert.equal(request.store, false);
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

const valid = parseInterpretBody(JSON.stringify({ chart, messages }));
assert.equal(valid.ok, true);
if (valid.ok) {
  assert.equal(valid.value.messages.at(-1)?.content, '那明年呢？');
}

const missingChart = parseInterpretBody(JSON.stringify({ messages }));
assert.equal(missingChart.ok, false);
if (!missingChart.ok) assert.equal(missingChart.status, 400);

const invalidRole = parseInterpretBody(JSON.stringify({
  chart,
  messages: [{ role: 'system', content: 'bad' }],
}));
assert.equal(invalidRole.ok, false);
if (!invalidRole.ok) assert.equal(invalidRole.status, 400);

const oversized = parseInterpretBody('x'.repeat(MAX_INTERPRET_BODY_CHARS + 1));
assert.equal(oversized.ok, false);
if (!oversized.ok) assert.equal(oversized.status, 413);

assert.equal(
  formatClientSse({ kind: 'delta', text: '命宫' }),
  `data: ${JSON.stringify({ delta: { text: '命宫' } })}\n\n`,
);
assert.equal(formatClientSse({ kind: 'done' }), 'data: [DONE]\n\n');
assert.match(formatClientSse({ kind: 'error', message: 'private upstream detail' }), /解读服务请求失败/);
assert.doesNotMatch(formatClientSse({ kind: 'error', message: 'private upstream detail' }), /private upstream detail/);

console.log('[openai-interpret] request, validation, and SSE contracts passed');
