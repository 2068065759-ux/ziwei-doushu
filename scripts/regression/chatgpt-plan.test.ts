import assert from 'node:assert/strict';
import {
  CHATGPT_PLAN_REQUIRED_SCOPE,
  buildRefreshTokenBody,
  chooseChatGPTPlanModel,
  parseChatGPTPlanAuth,
} from '../../lib/ai/chatgpt-plan';

assert.match(CHATGPT_PLAN_REQUIRED_SCOPE, /chatgpt\.tokens\.use\.direct/);
assert.match(CHATGPT_PLAN_REQUIRED_SCOPE, /offline_access/);

assert.equal(
  chooseChatGPTPlanModel([
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol' },
    { slug: 'gpt-6.1-terra', display_name: 'GPT-6.1 Terra' },
  ]),
  'gpt-6.1-terra',
);

assert.equal(
  chooseChatGPTPlanModel([{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol' }]),
  'gpt-6.1-sol',
);

assert.equal(chooseChatGPTPlanModel([]), null);

const parsed = parseChatGPTPlanAuth(JSON.stringify({
  host_id: 'urn:uuid:11111111-1111-4111-8111-111111111111',
  client_id: 'oaiapp_test',
  access_token: 'access',
  refresh_token: 'refresh',
  id_token: 'id',
  scope: CHATGPT_PLAN_REQUIRED_SCOPE,
  expires_at: Date.now() + 60_000,
  model: 'gpt-6.1-terra',
}));
assert.equal(parsed.ok, true);
if (parsed.ok) {
  const body = buildRefreshTokenBody(parsed.value);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('client_id'), 'oaiapp_test');
  assert.equal(body.get('refresh_token'), 'refresh');
  assert.equal(body.get('resource'), 'https://api.openai.com/v1');
}

const invalidScope = parseChatGPTPlanAuth(JSON.stringify({
  host_id: 'urn:uuid:11111111-1111-4111-8111-111111111111',
  client_id: 'oaiapp_test',
  access_token: 'access',
  refresh_token: 'refresh',
  scope: 'openid profile email',
  expires_at: Date.now() + 60_000,
}));
assert.equal(invalidScope.ok, false);

console.log('[chatgpt-plan] auth parsing, refresh contract and model selection passed');
