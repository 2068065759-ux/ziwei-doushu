import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CHATGPT_PLAN_REQUIRED_SCOPE =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const CHATGPT_PLAN_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_PLAN_AUTH_FILENAME = '.chatgpt-plan.json';

const TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';
const REFRESH_EARLY_MS = 5 * 60 * 1000;

export type ChatGPTPlanModel = {
  slug: string;
  display_name?: string;
  visibility?: string;
};

export type ChatGPTPlanAuth = {
  hostId: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  scope: string;
  expiresAt: number;
  model?: string;
  email?: string;
  name?: string;
};

export type ChatGPTPlanAuthorization = {
  accessToken: string;
  model?: string;
  authPath: string;
};

function hasDirectUsageScope(scope: string): boolean {
  return scope.split(/\s+/).includes('chatgpt.tokens.use.direct');
}

export function chooseChatGPTPlanModel(
  models: ChatGPTPlanModel[],
  preferred = 'gpt-6.1-terra',
): string | null {
  const visible = models.filter((model) => model.slug && model.visibility !== 'hidden');
  if (visible.length === 0) return null;
  return visible.find((model) => model.slug === preferred)?.slug ?? visible[0]?.slug ?? null;
}

export function parseChatGPTPlanAuth(raw: string):
  | { ok: true; value: ChatGPTPlanAuth }
  | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'ChatGPT 授权文件不是有效 JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'ChatGPT 授权文件格式无效' };
  }

  const record = parsed as Record<string, unknown>;
  const hostId = record.host_id;
  const clientId = record.client_id;
  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  const idToken = record.id_token;
  const scope = record.scope;
  const expiresAt = record.expires_at;
  const model = record.model;
  const email = record.email;
  const name = record.name;

  if (
    typeof hostId !== 'string' || !hostId ||
    typeof clientId !== 'string' || !clientId ||
    typeof accessToken !== 'string' || !accessToken ||
    typeof refreshToken !== 'string' || !refreshToken ||
    typeof scope !== 'string' || !scope ||
    typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)
  ) {
    return { ok: false, message: 'ChatGPT 授权文件缺少必要字段' };
  }

  if (!hasDirectUsageScope(scope)) {
    return { ok: false, message: 'ChatGPT 授权没有套餐使用权限' };
  }

  return {
    ok: true,
    value: {
      hostId,
      clientId,
      accessToken,
      refreshToken,
      idToken: typeof idToken === 'string' ? idToken : undefined,
      scope,
      expiresAt,
      model: typeof model === 'string' && model ? model : undefined,
      email: typeof email === 'string' ? email : undefined,
      name: typeof name === 'string' ? name : undefined,
    },
  };
}

export function buildRefreshTokenBody(auth: ChatGPTPlanAuth): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: auth.clientId,
    refresh_token: auth.refreshToken,
    resource: CHATGPT_PLAN_RESOURCE,
  });
}

export function resolveChatGPTPlanAuthPath(): string {
  const configured = process.env.CHATGPT_PLAN_AUTH_FILE?.trim();
  return configured ? path.resolve(configured) : path.join(process.cwd(), CHATGPT_PLAN_AUTH_FILENAME);
}

function serializeAuth(auth: ChatGPTPlanAuth): string {
  return JSON.stringify({
    host_id: auth.hostId,
    client_id: auth.clientId,
    access_token: auth.accessToken,
    refresh_token: auth.refreshToken,
    id_token: auth.idToken,
    scope: auth.scope,
    expires_at: auth.expiresAt,
    model: auth.model,
    email: auth.email,
    name: auth.name,
  }, null, 2) + '\n';
}

async function persistAuth(authPath: string, auth: ChatGPTPlanAuth): Promise<void> {
  const tempPath = `${authPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, serializeAuth(auth), { mode: 0o600 });
  await rename(tempPath, authPath);
  await chmod(authPath, 0o600).catch(() => undefined);
}

async function refreshAuth(authPath: string, auth: ChatGPTPlanAuth): Promise<ChatGPTPlanAuth> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: buildRefreshTokenBody(auth),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`ChatGPT 套餐授权刷新失败 (${response.status}): ${detail.slice(0, 300)}`);
  }

  const data = await response.json() as Record<string, unknown>;
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('ChatGPT 套餐授权刷新未返回 access_token');
  }

  const scope = typeof data.scope === 'string' ? data.scope : auth.scope;
  if (!hasDirectUsageScope(scope)) {
    throw new Error('ChatGPT 套餐授权刷新后缺少 chatgpt.tokens.use.direct 权限');
  }

  const expiresIn = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
    ? data.expires_in
    : 3600;

  const updated: ChatGPTPlanAuth = {
    ...auth,
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token
      ? data.refresh_token
      : auth.refreshToken,
    idToken: typeof data.id_token === 'string' && data.id_token ? data.id_token : auth.idToken,
    scope,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  await persistAuth(authPath, updated);
  return updated;
}

export async function getChatGPTPlanAuthorization(
  authPath = resolveChatGPTPlanAuthPath(),
): Promise<ChatGPTPlanAuthorization | null> {
  let raw: string;
  try {
    raw = await readFile(authPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    throw error;
  }

  const parsed = parseChatGPTPlanAuth(raw);
  if (!parsed.ok) throw new Error(parsed.message);

  let auth = parsed.value;
  if (auth.expiresAt <= Date.now() + REFRESH_EARLY_MS) {
    auth = await refreshAuth(authPath, auth);
  }

  return {
    accessToken: auth.accessToken,
    model: auth.model,
    authPath,
  };
}
