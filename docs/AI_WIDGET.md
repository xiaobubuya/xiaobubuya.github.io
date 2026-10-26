# AI 悬浮球 / PhotoCraft AI Bridge / 后端连线

> 2026-10-27 重写。这份文档是 AI 悬浮球相关事实的唯一权威来源。
> 读完应该能独立排查「悬浮球不见了」「显示已断开」「说应用了但没变」这三类问题。

---

## 一、三条铁律

1. **`photocraft/` 的 wasm 只能由 `build-photocraft-wasm.yml` 从打过 patch 的源码构建。**
   上游 release 包没有 AI Bridge，覆盖过去悬浮球就是死按钮。
2. **后端地址只能是 `https://ai.muyaya.world`。**
   不要用 trycloudflare 匿名地址——它每次重启就换域名。
3. **服务器 `/opt/ai-agent-server` 不是 git 仓库。**
   它靠文件同步 + `tsc` 构建，所以仓库和线上可能漂移。改动必须双向记录。

---

## 二、所有权：谁写哪个目录

| 路径 | 唯一写入者 | 含 AI Bridge |
|---|---|---|
| `photocraft/` | `build-photocraft-wasm.yml` | ✅ 是 |
| `lightcraft/` | `auto-deploy-web.yml` | ❌ 从来没有 |
| `ai-widget.js`（根） | 手工提交 | —— 悬浮球本体 |
| `photocraft-build.lock` | `verify-photocraft-build.sh --update` | —— 指纹锁 |

`auto-deploy-web.yml` 曾经也写 `photocraft/`，这是 2026-10-25 事故的根因。
现在它硬编码 `UPDATE_PC=false`，只负责 LightCraft。

---

## 三、AI Bridge 是怎么进 wasm 的

```
clone 上游 storytold/photocraft
  → node deploy-repo/apply-bridge.js      # 锚点式改源码，锚点缺失就 fatal
  → trunk build --release                 # 编译
  → 注入 <script src="ai-widget.js">
  → 更新 photocraft-build.lock
```

`apply-bridge.js` 改三处：

| 文件 | 改动 |
|---|---|
| `apps/photocraft-web/Cargo.toml` | 加 `serde_json` + `futures-util` |
| `apps/photocraft-web/src/web.rs` | 全局 `COMMAND_QUEUE`/`REPAINT`/`SESSION_READY`，导出 `execute_command`/`has_session`/`request_repaint` |
| `apps/photocraft-web/index.html` | 注入 shim，把 wasm-bindgen 导出挂到 `window` |

**shim 是烤进 Trunk 模板随构建进产物的，不是 sed 注的。** sed 只负责 `ai-widget.js`
那个 script 标签。

为什么用命令队列：`Session` 是 `!Send`、`Rc<RefCell<Session>>` 是 `!Sync`，
都不能进 `static`。队列里是 `(String, Value, Arc<AtomicBool>, Arc<Mutex<Option<Result>>>)`，
全部 `Send + Sync`，在 wasm32 上合法。

体积对照：上游 v0.16.0 wasm **98,880 字节**，自建构建 **26,445,909 字节**。

---

## 四、保证机制（指纹锁 + 绊线）

| 文件 | 作用 |
|---|---|
| `photocraft-build.lock` | 唯一真相来源：wasm/js 文件名 + sha256、`ai-widget.js` sha256、必须存在的 bridge 符号、wasm 体积下限 |
| `scripts/verify-photocraft-build.sh` | 七项校验，任一不符 `exit 1` |
| `.github/workflows/protect-photocraft-wasm.yml` | 独立绊线：任何 push 触及这些文件就校验 |

七项校验：产物文件名 → 校验和 → 体积下限 → bridge 符号 → shim + 标签 →
两份 `ai-widget.js` 一致 → 不得出现上游 `photocraft-web-boot-*`。

`--update` 写锁前先确认产物里有 `bridge_symbols`，没有就拒绝写并 `exit 1`。

**负面测试结果**（7 种破坏方式全部拦住）：上游包整体覆盖、wasm 内容被换、
去掉 shim、去掉标签、bridge 符号被抹、lightcraft 标签被删、混入上游产物。

⚠️ 绊线红了只是红，不会阻止合并。要真阻止需把 `Protect PhotoCraft Build`
设成 main 的 required status check —— **注意这也会挡掉 bot 自己的推送**
（`auto-deploy-web.yml` 和 `build-photocraft-wasm.yml` 都直接 push 到 main），
必须先配 bypass 名单。

---

## 五、后端连线（已改成命名隧道）

### 5.1 现状

```
ai.muyaya.world  →  Cloudflare 边缘  →  cloudflared 隧道  →  localhost:3000
wss://ai.muyaya.world/ws?key=bubu   →  同样走这条路（WebSocket 可用）
```

| 项 | 值 |
|---|---|
| 隧道名 / id | `muyaya-ai` / `89c07fac-0db4-463e-8e01-dddee0f2cc94` |
| 配置 | `/etc/cloudflared/config.yml` |
| 凭据 | `/root/.cloudflared/cert.pem`、`/root/.cloudflared/89c07fac-....json` |
| 服务 | `cloudflared.service`（systemd，`enabled`，开机自启） |
| ingress | `ai.muyaya.world → http://localhost:3000`，其余 `http_status:404` |

验证过的两条：

```
GET  https://ai.muyaya.world/api/health   → 200 {"status":"ok"}
WSS  wss://ai.muyaya.world/ws?key=bubu    → 101 Switching Protocols
```

为什么这样能绕开备案问题：`muyaya.world` 的 NS 在 Cloudflare，橙云代理后
流量终点是 CF 边缘，隧道是服务器**主动外连**，没有入站连接到百度云 IP。
而 `api.muyaya.world` 是 DNS 直指 `120.48.86.101`，会被百度云以「未备案」403。

### 5.2 待清理

服务器上还跑着两个**旧的匿名 trycloudflare** 隧道：

| pid | 目标 | 日志 |
|---|---|---|
| 24723 | `--url http://localhost:3000` | `/tmp/cloudflared-ai.log` |
| 30222 | `--url http://localhost:3001` | `/tmp/cloudflared-api.log` |

它们只在 `ai.muyaya.world` 上线前是唯一通路，现在可以退役。
退役前注意：`muyaya-api`（:3001）目前**没有**命名隧道，
如果前端还有地方依赖 :3001 的隧道地址，先确认再停。

---

## 六、事故记录：`d325301`（2026-10-25）

`auto-deploy-web.yml` 的 6 小时 cron 检出上游 PhotoCraft v0.16.0 后：

```bash
rm -rf photocraft/                          # 连 ai-widget.js 一起删
unzip 上游包 → cp -a 到 photocraft/          # 本来就没有悬浮球
git add -f .web-versions.json photocraft/ lightcraft/   # 把删除也 stage 了
```

流水线全绿，因为**没有任何一步检查悬浮球在不在**。删掉的东西：
`photocraft/ai-widget.js`（637 行）、`photocraft/index.html` 的 shim 与标签、
`lightcraft/index.html` 的标签（88 行）。

修复：`dabb051` 回退 `photocraft/` 到 `ccbf345`、重新注入 LightCraft 标签、
`auto-deploy-web.yml` 不再部署 PhotoCraft。

---

## 七、已知 bug（2026-10-27 记录，未修）

用户在 PhotoCraft 里输入「变成黑白的」，面板显示
「✅ 已应用到编辑器，可撤销」，但**图片没有任何变化**。两个独立原因：

### bug 1：`send()` 漏了 `await`

```js
// ai-widget.js:540
const success = executeCommands(data.commands);   // executeCommands 是 async
if (success) { ... '✅ 已应用到编辑器' ... }
```

`executeCommands` 声明为 `async`（326 行），不 `await` 拿到的是 Promise，
恒为真值。所以**无论实际应用成功与否都显示成功**。这解释了「说应用了但没变」。

### bug 2：键名映射不匹配

服务端 `STUDIO_ADJUSTMENTS` 发出的键带 `u` 前缀：

```
uExposure uContrast uHighlights uShadows uTemp uWhites uBlacks uClarity
uTint uSaturation uCurveShadow uCurveMid uCurveHigh uHue uHslSat uHslLight
uDenoiseLum uDenoiseColor uSharpenMask uSharpness uVignette uGrain uGrainSize
uBndRedHue uBndRedSat uBndRedLum ...
```

而 `mapToPhotoCraftCommand` 的映射表用的是**无前缀**名字：
`exposure`、`saturation`、`contrast`、`temperature`、`vignetteAmount`…

`map[key] || null` 命中不了 → `mapped` 为 `null` → 跳过 → `applied` 为 0。
而且命名还有额外错位：`uTemp` ≠ `temperature`、`uHslSat` ≠ `saturation`、
`uVignette` ≠ `vignetteAmount`、`uSharpness` ≠ `sharpening`。

所以即使修好 bug 1，**大部分参数仍然映射不上**。修 bug 2 需要一张
`u*` → `adjust.*` 的真实对照表，而不是去掉前缀了事。

### 修的时候注意

- 修完必须实测：黑白、提亮、加对比度至少各一次，看图片真的变。
- `executePhotoCraftCommands` 通过 `window.execute_command(commandId, JSON.stringify(params))`
  调用，返回 `applied > 0`；失败时应该把「哪几个没应用」告诉用户，不要静默。

---

## 八、部署路径与漂移风险

`/opt/ai-agent-server` **不是 git 仓库**。线上状态是：

| 项 | 状态 |
|---|---|
| 运行方式 | pm2 `ai-agent-server`（id 26），`node dist/index.js`，cwd `/opt/ai-agent-server` |
| 构建 | `npm run build`（即 `tsc`）；devDependencies 原本被 `--omit=dev` 砍掉 |
| 2026-10-27 改动 | 手工上传 `src/api/parse.ts`、`src/core/studio-prompts.ts`，在 `src/index.ts` 插了 2 行，装了 `typescript@5.8.3`，`npx tsc`，`pm2 restart` |
| 回滚点 | `dist.bak-20261027-001238`、`src/index.ts.bak-20261027-001238`、`package.json.bak-20261027-001238` |

**这次是手工部署，没走 CI。** 正规路径是推 `deploy-muyaya-node` 触发
`deploy-ai-agent.yml`（它从仓库构建 `dist` 再同步），但那条分支一推会连带触发
`deploy-muyaya-api-node.yml`（历史 2h20m 挂掉的生产部署）。
所以仓库里的 `7ee651c070` 和线上是同一份内容，但**不是 CI 同步的**。
接 CI 之前不要再手工改服务器代码。

`/api/parse` 已可用（实测）：

```
POST /api/parse  -H 'X-API-Key: bubu'
{"message":"变成黑白的","tool":"photocraft"}
→ {"commands":[{"key":"uSaturation","value":-1}],"explanation":"...","tool":"photocraft"}
```

不带 key → 401。LLM 三个键在服务器 `.env` 里都配好了。

---

## 九、运行时拓扑

```
muyaya.world          → GitHub Pages（185.199.10x.153），本仓库 main，push 后 30~60 秒生效
ai.muyaya.world       → Cloudflare 边缘 → 隧道 muyaya-ai → 120.48.86.101:3000
api.muyaya.world      → 直指 120.48.86.101，被百度云 403（未备案）

120.48.86.101（Debian 10）
  nginx            :80     不服务前端，/photocraft/ 是 404
  ai-agent-server  :3000   pm2 id 26；/api/health → {"status":"ok"}；/api/parse、/ws
  muyaya-api       :3001   pm2 id 19；/api/health → {"ok":true}
  cloudflared      systemd  muyaya-ai 命名隧道
  cloudflared      x2       旧匿名隧道（pid 24723 → :3000，30222 → :3001），待清理
  系统 Node         20.18.0 ai-agent-server / muyaya-api 用它，不要动
  /opt/harness-node 24.17.0 独立前缀，只给 dsh 用
  /opt/harness-cli          @deepseek-ai/dsh
  /usr/local/bin/dsh        真实文件，exec 上面的 Node 24
```

`muyaya-api` 的 `.env`：
`ALLOWED_ORIGINS=https://muyaya.world,https://xiaobubuya.github.io`、
`AGENT_BASE_URL=http://127.0.0.1:3000`、`AGENT_API_KEY=bubu`。

---

## 十、怎么正确升级 PhotoCraft

1. 上游发版后，跑 Actions → `Build PhotoCraft WASM`。
   它会打 patch → 构建 → 注入 → 更新锁 → 校验 → 推送。**不要手改锁文件。**
2. `apply-bridge.js` 报 `Anchor not found` = 上游改了锚点行，
   要按新代码更新锚点，再重跑。
3. `.web-versions.json` 里的 `photocraft=` 保留自建构建的版本号，
   不要写成上游 tag（会谎报版本）。

LightCraft 相反：只走 `auto-deploy-web.yml`，上游发版自动跟上。

---

## 十一、文件清单

| 文件 | 作用 |
|---|---|
| `ai-widget.js` | 悬浮球本体（按钮 + 面板 + 命令映射），全仓库唯一一份 |
| `apply-bridge.js` | 构建前改上游源码，注入 AI Bridge |
| `ai-bridge.patch` | `web.rs` 改动的 diff 存档，仅供参考 |
| `photocraft-build.lock` | `photocraft/` 指纹锁 |
| `scripts/verify-photocraft-build.sh` | 唯一校验实现，三处 workflow 共用 |
| `.github/workflows/protect-photocraft-wasm.yml` | 独立绊线 |
| `.github/workflows/build-photocraft-wasm.yml` | 唯一有权写 `photocraft/` |
| `.github/workflows/auto-deploy-web.yml` | 只写 `lightcraft/` |
| `.web-versions.json` | `photocraft=<自建版本>,lightcraft=<上游 tag>` |
| `docs/CONTEXT.md` | 项目当前状态速查（本文件是 AI 悬浮球专题） |
