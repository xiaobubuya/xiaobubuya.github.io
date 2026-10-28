# 上下文速查（给下一个 Agent / 未来的自己）

> 2026-10-27 重写。这份是**当前真实状态**的速查，不是教程。
> 动手之前先读这里 + `docs/AI_WIDGET.md`（AI 悬浮球专题）。
> 以前那份讲 Electron / Cloudflare Worker / `studio.js` / `vault-*` 的版本已作废——
> 那些文件在仓库里都不存在了。

---

## 一句话

两人自用的婚纱照相册。**GitHub Pages 前端 + 一台 VPS 上的两个 Node 服务**，
没有任何 Electron 桌面端、没有 Cloudflare Worker 后端。

```
muyaya.world      → GitHub Pages（本仓库 main，push 后 30~60 秒生效）
ai.muyaya.world   → Cloudflare 命名隧道 → 120.48.86.101:3000（AI 后端）
120.48.86.101     → Debian 10，跑 ai-agent-server(:3000) + muyaya-api(:3001)
```

---

## 工作区

```
C:\Users\42410\album_code\
├── frontend-repo\        前端（公开仓库 xiaobubuya/xiaobubuya.github.io）
├── harness-repo\         DeepSeek Harness（含 apps/ai-agent-server 源码、DEPLOY.md）
├── ssh_*.py              用 paramiko 连服务器的脚本（sshpass 不在 PATH）
└── _refs\                参考项目克隆，不属于任何仓库，别提交
```

服务器：`120.48.86.101`，root / 密码在本地脚本里。

---

## 约束（违反会出事）

1. **前端仓库是公开的。** 密钥、内部地址、个人信息都不能进。
2. **改 js/css 必须升 `sw.js` 的 `SHELL` 版本号**（现在是 `shell-v66`）。
   不升的话 Service Worker 会给老客户端返回缓存版本，
   症状是「本地好的，线上没反应」。
3. **`photocraft/` 的 wasm 只能由 `deploy-apps.yml`（含 `build-wasm` job）构建。**
   有指纹锁 + 校验脚本兜底，详见 `docs/AI_WIDGET.md`。
4. **AI 后端地址只能是 `https://ai.muyaya.world`。**
   不要写 trycloudflare 匿名地址，它每次重启换域名。
5. **Windows 上不要用 PowerShell 5.1 拼复杂命令。**
   `curl` 是 `Invoke-WebRequest` 的别名、`-replace` 只吃两个参数、
   中文和 JSON 会被改写。把命令写进 `.sh` / `.py` / `.js` 再执行。

---

## 前端实际文件

```
页面    index.html album.html share.html ai-agent.html
脚本    album.js app.js share.js upload.js nav.js reader.js orient.js
        autolayout.js common.js mask.js sw.js
AI      ai-widget.js（悬浮球本体）  apply-bridge.js（构建时改上游源码）
```

> `batch.html`、`studio.html`、`editor.html`、`nav.html`、`vault-*`、`ai-megvii.js`
> 这些在旧文档里出现过，**现在都不存在**。看到相关描述直接忽略。

### 修图能力从哪来

`photocraft/` 和 `lightcraft/` 是**构建产物目录，在 `.gitignore` 里**，
靠 workflow 从上游项目编译/解包后强制 `git add -f` 提交。
`photocraft/` 是我们打过 AI Bridge 补丁的自建构建（26 MB wasm），
`lightcraft/` 是上游原包。

---

## 测试

入口 `node test/run-all.mjs`：

```bash
npm test            # 全跑（含浏览器用例，需要 Chrome）
npm run test:fast   # 跳过浏览器用例
npm run test:browser
```

`test/` 里 25 个用例文件，和页面/脚本一一对应（`autolayout`、`mask`、
`upload`、`contract`、`crop-geometry`、`sw-version`、`line-endings`、
`shader-guard`、`adjustments`、`curve`、`nav-browser`、`panel-entry`…）。
**改接口先跑 `contract`。**

---

## 部署

| 东西 | 怎么部署 |
|---|---|
| 前端 | push 到 `main`，Pages 自动 redeploy（30~60 秒） |
| PhotoCraft wasm | Actions → `Deploy Apps`（手动点，或 6h 定时） |
| LightCraft | 同上 `Deploy Apps` 工作流（job `deploy-web-apps`），6 小时 cron 跟上游 |
| ai-agent-server | **手工**：服务器 `/opt/ai-agent-server` 不是 git 仓库，靠 `tsc` 构建 + `pm2 restart` |
| muyaya-api | 同上，`/opt/muyaya-api` |
| Harness CLI | `harness-repo` 的 `Deploy Harness CLI` workflow |

服务器部署细节、踩过的坑（Node 24 独立前缀、pm2、nginx 不服务前端等）
记在 `harness-repo/DEPLOY.md`，那边是部署相关的权威文档。

---

## 已知 bug（2026-10-27，未修）

AI 悬浮球在 PhotoCraft 里**显示「已应用到编辑器」但图片不变**。两个原因：

1. `ai-widget.js:540` 漏了 `await`（`executeCommands` 是 async），
   Promise 恒真 → 永远报成功。
2. 服务端返回的键是 `uExposure`/`uSaturation`/`uTemp`/`uHslSat`，
   widget 映射表用的是 `exposure`/`saturation`/`temperature`，命中不了 → 全部静默跳过。

细节和修法在 `docs/AI_WIDGET.md` 第七节。

---

## 文档地图

| 文档 | 状态 |
|---|---|
| `docs/AI_WIDGET.md` | ✅ 权威，AI 悬浮球 + 隧道 + 部署漂移 |
| `docs/CONTEXT.md` | ✅ 本文件，当前状态速查 |
| `docs/HANDOFF.md` | ⚠️ 部分过期（Electron/vault/studio 章节已作废），开头有声明 |
| `docs/PRD.md` | ✅ 相册功能需求（上传/相册）仍有效 |
| `docs/PRD-NAV.md` | ✅ 导航改版，`nav.js` 已在用 |
| `docs/ROADMAP.md` | ⚠️ 混合，完成项与计划项混在一起，以本文档为准 |
| `docs/REFERENCES.md` | ✅ 代码来源声明，长期有效 |
| ~~`docs/BATCH-EDIT-PRD.md`~~ | 🗑 已删：`batch.html` 不存在，功能没有实现 |
| ~~`docs/PRD-UI.md`~~ | 🗑 已删：描述的是已移除的 `studio.html` 修图页 |
| ~~`ALBUM-PLAN.md`~~ | 🗑 已删：Worker + R2 + D1 方案，实际后端改成了 VPS Node |

删除的只是在 git 历史里（`git log --all -- <path>` 能找回），不是真的丢了。
