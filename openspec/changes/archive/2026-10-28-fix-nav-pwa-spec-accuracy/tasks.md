# Tasks

## 1. Spec 修正

- [ ] 1.1 按 `nav.js` 现状改写 `app-nav`（5 个入口与 href、mode 三态、登录层隐藏），验证 `openspec validate` 通过
- [ ] 1.2 按 `sw.js` 现状改写 `pwa-shell` 的 ASSETS 规则，验证校验通过
- [ ] 1.3 归档合入主 spec，验证 `openspec show app-nav --type spec` 与 `openspec show pwa-shell --type spec`

## 2. 已知漂移记录

- [ ] 2.1 在 `AGENTS.md` 增加「已知漂移」小节，如实记录：`sw.js` ASSETS 仍含已删 studio.*、缺 ai-widget.js/apply-bridge.js，`test/sw-version.test.mjs` 当前失败（未修）
- [ ] 2.2 运行 `node test/sw-version.test.mjs` 复核失败项与记录一致，验证文档描述的是真实状态
