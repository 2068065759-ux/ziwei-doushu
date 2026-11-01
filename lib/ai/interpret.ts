export const DEFAULT_OPENAI_MODEL = 'gpt-6.1-terra';

export type InterpretMessage = {
  role: 'user' | 'assistant';
  content: string;
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
