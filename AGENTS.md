# AGENTS.md — muyaya 前端/静态应用仓库

> 本文档是进入本仓库的唯一入口。**文档真相来源在 `openspec/`**；改行为先看能力 spec。

## 这是什么

两人自用的婚纱照相册站点所依赖的**静态应用源码与构建产物**。仓库名还叫
`xiaobubuya.github.io`，但**已经不用 GitHub Pages 了**（2026-11-13 起）。

线上由一个 nginx 直接托管（百度云北京 `120.48.86.101`，Let's Encrypt 证书，
DNS 在阿里云云解析 `dns1/dns2.hichina.com`）：

```
muyaya.world            → nginx :443（80 只做 ACME + 301）
  /                       muyaya-web 仓库 rsync 到 /var/www/muyaya（相册前端主站）
  /photocraft/            /var/www/photocraft   ← 本仓库 photocraft/
  /lightcraft/            /var/www/lightcraft   ← 本仓库 lightcraft/ + ai-widget.js
  /pose/                  /var/www/pose（独立构建的姿势图库）
  /ai/                    → 127.0.0.1:3000  ai-agent-server（同源反代，无隧道）
  /api/                   → 127.0.0.1:8082  album-api（Java）
  /auth/ /oauth2/ /login/ → 127.0.0.1:8081  account-api（Java）
  /tv                     → 127.0.0.1:8080  LibreTV，白名单，仅站长本人
tv.muyaya.world         → 只有证书 + 301 到 muyaya.world/tv（不承载内容）
```

⚠️ 本仓库的旧 GitHub Pages 前端（`index.html` / `album.html` / `app.js` / `sw.js` /
`share.html` / 测试等）已于 2026-11-13 **删除**，线上由 `muyaya-web` 仓库取代
（那边用相对路径 `/api`，不写死任何后端域名）。本仓库现在只剩静态应用相关的东西。

前端仓库是**公开**仓库。

## 怎么部署到服务器

本仓库**没有**自动部署链路。改完要手动同步：

```bash
bash scripts/deploy-static-apps.sh          # rsync photocraft/ lightcraft/ ai-widget.js → /var/www
```

改 `ai-widget.js` 时注意服务端有三份副本（`/var/www/photocraft/`、`/var/www/lightcraft/`，
加上本仓库根目录那份），漏一份就是「改了但某个工具还是旧行为」。脚本处理前两份。

## 文档怎么进

1. 想改「系统应该做什么」→ 看 `openspec/specs/<capability>/spec.md`，
   有行为变化走 openspec 流程（见下），不要直接改 spec 外的文档双份维护。
2. 能力清单：`openspec list --specs`。
3. 旧大文档（Electron / `studio.html` / Cloudflare Worker / GitHub Pages 时代）归档在
   `openspec/changes/archive/legacy-docs/`，含映射表，**归档只作历史记录，不要据它判断现状**。

## OpenSpec 流程

任何行为/规范变化都走：

```
openspec new change "<name>"      # 建变更
openspec propose（proposal/specs/design/tasks）
openspec apply                     # 实现（改代码时）
openspec sync / archive            # 同步/归档到主 spec
```

本仓库当前 schema 为 `spec-driven`（proposal → specs → design → tasks）。
spec 只描述**可观察行为**，不写内部类名/库选型/逐步实现。

## 铁律（违反会出事）

1. **仓库是公开的。** 密钥、内部地址、个人信息都不能进。
   凭证只存服务器 `.env`（`/opt/muyaya-account/.env` 等）。
2. **静态资源换版要确认缓存头。** 本仓库已没有 Service Worker（`sw.js` 随旧前端删除，
   PWA 外壳现在归 `muyaya-web` 仓库管）。这里只要保证 nginx 对 `ai-widget.js` 发了
   `Cache-Control: no-cache`（`/etc/nginx/snippets/muyaya-station.conf` 有专门 location），
   否则浏览器按启发式缓存好几天，改了 widget 也「线上没反应」。
3. **`photocraft/` 的 wasm 只能由打过 AI Bridge 补丁的源码构建**（`apply-bridge.js`）。
   有指纹锁（`photocraft-build.lock`）+ 校验脚本（`scripts/verify-photocraft-build.sh`）兜底，
   改完 `ai-widget.js` 要同步 `widget_sha256`。`lightcraft/` 走上游原包。
4. **AI 后端走同源 `/ai`，不要写死任何域名。** 曾经的 `https://ai.muyaya.world`
   Cloudflare 隧道已于 2026-11-13 删除；trycloudflare 匿名地址更不能用（每次重启换域名）。
5. `ai-widget.js` 是 AI 悬浮球本体（全仓库唯一一份），并同步一份进 `photocraft/` 产物。
   映射表必须与后端 `WIDGET_ADJUSTMENTS` 的 key 集合一致、不得静默跳过（该表在服务器
   的 ai-agent-server 上，本地仓库看不到，48 个 key 是前端这一侧的实测数量）。
   画布送后端前会压成 JPEG（长边 ≤1024、base64 预算 700KB，超了自动降档），
   别改回 PNG——那会让每次解析多传好几 MB。
6. **Windows 不要用 PowerShell 5.1 拼复杂命令**；写进 `.sh` / `.py` / `.js` 再执行。
7. **部署 AI agent 服务时不得打包上传 harness。** 服务器 `/opt/ai-agent-server/harness`
   已有 dsh，161MB 包经 scp 到国内服务器会半开挂死（曾跑 4 小时且 tar 损坏）。
   （`deploy-ai-agent.yml` 这个 workflow 现在不在本仓库，规则仍适用于服务器侧。）

## 已知限制

- 本仓库没有自动化测试了（`test/` 随旧前端一起删除）。能机器校验的只有
  `scripts/verify-photocraft-build.sh`（wasm + widget 指纹锁），部署脚本会先跑它。
- GitHub 侧的 Pages 站点还挂着（`<user>.github.io` 这种仓库的 Pages 不能用 API 关闭），
  但 `muyaya.world` 已经指向本机 nginx，访问 `https://xiaobubuya.github.io/` 拿到的是
  旧快照。去仓库 Settings → Pages 把 Source 设为 None 才会彻底下线。

## 布局速览（真实文件）

```
AI 悬浮球   ai-widget.js（唯一源）  apply-bridge.js  ai-bridge.patch  patches/
构建产物    photocraft/（自建 + AI Bridge）  lightcraft/（上游原包）
构建/部署   scripts/verify-photocraft-build.sh  scripts/deploy-static-apps.sh
            scripts/deploy-pose-gallery.sh  photocraft-build.lock  .web-versions.json
工具        widget-layout.html  widget-mock.html（本地调布局的草稿，不入库）
工作流      .github/workflows/deploy-apps.yml（构建+提交产物）
            .github/workflows/protect-photocraft-wasm.yml（指纹校验绊线）
文档        docs/README.md  docs/photocraft-i18n.md  docs/ai-pose-gallery-deploy.md
```

能力 → 文件映射见 `openspec/specs/` 各 spec。
