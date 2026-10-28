# Tasks

## 1. 后端启用并验证 harness（/opt/ai-agent-server，非本前端仓库）

- [x] 1.1 确认修复后的 `harness-agent.ts` 存在并接入 `parse.ts`（harness 优先、LLM 兜底）
- [x] 1.2 `.env` 增加 `HARNESS_ENABLED=true`、`HARNESS_CLI=/usr/local/bin/dsh`
- [x] 1.3 `config.ts` 用 `dotenv.config({ override: true })` 修复旧环境变量覆盖 SiliconFlow 的 401 根因
- [x] 1.4 `tsc` 构建 + `pm2 restart ai-agent-server`
- [x] 1.5 验证 `POST /api/parse` 返回 2 条命令（hueSaturation 黑白 + brightnessContrast 对比度），日志确认 `[Parse] (photocraft, harness)` + `[Harness] 生成 2 条命令`

## 2. 后端同步到 git（deepseek-harness 仓库 apps/ai-agent-server）

- [x] 2.1 同步运行中 `/opt/ai-agent-server/src` 全量（含 parse.ts、photocraft-prompts.ts、photocraft-serve.ts 等）到 `apps/ai-agent-server/src`
- [x] 2.2 删除旧 `llm-parser-fallback.ts`
- [x] 2.3 `deploy-ai-agent.yml` 生成的 `.env` 增加 `HARNESS_ENABLED=true`
- [x] 2.4 `.env.example` 补充 HARNESS_ENABLED、SiliconFlow、serve gateway 配置
- [x] 2.5 `git commit`（本地；push 由用户决定）

## 3. 前端仓库文档（本仓库 xiaobubuya.github.io）

- [x] 3.1 `openspec/specs/ai-widget/spec.md` 补充「一句话返回多条命令」Scenario
- [x] 3.2 归档文档 `AI-BRIDGE-FIX-2026-10-27.md` 数据流部分追加 2026-10-28 切换更正（新旧链路图）
- [x] 3.3 建本 change（proposal / specs / design / tasks）

## 4. 归档

- [x] 4.1 `openspec archive harness-agent-instruction-parsing` 归档到 `openspec/changes/archive/2026-10-28-harness-agent-instruction-parsing`
- [ ] 4.2 `git commit` 前端仓库文档变更
