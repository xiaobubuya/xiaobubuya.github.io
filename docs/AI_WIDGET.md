# AI 悬浮球 & PhotoCraft AI Bridge — 部署铁律

> 写于 2026-10-26。起因是 `d325301` 把 AI 悬浮球从两个编辑器里删掉了，
> 而流水线是绿的。这份文档记录「为什么会坏」和「为什么不能再坏」，
> 以后任何要动 `photocraft/`、`lightcraft/`、这两个 workflow 的人先看这一份。

---

## 一、一句话铁律

**`photocraft/` 里的 wasm 只能由 `build-photocraft-wasm.yml` 从打过 patch 的源码构建，
任何工作流都不得用上游 release 压缩包覆盖它。**

原因：AI Bridge 是改 Rust 源码编进 wasm 的。上游 release 包里没有它。
拿上游包覆盖 = 悬浮球变成一个点了没反应的死按钮。

> 上游 v0.16.0 的 wasm 是 **98,880 字节**；打过 patch 的自建构建是 **26,445,909 字节**。
> 差 270 倍。看到 `photocraft/photocraft-web-boot-*.wasm` 这种文件名和这个小体积，
> 就是被上游包覆盖了。

---

## 二、谁归谁管（所有权表）

| 路径 | 唯一写入者 | 来源 | 含 AI Bridge |
|---|---|---|---|
| `photocraft/*` | `build-photocraft-wasm.yml` | `apply-bridge.js` 改源码 → `trunk build --release` | ✅ 是 |
| `lightcraft/*` | `auto-deploy-web.yml` | `storytold/lightcraft` 上游 release zip | ❌ 从来就没有 |
| `ai-widget.js`（仓库根） | 手工提交 | —— | —— 就是悬浮球本身 |

`auto-deploy-web.yml` 曾经也写 `photocraft/`，这就是事故的根因。
现在它强制 `UPDATE_PC=false`，只负责 LightCraft。

---

## 三、AI Bridge 到底是什么

### 3.1 构建时的注入链路

`build-photocraft-wasm.yml`：

```
clone 上游 storytold/photocraft
  → node deploy-repo/apply-bridge.js     # 第 48 行：锚点式改源码
  → trunk build --release                # 第 57 行：编译出 wasm
  → cp 产物到 ../deploy-repo/photocraft/
  → sed 注入 <script src="ai-widget.js">  # 第 149-163 行
  → git add -f photocraft/ && commit && push
```

**AI Bridge shim 不是 sed 注的，是 `apply-bridge.js` 烤进 `apps/photocraft-web/index.html`
模板里的**，随 Trunk 构建一起进产物。所以 `build-photocraft-wasm.yml` 的 sed 只负责
`ai-widget.js` 那个 script 标签。

### 3.2 `apply-bridge.js` 改了什么

锚点式插入（anchor-based），锚点缺失就直接 `fatal()` 退出，不静默跳过。三处：

| 文件 | 改动 |
|---|---|
| `apps/photocraft-web/Cargo.toml` | 加 `serde_json` + `futures-util` |
| `apps/photocraft-web/src/web.rs` | 加全局 `COMMAND_QUEUE` / `REPAINT` / `SESSION_READY`，加 `#[wasm_bindgen]` 的 `execute_command` / `has_session` / `request_repaint`，在 `start()` 里注册 repaint 回调并置位 `SESSION_READY`，在 `WebShell::logic()` 里处理命令队列 |
| `apps/photocraft-web/index.html` | 注入 AI Bridge shim（把 wasm-bindgen 导出挂到 `window`） |

`ai-bridge.patch` 是 `web.rs` 改动的 diff 存档（3842 字节），仅供参考，
**实际注入靠 `apply-bridge.js`**（`fix(ci): move AI bridge injection into Trunk template
via apply-bridge.js`，commit `fe9b3b4`）。

### 3.3 为什么用命令队列而不是 `Rc<RefCell<Session>>`

（`apply-bridge.js` 头部的原始注释，保留以免重蹈覆辙）

- `Session` 是 `!Send`，所以 `Mutex<Session>` 是 `!Sync`，不能放进 `static`。
- `Rc<RefCell<Session>>` 也是 `!Sync`，同样不能进 `static`。
- 队列里放的是 `(String, Value, Arc<AtomicBool>, Arc<Mutex<Option<Result>>>)`，
  全部 `Send + Sync`，在 wasm32 上放进 `static` 合法。
- `execute_command()` 是 async：把请求压进队列然后 yield；eframe 循环在下一帧
  处理队列并 resolve 这个 Promise。

### 3.4 运行时：JS 侧怎么接

`ai-widget.js` 的判定（**这就是「tag 在不等于能用」的地方**）：

```js
function hasPhotoCraftAIBridge() {
  return typeof window.execute_command === 'function'
      && typeof window.has_session === 'function';
}
```

`window.execute_command` / `window.has_session` 由 index.html 里的 shim 在
`TrunkApplicationStarted` 事件后从 `window.wasmBindings` 上摘出来。
上游构建的 wasm 导出只有 `initSync, __wbg_init`，所以 shim 摘不到，
这两个 `typeof` 检查永远不成立。

### 3.5 降级路径也是断的

`ai-widget.js` 有三级降级（`executeEditorCommands`，146-159 行）：
PhotoCraft AI Bridge → Studio（legacy）→ Canvas 2D。

Canvas 2D 兜底走的是 `document.getElementById('photocraft_canvas').getContext('2d')`。
但 PhotoCraft 的画布是 WebGL 上下文，`getContext('2d')` 对同一 canvas 返回 `null`，
兜底直接返回 false。

**结论：没有 AI Bridge，悬浮球在 PhotoCraft 里就是死按钮。**

---

## 四、事故记录：`d325301`（2026-10-25）

### 4.1 时间线

```
ccbf345  chore: update PhotoCraft WASM with AI Bridge (run #36)   ← 悬浮球还在 ✅
   ↓
d325301  deploy: update web apps (photocraft=v0.16.0 lightcraft=v0.14.0)
         github-actions[bot]  2026-10-25T15:08:24Z  ← 悬浮球没了 ❌
```

`d325301` 的作者是 `github-actions[bot]`，由 `auto-deploy-web.yml` 的
`schedule` 触发（run `40205503804`，21 秒）。它检出上游 `storytold/photocraft`
发布了 v0.16.0，就下载解包了。

线上 `Last-Modified: Sun, 25 Oct 2026 15:09:16 GMT`，与提交时间吻合。

### 4.2 被删了什么

| 文件 | 删除内容 |
|---|---|
| `photocraft/ai-widget.js` | 637 行（整个文件） |
| `photocraft/index.html` | AI Bridge shim 整块 + `<script src="ai-widget.js">` |
| `lightcraft/index.html` | `<script src="../ai-widget.js">`（共 88 行 diff） |

### 4.3 为什么流水线是绿的

`auto-deploy-web.yml` 的部署步骤：

```bash
rm -rf photocraft/                                # 连 ai-widget.js 一起删
unzip -q "/tmp/$ZIP" -d "$EXTRACT"                # 上游原始包，本来就没有悬浮球
cp -a "$EXTRACT"/photocraft-web-*/. photocraft/
test -f photocraft/index.html || exit 1           # 只验入口文件，不验悬浮球
```

提交步骤：

```bash
git add -f .web-versions.json photocraft/ lightcraft/   # -f 把「删除」也 stage 进去
```

每一步都成功了。工作流里压根没有「悬浮球必须存在」这个检查项，
所以它不知道自己在删东西。**`build-photocraft-wasm.yml` 里那几行
`exit 1` 守卫没起作用，是因为它们在另一条工作流里。**

### 4.4 为什么下午还有

当天 10:15 UTC 那次 cron 是 `Already up to date`（上游还没发新版）。
15:08 UTC 那次才真的动了文件。

### 4.5 修复：`dabb051`

- `photocraft/` 整体回退到 `ccbf345`（run #36）的 patch 构建
- `lightcraft/index.html` 重新注入 script 标签
  （LightCraft 新旧构建都没有 Bridge，它丢的只有标签）
- `auto-deploy-web.yml` 不再部署 PhotoCraft
- `auto-deploy-web.yml` 部署 LightCraft 后注入并校验标签
- 新增提交前硬校验（见第五节）

---

## 五、保证机制：指纹锁 + 绊线

「不要在 `auto-deploy-web.yml` 里部署 PhotoCraft」只是**约定**，约定会被下一个人改回去。
真正的保证是下面三层。

### 5.1 `photocraft-build.lock` —— 唯一真相来源

仓库根的锁文件钉死了 `photocraft/` 里应该是什么：

```
wasm_file=photocraft-web-3074dac37f862afe_bg.wasm
wasm_sha256=5f5cc3aa9389ecc126f6934fa6c467c00ca226cdfddf065e53dbcf7207bd751e
js_file=photocraft-web-e693319804da66c3.js
js_sha256=70c15bd6784edc43bedc10af1f3ff0ca1983cbcb088a07d4af40f4bc3cf499c8
widget_sha256=28e9ced6774dc8540c226183ebc7e97a93dd608670effb521b43f384b95d40ea
bridge_symbols=execute_command has_session request_repaint
min_wasm_bytes=1048576
```

### 5.2 `scripts/verify-photocraft-build.sh` —— 唯一的校验实现

七项逐条比对，任一不符就 `exit 1`：

| # | 检查 | 拦的是什么 |
|---|---|---|
| 1 | 产物文件名与锁一致 | 被换成别的构建 |
| 2 | wasm / js 的 sha256 与锁一致 | 文件内容被改 |
| 3 | wasm 体积 ≥ `min_wasm_bytes` | 上游 98KB 的桩 |
| 4 | `bridge_symbols` 真的出现在构建 JS 里 | 没打 Bridge 的构建 |
| 5 | `photocraft/index.html` 有 shim + 标签；`lightcraft/index.html` 有标签 | shim / 标签被删 |
| 6 | 根目录与 `photocraft/` 的 `ai-widget.js` 一致，且校验和等于锁 | 悬浮球被换、或只更新了一份 |
| 7 | `photocraft/` 里没有 `photocraft-web-boot-*` | 上游产物混进来 |

```bash
bash scripts/verify-photocraft-build.sh            # 校验，失败退出 1
bash scripts/verify-photocraft-build.sh --update   # 构建成功后重建指纹
```

`--update` 写锁**之前**会先确认新产物里有 `bridge_symbols`，没有就拒绝写并 exit 1 ——
所以「构建出没带 AI Bridge 的产物」在这一步就被挡住，坏产物锁不进锁文件。

### 5.3 三个 workflow 共用同一份校验

| workflow | 何时跑 | 作用 |
|---|---|---|
| `protect-photocraft-wasm.yml` | push 到 main 触及 `photocraft/**`、`lightcraft/**`、`ai-widget.js`、锁文件、脚本，以及 PR | **独立绊线**：不部署任何东西，只校验。任何写入者都会在这里红 |
| `auto-deploy-web.yml` | 6 小时 cron / 手动 | 部署 LightCraft 之前校验 |
| `build-photocraft-wasm.yml` | 手动 / 改 `apply-bridge.js` | 构建后 `--update` 写锁，push 前再 `verify` 一次 |

**已做负面测试**：7 种破坏方式全部被拦住，包括 `d325301` 的原始场景
（上游包整体覆盖 + 98KB 桩 wasm + 删 `ai-widget.js` + 去掉 shim）。

### 5.4 绊线红了不等于合不进去

要真正阻止合并，需把 `Protect PhotoCraft Build` 设成 main 的
**required status check**（Settings → Branches），再给 `photocraft-build.lock`
配 CODEOWNERS 审批。这两项是 GitHub 设置，不在仓库文件里。

---

## 六、怎么正确升级 PhotoCraft

**不要**去动 `auto-deploy-web.yml` 里 PhotoCraft 那一段。

1. 上游发新版后，跑 Actions → `Build PhotoCraft WASM`（`build-photocraft-wasm.yml`）。
   它会 `apply-bridge.js` 打 patch → 构建 → 注入 `ai-widget.js` → 更新
   `photocraft-build.lock` → 校验 → 提交推送。**不要手工改锁文件。**
2. 如果 `apply-bridge.js` 报 `Anchor not found`，说明上游改了锚点行，
   需要按新代码更新 `apply-bridge.js` 里的锚点和插入块，再重跑。
3. `.web-versions.json` 里的 `photocraft=` 保留自建构建对应的版本号，
   **不要**写成上游 tag（会谎报版本）。

LightCraft 反之：只走 `auto-deploy-web.yml`，上游发版自动跟上，
它没有 Bridge，悬浮球在 LightCraft 里只提供聊天。

---

## 七、运行时拓扑（排查用）

```
muyaya.world          → GitHub Pages（185.199.110.153）
                        本仓库 main 分支，push 后约 30~60 秒生效
api.muyaya.world      → 120.48.86.101，但百度云 403 拦截（域名未备案）

120.48.86.101
  nginx          :80      注意：它并不服务前端，/photocraft/ 返回 404
  ai-agent-server :3000   PM2 id 26；/api/health → {"status":"ok"}
  muyaya-api      :3001   PM2 id 19；/api/health → {"ok":true}
  cloudflared    x2       --url http://localhost:3000 和 :3001，各自一个 cfargotunnel 地址
  系统 Node      20.18.0  ai-agent-server / muyaya-api 用它，不要动
  /opt/harness-node  Node 24.17.0 独立前缀，只给 dsh 用
  /opt/harness-cli   @deepseek-ai/dsh（从 npm 装）
  /usr/local/bin/dsh  真实文件（不是 symlink），exec 上面的 Node 24
```

`muyaya-api` 的 `.env`：
`ALLOWED_ORIGINS=https://muyaya.world,https://xiaobubuya.github.io`、
`AGENT_BASE_URL=http://127.0.0.1:3000`、`AGENT_API_KEY=bubu`。

---

## 八、相关文件清单

| 文件 | 作用 |
|---|---|
| `ai-widget.js` | 悬浮球本身（按钮 + 面板 + 命令映射），全仓库唯一一份 |
| `apply-bridge.js` | 构建前改上游源码，注入 AI Bridge |
| `ai-bridge.patch` | `web.rs` 改动的 diff 存档，仅供参考 |
| **`photocraft-build.lock`** | **`photocraft/` 的指纹锁，唯一真相来源** |
| **`scripts/verify-photocraft-build.sh`** | **唯一的校验实现，三处 workflow 共用** |
| `.github/workflows/protect-photocraft-wasm.yml` | **独立绊线，任何写入者都会被校验** |
| `.github/workflows/build-photocraft-wasm.yml` | 唯一有权写 `photocraft/`，构建后更新锁 |
| `.github/workflows/auto-deploy-web.yml` | 只写 `lightcraft/`；部署前校验 |
| `.web-versions.json` | `photocraft=<自建构建版本>,lightcraft=<上游 tag>` |
| `docs/HANDOFF.md` | 项目整体交接文档 |
