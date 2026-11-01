# 使用 ChatGPT Plus / Pro 套餐进行命盘问答

本项目支持 OpenAI 官方的 **Sign in with ChatGPT / ChatGPT plan usage** 开源工具流程。

适用范围：个人、本地运行或自托管的开源工具。公开远程托管的网站若要直接向用户提供 ChatGPT 套餐共享，需要按 OpenAI 的合作方/私有应用规则申请相应资格；不要把本地授权文件提交到 GitHub 或公开服务器镜像。

## 本地连接

```bash
npm ci
npm run chatgpt:login
npm run dev
```

`npm run chatgpt:login` 会：

1. 在 `127.0.0.1` 启动一次性 OAuth 回调；
2. 打开 OpenAI 官方登录页；
3. 请求 `chatgpt.tokens.use.direct` 等套餐共享权限；
4. 校验 OpenAI ID Token；
5. 读取当前账号实际可用的模型目录；
6. 优先选择 `gpt-6.1-terra`，若账号没有该模型则选择账号返回的首个可用模型；
7. 把凭证保存到 `.chatgpt-plan.json`（权限 0600，已加入 `.gitignore`）。

AI 请求优先使用该 ChatGPT 套餐授权。Access Token 临近过期时，服务端会使用 Refresh Token 自动续期并原子写回最新凭证。

## 自托管服务器

OpenAI 的开源流程使用 `127.0.0.1` 回调，因此授权应先在你自己的电脑上完成。若把应用运行在自托管 VM，请按 OpenAI 的 self-hosted VM 指南通过安全通道转移凭证，并确保授权文件只有服务进程可读。

## API Key 备用

如果没有 `.chatgpt-plan.json`，程序仍可读取 `OPENAI_API_KEY` 作为备用。套餐共享请求失败时不会自动切换到 API Key，以避免在用户不知情时改变计费路径。
