# Proposal: 用 OpenSpec 重构文档

## Why

muyaya.world（`xiaobubuya.github.io` 前端仓库）现有 `docs/` 下有
`CONTEXT.md` / `PRD.md` / `PRD-NAV.md` / `HANDOFF.md` / `AI_WIDGET.md` /
`ROADMAP.md` / `REFERENCES.md` / `AI_WIDGET-FIX-RECORD.md` 共八份大文档，
其中多数已过期：`PRD.md`、`HANDOFF.md` 描述的是已删除的 Electron 桌面端、
`studio.html`、Cloudflare Worker（`/api/img/:size/:key`）等，而当前真实形态
是 **GitHub Pages 纯静态前端 + VPS 上的两个 Node 服务**。文档与实际代码
严重漂移，新接手者（或新 Agent）无法靠它们准确理解系统。我们改用
OpenSpec 的 spec-driven 结构，把「系统应该做什么」固化成可验证的能力规格，
把已过期的历史文档归档，让 `AGENTS.md` 作为进入系统的唯一入口。

## What Changes

- 在本仓库根建立 `openspec/`（已初始化），以 `AGENTS.md` + `openspec/specs/`
  作为文档真相来源。
- 把「前端系统能力」拆分为若干 capability spec，每个能力一份 `spec.md`，
  描述**可观察的外部行为**（鉴权、时间线浏览、上传、相册、导航、PWA、
  分享页、AI 悬浮球、PhotoCraft/LightCraft 构建产物部署与指纹锁等）。
- 更新/新建根 `AGENTS.md`，作为 AI 的唯一入口，指向 `openspec/`。
- 将 `docs/` 下已过期的原文归档进 `openspec/changes/archive/`
  （git 历史仍可找回，不丢失），其仍有效的事实提炼进对应 spec。
- 保留 `docs/` 中**仍唯一权威**的部分（如 `AI_WIDGET.md` 作为 AI 悬浮球
  专题事实来源）——确认为仍在用的内容先并入 spec 再决定是否归档。
- 不改动任何运行时代码；本 change 只重写文档与流程，因此主行为无变。

## Capabilities

以下是本仓库「前端系统能力」的划分（均为**新建**主 spec，反映当前真实
代码形态）：

- `auth-session` — 口令登录与会话 Cookie，前端不存密钥
- `photo-browser` — 时间线网格 / 大图查看 / 幻灯片（`app.js`, `index.html`）
- `photo-upload` — 浏览器端派生缩略图 + 直传后端 + 去重与续传（`upload.js`）
- `album` — 相册管理 + 自由排版编辑器 + 翻页阅读（`album.js`, `reader.js`,
  `autolayout.js`）
- `app-nav` — 全局导航壳（`nav.js` / `nav.css`，桌面顶栏 + 手机底部 tab）
- `pwa-shell` — Service Worker 只缓存静态外壳，绝不缓存 API 与照片（`sw.js`）
- `share-page` — 只读分享页（`share.html`, `share.js`，复用阅读器）
- `ai-widget` — AI 悬浮球，连后端 `ai.muyaya.world`（`ai-widget.js`）
- `wasm-apps` — PhotoCraft/LightCraft 构建产物部署与指纹锁（`photocraft/`,
  `lightcraft/`, `deploy-apps.yml`, `verify-photocraft-build.sh`）

后端（`album-api` 仓库、VPS 上的 `ai-agent-server` / `muyaya-api`）作为
本仓库的**外部边界**出现在相关 spec 的约束里，但不在本 change 重写。

## Impact

- 修改：根 `AGENTS.md`（新建）、`docs/`（归档与提炼）。
- 新增：`openspec/specs/<capability>/spec.md` 若干。
- 不触碰：所有 `.html` / `.js` / `.css` / `.yml` / `test/`。
- 后续任何能力的行为变化，一律走 `openspec new change` → sync → archive。
