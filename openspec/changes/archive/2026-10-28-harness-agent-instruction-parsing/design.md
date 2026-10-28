# Design: harness agent 指令解析链路

## 目标链路

```
用户对话 / 图片
  → 浏览器 ai-widget.js（POST /api/parse，或 ws /api/chat）
  → ai-agent-server :3000（pm2，/opt/ai-agent-server）
       ↳ 优先 → dsh headless --json（DeepSeek Harness agent，SiliconFlow 底模）→ /api/parse
       ↳ 兜底 → 单次 SiliconFlow /v1/chat/completions
  → {"commands":[{"id","params"},…],"explanation","tool"}   ← 一次可多条命令
  → widget 提交命令 + request_repaint()
  → wasm 引擎 / photocraft-cli serve gateway → PhotoCraft 引擎 → 画布更新
```

## 关键设计点

### harness-agent.ts（后端，非本前端仓库）
- 用 `dsh --profile headless --patch <tmp yml> --json <task>` 调用。
- `--patch` 注入 SiliconFlow 路由：`llm-pi-ai.providers.siliconflow` 设 `openai-completions` 兼容端点、
  `apiKeyEnv: LLM_API_KEY`，无需 DeepSeek 官方 key；`agent-default-model` 指向同模型。
- task 正文 = `PHOTOCRAFT_SYSTEM_PROMPT`（真实引擎命令目录 + 强约束"只输出 JSON、不调用工具"）。
- 解析 JSONL 流里 `final` 事件的 `text`，提 `{commands:[{id,params}], explanation}`。
- 超时 `taskTimeout * 2`，失败抛出并由 parse.ts 回退单次 LLM。

### 401 根因与 `dotenv { override: true }`
- 部署/启动环境可能注入旧的 `LLM_API_URL=https://token.sensenova.cn/v1`、`LLM_MODEL=sensenova-6.8-flash-lite`。
- 默认 `dotenv/config` 不覆盖已存在环境变量 → SiliconFlow patch 用错 URL → 401 Forbidden。
- 修复：`dotenv.config({ override: true })`，让 `.env` 优先。

### 可观察行为变化（本前端仓库）
- 一句话可返回多条命令并逐一应用（`ai-widget` spec 已补充 Scenario）。
