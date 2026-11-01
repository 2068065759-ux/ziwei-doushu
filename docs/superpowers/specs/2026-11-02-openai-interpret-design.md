# OpenAI 命盘问答设计

目标：为现有紫微斗数聊天面板补齐 `/api/interpret` 后端，使用户能基于当前完整命盘连续提问。

## 约束
- 不修改排盘算法和现有聊天 UI。
- 仅服务端读取 `OPENAI_API_KEY`，浏览器永远拿不到密钥。
- 使用 OpenAI Responses API。
- 默认模型固定为 `gpt-6.1-terra`，可由 `OPENAI_MODEL` 覆盖。
- 保持现有 ChatPanel 的 SSE 协议：`data: {"delta":{"text":"..."}}`，结束发送 `data: [DONE]`。
- 请求中包含完整命盘和对话历史，以支持连续追问。
- 对缺少命盘、空消息、超长输入、OpenAI 上游异常返回明确错误。

## 实现方式
新增纯函数模块 `lib/ai/interpret.ts`，负责构造 Responses API 请求和解析上游 SSE；新增 `app/api/interpret/route.ts` 负责校验请求、调用 OpenAI 并把上游增量转换成前端既有 SSE 格式。

不引入 OpenAI SDK，直接使用服务端 `fetch`，减少依赖和锁文件改动。
