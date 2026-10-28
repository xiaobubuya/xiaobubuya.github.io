# Proposal: 指令解析切换到 DeepSeek Harness agent

## Why

`/api/parse` 之前用**单次 LLM**（SiliconFlow `/v1/chat/completions`）把一句自然语言
解析成 PhotoCraft 原生命令。单次 LLM 对「一句话包含多次修改」很弱：要么只给一条命令、
要么给结构不稳的 JSON。我们希望用户一句话能做多次图片修改（如「改黑白，再提对比度」），
于是把解析链路切换到 **DeepSeek Harness `dsh headless --json`**（harness agent）：
它带推理/多步规划，一次可产出多命令，且可注入 SiliconFlow 做底模，无需 DeepSeek 官方 key。

## What Changes

- 后端 `ai-agent-server`（非本前端仓库）：
  - `src/core/harness-agent.ts` 恢复/修复：用 `dsh --profile headless --patch <siliconflow路由> --json`，
    强约束"只输出 JSON 命令、不调用工具"，一次产出 `{commands:[{id,params},…], explanation}`。
  - `src/api/parse.ts` 接入 `callHarnessAgent`：**harness 优先**，失败回退单次 LLM。
  - `src/core/photocraft-prompts.ts` 提供真实引擎命令目录 + 系统提示词（命令 id 全部取自上游，不发明）。
  - `config.ts` 用 `dotenv { override: true }`，避免进程环境里旧的 sensenova URL 覆盖 SiliconFlow 而 401。
  - `index.ts` 挂载 `/api/parse`。
- 本前端仓库 `xiaobubuya.github.io`：
  - `openspec/specs/ai-widget/spec.md` 补充「一句话返回多条命令」的可观察行为场景。
  - 归档文档 `AI-BRIDGE-FIX-2026-10-27.md` 的数据流部分追加 10-28 切换更正。

## Capabilities

- `ai-widget`：悬浮球指令链路，后端一次可返回多条命令并逐一应用。
