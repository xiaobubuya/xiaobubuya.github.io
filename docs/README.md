# docs/ 说明

> 文档真相来源已迁到根 `AGENTS.md` 与 `openspec/specs/`。

本仓库提供 muyaya.world 站点里那几个静态应用（PhotoCraft / LightCraft）的源码与
构建产物。**站点已不再使用 GitHub Pages**（2026-11-13 起由本机 nginx 直接托管，
DNS 在阿里云，证书 Let's Encrypt）。部署方式见根 `AGENTS.md` 的「怎么部署到服务器」。

- **入口**：读根 `AGENTS.md`，它指向 `openspec/` 全部能力规范。
- **能力规范**：`openspec/specs/<capability>/spec.md`（鉴权 / 时间线浏览 / 上传 /
  相册 / 导航 / PWA / 分享页 / AI 悬浮球 / PhotoCraft·LightCraft 构建产物）。
- **旧文档**（Electron / `studio.html` / Cloudflare Worker / GitHub Pages 时代）
  归档在 `openspec/changes/archive/legacy-docs/`。**归档只作历史记录，不要据它判断现状。**
- **变更流程**：任何行为变化走 `openspec new change` → propose → specs →
  apply → sync → archive，不允许直接改 `openspec/specs/` 之外的文档双份维护。
