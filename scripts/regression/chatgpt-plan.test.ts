import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CHATGPT_PLAN_REQUIRED_SCOPE,
  buildRefreshTokenBody,
  chooseChatGPTPlanModel,
  getChatGPTPlanAuthorization,
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

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ziwei-chatgpt-plan-'));
const authPath = path.join(tempDir, '.chatgpt-plan.json');
await writeFile(authPath, JSON.stringify({
  host_id: 'urn:uuid:22222222-2222-4222-8222-222222222222',
  client_id: 'oaiapp_concurrency_test',
  access_token: 'expired-access',
  refresh_token: 'refresh-old',
  id_token: 'id-old',
  scope: CHATGPT_PLAN_REQUIRED_SCOPE,
  expires_at: Date.now() - 1,
  model: 'gpt-6.1-terra',
}));

const originalFetch = globalThis.fetch;
let refreshCalls = 0;
globalThis.fetch = async () => {
  refreshCalls += 1;
  await new Promise((resolve) => setTimeout(resolve, 25));
  return new Response(JSON.stringify({
    access_token: 'access-new',
    refresh_token: 'refresh-new',
    id_token: 'id-new',
    scope: CHATGPT_PLAN_REQUIRED_SCOPE,
    expires_in: 3600,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

try {
  const [first, second] = await Promise.all([
    getChatGPTPlanAuthorization(authPath),
    getChatGPTPlanAuthorization(authPath),
  ]);
  assert.equal(refreshCalls, 1, 'concurrent callers must share one rotating-token refresh');
  assert.equal(first?.accessToken, 'access-new');
  assert.equal(second?.accessToken, 'access-new');

  const saved = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, unknown>;
  assert.equal(saved.refresh_token, 'refresh-new');
  assert.equal(saved.access_token, 'access-new');
} finally {
  globalThis.fetch = originalFetch;
  await rm(tempDir, { recursive: true, force: true });
}

console.log('[chatgpt-plan] auth parsing, model selection and serialized refresh passed');
