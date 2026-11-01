import {
  DEFAULT_OPENAI_MODEL,
  buildOpenAIRequest,
  formatClientSse,
  parseInterpretBody,
  parseOpenAISseLine,
  type ParsedOpenAIEvent,
} from '@/lib/ai/interpret';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const UPSTREAM_TIMEOUT_MS = 120_000;

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
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

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.error('[interpret] OPENAI_API_KEY is not configured');
    return errorResponse('AI 解读服务尚未配置', 503);
  }

  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;

  let upstream: Response;
  try {
    upstream = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
    console.error(`[interpret] OpenAI ${upstream.status}: ${detail.slice(0, 800)}`);
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
