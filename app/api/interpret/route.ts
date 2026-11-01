import {
  DEFAULT_OPENAI_MODEL,
  buildOpenAIRequest,
  formatClientSse,
  parseInterpretBody,
  parseOpenAISseLine,
  type ParsedOpenAIEvent,
} from '@/lib/ai/interpret';
import { getChatGPTPlanAuthorization } from '@/lib/ai/chatgpt-plan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const UPSTREAM_TIMEOUT_MS = 120_000;

type AuthSource = 'chatgpt-plan' | 'api-key';

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function planErrorResponse(status: number): Response {
  if (status === 401) return errorResponse('ChatGPT Plus 授权已失效，请重新连接 ChatGPT', 401);
  if (status === 403) return errorResponse('当前 ChatGPT 账号或套餐不允许这个请求', 403);
  if (status === 429) return errorResponse('ChatGPT Plus 当前使用额度已达到限制，请到 ChatGPT 设置 → Usage 查看', 429);
  return errorResponse('ChatGPT Plus 请求暂时不可用', 502);
}

export async function POST(request: Request): Promise<Response> {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return errorResponse('无法读取请求内容', 400);
  }

  const parsed = parseInterpretBody(rawBody);
  if (!parsed.ok) {
    return errorResponse(parsed.message, parsed.status);
  }

  let bearerToken: string | null = null;
  let model = DEFAULT_OPENAI_MODEL;
  let authSource: AuthSource | null = null;

  try {
    const planAuthorization = await getChatGPTPlanAuthorization();
    if (planAuthorization) {
      bearerToken = planAuthorization.accessToken;
      model = planAuthorization.model || DEFAULT_OPENAI_MODEL;
      authSource = 'chatgpt-plan';
    }
  } catch (error) {
    console.error('[interpret] ChatGPT plan authorization failed:', error instanceof Error ? error.message : error);
    return errorResponse('ChatGPT Plus 授权需要重新连接，请运行 npm run chatgpt:login', 503);
  }

  if (!bearerToken) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (apiKey) {
      bearerToken = apiKey;
      model = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
      authSource = 'api-key';
    }
  }

  if (!bearerToken || !authSource) {
    return errorResponse('尚未连接 ChatGPT Plus。请先运行 npm run chatgpt:login', 503);
  }

  let upstream: Response;
  try {
    upstream = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildOpenAIRequest({
        chart: parsed.value.chart,
        messages: parsed.value.messages,
        model,
      })),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    console.error('[interpret] failed to reach OpenAI:', error instanceof Error ? error.message : error);
    return errorResponse('AI 解读服务连接失败', 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error(`[interpret] OpenAI ${upstream.status} (${authSource}): ${detail.slice(0, 800)}`);
    if (authSource === 'chatgpt-plan') return planErrorResponse(upstream.status);
    return errorResponse('AI 解读服务请求失败', 502);
  }

  if (!upstream.body) {
    return errorResponse('AI 解读服务未返回数据流', 502);
  }

  const upstreamReader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = '';
      let finished = false;

      const emit = (event: ParsedOpenAIEvent | null): boolean => {
        if (!event) return false;
        controller.enqueue(encoder.encode(formatClientSse(event)));
        if (event.kind === 'done' || event.kind === 'error') {
          finished = true;
          return true;
        }
        return false;
      };

      try {
        while (!finished) {
          const { done, value } = await upstreamReader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (emit(parseOpenAISseLine(line))) break;
          }
        }

        if (!finished && buffer) {
          emit(parseOpenAISseLine(buffer));
        }

        if (!finished) {
          controller.enqueue(encoder.encode(formatClientSse({ kind: 'done' })));
        }
        controller.close();
      } catch (error) {
        console.error('[interpret] OpenAI stream failed:', error instanceof Error ? error.message : error);
        if (!finished) {
          controller.enqueue(encoder.encode(formatClientSse({
            kind: 'error',
            message: 'OpenAI stream failed',
          })));
        }
        controller.close();
      } finally {
        upstreamReader.cancel().catch(() => undefined);
      }
    },
    cancel() {
      return upstreamReader.cancel();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
