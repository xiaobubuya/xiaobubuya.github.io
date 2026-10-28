# AGENTS.md — muyaya 前端仓库（muyaya.world）

> 本文档是进入本仓库的唯一入口。**文档真相来源在 `openspec/`**；改行为先看能力 spec。

## 这是什么

两人自用的婚纱照相册的**前端**。**GitHub Pages 纯静态前端**（`muyaya.world`），
**无 Electron 桌面端**。后端分两处：

```
muyaya.world      → GitHub Pages（本仓库 main，push 后 30~60 秒生效）
相册后端           → album-api（Cloudflare Worker + D1 + R2/KV）
ai.muyaya.world   → Cloudflare 命名隧道 → 服务器 120.48.86.101:3000（ai-agent-server）
120.48.86.101     → Debian 10，跑 ai-agent-server(:3000) + muyaya-api(:3001)
```

⚠️ `app.js` 里相册 API 的 `PROD_API` **目前是临时 trycloudflare 隧道地址**
（`main-lawsuit-sewing-pregnancy.trycloudflare.com`），代码内 TODO 是换回正式域名；
不要把文档里「api.muyaya.world」当成已经生效的相册 API 地址。

前端仓库是**公开**仓库。

## 文档怎么进

1. 想改「系统应该做什么」→ 看 `openspec/specs/<capability>/spec.md`，
   有行为变化走 openspec 流程（见下），不要直接改 spec 外的文档双份维护。
2. 能力清单：`openspec list --specs`。
3. 旧大文档（Electron/`studio.html`/Worker 等已过期版本）归档在
   `openspec/changes/archive/legacy-docs/`（含映射表）。

## OpenSpec 流程

任何行为/规范变化都走：

```
openspec new change "<name>"      # 建变更
openspec propose（proposal/specs/design/tasks）
openspec apply                     # 实现（改代码时）
openspec sync / archive            # 同步/归档到主 spec
```

本仓库当前 schema 为 `spec-driven`（proposal → specs → design → tasks）。
spec 只描述**可观察行为**，不写内部类名/库选型/逐步实现。

## 铁律（违反会出事）

1. **前端仓库是公开的。** 密钥、内部地址、个人信息都不能进。
   凭证只存后端环境变量（服务器 `.env` / 后端仓库）。
2. **改 js/css/html 必须升 `sw.js` 的 `SHELL` 版本号**（现在是 `shell-v67`）。
   不升的话 Service Worker 会给老客户端返回缓存版本，症状是「本地好的，线上没反应」。
   改了 `ASSETS` 清单也要升；已删文件必须从清单移除。
3. **`photocraft/` 的 wasm 只能由 `deploy-apps.yml`（job `build-wasm`）从打过 AI Bridge
   补丁的源码构建。** 有指纹锁（`photocraft-build.lock`）+ 校验脚本
   （`scripts/verify-photocraft-build.sh`）兜底。`lightcraft/` 走上游原包。
4. **AI 后端地址只能是 `https://ai.muyaya.world`。** 不要写 trycloudflare 匿名地址，
   它每次重启换域名。这是命名隧道，绕开备案（`api.muyaya.world` 直指百度云 IP 会被 403）。
5. `ai-widget.js` 是 AI 悬浮球本体（全仓库唯一一份），并同步一份进 `photocraft/` 产物。
   映射表必须与后端 `WIDGET_ADJUSTMENTS` 的 key 集合一致、不得静默跳过（该表在 VPS 的
   ai-agent-server 上，本地仓库看不到，48 个 key 是前端这一侧的实测数量）。
6. **Windows 不要用 PowerShell 5.1 拼复杂命令**；写进 `.sh` / `.py` / `.js` 再执行。
7. **`deploy-ai-agent.yml` 不得打包上传 harness。** 服务器 `/opt/ai-agent-server/harness`
   已有 dsh，161MB 包经 scp 到国内服务器会半开挂死（曾跑 4 小时且 tar 损坏）。
   改这个 workflow 后必须确认 `.env` 的 `LLM_API_KEY`/`API_KEY`/`PHOTOCRAFT_SERVE_TOKEN`
   不被置空或覆盖（heredoc 单引号会让 secret 在远程展开为空），
   且 `/usr/local/bin/dsh` 仍指向全局完好版本。详见 `SERVER-OPS-2026-10-28.md`。

## 已知漂移（文档如实记录，尚未修复）

- `sw.js` 的 `ASSETS` 仍列着已删除的 `/studio.html`、`/studio.css`、`/studio.js`，
  同时漏了 `/ai-widget.js`、`/apply-bridge.js`；`test/sw-version.test.mjs` 当前
  **失败**（其中一条断言还在要求「ASSETS 里列了 studio.*」，测试本身也过期了）。
  修的时候要同时改 `sw.js`、`test/sw-version.test.mjs`，并升 `SHELL`。
- `app.js` 的相册 API `PROD_API` 仍是临时 trycloudflare 隧道地址（见上文 ⚠️）。

## 测试

```bash
npm test            # 全跑（含浏览器用例，需要 Chrome）
npm run test:fast   # 跳过浏览器用例
npm run test:browser
```

改了接口先跑 `test/contract.test.mjs`。测试入口 `node test/run-all.mjs`。
`test/` 里 25 个用例文件与页面/脚本一一对应。

## 布局速览（真实文件）

```
页面     index.html  album.html  share.html  ai-agent.html
脚本     album.js  app.js  share.js  upload.js  nav.js  reader.js
         orient.js  autolayout.js  common.js  mask.js  sw.js
AI       ai-widget.js   apply-bridge.js（构建时改上游源码）  ai-bridge.patch
构建产物  photocraft/（自建+AI Bridge）  lightcraft/（上游原包）
工作流    .github/workflows/deploy-apps.yml  protect-photocraft-wasm.yml
```

能力 → 文件映射见 `openspec/specs/` 各 spec。
