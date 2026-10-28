# Proposal: 修正前端 spec 与代码的不一致

## Why

首次梳理时 `photo-browser` / `photo-upload` 两个能力的主要依据是历史 PRD 与文档，
但文档描述的是**计划中的行为**，与当前代码实现有多处不符（例如上传并没有
IndexedDB 断点续传、没有 100MB 上限、HEIC 是报错而不是标记待补；幻灯片是
从新到旧播而不是从早到晚；没有「某天超 100 张折叠」）。文档将长期以 OpenSpec
维护，spec 必须描述**代码真实行为**，否则会误导后续开发。

## What Changes

- 修正 `photo-browser`：网格列数按真实断点（2/3/4/5），去掉未实现的「当天折叠」；
  大图查看按真实手势（左右滑切换、下滑关闭、Esc/方向键；页面 `user-scalable=no`
  因此无双指缩放）；幻灯片按真实方向（从当前张开始按数组顺序循环，数组为拍摄
  时间倒序）并去掉未实现的「弱网跳过」。
- 修正 `photo-upload`：派生图档位与质量按真实值（thumb 400/q0.75、preview
  1600/q0.80）；HEIC 无法解码时如实报错并置为失败可重试，而不是标记待补；
  去重依据「当前时间线已加载的 key 集合」；删除未实现的「IndexedDB 断点续传」
  与「100MB 上限」，并发 3 保留。
- 不改任何代码；只修正 spec 文本与 `AGENTS.md` 中过期的 SW 版本号。

## Capabilities

- **Modified Capabilities**：
  - `photo-browser` — 网格列数、大图手势、幻灯片方向/跳过行为
  - `photo-upload` — 派生质量、HEIC 处理、去重依据、断点续传与大小上限

## Impact

- 修改：`openspec/specs/photo-browser/spec.md`、`openspec/specs/photo-upload/spec.md`、
  根 `AGENTS.md`（`sw.js` 版本号 shell-v66 → shell-v67）。
- 不触碰：任何 `.js` / `.html` / `.css`。
