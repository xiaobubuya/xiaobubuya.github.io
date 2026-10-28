# Proposal: 修正导航与 PWA spec 与代码的不一致

## Why

`app-nav` 与 `pwa-shell` 首次依据 PRD 与文档编写：PRD 说「三个 tab（照片/相册/修图）」，
但 `nav.js` 实际渲染 **5 个**入口（照片、相册、调色→`/photocraft/`、修图→`/lightcraft/`、
AI 修图→`/ai-agent.html`）；`studio.html` 已删除，导航里没有独立的 studio 页。
`pwa-shell` 声称 `ASSETS` 只含实时存在的文件且测试守住，但实际 `sw.js` 的 `ASSETS`
仍列着已删除的 `/studio.html`、`/studio.css`、`/studio.js`，同时漏了
`/ai-widget.js`、`/apply-bridge.js`，导致 `test/sw-version.test.mjs` 当前**失败**。

## What Changes

- `app-nav`：把「三个核心功能」改为真实的 5 个入口与 href；补充 `mode` 三态
  （`full` / `brand` / `none`）与「登录层可见时隐藏导航」；保留动作下沉与沉浸态规则。
- `pwa-shell`：`ASSETS` 规则修正为「清单须与仓库实际文件一致、且覆盖页面引用的
  js/css」；当前漂移与失败测试记入 `AGENTS.md` 的「已知漂移」，不在 spec 里写死缺陷。
- 不改代码。

## Capabilities

- **Modified Capabilities**：
  - `app-nav` — 入口数量与 href、导航模式
  - `pwa-shell` — ASSETS 一致性与覆盖范围

## Impact

- 修改：`openspec/specs/app-nav/spec.md`、`openspec/specs/pwa-shell/spec.md`、
  根 `AGENTS.md`（新增「已知漂移」）
- 不触碰：`nav.js`、`sw.js`、`test/`
