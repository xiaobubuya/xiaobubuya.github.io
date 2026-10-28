## Purpose

定义 PhotoCraft 与 LightCraft 两个 WebAssembly 应用产物在前端仓库中的构建、注入与校验约束：`photocraft/` 只由 `deploy-apps.yml` 的 `build-wasm` job 从打过 AI Bridge 补丁的源码构建并注入悬浮球，`lightcraft/` 走上游原包；两者由指纹锁与独立绊线守护，防止被上游 release 覆盖成没有 AI 能力的死按钮。

## ADDED Requirements

### Requirement: 构建产物所有权唯一
`photocraft/` 目录 SHALL 只由 `deploy-apps.yml`（job `build-wasm`）从打过 AI Bridge patch 的源码构建后写入；`lightcraft/` 由 `deploy-apps.yml`（job `deploy-web-apps`）从上游原包写入。任何手动 git add 或其它 workflow 覆盖这两个目录 SHALL 被视为错误。`ai-widget.js`（根）只由人工提交，并同步一份进 `photocraft/` 产物。构建后通过注入 `<script src=\"ai-widget.js\">` 使悬浮球进入产物。

#### Scenario: 上游发布不覆盖 AI 能力
WHEN 上游 PhotoCraft 发新版并检出
THEN 构建流程经由 `apply-bridge.js` 打补丁 → 编译 → 注入悬浮球，产物仍是自建带 AI Bridge 的构建，而不是没有悬浮球的上游原包。

#### Scenario: 违反所有权被绊线拦截
WHEN 有 push 触及 `photocraft/` / `lightcraft/` / 相关构建文件
THEN `protect-photocraft-wasm.yml` 独立绊线触发 `verify-photocraft-build.sh` 七项校验，任一不符即 `exit 1`。

### Requirement: 指纹锁与七项校验
`photocraft-build.lock` 是唯一真相来源，记录 wasm/js 文件名与 sha256、`ai-widget.js` sha256、必须存在的 bridge 符号、wasm 体积下限；`scripts/verify-photocraft-build.sh` 做七项校验，任一不符 `exit 1`。`--update` 写锁前必须确认产物里有 `bridge_symbols`，没有就拒绝写锁。校验项：产物文件名 → 校验和 → 体积下限 → bridge 符号 → shim+注入标签 → 两份 `ai-widget.js` 一致 → 不得出现上游 `photocraft-web-boot-*` 符号。

#### Scenario: 产物被换成上游包被拦截
WHEN 有人把上游 release 产物整体覆盖进 `photocraft/`
THEN 校验在 bridge 符号、注入标签、文件校验和等项上失败并以非零退出，拒绝合并。

### Requirement: AI Bridge 进入 wasm 的方式
`apply-bridge.js` 以锚点式方式改动上游源码三处：`apps/photocraft-web/Cargo.toml`（加 serde_json + futures-util）、`apps/photocraft-web/src/web.rs`（加全局 `COMMAND_QUEUE` / `REPAINT` / `SESSION_READY` 与导出的 `execute_command` / `has_session` / `request_repaint`）、`apps/photocraft-web/index.html`（注入 shim，把 wasm-bindgen 导出挂到 `window`）。`shim` 随 Trunk 模板烤进构建产物（非 sed 注入）；`ai-widget.js` 的 script 标签由 sed 注入。锚点缺失时 `apply-bridge.js` SHALL 报 `Anchor not found` 并失败，不得静默继续。

#### Scenario: 上游改动锚点导致失败
WHEN 上游改了 `web.rs` 的锚点行
THEN `apply-bridge.js` 报 `Anchor not found` 并终止构建，提示按新代码更新锚点后重跑，而不是产出一个没有 bridge 能力的包。

### Requirement: 版本记录准确性
`.web-versions.json` SHALL 记录 `photocraft=<自建构建版本>`（不写成上游 tag，避免谎报版本）与 `lightcraft=<上游 tag>`。构建流程 SHALL 同步更新该文件。

#### Scenario: 版本记录可溯源
WHEN 查看 `.web-versions.json`
THEN `photocraft` 字段是自建构建的版本号而非上游 tag，`lightcraft` 字段是上游 tag，二者可与产物做核对。

