## MODIFIED Requirements

### Requirement: 悬浮球指令链路
系统 SHALL 提供 `ai-widget.js` 悬浮球（全仓库唯一一份，并同步进 `photocraft/` 构建产物），用户输入自然语言指令后 POST 到固定的后端地址 `https://ai.muyaya.world/api/parse`；后端返回 `{"commands":[...], "explanation", "tool"}`，命令有两种形状：原生命令 `{id, params}` SHALL 直接经 `window.execute_command(id, JSON.stringify(params))` 提交；旧形状 `{key, value}` SHALL 先按映射表转成 `adjust.*` 再提交。AI Bridge 的 promise 不会 settle（无 waker），因此 SHALL NOT `await` 它，而是在提交后调用 `request_repaint()` 强制跑一帧，否则空闲编辑器不会执行该命令。若 AI Bridge 不可用，SHALL 回退到浏览器内 Studio/canvas 指令执行（历史 Plan B，`studio.html` 删除后基本不再走到）。后端地址 SHALL 只使用命名隧道 `https://ai.muyaya.world`，绝不用 trycloudflare 匿名地址（每次重启换域名）。

#### Scenario: 自然语言指令被应用
WHEN 用户在悬浮球输入「变成黑白的」并提交
THEN 后端返回命令（原生 `{id:"adjust.saturation", params:{amount:-1}}` 或旧 `{key:"saturation", value:-1}`），悬浮球提交并触发重绘，编辑器图片实时变黑白。

#### Scenario: 提交与重绘成对出现
WHEN 悬浮球提交一条命令
THEN 必须在同一次调用里请求一帧重绘（`request_repaint`），且 SHALL NOT 等待 bridge promise 完成（它永不完结）。

#### Scenario: 一句话返回多条命令
WHEN 用户在悬浮球输入一句话但包含多次修改（如「改成黑白、再提高对比度」）
THEN 后端 `/api/parse` 通过 harness agent（`dsh headless --json`，SiliconFlow 底模）一次返回 `commands` 数组里的多条原生命令，悬浮球 SHALL 按顺序逐条提交并各自触发重绘，编辑器依次应用全部改动。
