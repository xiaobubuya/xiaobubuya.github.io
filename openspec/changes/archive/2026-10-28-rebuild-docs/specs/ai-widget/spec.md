## Purpose

提供嵌入 PhotoCraft / LightCraft 编辑器页面的 AI 悬浮球：用户在悬浮球里输入自然语言指令，后端 LLM 解析成一组修图参数命令，悬浮球在浏览器端映射成真实可执行的 `adjust.*` 命令（通过 AI Bridge），实现与编辑器实时联动。后端不主动出图。

## ADDED Requirements

### Requirement: 悬浮球指令链路
系统 SHALL 提供 `ai-widget.js` 悬浮球（全仓库唯一一份，并同步进 `photocraft/` 构建产物），用户输入自然语言指令后 POST 到固定的后端地址 `https://ai.muyaya.world/api/parse`；后端返回 `{"commands":[{key, value}], "explanation", "tool"}`，悬浮球 SHALL 把其中的键名映射为真实 `adjust.*` 命令，经 `window.execute_command(...)` 交予真实 PhotoCraft 引擎执行，并在界面实时反馈应用结果。后端地址 SHALL 只使用命名隧道 `https://ai.muyaya.world`，绝不用 trycloudflare 匿名地址（每次重启换域名）。

#### Scenario: 自然语言指令被应用
WHEN 用户在悬浮球输入「变成黑白的」并提交
THEN 后端返回命令（如 `key:"saturation", value:-1`），悬浮球映射为 `adjust.saturation` 并执行成功，编辑器图片实时变黑白，界面显示真实成功反馈。

#### Scenario: 应用失败不假报成功
WHEN 命令实际应用失败（或部分命令映射不上）
THEN 悬浮球 SHALL 基于 `executeCommands` 的真实返回值（需 `await`）如实反馈（含哪些命令未应用），SHALL NOT 因漏掉 `await` 而恒显示成功。

### Requirement: 失败可排查
悬浮球 SHALL 在「悬浮球不见了 / 显示已断开 / 说应用了但图片没变」三类故障上便于排查：显示已断开对应 `ai.muyaya.world` 不可达（隧道 down），说应用了但没变要么是命令映射表键名不匹配要么是执行未真实生效。系统 SHALL NOT 静默跳过任何未能映射的命令。

#### Scenario: 后端断开可发现
WHEN 后端隧道不可达
THEN 悬浮球显示「已断开」状态，用户能据此判断是链路问题而非功能问题。

#### Scenario: 无静默跳过
WHEN `mapToPhotoCraftCommand` 对某个后端返回的键名无法命中有效 `adjust.*` 命令
THEN 该命令不得被静默标记为已应用；映射表与后端 `WIDGET_ADJUSTMENTS`（48 个无前缀 key）保持一致，键名完全对得上。
