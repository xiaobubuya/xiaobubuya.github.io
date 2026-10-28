# AI 修图「无法解析指令」故障记录（2026-10-27 → 10-28）

> 链路原理见 [`AI-BRIDGE.md`](AI-BRIDGE.md)。本文只记录这次故障的现象、根因、改动、验证与回滚。

## 现象

`https://muyaya.world/photocraft/` 打开图片后，在「✨ AI 修图」面板发送「你好」/「改为黑白的」，
面板返回红色错误 `❌ 无法解析指令，请尝试更具体的描述`，图片无任何变化。
面板顶部状态是绿色的「已连接 · PhotoCraft AI Bridge（新 API）」。

## 根因（三层，叠加故障）

| # | 位置 | 问题 |
|---|------|------|
| 1 | `ai-agent-server` → LLM 网关 | `.env` 指向 `https://token.sensenova.cn/v1`，模型 `sensenova-6.8-flash-lite` 在该网关 `/v1/models` 里存在但路由不可用：`404 {"error":{"message":"model route not found","code":"5"}}`；换成 `deepseek-v4-flash` / `glm-5.2` / `kimi-k3` 等全部 `429 inference exceeds tpm/rpm limit`，`deepseek-v4.1-flash` 是 `403 not available in current token plan`。即**账号侧没有可用额度**，服务端返回 `500 {"error":"指令解析失败"}`，前端只能落到兜底文案。 |
| 2 | 前端 `ai-widget.js` | 服务端 `/api/parse` 早已改成返回原生命令 `{commands:[{id,params}],explanation}`，而页面上的 widget 仍是旧的 `{key,value}` 形状：既渲染不出 `cmd.value.toFixed(2)`，也不会调 `window.execute_command(cmd.id, …)`。 |
| 3 | wasm 桥 `execute_command()` | 命令入队后既不 `request_repaint()`，其返回的 Promise 也永远不 resolve（`poll_fn` 只返回 `Pending`、没有 waker）。后果：空闲编辑器根本不跑那一帧 → 命令不执行；面板 `await` 卡死在「⚡ 正在应用到编辑器…」，发送按钮永久禁用。 |

## 修复

### 1. 换掉不可用的模型网关（服务器）

```bash
# /opt/ai-agent-server/.env
LLM_API_URL=https://api.siliconflow.cn/v1
LLM_API_KEY=<SiliconFlow key>
LLM_MODEL=deepseek-ai/DeepSeek-V4-Flash
pm2 restart ai-agent-server --update-env
```

旧文件备份在 `/opt/ai-agent-server/.env.bak-20261027-2355`。

### 2. 前端 widget 适配原生命令（仓库 `xiaobubuya/xiaobubuya.github.io`）

`ai-widget.js`（根目录源文件）与 `photocraft/ai-widget.js`（部署副本）**同步修改**：

- 提交 `3ef6906`：`formatCommandsHtml` / `executePhotoCraftCommands` 支持 `{id, params}`，
  保留 `{key, value}` 旧分支；新增 `escapeHtml`。
- 提交 `73b2b16`：新增 `submit()` —— 调 `execute_command` 后**不 await**，并立刻
  `window.request_repaint()`，绕开「promise 不 resolve + 不重绘」双重坑。

> ⚠️ CI（`.github/workflows/build-photocraft-wasm.yml`，每 6 小时）会用**根目录** `ai-widget.js`
> 覆盖 `photocraft/ai-widget.js`。以后只改根目录那份，两处必须一致。

## 验证

| 项 | 结果 |
|---|---|
| 服务器本机 `POST 127.0.0.1:3000/api/parse {"message":"改成黑白的"}` | `200`，返回 `image.adjustments.hueSaturation {"saturation":-100}` + 中文 explanation |
| 公网 `POST https://ai.muyaya.world/api/parse`（`X-API-Key: bubu`） | `200`（cloudflared → 3000 正常） |
| 页面实测（640×480 红底测试文档 → 面板发送「改为黑白的」） | 画布由红变灰；面板出现 `🎯 将图片转为黑白（去色）` + `image.adjustments.hueSaturation {"saturation":-100}`，并显示 `✅ 已应用到编辑器，可撤销` |
| 桥的底层命令（`file.new` / `layer.new.layer` / `edit.fill`） | 均成功作用于画布与图层面板 |

## 数据流（回答「是不是 DSH 返回的 JSON」）

**⚠️ 2026-10-28 已切换**：以下「不是 DeepSeek Harness」为 10-27 当天记录，现已改变。

### 10-27 当天（单次 LLM 解析）

指令解析当时走**单次 LLM**（SiliconFlow /v1/chat/completions），DSH 只用于排障，不参与线上链路：

```
浏览器 ai-widget.js
  → POST https://ai.muyaya.world/api/parse   (X-API-Key, cloudflared 隧道)
  → ai-agent-server :3000 (pm2, /opt/ai-agent-server)
  → SiliconFlow /v1/chat/completions (deepseek-ai/DeepSeek-V4-Flash)
  → {"commands":[{"id","params"}],"explanation","tool"}   ← JSON 由服务端返回
  → widget 渲染命令卡片 + window.execute_command(id, JSON.stringify(params))
  → wasm 引擎命令队列 (WebShell::logic 每帧消费) → 画布更新
```

### 10-28 切换后（harness agent，支持一句话多次修改）

`/api/parse` 优先走 **DeepSeek Harness `dsh headless --json`**，用 SiliconFlow 做底模
（`llm-pi-ai` 注入 OpenAI 兼容路由），一次推理可产出一组命令实现「一句话多次图片修改」；
harness 不可用时仍回退单次 LLM：

```
用户对话 / 图片
  → 浏览器 ai-widget.js（POST /api/parse, 或 ws /api/chat）
  → ai-agent-server :3000 (pm2, /opt/ai-agent-server)
       ↳ 优先 → dsh headless --json（DeepSeek Harness agent, SiliconFlow 底模）+ /api/parse
       ↳ 兜底 → 单次 SiliconFlow /v1/chat/completions
  → {"commands":[{"id","params"},…],"explanation","tool"}   ← 可能多条命令
  → widget 提交命令 + request_repaint()
  → wasm 引擎 / photocraft-cli serve gateway → PhotoCraft 引擎 → 画布更新
```

图片从不上传，云端只处理文字。

## 遗留问题 / 下一步

1. **`ai-widget.js` 有 600 秒强缓存**：已经打开的旧标签页必须等缓存过期或硬刷新（Ctrl+F5）
   才能拿到新版；否则仍会卡在「正在应用」。后续可给 script 标签加 `?v=` 或改 Cache-Control。
2. **根治桥的 Promise**：`apply-bridge.js` 里 `execute_command` 应改成「入队后立即
   `ctx.request_repaint()` 并返回 `"queued"`」（无 waker 的 `poll_fn` 永远不 Ready），
   需重建 wasm（CI 约 30–60 分钟）。现在前端已规避，不阻塞使用。
3. **wasm 体积**：`photocraft-web-*_bg.wasm` 28.6 MB（gzip 12.7 MB），国内首屏全量下载
   需 4–8 分钟；可上 `wasm-opt -Oz`、VPS 镜像或国内 CDN。
4. `docs/AI-BRIDGE.md` 仍是未跟踪文件，需要时再入库。

## 回滚

| 目标 | 操作 |
|---|---|
| 模型配置 | `cp /opt/ai-agent-server/.env.bak-20261027-2355 /opt/ai-agent-server/.env && pm2 restart ai-agent-server --update-env` |
| 前端 widget | `git revert 73b2b16 3ef6906 && git push`（或 `git checkout 7f8095b -- ai-widget.js photocraft/ai-widget.js`）后刷新页面 |

## 顺带改动

- 服务器 `/root/start-dsh-web.sh` 的 `--public-url` 已由 `http://muyaya.world/dsh/` 改回
  `http://120.48.86.101/`（`muyaya.world` 实际指向 GitHub Pages，`/dsh/` 会 404）。
  该改动**下次重启 dsh-web 才生效**，当前进程仍用旧参数。
