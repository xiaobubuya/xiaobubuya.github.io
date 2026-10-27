# 2026-10-27：AI 悬浮球联动修复记录

记录 ai-agent-server 与前端 `ai-widget.js` 之间「应用后图片不变」问题的修复（对应 `docs/AI_WIDGET.md` §7 的两个 bug）。

## 背景与正确架构

右下角悬浮球(`ai-widget.js`) → `POST ai.muyaya.world/api/parse` → ai-agent-server(LLM 解析) →
返回命令 JSON `{commands:[{key, value}]}` → 悬浮球 `mapToPhotoCraftCommand` →
`window.execute_command(adjust.*, …)` → 真实 photocraft-web 引擎(AI Bridge `session.execute`) → UI 实时联动。
**后端不主动出图**。

## Bug 2（server 端，已修已验）

- 现象：返回的 key 带 `u` 前缀（`uExposure`…），而 `ai-widget.js` 映射表用无前缀 key（`exposure`…），映射不到 → 图片不变。
- 修复（`/opt/ai-agent-server/src/core/studio-prompts.ts`）：
  - `WIDGET_ADJUSTMENTS` 改为 48 个无前缀 key，与 `ai-widget.js` `mapToPhotoCraftCommand` 逐一对应。
  - `STUDIO_SYSTEM_PROMPT` 改为只输出无前缀 key。
- 修复（`/opt/ai-agent-server/src/api/parse.ts`）：白名单改用 `ALL_WIDGET_KEYS`，值夹到 [-1,1]。
- 校验：server 48 个 key 与 widget 映射表 48 个 key **完全一致**，无静默跳过。
- 实测：`/api/parse` 返回 `exposure`/`temperature`/`saturation`/`redSaturation`/`contrast`/`clarity` 等。
- 已 `npm run build`(tsc) + `pm2 restart ai-agent-server` 生效。

## Bug 1（前端 `ai-widget.js:540`，补丁见仓库 `patches/`）

- 现象：`const success = executeCommands(...)` 漏 `await`，Promise 恒真 → 永远显示「已应用」。
- 修复：`const success = await executeCommands(...)`。
- 补丁文件：`patches/ai-widget.await-fix.patch`（需应用到前端仓库再推 Pages）。

## 端到端验证

对实时 `/api/parse` 响应按 widget 映射表解析，全部映射到有效 `adjust.*` 命令（可被 `window.execute_command` 执行）：

- 调亮+暖色 → `adjust.exposure`, `adjust.colorTemperature`
- 黑白 → `adjust.saturation`
- 红色更鲜艳 → `adjust.hueSaturation.red`
- 对比度+清晰度 → `adjust.contrast`, `adjust.clarity`

## 保留 v0.16 更新口子

部署的 `photocraft/` wasm 已是 v0.16.0 + AI Bridge，由前端仓库 `build-photocraft-wasm.yml` CI 构建（非本机）。上游升级路径在仓库 CI，不在本机改。

## 待办

- 前端 `ai-widget.js` Bug1 修复尚未生效：需应用 `patches/ai-widget.await-fix.patch` 并重推。注意改 js 要升 `sw.js` 的 `SHELL` 版本号（当前 `shell-v66`）。
