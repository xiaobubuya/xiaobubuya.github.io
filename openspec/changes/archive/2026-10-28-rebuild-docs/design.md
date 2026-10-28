# Design: 前端仓库文档重构

## Context

仓库是无构建链路的纯静态 GitHub Pages 站点（`muyaya.world`），所有页面直接引
`nav.js` / `app.js` / `upload.js` 等根级静态脚本。现有文档集中在 `docs/`，其中
多数描述的是已删除的架构（Electron 桌面端 `album-studio`、`studio.html`、
Cloudflare Worker 后端 `/api/img/:size/:key`、密钥保险箱等），当前真实后端是
VPS 上的两个 Node 服务。文档必须反映真实形态，这要求能力划分为「前端可观察
行为」，把后端当作外部边界。

## Goals / Non-Goals

**Goals**：
- 用 `openspec/specs/<capability>/spec.md` 固化前端系统的可验证行为。
- 根 `AGENTS.md` 作为唯一 AI 入口，指向 `openspec/`。
- 已过期文档归档进 `openspec/changes/archive/`，历史信息用 git 仍可找回。

**Non-Goals**：
- 不改任何运行时代码（`*.html` / `*.js` / `*.css` / `*.yml` / `test/`）。
- 不重构后端文档（`album-api`、VPS 服务各自另立仓库/目标，不在本 change）。
- 不新增 CI 工作流。

## Decisions

- **能力粒度按前端可观察行为切分**（9 个 capability），而非按文件切分：
  `auth-session`、`photo-browser`、`photo-upload`、`album`、`app-nav`、
  `pwa-shell`、`share-page`、`ai-widget`、`wasm-apps`。理由：OpenSpec 的 spec
  描述「系统应该做什么」，按文件切开会退化成代码目录说明；按行为切分，后续
  行为变化能精确落到某个 capability 的 delta。
  备选（已否决）：按页面文件切分（`index` / `album` / `share` / `ai-agent`），
  会与能力语义重叠、且无法表达跨页面的导航层与 PWA。
- **后端作为外部边界**：把 `ai.muyaya.world` 等后端地址写进 spec 的约束
  （固定不变的事实），但后端内部实现不展开。
- **归档而非删除旧文档**：`docs/` 原文移入 `openspec/changes/archive/`，
  不直接删文件，保证历史可查（git 也能找回）。
- **AGENTS.md 为入口、不复制内容**：AGENTS.md 只指路（怎么进系统、怎么用
  openspec 流程、关键铁律），详细行为在对应 spec，避免双份维护。

## Risks / Trade-offs

- [旧文档里仍有有效事实（如坐标朝向、CDP 测试 harness、服务端渲染 og 标签
  的原因）] → 归档时保留原文；若某条已提炼进 spec，在归档文件名或摘要里标注
  对应能力，避免二度丢失。
- [`docs/AI_WIDGET.md` 仍是 AI 悬浮球的唯一权威事实来源，含大量部署细节] →
  本 change 的 `ai-widget` spec 只提炼「可验证行为」；部署细节、服务器路径、
  事故记录继续留在归档自带的原文里可查，不强行塞进 spec（spec 不描述内部实现）。
- [一次性归档八份文档改动面大] → 归档只是移动文件 + 提炼，不触碰代码；
  validate 会守住 spec 结构合法性。

## Open Questions

- `docs/` 是否在归档后保留一个 `README.md` 索引（指向 `openspec/` 与归档点）？
  可安全延后；本 change 先以根 `AGENTS.md` 和 `openspec/` 为准，`docs/` 若保留
  只留一份简短说明。
