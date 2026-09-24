# 上下文总结（给下一个 Agent / 未来的自己）

> 这份是**压缩过的工作记忆**：不是给人读的教程，而是让一个没有历史上下文的
> Agent 能在几分钟内接手的速查。想了解设计动机看 `HANDOFF.md`。

---

## 一句话

两人自用的婚纱照相册：GitHub Pages 前端 + Cloudflare Worker 后端 + Electron 修图 App。
核心功能全部可用，353 项测试全绿，密钥已迁进加密保险箱。

---

## 工作区结构

```
~/lobsterai/project/
├── xiaobubuya-github-io/    前端（公开仓库，GitHub Pages）
├── album-api/               Worker 后端（私有）
└── album-studio/            Electron App（私有）
```

三个必须放在同一父目录 —— `contract.test.mjs` 会跨目录读文件。

---

## 最重要的几条约束

1. **前端仓库是公开的。** 任何写进去的东西都等于公开。密钥、内部地址、
   个人信息都不能进。

2. **改 js/css 必须升 `sw.js` 的 `SHELL` 版本号。** 否则 Service Worker
   会给老客户端返回缓存版本，表现是「本地测好了，线上没反应」。

3. **App 加载的是 `https://muyaya.world`，不是本地文件。**
   因为会话 Cookie 是 `SameSite=Lax`，`file://` 打开会跨站，Cookie 发不出去。

4. **`AUTH_SECRET` 不能随便改。** 它同时是会话签名密钥**和**
   密钥库主密钥的派生源。改了 → 所有人被登出 **且** 所有密钥解不开。

5. **浏览器测试用位置参数。** `node /tmp/dsh-browser.mjs eval <url> <code>`，
   code 必须是单个表达式（包成 `async IIFE`），语句块会静默返回 `undefined`。

---

## 三处 10 分钟缓存（改了密钥必查）

| 层 | 位置 | 清理方式 |
|---|---|---|
| 页面 | `studio.js` 的 `vaultCache` | `Studio.invalidateKeys(p)` |
| 主进程 | `vault-client.js` 的 `cache` | IPC `vault:invalidate` |
| 服务端 | `vault-api.js` 的 Cache API | PUT 时自动清 |

症状：改了密钥发现"没生效" → 先怀疑缓存，不用怀疑代码。

---

## 坐标系（最容易错的地方）

```
鼠标屏幕 y↓ --toImageCoord--> 图片坐标 y↑ --mask.js--> 位图 y↓ --maskStats--> bbox y↑
```

**每一步都必须翻，翻错/漏翻的表现是「AI 改了完全不相干的地方」。**
验证方法：真机涂一笔在画面上方，打印 `maskStats().bbox`，`y0` 应该 > 0.5。

另外：`UNPACK_FLIP_Y_WEBGL` 对 **ImageBitmap** 无效，Y 翻转放在顶点着色器里。

---

## AI 接口速查

全部从**主进程**发（国内厂商不给 CORS 头，网页 fetch 会被拦）。

| 厂商 | 用途 | 关键点 |
|---|---|---|
| 百度 | 人像分割 | `type=labelmap`（**裸 base64**，要补 `data:` 前缀）；token 缓存 30 天 |
| 旷视 | 美颜 | **`v2/beautify`** 不是 v3；apiKey/apiSecret 直接进 form-data，不换 token |
| 火山 | 去物 | `image_urls` 要**公网 URL**；`jimeng_t2i_v40`；异步任务要轮询 |

**火山的坑**：对不认识的字段**不报错、直接忽略**。
`binary_data_base64` 等字段名会"返回成功"但图根本没进去。
→ 必须验输入输出的因果关系（输出尺寸/比例是否跟随输入）。

**去物的完整链路**：
蒙版 → bbox → 上传换公网 URL（`/api/tmp`，10 分钟）→ 主进程 → 火山 → 只取选区那块合成回来。
最后一步很重要：火山会重画整张图（顺手"美化"人脸），只取选区才对。

---

## 测试基线（353 项）

```
autolayout  62   前端几何
upload      20   上传流程
mask        21   蒙版引擎
contract     6   跨仓库契约 ← 改任何接口后必跑
mask-browser      18   真实 Chrome + WebGL
inpaint-browser   13   去物链路（真逻辑 + 假网络）
inpaint（桌面）    20   提示词 + 坐标
smoke（后端）    193   全接口
```

**写测试的重点是测「接缝」不是测「函数」。**
有过一次教训：三层测试全绿，功能完全不能用 ——
因为三层都在测「我以为的接口」，没有一层在测两边约定是否一致
（`window.AlbumStudio` 大写 vs `window.albumStudio` 小写）。

---

## 代码风格约定

- 注释写**为什么**，不写「这行在干什么」。
- 踩过的坑必须在代码注释里留痕，否则会再踩。
- 提交信息写清楚动机和验证方式，中文。
- 改完直接推，不等 review。

---

## 用户的偏好

- 说话简洁，要进度不要客套。
- 改完直接 commit + push。
- 文档跟着代码走，不要单独的 spec 流程。
- 评估方案时要说清楚**取舍和代价**，不要只报喜。
- 会追问"这个方案防住了什么、没防住什么" —— 要如实回答。

---

## 下一步建议（按性价比）

1. **旷视美颜接 UI** ⭐ —— 接口早通了，0.9 秒出结果，
   不用蒙版不用公网 URL。改 `studio.js` + 加一个 IPC 就行。
2. 更多本地修图工具（磨皮/锐化/暗角/曲线/HSL/渐变蒙版）
3. 修图结果回存相册（内容寻址天然支持非破坏性）
4. 火山任务持久化（现在关掉 App 任务就丢）
5. **密钥轮换** —— 之前在对话里贴过明文密钥，建议去控制台换一遍，
   再用 `tools/vault-import.mjs` 重新导入

---

## 已知未验证项

- **Windows 安装包**从没被真人验证过（CI 能出包，但 repo 私有，
  Agent 读不到 Actions 产物，需要用户手动下载试）。
- 旷视美颜的**实际出图效果**没评估过（接口通了，但不是"效果好看"）。
- 火山去物在**真实婚纱照**上的效果只有一次验证（合成测试图上的黑块），
  复杂场景（去掉背景路人、电线杆）没试过。
