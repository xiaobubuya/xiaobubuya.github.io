# docs/ 说明

> 文档真相来源已迁到根 `AGENTS.md` 与 `openspec/specs/`。

本仓库是 muyaya.world（GitHub Pages 静态前端）的代码与构建产物。

- **入口**：读根 `AGENTS.md`，它指向 `openspec/` 全部能力规范。
- **能力规范**：`openspec/specs/<capability>/spec.md`（鉴权 / 时间线浏览 / 上传 /
  相册 / 导航 / PWA / 分享页 / AI 悬浮球 / PhotoCraft·LightCraft 构建产物）。
- **旧大文档**（Electron / `studio.html` / Cloudflare Worker 等已过期版本）归档在
  `openspec/changes/archive/legacy-docs/`，含映射表，git 历史仍可找回。
- **变更流程**：任何行为变化走 `openspec new change` → propose → specs →
  apply → sync → archive，不允许直接改 `openspec/specs/` 之外的文档双份维护。
