# ai-widget Specification

## Purpose
提供嵌入 PhotoCraft / LightCraft 编辑器页面的 AI 悬浮球：用户在悬浮球里输入自然语言指令，后端 LLM 解析成一组修图参数命令，悬浮球在浏览器端把命令（原生命令 `{id,params}` 或旧 `{key,value}` 经映射表转成 `adjust.*`）经 AI Bridge 提交给真实引擎，实现与编辑器实时联动。后端不主动出图。

## Requirements

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

### Requirement: 失败可排查
悬浮球 SHALL 在「悬浮球不见了 / 显示已断开 / 说应用了但图片没变」三类故障上便于排查：显示已断开对应 `ai.muyaya.world` 不可达（隧道 down），说应用了但没变要么是命令映射表键名不匹配要么是执行未真实生效。系统 SHALL NOT 静默跳过任何未能映射的命令。

#### Scenario: 后端断开可发现
WHEN 后端隧道不可达
THEN 悬浮球显示「已断开」状态，用户能据此判断是链路问题而非功能问题。

#### Scenario: 无静默跳过
WHEN `mapToPhotoCraftCommand` 对某个后端返回的键名无法命中有效 `adjust.*` 命令
THEN 该命令不得被静默标记为已应用；前端映射表（实测 48 个无前缀 key）须与后端 `WIDGET_ADJUSTMENTS` 的 key 集合一致，键名完全对得上；该表在 VPS 后端，本地不可见。
