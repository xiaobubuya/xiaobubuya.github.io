# 归档：原 `docs/` 旧文档

> 2026-10-28 归档。这些是历史上写在前端仓库 `docs/` 下的大文档，多数描述的是
> **已删除的架构**（Electron 桌面端 `album-studio`、`studio.html`、Cloudflare
> Worker 后端 `/api/img/:size/:key`、密钥保险箱等）。当前真实形态以
> 根 `AGENTS.md` 与 `openspec/specs/` 为准。
>
> 归档不删除：git 历史仍可找回（`git log --all -- <path>`），本目录也保留原文。

## 映射表：旧文档 → 现在由哪个 spec / 哪里覆盖

| 旧文档 | 仍有效的事实提炼到 | 说明 |
|---|---|---|
| `CONTEXT.md` | 根 `AGENTS.md`（铁律） + `openspec/config.yaml`（context） | 当前状态速查，已并入入口文档 |
| `PRD.md` | `photo-browser` / `photo-upload` / `album` / `auth-session` | 相册功能需求仍有效；方案层已过期（Worker→VPS Node） |
| `PRD-NAV.md` | `app-nav` | 导航与布局改版，`nav.js` 已在用 |
| `HANDOFF.md` | 各能力 spec 的约束 + `tests` 说明 | 描述 Electron/vault/studio 的章节已作废；「踩过的坑」仍有效 |
| `AI_WIDGET.md` | `ai-widget` / `wasm-apps` | AI 悬浮球 + 隧道 + 部署漂移的唯一权威事实来源 |
| `AI_WIDGET-FIX-RECORD.md` | `ai-widget` | Bug 修复记录，仍有效 |
| `AI-BRIDGE-FIX-2026-10-27.md` | `ai-widget` | 2026-10-27 解析失败三层根因与修复；命令形状与 repaint 行为已并入 `ai-widget` spec |
| `SERVER-OPS-2026-10-28.md` | （运维，不入 spec） | 部署链路四个缺陷（161MB harness 包 / heredoc 变量 / dsh 指向 / API_KEY 覆盖）与 fail2ban 上线 |
| `ROADMAP.md` | 各能力 spec | 完成项与计划项混杂；以本文档为准 |
| `REFERENCES.md` | （长期有效） | 三个外部仓库评估 + 哪些代码独立写的，未并入 spec，保留原文 |

## 仍值得读的「经验」内容

- `HANDOFF.md` 第七节：坐标朝向、`UNPACK_FLIP_Y_WEBGL`、坑等经验。
- `AI_WIDGET.md`：AI 悬浮球唯一的权威事实来源（含服务器路径、事故记录）。
- `PRD.md` §6/§7/§8：相册数据模型与 API 的原始设计（虽后端已改 VPS Node，
  但 `F8.2` 归一化排版坐标、并发乐观锁思路仍生效）。
