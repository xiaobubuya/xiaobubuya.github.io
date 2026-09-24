# 婚纱照相册 · 项目交接文档

> 写于 2026-09-23，为「换一台电脑继续开发」准备的完整上下文。
> 读完这一份应该能直接上手，不需要再翻聊天记录。

---

## 一、这是什么

一个两人用的私人婚纱照相册：上传照片 → 自由排版成可翻页的相册 → 分享给家人看 → 在桌面 App 里修图（含 AI 修图）。

**不是**通用产品，就两个人用（yuge / meimei）。所有取舍都按「两人自用」来定：
不做注册流程、不做多租户、不做权限体系、不追求高可用。

---

## 二、架构

```
                    muyaya.world（GitHub Pages，静态）
                    ├── index.html      时间线 / 登录 / 大图浏览 / 幻灯片
                    ├── album.html      相册列表 + 自由排版编辑器 + 翻页阅读
                    ├── share.html      分享页（只读，凭 token）
                    └── studio.html     修图（WebGL 调色 + 蒙版 + AI）
                              │
                              │ fetch（带 httpOnly Cookie）
                              ▼
                    api.muyaya.world（Cloudflare Worker）
                    ├── /api/login         登录（HMAC 签名的会话 Cookie，30 天）
                    ├── /api/photos        照片元数据（D1）
                    ├── /api/blob/:size/:key  上传字节（R2）
                    ├── /api/img/:size/:key   读图（鉴权 + 边缘缓存）
                    ├── /api/albums        相册 + 页面排版（D1）
                    ├── /api/share/:token  分享（免登录、只读、永久）
                    ├── /api/tmp/:token    临时上传（给火山当公网中转，10 分钟）
                    └── /api/vault/:provider  密钥保险箱（加密存储，10 分钟缓存）
                              │
                              ▼
                    D1（元数据/相册/密钥） + R2（图片字节）
```

### 三个仓库

| 仓库 | 可见性 | 内容 |
|---|---|---|
| `xiaobubuya/xiaobubuya.github.io` | 公开 | 前端（GitHub Pages） |
| `xiaobubuya/album-api` | 私有 | Worker 后端 |
| `xiaobubuya/album-studio` | 私有 | Electron 桌面 App + CI 构建 |

> ⚠️ 前端仓库是**公开**的，所以任何东西写进它都等于公开。
> 密钥永远不能出现在前端代码里 —— 这是保险箱存在的原因之一。

### 关键常量

```
Cloudflare 账号   424102378@qq.com
Account ID       0a14ec116b0f68d22849e89b56ed0f6f
D1 数据库         album-db   08205b0e-806d-42a5-8010-320f825f85fe
R2 桶            album-photos
Worker 名称       album-api
DNS 托管          Cloudflare（alan/teagan.ns.cloudflare.com）
```

`muyaya.world` 是指向 GitHub Pages 的 A 记录（185.199.108~111.153，**灰云 / DNS only**）。
`api.muyaya.world` 是 Worker 的自定义域名（**橙云**，Cloudflare 自动签证书）。
> ⚠️ 不要手动给 api 加 DNS 记录，加了反而会挡住自动创建。

---

## 三、怎么跑起来

### 换新电脑后的第一步

```bash
git clone git@github.com:xiaobubuya/xiaobubuya.github.io.git
git clone git@github.com:xiaobubuya/album-api.git
git clone git@github.com:xiaobubuya/album-studio.git
```

三个仓库都要放在同一个父目录下（`contract.test.mjs` 会跨目录读文件）。

### 前端

静态文件，直接 `python3 -m http.server` 就能本地看。
部署 = push 到 main（GitHub Pages 自动构建，约 30~60 秒生效）。

> ⚠️ 改完 js/css 记得升 `sw.js` 里的 `SHELL` 版本号，否则老客户端拿不到新文件。
> 表现是「本地测好了，线上用起来没反应」。

### 后端

```bash
cd album-api
npm install
npx wrangler dev          # 本地（D1/R2 走本地模拟）
npx wrangler deploy       # 部署
```

需要预先设置的 Secret（**不在代码里**）：

```bash
npx wrangler secret put AUTH_SECRET     # 会话签名 + 密钥库主密钥派生，改了会让所有密钥解不开
npx wrangler secret put USERS           # JSON: {"yuge":"...","meimei":"..."}
```

改 schema 后要同步到线上：

```bash
npx wrangler d1 execute album-db --remote --file=schema.sql
```

### 桌面 App

```bash
cd album-studio
npm install
npm start                 # 开发运行
npm run dist:mac          # 打包（macOS）
npm run dist:win          # 打包（Windows）
```

> **不需要配任何密钥文件**。密钥从保险箱接口取（见第六节）。
> App 加载的是 `https://muyaya.world`（不是本地文件）——
> 因为会话 Cookie 是 `SameSite=Lax`，从 `file://` 打开会跨站，Cookie 发不出去。

CI：打 `v*` 标签会触发 GitHub Actions 构建 Windows + macOS 安装包。

---

## 四、进度：已完成什么

### 阶段 1 · 相册基础 ✅

- 登录（HMAC 签名 Cookie，30 天，带失败限流）
- 上传（内容寻址，key = `sha256(原图).slice(0,16)`；只存 thumb 400w + preview 1600w，**不存原图**）
- 时间线浏览、大图查看、幻灯片
- 自由排版编辑器（拖拽、缩放、旋转、层级）
- 自动排版引擎（`autolayout.js`，纯几何，62 项测试）
- 翻页阅读器（`reader.js`，滑动翻页，编辑器与分享页共用）
- 移动端横屏查看（`orient.js`）
- 分享链接（永久有效、只读、`?t=<32位hex>`）

### 阶段 2 · 修图（本地） ✅

- WebGL 实时调色：曝光 / 对比度 / 高光 / 阴影 / 饱和度 / 色温
  - 曝光、高光、阴影在**线性空间**算；对比度、饱和度在 sRGB 空间
  - 单趟 fragment shader，拖滑块只更新 uniform，60fps
- 蒙版引擎（`mask.js`）：矢量描边 + 撤销 + 反选 + 从位图导入
- 局部调整（蒙版控制调整范围，线性空间混合）
- 导出（原分辨率重绘，`原名-edit.jpg`）

### 阶段 3 · AI 修图 ✅（接口全通）

| 能力 | 厂商 | 状态 | 实测耗时 |
|---|---|---|---|
| 人像分割 | 百度 | ✅ 已接 UI | 925ms |
| 去物 / 生成式重绘 | 火山即梦 | ✅ 已接 UI | 16~22s |
| 美颜 | 旷视 | ⚠️ 接口通了，**UI 没接** | 925ms |

### 阶段 4 · 密钥保险箱 ✅

- 密钥加密存 D1，客户端按需取，10 分钟缓存
- 本地 `.secrets/` 已删除

---

## 五、还没做的（按建议优先级）

### 1. 旷视美颜接 UI ⭐ 建议先做

接口早就调通了（`v2/beautify`，参数见 `docs/AI-API-NOTES.md`），
只是还没接界面。**性价比最高的一项** ——
不用蒙版、不用公网 URL、不用等 20 秒，0.9 秒出结果。

参数：`whitening` `smoothing` `thinface` `enlarge_eye` `shrink_face`
`remove_acne` `remove_eyebrow` `remove_eyebag` `remove_wrinkle` `filter_type`（0~100）

### 2. 更多本地修图工具

- 磨皮 / 锐化 / 暗角
- 曲线 / HSL
- 液化 / 裁剪 / 透视校正
- 局部调整的**渐变蒙版**和**径向蒙版**（现在只有画笔）

### 3. 修图结果回存相册

现在导出是存到本地文件。可以加「存回相册」——
内容寻址天然支持非破坏性：改完的图是新 key，原图还在。

### 4. 火山异步任务的持久化

现在即梦是同步等待（轮询直到出图）。如果关掉 App，任务就丢了。
要做得更稳的话需要一张任务表记录 `task_id`，重开 App 还能取回结果。

### 5. 密钥定期轮换

你之前在对话里贴过明文密钥，建议在厂商控制台轮换一遍，
然后用 `tools/vault-import.mjs` 重新导入。

---

## 六、密钥保险箱（重要，必读）

### 怎么用

```bash
cd album-studio
API_PASS=你的口令 node tools/vault-import.mjs          # 导入
API_PASS=你的口令 node tools/vault-import.mjs --dry    # 只看会传什么
```

脚本**从不打印密钥内容**，只打印字段名、长度、指纹。

### 加密方案

```
明文密钥
   │ ① AES-256-GCM，用每条记录独立的 DEK
   ▼
密文 ──┐
       ├─→ D1 一行
被 KEK 包起来的 DEK ─┘
       ▲
       │ KEK = HKDF(AUTH_SECRET, salt 存在 D1)
```

选 GCM 是因为它自带完整性校验：密文被改过会直接解密失败，
而不是解出一段垃圾再拿去调接口、报一个看不懂的错。

### ⚠️ 它防住什么、没防住什么

**防住**：仓库/代码泄露、电脑上的残留文件、日志截图带出密钥。

**没防住**：拿到 D1 读权限的人 —— 密文和 salt 在同一个库里。
掺 `AUTH_SECRET` 是为了把「单点泄露」变成「得同时拿到数据库和 Worker 环境变量」，
但这不是彻底解决。

真要抗数据库泄露，得再加一个只存在密码管理器里的口令，
每次取密钥输一次 —— 对两人用的相册不值得。

### 客户端链路（有点绕）

```
页面 fetch /api/vault/:p   ← 它有 Cookie（httpOnly，主进程读不到）
    │ 明文密钥
    ▼
prime 给主进程 → 主进程内存缓存 10 分钟 → 调厂商接口
```

密钥会经过渲染进程。这没问题（页面本来就要传图出去），
但意味着**页面被 XSS 的话密钥会泄露** ——
所以页面上不能引任何第三方脚本。当前只用自己仓库的 js，没有 CDN 依赖。

### ⚠️ 改了密钥要清三处缓存

页面 / 主进程 / 服务端各有一份 10 分钟缓存。
接口 PUT 时会自动清服务端那份，但清不到客户端。

`studio.js` 里有 `invalidateKeys(provider)` 可以清两边。
不改密钥就不用管；改了发现"没生效"，先怀疑缓存。

---

## 七、踩过的坑（别再踩一遍）

### 坐标朝向：翻了三次才对

完整链路（每一步都必须）：

```
鼠标屏幕 y↓
  │ toImageCoord: 1 - y/h
  ▼
图片坐标 y↑
  │ mask.js: (1 - y) * h
  ▼
蒙版位图 y↓（canvas 坐标）
  │ maskStats: 1 - y/h
  ▼
bbox y↑（交给 AI 描述方位）
```

`mask.js` 只能用 canvas 坐标画，而方位词要 y 向上，所以必须来回翻。
翻错/漏翻的表现是「AI 去改了完全不相干的地方」，
成品"就是不对劲"但完全看不出问题在哪。要靠真机涂一笔、打印 bbox 对比才查得出来。

### `UNPACK_FLIP_Y_WEBGL` 对 ImageBitmap 无效

这个 Chrome/SwiftShader 组合下，`texImage2D` 收到 **ImageBitmap** 时
不管 `UNPACK_FLIP_Y_WEBGL` 设 true 还是 false，纹理都是倒的
（同一个 canvas 源设 true 就正常）。

症状：**整张预览上下颠倒**。之前一直没发现，因为测试图都是纯色或对称的。

修法：翻 Y 放到顶点着色器里，不依赖那个标志。

### 尺寸不匹配的字段名错配

`IPC` 回 `maskPng`，页面读 `mask` —— 不报错，只是静默什么都不做。
标成「点了没反应」的都是这类。现在两边都给，并有契约测试盯着。

### 大小写：`window.AlbumStudio` vs `window.albumStudio`

JS 里是两个完全不同的变量。preload 暴露大写，页面读小写，
导致 **AI 功能在真实 App 里从来没工作过**。

三层测试全绿却没发现，因为：
- 单元/浏览器测试用假的桩件（我自己按页面代码写的）
- App 冒烟直接用大写名调 IPC，绕过了页面

**三层都在测「我以为的接口」，没有一层在测「两边的约定是否一致」。**
所以加了 `test/contract.test.mjs` 专门做静态比对。

### 羽化渐变只算一次 → 一条线只剩两个端点

`createRadialGradient` 建好就固定在画布坐标上。
沿路径盖章时只算一次 `fillStyle` 的话，除了起点附近，其余章都落在渐变半径外，全是透明的。

### `getCoalescedEvents()` 可能返回空数组

合成事件（自动化测试）就是空数组。直接遍历的话循环体一次都不执行，
表现是「拖一整条线只画出落笔那一个点」。要加空数组回退。

### 其它

- **`session` 上的用户名字段是 `u` 不是 `user`**。取错得到 `undefined`，
  而 `node:sqlite` 对 `undefined` 是直接抛的（`null` 才接受）。
- **百度 `labelmap` 是裸 base64**，不带 `data:` 前缀，直接塞 `Image.src` 加载不出来且不报错。
- **火山的 base64 字段名会被静默忽略**。`binary_data_base64` 等三个字段名都"返回成功"，
  但图根本没进去（输出尺寸对不上才发现）。它对不认识的字段不报错，直接忽略。
  → **「返回 200 + 有 task_id + 出图了」不能证明参数生效**，要验输入输出的因果关系。
- **旷视美颜是 `v2/beautify` 不是 `v3`**（v3 返回 `API_NOT_FOUND`）。
- **文件扩展名不可信**：相册 preview 是 WebP 但存成了 `.jpg`，旷视直接报格式错。
- **TOML**：`[table]` / `[[array]]` 之后的裸键值对属于那张表。`routes` 被这个坑过两次。
- **Electron 44.4.4** 的 registry 元数据没有 `scripts` 字段，`npm ci` 不会下载二进制，
  所以有 `scripts/ensure-electron.js` 这个 postinstall。
- **macOS 未签名** → 报「已损坏」。需要 `xattr -cr /Applications/AlbumStudio.app`。
  已配置 `mac.identity = "-"`（ad-hoc 签名）解决大部分情况。
- **Windows 安装包**：repo 是私有的，Agent 读不到 Actions 产物，需要你手动下载验证。

---

## 八、测试怎么跑

```bash
# 前端（在 xiaobubuya-github-io/）
node test/autolayout.test.mjs      # 62 项 · 自动排版几何
node test/upload.test.mjs          # 20 项 · 上传流程
node test/mask.test.mjs            # 21 项 · 蒙版引擎
node test/contract.test.mjs        #  6 项 · 跨仓库契约（改接口后必跑）

# 浏览器测试（需要 CDP harness，见下）
STUDIO_URL=http://127.0.0.1:8899/studio.html node test/mask-browser.test.mjs      # 18 项
STUDIO_URL=http://127.0.0.1:8899/studio.html node test/inpaint-browser.test.mjs   # 13 项

# 桌面（在 album-studio/）
node test/inpaint.test.js          # 20 项 · 提示词生成 + 坐标

# 后端（在 album-api/）
node test/smoke.mjs                # 193 项 · 全接口
```

### 浏览器测试怎么跑

需要在 `/tmp/dsh-browser.mjs` 有一个 CDP harness（用无头 Chrome 驱动）：

```bash
# 1. 起本地静态服务
cd xiaobubuya-github-io && python3 -m http.server 8899 --bind 127.0.0.1 &

# 2. 跑测试
STUDIO_URL=http://127.0.0.1:8899/studio.html node test/mask-browser.test.mjs
```

harness 需要 `/tmp/session.txt` 存登录 Cookie，启动 Chrome 时加
`--headless=new --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`
（无头环境没 GPU，WebGL 要软件渲染）。

> ⚠️ harness 的参数是**位置参数**：`eval <url> <code>`，code 必须紧跟 url。
> 而且 `Runtime.evaluate` 只接受**单个表达式** ——
> 语句块会静默返回 `undefined`，所以统一包成 `async IIFE`。

### 当前测试基线

```
autolayout 62 · upload 20 · mask 21 · contract 6       = 109
mask-browser 18 · inpaint-browser 13                    =  31
inpaint（桌面）20                                        =  20
smoke（后端）193                                         = 193
                                                合计    353
```

---

## 九、文档索引

| 文档 | 位置 | 内容 |
|---|---|---|
| **本文档** | `xiaobubuya.github.io/docs/HANDOFF.md` | 总览 + 交接 |
| AI 接口笔记 | `album-studio/docs/AI-API-NOTES.md` | 三家厂商的**实测**调用方式、参数、坑 |
| 前端说明 | `xiaobubuya.github.io/README.md` | 前端结构 |
| 后端说明 | `album-api/README.md` | API 路由 |
| App 说明 | `album-studio/README.md` | 构建、打包、签名 |

### 有用的工具

| 工具 | 位置 | 用途 |
|---|---|---|
| `tools/ai-probe.mjs` | album-studio | 一条命令验证三家 AI 接口还通不通 |
| `tools/vault-import.mjs` | album-studio | 导入密钥到保险箱 |
| `tools/import.mjs` | album-api | 批量导入照片 |

---

## 十、开发约定

- **提交信息写清楚「为什么」**，不只是「改了什么」。
  踩过的坑要写进注释或文档，否则下一个人（或三个月后的你）会再踩一遍。
- **新功能配测试**。特别注意测**接缝**（跨仓库的约定），
  而不只是测自己写的那个函数 —— 上面那个大小写 bug 就是这么漏掉的。
- **改完直接推**，不需要等 review。
- **密钥永不进 git**，也永不进前端仓库（前端仓库是公开的）。
- 注释用中文，代码里解释「为什么这么做」而不是「这行在干什么」。

---

## 十一、当前状态速查

```
✅ 能用：上传、相册排版、翻页阅读、分享、WebGL 调色、
        蒙版局部调整、AI 抠人、AI 去物、导出
⚠️ 接口通但没 UI：旷视美颜
📋 没做：更多修图工具、修图结果回存、火山任务持久化
🔑 密钥：已全部迁到保险箱，本地文件已删
🧪 测试：353 项全绿
```
