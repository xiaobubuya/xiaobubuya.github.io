# 婚纱照相册 · 实施方案

> 目标：一个只属于我和老婆的相册，随时随地在手机/电脑上打开翻看。
> 形态：GitHub Pages（公开外壳） + Cloudflare Worker（私有后端 + R2 存图 + D1 存数据）
> 域名：`muyaya.world`（现有域名，小说站让位）
> 本文档不含任何密钥。所有密钥只存在于 Cloudflare 环境变量与本地 `.env`（不入库）。

---

## 0. 结论速览

| 项 | 决定 |
|---|---|
| 架构 | 方案 A：GitHub Pages 公开外壳 + Worker 私有后端 |
| 前端 | GitHub Pages，`muyaya.world`，**零密钥** |
| API | `api.muyaya.world`（Cloudflare Worker） |
| 图片 | Cloudflare R2，**不开公共访问**，只发短过期签名 URL |
| 数据 | D1（心愿 / 纪念日 / 收藏）+ R2 `manifest.json`（照片索引） |
| 鉴权 | Worker 自建：口令 → HMAC 签名 Cookie（`HttpOnly; Secure; SameSite=Lax`） |
| 存储策略 | 原图**不上云**（本地 + 网盘冷备）；云端只放 thumb 400w + preview 1600w |
| 预计成本 | **¥0/月**（照片量级落在 R2 10GB 免费额度内） |
| 预计工时 | 2～3 个工作日 |
| 域名 / NS | `muyaya.world` NS 从阿里云迁到 Cloudflare —— **已确认执行** ✅（步骤见附录 A） |
| 小说站 | **不要**，`muyaya.world` 让位给相册；原文保留在 git 历史与 `novels` 分支 |

**一个硬前提（已确认）**：API 必须挂在 `muyaya.world` 的子域下，因此需要把该域名的 NS 从阿里云改到 Cloudflare。
原因见 §2.3。NS 迁移已确认执行，完整操作清单见 **附录 A**。

> 已定案：架构 = 方案 A；域名 = `muyaya.world`（不新买域名）；小说站 = 下线让位；
> 照片 = 云端只放网页浏览用的高清版，原图不上云；NS = 迁移到 Cloudflare。

---

## 1. 现状盘点（已核实）

| 项 | 事实 |
|---|---|
| 当前工作区 | 只有 `app.js`（1866 行），**无 git 仓库、无 `index.html` / `styles.css`**，单独跑不起来 |
| `app.js` 出处 | 等于 `xiaobubuya/xiaobubuya.github.io` 的提交 `12a576c`（2026-04-07 17:03） |
| 线上 `muyaya.world` | 现在跑的是**小说站**，相册已不在线 |
| 相册前端完整体 | 在该仓库 git 历史 `e5d2121`：`app.js`(2068 行) + `index.html` + `base.css` + `components.css` + `story.css` + `story.js` + `wishes.json` + `events.json`，**可完整恢复** |
| 照片存哪 | `xiaobubuya/image` 仓库，经 `cdn.jsdelivr.net/gh/...` 发布 |
| 域名 | `muyaya.world` NS = `dns1/dns2.hichina.com`（阿里云），A 记录指向 GitHub Pages |
| 旧副本 | `taopengyu/couple-album`（另一账号，1 个 initial commit，比现版旧） |

### 1.1 必须先止血的安全问题

**(a) 硬编码 GitHub PAT**
`app.js` 第 16 行有一个双重 base64 编码的 GitHub Personal Access Token，第 17 行解码后直接当鉴权用。
这个文件是**公开部署**在 GitHub Pages 上的 → 该 token 等同于全网公开。
持有者可对 `xiaobubuya.github.io` 与 `image` 仓库推任意内容、删任意文件。
GitHub secret scanning 会扫到并**自动吊销**——历史上"相册莫名其妙报错"，很可能就是这个原因。
> 行动：立即到 GitHub → Settings → Developer settings → Personal access tokens 删除该 token。
> 注意：双重 base64 只是混淆，不是加密，不能作为缓解手段。

**(b) 明文口令 + 前端鉴权**
`app.js` 第 2 行以明文保存账号口令；第 1245 行 `login()` 仅做前端字符串比较。
任何人 F12 即可看到口令；更关键的是**照片本身在 `image` 仓库公开可枚举**，绕过页面直接访问 CDN 就能拿到全部原图。
婚纱照的隐私要求下，这个设计不成立，必须整体替换。

**(c) jsDelivr 不适合做私有相册 CDN**
它是面向开源 npm/GitHub 项目的免费 CDN：会限流、会因仓库体积拒绝服务、**无任何访问控制**。
叠加 GitHub 仓库的硬约束（单文件 100MB、仓库建议 <1GB、Pages 站点 1GB），当前形态无法规模化。

---

## 2. 架构设计

### 2.1 全景

```
┌─────────────────────────── GitHub Pages · muyaya.world ───────────────────────────┐
│  公开静态前端：index.html / styles.css / app.js / story.js / *.css                 │
│  · 只含 UI 与渲染逻辑                                                             │
│  · 通过 fetch 调 API_BASE，凭 Cookie 访问数据                                      │
│  · 仓库内 grep 不到任何 token / 口令 / 密钥                                        │
└────────────────────────────────────┬──────────────────────────────────────────────┘
                                     │ HTTPS + Cookie(same-site)
┌────────────────────────────────────▼──────────────────────────────────────────────┐
│                    Cloudflare Worker · api.muyaya.world                           │
│  POST /api/login         口令 → 校验 → 下发 HMAC 签名 Cookie                       │
│  POST /api/logout        清 Cookie                                                │
│  GET  /api/photos        鉴权 → manifest 分页 / 筛选 / 搜索                        │
│  GET  /api/img/:key      鉴权 → 302 到 R2 短过期签名直链（5 min）                  │
│  GET  /api/wishes        鉴权 → D1 读                                            │
│  POST /api/wishes        鉴权 → D1 写（新增 / 编辑 / 完成 / 删除）                  │
│  GET  /api/events        鉴权 → D1 读                                            │
│  POST /api/events        鉴权 → D1 写                                            │
│  POST /api/upload-url    鉴权 → 签发 R2 presigned PUT（浏览器直传）                │
│  POST /api/favorite      鉴权 → D1 写收藏                                         │
│                                                                                   │
│  统一中间件：验签 → 过期检查 → 失败限流 → CORS 白名单 → 路由                       │
└───────────┬────────────────────────────────────────────┬──────────────────────────┘
            │                                            │
   ┌────────▼─────────┐                        ┌─────────▼──────────┐
   │  R2: album-photos│                        │  D1: album-db      │
   │  thumb/<h>.webp  │ 400w  ~60KB            │  wishes            │
   │  preview/<h>.webp│ 1600w ~350KB           │  events            │
   │  full/<h>.jpg    │ 2560w（可选）           │  favorites         │
   │  manifest.json   │ 上传时生成，不可变       │  login_attempts    │
   │  ⛔ 不开启公共访问 │                        └────────────────────┘
   └──────────────────┘
```

### 2.2 数据流：看照片

1. 打开 `https://muyaya.world` → GitHub Pages 返回静态前端（**这一步是完全公开的，符合预期**）
2. 前端调 `POST api.muyaya.world/api/login`，带上口令 → Worker 校验 → 下发签名 Cookie
3. 前端调 `GET /api/photos?page=0` → Worker 验 Cookie → 从 `manifest.json` 切片返回照片元数据
   - 前端拿到的是 `key`，**不是图片 URL**
4. 前端渲染缩略图，`<img src="https://api.muyaya.world/api/img/thumb/<hash>.webp">`
   - 浏览器自动带 Cookie（same-site）
   - Worker 验 Cookie → 签发 5 分钟有效的 R2 签名 URL → `302` 重定向
   - 302 响应带 `Cache-Control: private, max-age=3600`，避免重复验签
5. 点开大图 → 取 `preview/<hash>.webp`；「下载原图」按钮 → 取 `full/<hash>.jpg`

**关键点：任何未鉴权请求都拿不到图片 URL。** R2 bucket 不开公共域名，签名 URL 短过期且只绑单个 key。

### 2.3 为什么 API 必须挂在 `muyaya.world` 子域（方案 A 的硬约束）

前端在 `muyaya.world`，如果 API 在别的注册域（例如 `xxx.workers.dev`），登录 Cookie 就属于**第三方 Cookie**：

- Safari 的 ITP 默认拦截第三方 Cookie
- Chrome 正在淘汰第三方 Cookie
- 结果是：登录态时有时无，手机 Safari 上基本必挂

而 `api.muyaya.world` 与 `muyaya.world` 共享同一个 registrable domain（`muyaya.world`），属于 **same-site**，`SameSite=Lax` 即可正常工作，不受第三方 Cookie 策略影响。

**推论**：要让方案 A 稳定工作，就必须能给自己域名添加子域 → 必须把 `muyaya.world` 的 NS 迁到 Cloudflare。
（Workers 自定义域名 / Cloudflare Access 都要求该 zone 在 Cloudflare 账号内。）

- 改动位置：阿里云域名控制台 → DNS 修改 → 改成 Cloudflare 分配的两个 NS
- 域名注册商仍是阿里云，域名所有权不变；操作免费、可回退
- **迁移前先导出阿里云现有全部 DNS 记录**，迁完在 Cloudflare 逐条重建，避免漏配导致站点中断

**唯一的退路**（不推荐）：不动 NS，API 用 `*.workers.dev`，鉴权不用 Cookie 改用 `Authorization: Bearer` + `localStorage`。
代价有两个：① `workers.dev` 在国内基本不可用；② token 暴露在 localStorage 有 XSS 风险。
仅在"实在不能改 NS"时启用。

### 2.4 鉴权设计细节（自建，不依赖 Cloudflare Access）

因为要"前端公开 + 数据私有"，Access 那种整站保护不适用，所以鉴权写在 Worker 里。

```
签发：payload = { u: <user>, exp: <now + 30d> }
      body    = base64url(JSON.stringify(payload))
      sig     = base64url(HMAC-SHA256(AUTH_SECRET, body))
      cookie  = body + "." + sig
      Set-Cookie: album_session=<cookie>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000

校验：拆 body/sig → 重算 HMAC → 常数时间比较 → 检查 exp
```

要点：
- `AUTH_SECRET` 只存在 Worker secret，**永不进前端、永不进仓库**
- 口令同样只存 Worker secret（`wrangler secret put`），前端只负责收集并 POST
- **限流**：`login_attempts` 表按 IP + 时间窗记录失败次数，超过阈值（例如 10 次/15 分钟）直接 429
- 口令建议 ≥ 12 位随机串，两人各一份，或共用一份
- 前端不存任何凭证，登出 = 让 Worker 下发过期 Cookie
- **前端公开意味着 API 会被扫描器发现**，限流不是可选项

### 2.5 连通性实测（改 NS 之前的前置门槛）

**为什么不能用 workers.dev 单独做判据**：`workers.dev` 这个域名在国内被单独阻断的程度，
明显高于 Cloudflare 上的**自定义域**。用 workers.dev 打不开就否决整个方案，会误杀一个本来可用的架构。

所以分两段探测。

**探测 A · Cloudflare 边缘可达性**（手机 4G，关 Wi-Fi）
- 打开 `https://speed.cloudflare.com`（Cloudflare 自家测速站，直连其边缘网络）
- 再打开任意一个你已知走 Cloudflare 的站点作为交叉验证

**探测 B · workers.dev 域名可达性**
- `npx wrangler init` 一个 hello world Worker 并 deploy，得到 `https://<name>.<account>.workers.dev`
- 同样用手机 4G 打开

**判读**

| 探测 A | 探测 B | 结论 |
|---|---|---|
| 通、速度快 | 通 | ✅ **放心迁 NS** |
| 通、速度可接受 | 不通/超时 | ⚠️ **仍建议迁** —— 大概率是 workers.dev 域名被单独阻断，自定义域不受影响。存在不确定性，但成本低、可回滚，值得一试 |
| 超时/极慢 | 任意 | ⛔ **停止**，走 §8 的阿里云备选方案 |

**记录实测数据**（迁移决策的依据，留给以后回看）：

- 探测 A 耗时：**约 200 ms**（`speed.cloudflare.com` 实测 0.182s）／ 结果：**通**
- 探测 B 耗时：**超时（HTTP 000）** ／ 结果：**不通**
- 测试时间与运营商：2026-09-21，浙江电信（内网 10.242.x，出口 115.236.x）
- 补充实测：**绕过 DNS 直连 Cloudflare 真实 IP（`104.21.41.32`）访问已部署的 Worker**
  → **HTTP 200，0.15 ~ 0.43s（中位约 0.20s）**

**判读结论：⚠️ 落在上表第 2 行 —— 「边缘通、`workers.dev` 不通」→ 仍建议迁 NS。**

`album-api.424102378.workers.dev` 的解析对照：

| 来源 | 解析结果 |
|---|---|
| 本地 DNS | `104.244.43.35` / `108.160.172.208` ← **Twitter / Dropbox 网段，属投毒** |
| DoH（Cloudflare） | `104.21.41.32` / `172.67.159.128` ← 真实 Cloudflare |
| DoH（Google） | `172.67.159.128` / `104.21.41.32` ← 一致 |

**结论：`workers.dev` 域名被 DNS 投毒；但 Cloudflare 边缘本身完全可达，且相当快（~0.2s）。**
**→ 必须绑自定义域名（`api.muyaya.world`），NS 迁移是必需步骤，且预期能拿到 0.2s 级别的访问速度。**

---

## 3. 存储与图片处理

### 3.1 尺寸策略（按"只要网页高清版"确定）

| 档位 | 规格 | 用途 | 单张约 |
|---|---|---|---|
| `thumb` | 长边 400px，WebP q75 | 网格 / 瀑布流 | ~60 KB |
| `preview` | 长边 1600px，WebP q80 | 点击放大（手机够看） | ~350 KB |
| `full` | 长边 2560px，JPEG q85 | 「下载高清原图」（**可选档**） | ~1.2 MB |

估算：2000 张 → thumb 120MB + preview 700MB ≈ **0.8 GB**，远低于 R2 免费 10GB。
加 `full` 档约 2.4 GB，仍然宽裕。

**原图（相机/摄影师给的几十 MB 版本）不入云**：本地磁盘 + 网盘（阿里云盘/百度网盘/iCloud）做冷备。
理由：原图是"归档"，不是"浏览"；云端只需承担浏览，成本与速度都最优。

### 3.2 命名与缓存

- key = `sha256(原图内容).slice(0,16)` → `thumb/<h>.webp`
- 内容寻址 ⇒ 同一张图重复上传自动去重，且内容永不变
- 响应头：`Cache-Control: public, max-age=31536000, immutable`
  - ⚠️ 只对 `thumb/` 与 `preview/` 用 `public`（它们本身在私有 bucket 里，浏览器缓存不影响安全）
  - 不要给 `manifest.json` 加 immutable，它需要可更新
- Cloudflare 边缘缓存能挡掉绝大部分回源，R2 的 B 类操作量会非常低

### 3.3 元数据

`manifest.json`（放 R2，上传时由脚本生成）：

```json
{
  "generatedAt": "2026-01-01T00:00:00Z",
  "count": 2000,
  "photos": [
    {
      "k": "a1b2c3d4e5f60718",
      "w": 1600, "h": 1067,
      "takenAt": "2025-09-18T10:23:00+08:00",
      "folder": "01-外景",
      "tags": ["婚纱", "海边"],
      "hasFull": true
    }
  ]
}
```

- 2000 条 ≈ 400KB，一次拉取即可；超过约 5000 张再考虑拆分为分片索引或迁到 D1
- **只存派生信息，不存敏感内容**（EXIF 里的 GPS 默认剥离，不进 manifest）

D1 表结构：

```sql
CREATE TABLE wishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE favorites (
  photo_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts ON login_attempts(ip, ts);
```

### 3.4 上传管线

`tools/upload.mjs`（Node 脚本，本地跑）：

1. 递归扫描源目录（`.jpg .jpeg .png .heic .webp`）
2. 读 EXIF：拍摄时间（用于时间线分组）、方向（用于自动旋转）
3. `sharp` 生成 `thumb` / `preview`（可选 `full`）
4. 内容 hash → 跳过已上传的（查本地 `.upload-cache.json`，支持断点续传）
5. 并发（6～8）经 S3 API 上传到 R2（`@aws-sdk/client-s3` 或轻量的 `aws4fetch`）
6. 全部完成后生成并上传 `manifest.json`

用法：

```bash
node tools/upload.mjs ~/Pictures/wedding/2025-09-18外景
node tools/upload.mjs ~/Pictures/wedding --recursive --with-full
node tools/upload.mjs --rebuild-manifest      # 只重建索引
```

**HEIC 注意**：iPhone 直出是 HEIC。Node 版 `sharp` 的预编译包含 libheif，通常可直接读；若失败，macOS 上先批量转换：
```bash
for f in *.HEIC; do sips -s format jpeg "$f" --out "${f%.HEIC}.jpg"; done
```

---

## 4. 前端改造清单

### 4.1 先恢复完整前端

工作区当前缺文件，从 git 历史取回：

```bash
# 在 xiaobubuya.github.io 仓库内（本机副本：../xiaobubuya-github-io-temp）
git checkout e5d2121 -- index.html app.js base.css components.css story.css story.js
# wishes.json / events.json 不再需要（数据迁到 D1），仅作迁移参考
```

恢复后先确认它能在本地起起来、能渲染，再动刀。**不要直接改线上 main**，先开分支。

### 4.2 必须删除的东西

| 位置 | 内容 | 处理 |
|---|---|---|
| `app.js` L16–17 | 硬编码 PAT + 解码逻辑 | **整段删除** |
| `app.js` L2 | 明文 `ACCOUNTS` | **整段删除** |
| `app.js` L5–15 | `CONFIG.imageRepo` / `cdnBase` / `rawBase` | 删除，替换为 `API_BASE` |
| `login()` L1245 | 前端比较口令 | 改为 POST `/api/login` |

### 4.3 必须替换的数据源

| 函数 | 行号 | 原来 | 改为 |
|---|---|---|---|
| `loadSlideshowPhotos` | 273 | GitHub Contents API | `GET /api/photos?tag=slideshow` |
| `loadWishes` | 603 | `wishes.json` (GitHub) | `GET /api/wishes` |
| `saveWishes` | 627 / 653 | GitHub Contents PUT | `POST /api/wishes` |
| `loadCountdownEvents` | 919 | `events.json` (GitHub) | `GET /api/events` |
| `saveCountdownEvents` | 945 / 973 | GitHub Contents PUT | `POST /api/events` |
| `handleFiles` | 1310 | 逐张 base64 提交 | 直传 R2（§4.4） |
| `uploadFile` | 1331 / 1339 | GitHub Contents PUT | 见下 |
| 图片列表 | 1367 / 1387 / 1652 | GitHub Contents 列举 | `manifest`（由 `/api/photos` 提供） |
| 图片地址 | 全站 | `cdn.jsdelivr.net/gh/...` | `https://api.muyaya.world/api/img/<size>/<key>` |

### 4.4 浏览器上传改造

浏览器的 GitHub Contents API 上传（base64、1MB 限制、慢）改为：

1. 前端 `POST /api/upload-url`，带 `{ filename, size, contentType }`
2. Worker 鉴权 → 生成 key → 返回 presigned PUT URL（R2 S3 API 签发，10 分钟有效）
3. 前端 `fetch(presignedUrl, { method: 'PUT', body: file })` **直传 R2**（不经 Worker，省流量）
4. 前端通知 Worker 更新 manifest（或由 Worker 在签名时预登记，上传完成后置位）
5. 浏览器端**不做缩略图生成**（前端 sharp 不现实）：直传的 `full` 档由 Worker 侧定时任务或本地脚本补生成 thumb/preview

> 建议：批量导入（婚纱照主要来源）走 §3.4 的本地脚本；
> 浏览器上传只作为"手机随手补几张"的补充通道。

### 4.5 可以完整保留的部分

这些是现有代码的资产，**只换数据源，不动渲染逻辑**：
幻灯片（含全屏、触摸滑动、自动播放）、心愿面板、纪念日卡片、成就系统、背景模式/模糊/暗度设置、IndexedDB 本地缓存、登录页 UI 外观。

---

## 5. 分阶段实施步骤

### Phase 0 · 止血（今天，30 分钟）
- [ ] 到 GitHub 吊销 `app.js` 中泄露的那个 PAT
- [ ] 确认 `xiaobubuya/image` 仓库现状：是否需要转私有 / 清空（照片已公开过，若要彻底私有需重新上传到 R2）
- [ ] 导出阿里云 `muyaya.world` 现有全部 DNS 记录并存档

### Phase 1 · 恢复前端（0.5 小时）
- [ ] 从 `e5d2121` 取回 `index.html` / `app.js` / `base.css` / `components.css` / `story.css` / `story.js`
- [ ] 本地起静态服务，确认能渲染
- [ ] 新建工作分支，不碰线上 main

### Phase 2 · Cloudflare 基础设施（2 小时）
- [ ] 注册/登录 Cloudflare，确认套餐免费
- [ ] **先做连通性实测（必须在改 NS 之前完成）**，两段式探测，见 §2.5
- [ ] 依据 §2.5 的判读结论决定是否继续；结论为"停"则回到 §8 的备选方案
- [ ] 把 `muyaya.world` NS 改到 Cloudflare —— **按附录 A 的清单逐步执行**
- [ ] 确认 `muyaya.world` 仍指向 GitHub Pages（A 记录 → `185.199.108.153` 等 4 个 IP，或 CNAME → `xiaobubuya.github.io`）
- [ ] 创建 R2 bucket `album-photos`，**不开启公共访问**
- [ ] 创建 D1 数据库 `album-db`，执行 §3.3 建表
- [ ] `wrangler secret put AUTH_SECRET`（随机 32 字节）
- [ ] `wrangler secret put ALBUM_PASSCODE`
- [ ] Worker 绑定自定义域 `api.muyaya.world`

### Phase 3 · Worker 实现（1 天）
- [ ] 路由骨架 + 中间件链（验签 → 过期 → 限流 → CORS → 路由）
- [ ] `/api/login` 与 `/api/logout`（HMAC 签名 Cookie，§2.4）
- [ ] `/api/photos`（读 manifest，分页 / 按 folder / 按 tag / 按时间 / 关键词）
- [ ] `/api/img/:size/:key`（验签 → 302 到 R2 5 分钟签名 URL）
- [ ] `/api/wishes`、`/api/events`、`/api/favorite`（D1 读写）
- [ ] `/api/upload-url`（presigned PUT）
- [ ] 登录失败限流
- [ ] R2 bucket binding + S3 凭证配置

### Phase 4 · 上传管线（0.5 天）
- [ ] `tools/upload.mjs`（sharp 多档 + hash 去重 + 断点续传 + manifest 生成）
- [ ] 首次批量导入全部婚纱照
- [ ] 抽查：随机 10 张对比原图与 preview 的画质/方向是否正确

### Phase 5 · 前端改造（1 天）
- [ ] 删除所有密钥（§4.2）
- [ ] 替换所有数据源（§4.3）
- [ ] 登录流程接 Worker
- [ ] 图片地址切到 `/api/img/...`
- [ ] 本地联调：登录 → 列表 → 大图 → 幻灯片 → 心愿 → 纪念日
- [ ] 全局 grep 确认无残留：`grep -rniE "token|passwd|password|secret|jsdelivr|raw.githubusercontent" .`

### Phase 6 · 部署与验收（2 小时）
- [ ] 前端推到 GitHub Pages（**让小说站让位**，见 §7）
- [ ] 手机实测（Wi-Fi + 4G，iOS Safari + Android Chrome）
- [ ] 加 `manifest.webmanifest` + Service Worker → 可"添加到主屏幕"，接近原生 App
- [ ] 按 §6 逐条验收

---

## 6. 验收标准

- [ ] 未登录直接调任何 `/api/*`（除 login）→ **401**
- [ ] 未登录时从浏览器拿不到**任何一个**图片 URL
- [ ] R2 bucket 未开公共访问；无签名 URL 时直连 R2 域名 → **403**
- [ ] 签名 URL 过期（>5 分钟）后失效
- [ ] 前端仓库与构建产物中 grep 不到 token / 口令 / 密钥
- [ ] 手机 4G 下首屏 < 3s，滚动 500 张列表不掉帧
- [ ] 增量上传 100 张，已存在的 hash 不重复上传
- [ ] 连续 15 次错误口令 → 被限流（429）
- [ ] iOS Safari 上登录态在关闭标签页后重开仍有效（验证 same-site Cookie 生效）

---

## 7. 域名与仓库的处置

- **`muyaya.world` 一个域名只能指向一个站点**，相册上线的同时小说站必须让位
- 小说内容仍在 `xiaobubuya/xiaobubuya.github.io` 的 git 历史里，**不要 `rm`**；
  建议保留一个 `novels` 分支存档，main 切回相册
- 小说站若还想保留，需要另开仓库 + 另一个子域（例如 `novel.muyaya.world`），与相册互不影响
- `taopengyu/couple-album` 旧副本：确认是否还需要，不需要则归档（Archive），避免以后改错地方
- 若不想让 `/ALBUM-PLAN.md` 被公开访问，部署前从 Pages 目录移出或加入 `.gitignore`

---

## 8. 风险与备选

| 风险 | 影响 | 应对 |
|---|---|---|
| **Cloudflare 在国内访问质量差** | 最高优先级风险，可能推翻整个方案 | §2.5 两段式探测，**在改 NS 之前**完成；判读为"停"则走下方备选 |
| NS 迁移期间解析中断 | 站点短时不可访问 | 迁移前导出全部记录；TTL 提前调低到 300s；选低峰时段操作 |
| 第三方 Cookie 被拦 | 登录态失效 | 已通过"API 挂 `muyaya.world` 子域"规避（§2.3） |
| 前端公开 → API 被扫 | 爆破尝试 | 限流 + 高熵口令 + 签名 Cookie 短过期 |
| HEIC 无法处理 | 部分 iPhone 照片缺失 | `sharp` 直读；失败则用 `sips` 预转换 |
| manifest 过大 | 首屏变慢 | >5000 张时拆分为分片索引或迁 D1 |
| 免费额度超出 | 开始计费 | R2 存储超 10GB 后 $0.015/GB/月（100GB ≈ $1.5/月）；设置用量告警 |
| 照片只有云端一份 | 数据丢失 | **原图必须本地 + 网盘双备份**；R2 只是分发层，不是备份 |

> 费用数据（R2 10GB 免费 / 出站免费、Workers 10 万请求每天、D1 5GB、Access 50 用户内免费）
> 为撰写时的记忆中额度，本次联网核实失败，**开通前请对照 Cloudflare 官网确认一次**。

### 备选方案（若 Cloudflare 国内实测不通）

**阿里云 OSS + CDN + 函数计算**：你已有阿里云账号和域名，大陆节点速度最好。
- 代价：自定义域名需 **ICP 备案**（域名已在阿里云，备案流程可走）
- 架构与本文档基本一致，把 Worker 换成函数计算、R2 换成 OSS、D1 换成表格存储/云数据库即可
- 前端仍可留在 GitHub Pages

---

## 9. 决策记录

### 已定案
1. **架构**：方案 A —— GitHub Pages 公开外壳 + Worker 私有后端
2. **域名**：沿用 `muyaya.world`，不新买域名；前端就用它
3. **NS**：`muyaya.world` NS 从阿里云迁到 Cloudflare（附录 A）—— 方案 A 的硬前提，已确认
4. **小说站**：不要，域名让位给相册。内容保留在 git 历史，不删除
5. **存储**：原图不上云（本地 + 网盘冷备）；云端只放 `thumb` 400w + `preview` 1600w

### 待定（不阻塞 Phase 0/1，可在 Phase 3 前决定）
6. 云端是否需要 `full`（长边 2560px，JPEG）档用于"下载高清原图"？
   默认先不做，脚本留 `--with-full` 开关，日后可增量补传
7. 口令是两人共用一份，还是各自一份？（影响 `login` 的入参形状，共用更省事）
8. `xiaobubuya/image` 仓库中**已经公开过**的照片，是否全部重新上传到 R2、彻底切断旧链接？
   （照片一旦公开，旧 URL 可能已被抓取或缓存，重传是唯一彻底切割方式）

---

## 附录 A · 阿里云 → Cloudflare NS 迁移操作清单

> 目标：把 `muyaya.world` 的权威 DNS 交给 Cloudflare，从而能签发 `api.muyaya.world` 这个 Worker 域名。
> 预计 30 分钟操作 + 生效等待（几分钟到 24 小时，通常 < 1 小时）。免费。**可回滚**。
>
> 为什么不能"只在阿里云加一条解析记录"：Worker 自定义域名要求该 zone 在 Cloudflare 账号内。
> 在阿里云加 `api` CNAME → `xxx.workers.dev` **不通** —— Cloudflare 收到 `Host: api.muyaya.world`
> 时既没有对应 zone 做路由，也签不出该主机名的证书。

### A.0 迁移前确认（阿里云）

- [ ] 确认域名**已实名认证**。未实名的域名不允许修改 DNS 服务器，且会被暂停解析。
      路径：域名列表 → `muyaya.world` → 「管理」→ 基本信息里的实名认证状态
- [ ] 确认域名状态正常（截图显示"正常" ✅）
- [ ] 到期 `2027-03-16`、自动续费已开 ✅（NS 迁移**不影响**续费，仍在阿里云）

### A.1 导出阿里云现有解析记录（最关键，别跳过）

- [ ] 域名列表 → `muyaya.world` 行 → 点「解析」→ 进入云解析 DNS 控制台
- [ ] 逐条抄成表格（类型 / 主机记录 / 记录值 / TTL）。已知至少有：
  - `@` 的 A 记录 → GitHub Pages：`185.199.108.153`、`185.199.109.153`、`185.199.110.153`、`185.199.111.153`
- [ ] 留意可能存在的其他记录：`www`、`_github-pages-challenge-*` 的 TXT（GitHub 域名验证用）、邮箱相关 MX/TXT
- [ ] **截图存档**整个记录列表页；若有「导出区文件」功能一并导出

> 云解析 DNS 的记录**不会**因为改 NS 而丢失。日后回滚，改回 NS 即原样恢复。

### A.2 在 Cloudflare 添加站点

- [ ] 注册/登录 Cloudflare → Add a site → 输入 `muyaya.world` → 选 **Free** 计划
- [ ] Cloudflare 自动扫描现有记录 → **逐条与 A.1 的表格核对**（自动扫描常不完整）
- [ ] 补上缺失的记录，删除多余的记录
- [ ] **关键**：`@` 与 `www` 这两条指向 GitHub Pages 的记录，代理状态设为 **DNS only（灰云）**
      理由：前端本来就是公开内容，不需要 Cloudflare 代理；开橙云反而容易和 GitHub Pages 的
      「Enforce HTTPS」证书验证打架。**灰云 = 直连 GitHub Pages，最省事。**
- [ ] 记下 Cloudflare 分配的两个 NS（形如 `xxx.ns.cloudflare.com`）

### A.3 切换 NS（阿里云）

- [ ] 推荐：先把现有记录 TTL 调小到 **300s**，缩短切换中断窗口（若云解析支持）
- [ ] 域名列表 → `muyaya.world` → 「管理」→ 「DNS 修改」/「修改 DNS 服务器」
- [ ] 填入 A.2 得到的两个 Cloudflare NS，**删除**原有的 `dns1.hichina.com` / `dns2.hichina.com`
- [ ] 确认提交（阿里云会提示"云解析 DNS 将不再为该域名提供服务"，属正常）

### A.4 等待生效与验证

- [ ] Cloudflare 里 zone 状态变为 **Active**
- [ ] `dig +short NS muyaya.world` → 返回 Cloudflare 的 NS
- [ ] `dig +short A muyaya.world` → 仍返回 GitHub Pages 的 4 个 IP
- [ ] 浏览器打开 `https://muyaya.world` → 站点正常
- [ ] GitHub 仓库 Settings → Pages 里自定义域名正常、证书有效（灰云下 GitHub 能正常签发证书）

### A.5 之后才做的事

- [ ] Cloudflare → Workers → 目标 Worker → Settings → Domains & Routes → Add Custom Domain → `api.muyaya.world`
      ⚠️ **不要手动为 `api` 添加 A/CNAME 记录** —— 添加自定义域时 Cloudflare 会自动创建记录并签发证书
- [ ] `dig +short api.muyaya.world` 验证

### A.6 回滚

把阿里云 DNS 服务器改回 `dns1.hichina.com` / `dns2.hichina.com`。
云解析里的记录原样还在，改回后即恢复。**这是本操作低风险的根本原因。**
