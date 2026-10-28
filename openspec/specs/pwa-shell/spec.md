# pwa-shell Specification

## Purpose
提供 PWA 基础能力：可添加到主屏幕、离线可用。核心约束是 Service Worker 只缓存「静态外壳」（HTML/CSS/JS/图标），绝不缓存照片与 API 响应，以避免鉴权串号或显示过期内容。

## Requirements

### Requirement: 只缓存静态外壳
Service Worker SHALL 只缓存静态外壳资源，SHALL NOT 缓存任何照片字节与 API 响应；改动了外壳里的任一文件（HTML/CSS/JS/图标）时，SHALL 升 `sw.js` 的 `SHELL` 版本号，否则老客户端会一直拿到旧缓存版本（`test/sw-version.test.mjs` 会检查「外壳文件改动必须同时升 SHELL」）。

#### Scenario: 改壳后升版本
WHEN 改动某个静态外壳文件（如 `nav.css`）并同步升高 `sw.js` 的 `SHELL` 版本
THEN 新客户端拿到新外壳；而若未升版本，则老客户端（已缓存）继续使用旧外壳。

#### Scenario: 离线打开显示离线兜底
WHEN 断网且已有缓存外壳
THEN 站点能打开缓存的静态外壳；未缓存到的资源（照片/API）由 `offlinePage()` 兜底，不抛未捕获错误。

### Requirement: 版本升级一致性
`ASSETS` 缓存清单 SHALL 与仓库实际文件一致：SHALL 只列实际存在的文件，且 SHALL 覆盖页面引用的全部 js/css（含 `nav.js`、`nav.css`、`upload.js`、`ai-widget.js` 等），否则离线会缺失资源或请求必然 404 的文件。`test/sw-version.test.mjs` SHALL 检查这两点（清单不含已删文件、覆盖全部被引用 js/css）。

#### Scenario: 已删文件不入清单
WHEN 审计 `sw.js` 的 `ASSETS` 清单
THEN 清单中不包含任何已从仓库删除的文件，且覆盖页面引用的全部 js/css；相关测试通过。
