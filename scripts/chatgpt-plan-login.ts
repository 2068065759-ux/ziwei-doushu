import { createServer } from 'node:http';
import {
  constants,
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature,
} from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CHATGPT_PLAN_AUTH_FILENAME,
  CHATGPT_PLAN_REQUIRED_SCOPE,
  CHATGPT_PLAN_RESOURCE,
  chooseChatGPTPlanModel,
  parseChatGPTPlanAuth,
  type ChatGPTPlanModel,
} from '../lib/ai/chatgpt-plan';

const AUTHORIZE_ENDPOINT = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';
const JWKS_ENDPOINT = 'https://auth.openai.com/.well-known/jwks.json';
const MODELS_ENDPOINT = 'https://api.openai.com/v1/models';
const ISSUER = 'https://auth.openai.com';
const AGENT_NAME = 'Ziwei Doushu';
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const CALLBACK_PATH = '/auth/callback';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const authPath = process.env.CHATGPT_PLAN_AUTH_FILE?.trim()
  ? path.resolve(process.env.CHATGPT_PLAN_AUTH_FILE.trim())
  : path.join(process.cwd(), CHATGPT_PLAN_AUTH_FILENAME);
const hostPath = path.join(path.dirname(authPath), '.chatgpt-plan-host.json');

type HostRegistration = {
  host_id: string;
  client_id?: string;
  id_token_hint?: string;
  email?: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function openSystemBrowser(url: string): void {
  const child = process.platform === 'darwin'
    ? spawn('open', [url], { detached: true, stdio: 'ignore' })
    : process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
      : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
}

function decodeJwtJson(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function verifyIdToken(
  idToken: string,
  expectedClientId: string,
  expectedNonce: string,
): Promise<Record<string, unknown>> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('OpenAI 返回的 ID Token 格式无效');

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtJson(encodedHeader);
  const payload = decodeJwtJson(encodedPayload);
  const kid = header.kid;
  const alg = header.alg;
  if (typeof kid !== 'string' || typeof alg !== 'string') {
    throw new Error('ID Token 缺少签名信息');
  }

  const jwksResponse = await fetch(JWKS_ENDPOINT, { headers: { accept: 'application/json' } });
  if (!jwksResponse.ok) throw new Error('无法读取 OpenAI 签名公钥');
  const jwks = await jwksResponse.json() as { keys?: Array<Record<string, unknown>> };
  const jwk = jwks.keys?.find((key) => key.kid === kid);
  if (!jwk) throw new Error('找不到匹配的 OpenAI 签名公钥');

  const publicKey = createPublicKey({ key: jwk as never, format: 'jwk' });
  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`);
  const signature = Buffer.from(encodedSignature, 'base64url');

  let verified = false;
  if (alg === 'RS256') {
    verified = verifySignature('RSA-SHA256', signingInput, publicKey, signature);
  } else if (alg === 'PS256') {
    verified = verifySignature('sha256', signingInput, {
      key: publicKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }, signature);
  } else if (alg === 'ES256') {
    verified = verifySignature('sha256', signingInput, {
      key: publicKey,
      dsaEncoding: 'ieee-p1363',
    }, signature);
  } else {
    throw new Error(`暂不支持的 ID Token 签名算法：${alg}`);
  }

  if (!verified) throw new Error('ID Token 签名校验失败');
  if (payload.iss !== ISSUER) throw new Error('ID Token issuer 校验失败');

  const audience = payload.aud;
  const audienceOk = typeof audience === 'string'
    ? audience === expectedClientId
    : Array.isArray(audience) && audience.includes(expectedClientId);
  if (!audienceOk) throw new Error('ID Token audience 校验失败');
  if (payload.nonce !== expectedNonce) throw new Error('ID Token nonce 校验失败');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now - 60) {
    throw new Error('ID Token 已过期');
  }
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) {
    throw new Error('ID Token 尚未生效');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('ID Token 缺少用户标识');
  }

  return payload;
}

async function startLoopbackListener(): Promise<{
  redirectUri: string;
  waitForCallback: () => Promise<URL>;
  close: () => Promise<void>;
}> {
  let resolveCallback!: (url: URL) => void;
  let rejectCallback!: (error: Error) => void;
  const callbackPromise = new Promise<URL>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request, response) => {
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('本地回调地址不可用');
      const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${address.port}`);
      if (requestUrl.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><title>ChatGPT 已连接</title><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:40px"><h2>ChatGPT 已授权</h2><p>可以关闭这个页面，返回终端。</p></body>');
      resolveCallback(requestUrl);
    } catch (error) {
      rejectCallback(error instanceof Error ? error : new Error(String(error)));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动本地授权回调');
  const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;

  const timeout = setTimeout(() => rejectCallback(new Error('ChatGPT 登录授权超时')), LOGIN_TIMEOUT_MS);
  timeout.unref();

  return {
    redirectUri,
    waitForCallback: () => callbackPromise.finally(() => clearTimeout(timeout)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function listModels(accessToken: string): Promise<ChatGPTPlanModel[]> {
  const response = await fetch(MODELS_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`无法读取 ChatGPT 套餐模型列表 (${response.status})`);
  }

  const data = await response.json() as Record<string, unknown>;
  const rawModels = Array.isArray(data.models)
    ? data.models
    : Array.isArray(data.data)
      ? data.data
      : [];

  return rawModels.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const model = item as Record<string, unknown>;
    const slug = typeof model.slug === 'string'
      ? model.slug
      : typeof model.id === 'string'
        ? model.id
        : null;
    if (!slug) return [];
    return [{
      slug,
      display_name: typeof model.display_name === 'string' ? model.display_name : undefined,
      visibility: typeof model.visibility === 'string' ? model.visibility : undefined,
    }];
  });
}

async function main(): Promise<void> {
  const savedHost = await readJsonFile<HostRegistration>(hostPath);
  let existingAuth = null;
  try {
    const raw = await readFile(authPath, 'utf8');
    const parsed = parseChatGPTPlanAuth(raw);
    if (parsed.ok) existingAuth = parsed.value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }

  const hostId = savedHost?.host_id || existingAuth?.hostId || `urn:uuid:${randomUUID()}`;
  const issuedClientId = savedHost?.client_id || existingAuth?.clientId;
  const retainedIdToken = savedHost?.id_token_hint || existingAuth?.idToken;
  const savedEmail = savedHost?.email || existingAuth?.email;

  await writePrivateJson(hostPath, {
    host_id: hostId,
    client_id: issuedClientId,
    id_token_hint: retainedIdToken,
    email: savedEmail,
  });

  const listener = await startLoopbackListener();
  const state = randomUrlSafe();
  const nonce = randomUrlSafe();
  const verifier = randomUrlSafe(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const authorizationUrl = new URL(AUTHORIZE_ENDPOINT);
  authorizationUrl.search = new URLSearchParams({
    client_id: issuedClientId || DYNAMIC_CLIENT_ID,
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: listener.redirectUri,
    scope: CHATGPT_PLAN_REQUIRED_SCOPE,
    resource: CHATGPT_PLAN_RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    ...(issuedClientId ? {} : { agent_name_hint: AGENT_NAME }),
    ...(retainedIdToken ? { id_token_hint: retainedIdToken } : {}),
    ...(!retainedIdToken && savedEmail ? { login_hint: savedEmail } : {}),
  }).toString();

  console.log('\n正在打开 ChatGPT 授权页…');
  console.log('请在浏览器中登录你的 Plus 账号，并允许“使用 ChatGPT 套餐”。\n');
  openSystemBrowser(authorizationUrl.toString());

  try {
    const callback = await listener.waitForCallback();
    if (callback.searchParams.get('state') !== state) throw new Error('授权 state 校验失败');
    const oauthError = callback.searchParams.get('error');
    if (oauthError) throw new Error(`ChatGPT 授权未完成：${oauthError}`);

    const code = callback.searchParams.get('code');
    if (!code) throw new Error('授权回调缺少 code');

    const callbackClientId = callback.searchParams.get('client_id');
    const clientId = issuedClientId || callbackClientId;
    if (!clientId || clientId === DYNAMIC_CLIENT_ID) throw new Error('授权回调缺少 OpenAI 分配的 client_id');
    if (issuedClientId && callbackClientId && callbackClientId !== issuedClientId) {
      throw new Error('授权回调 client_id 与已保存账号不匹配');
    }

    // OpenAI recommends retaining the issued client ID before code exchange.
    await writePrivateJson(hostPath, {
      host_id: hostId,
      client_id: clientId,
      id_token_hint: retainedIdToken,
      email: savedEmail,
    });

    const tokenResponse = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: listener.redirectUri,
        resource: CHATGPT_PLAN_RESOURCE,
      }),
    });

    if (!tokenResponse.ok) {
      const detail = await tokenResponse.text().catch(() => '');
      throw new Error(`OpenAI token exchange 失败 (${tokenResponse.status}): ${detail.slice(0, 300)}`);
    }

    const tokens = await tokenResponse.json() as TokenResponse;
    if (!tokens.access_token || !tokens.refresh_token || !tokens.id_token) {
      throw new Error('OpenAI 没有返回完整的套餐授权凭证');
    }
    const grantedScope = tokens.scope || '';
    if (!grantedScope.split(/\s+/).includes('chatgpt.tokens.use.direct')) {
      throw new Error('你已登录 ChatGPT，但没有允许该工具使用 Plus 套餐额度');
    }

    const identity = await verifyIdToken(tokens.id_token, clientId, nonce);
    const models = await listModels(tokens.access_token);
    const visibleModels = models.filter((model) => model.visibility === 'list' || !model.visibility);
    const model = chooseChatGPTPlanModel(visibleModels);
    if (!model) throw new Error('这个 ChatGPT 账号没有返回可用于套餐共享的模型');

    const expiresIn = typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)
      ? tokens.expires_in
      : 3600;
    const email = typeof identity.email === 'string' ? identity.email : undefined;
    const name = typeof identity.name === 'string' ? identity.name : undefined;

    await writePrivateJson(authPath, {
      host_id: hostId,
      client_id: clientId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      scope: grantedScope,
      expires_at: Date.now() + expiresIn * 1000,
      model,
      email,
      name,
    });

    await writePrivateJson(hostPath, {
      host_id: hostId,
      client_id: clientId,
      id_token_hint: tokens.id_token,
      email,
    });

    console.log('ChatGPT Plus 已连接。');
    console.log(`当前模型：${model}`);
    if (model !== 'gpt-6.1-terra') {
      console.log('你的套餐模型目录当前没有 gpt-6.1-terra，已自动选择账号实际可用的首选模型。');
    }
    console.log(`授权文件：${authPath}`);
    console.log('现在运行 npm run dev，即可在命盘页面直接提问。\n');
  } finally {
    await listener.close();
  }
}

main().catch((error) => {
  console.error('\nChatGPT Plus 连接失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
