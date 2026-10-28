# Tasks

## 1. Spec 修正

- [ ] 1.1 把 `photo-browser` 的 3 条 requirement 按代码现状改写（网格断点 2/3/4/5、大图手势、幻灯片方向），验证 `openspec validate` 通过
- [ ] 1.2 把 `photo-upload` 的 4 条 requirement 按代码现状改写并移除未实现的「断点续传」，验证 `openspec validate` 通过且 REMOVED 段含 Reason/Migration
- [ ] 1.3 合并进主 spec（sync/archive），验证 `openspec show photo-browser --type spec` 与 `photo-upload` 反映新文本

## 2. 入口文档修正

- [ ] 2.1 把根 `AGENTS.md` 里的 SW 版本号改为当前真实值 `shell-v67`，验证与 `sw.js` 的 `SHELL` 常量一致
- [ ] 2.2 在 `AGENTS.md` 注明 `app.js` 的 `PROD_API` 目前是临时 trycloudflare 隧道（TODO 换回正式域名），避免误以为已是 `api.muyaya.world`

## 3. 一致性校验

- [ ] 3.1 逐条对照 `app.js`/`upload.js` 复核 spec 中的数值（400/1600/0.75/0.80、CONCURRENCY=3、SLIDE_MS=4000、断点列数、手势阈值），验证每条都能在代码里找到依据
