export const DEFAULT_OPENAI_MODEL = 'gpt-6.1-terra';
export const MAX_INTERPRET_BODY_CHARS = 750_000;
const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 20_000;

export type InterpretMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type InterpretPayload = {
  chart: Record<string, unknown>;
  messages: InterpretMessage[];
};

export type BuildOpenAIRequestArgs = {
  chart: unknown;
  messages: InterpretMessage[];
  model?: string;
};

export type ParsedOpenAIEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

export type ParseInterpretBodyResult =
  | { ok: true; value: InterpretPayload }
  | { ok: false; status: 400 | 413; message: string };

const SYSTEM_INSTRUCTIONS = `你是紫微斗数命盘分析助手。回答必须以传入的当前命盘数据为依据，不得虚构盘中不存在的星曜、宫位、四化、大限或流年信息。

分析时优先检查命宫、身宫、三方四正、十四主星、辅煞星、四化、宫干引动、大限与流年之间的关系。用户追问年份、事业、财运、感情、学业、健康或具体事件时，要结合当前命盘与已有对话上下文回答。

输出使用简体中文，先给明确结论，再给命盘依据。区分“命盘中直接可见的信息”和“基于紫微斗数体系的推断”。如果命盘数据本身不足以支持某个细节，直接说明缺少哪项盘面依据，不要自行补造数据。`;

function renderConversation(messages: InterpretMessage[]): string {
  if (messages.length === 0) return '（暂无历史提问）';
  return messages
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`)
    .join('\n\n');
}

export function buildOpenAIRequest({
  chart,
  messages,
  model = DEFAULT_OPENAI_MODEL,
}: BuildOpenAIRequestArgs) {
  return {
    model,
    stream: true as const,
    store: false,
    reasoning: { effort: 'medium' as const },
    instructions: SYSTEM_INSTRUCTIONS,
    input: [
      {
        role: 'user' as const,
        content: `【当前紫微斗数命盘 JSON】\n${JSON.stringify(chart)}\n\n【本轮对话历史】\n${renderConversation(messages)}`,
      },
    ],
  };
}

export function parseInterpretBody(rawBody: string): ParseInterpretBodyResult {
  if (rawBody.length > MAX_INTERPRET_BODY_CHARS) {
    return { ok: false, status: 413, message: '请求内容过大' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, message: '请求不是有效 JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, status: 400, message: '请求格式无效' };
  }

  const record = parsed as Record<string, unknown>;
  const chart = record.chart;
  const messages = record.messages;

  if (!chart || typeof chart !== 'object' || Array.isArray(chart)) {
    return { ok: false, status: 400, message: '缺少有效命盘数据' };
  }

  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return { ok: false, status: 400, message: '消息数量无效' };
  }

  const normalized: InterpretMessage[] = [];
  for (const item of messages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, status: 400, message: '消息格式无效' };
    }
    const message = item as Record<string, unknown>;
    if (message.role !== 'user' && message.role !== 'assistant') {
      return { ok: false, status: 400, message: '消息角色无效' };
    }
    if (typeof message.content !== 'string' || !message.content.trim()) {
      return { ok: false, status: 400, message: '消息内容不能为空' };
    }
    if (message.content.length > MAX_MESSAGE_CHARS) {
      return { ok: false, status: 400, message: '单条消息过长' };
    }
    normalized.push({ role: message.role, content: message.content });
  }

  return {
    ok: true,
    value: {
      chart: chart as Record<string, unknown>,
      messages: normalized,
    },
  };
}

export function parseOpenAISseLine(line: string): ParsedOpenAIEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;

  const data = trimmed.slice(5).trim();
  if (!data) return null;
  if (data === '[DONE]') return { kind: 'done' };

  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }

  if (!event || typeof event !== 'object') return null;
  const record = event as Record<string, unknown>;

  if (record.type === 'response.output_text.delta' && typeof record.delta === 'string') {
    return { kind: 'delta', text: record.delta };
  }

  if (record.type === 'response.completed') {
    return { kind: 'done' };
  }

  if (record.type === 'error') {
    return {
      kind: 'error',
      message: typeof record.message === 'string' ? record.message : 'OpenAI streaming error',
    };
  }

  if (record.type === 'response.failed') {
    const response = record.response;
    if (response && typeof response === 'object') {
      const error = (response as Record<string, unknown>).error;
      if (error && typeof error === 'object') {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === 'string') return { kind: 'error', message };
      }
    }
    return { kind: 'error', message: 'OpenAI response failed' };
  }

  return null;
}

export function formatClientSse(event: ParsedOpenAIEvent): string {
  if (event.kind === 'delta') {
    return `data: ${JSON.stringify({ delta: { text: event.text } })}\n\n`;
  }
  if (event.kind === 'done') {
    return 'data: [DONE]\n\n';
  }
  return `data: ${JSON.stringify({ delta: { text: '\n\n解读服务请求失败，请稍后重试。' } })}\n\ndata: [DONE]\n\n`;
}
