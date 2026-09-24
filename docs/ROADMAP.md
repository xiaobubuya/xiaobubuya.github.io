# 执行计划

> 截至 2026-09-23 的状态与后续路线。已完成的部分只列结果，
> 详细动机看 `HANDOFF.md`。

---

## 总路线

```
阶段 1  相册基础（上传 / 排版 / 翻页 / 分享）        ✅ 完成
阶段 2  本地修图（WebGL 调色 + 蒙版）                ✅ 完成
阶段 3  AI 修图（分割 / 去物 / 美颜）                🟡 2/3 完成
阶段 4  密钥保险箱（加密存储 + 下发）                ✅ 完成
阶段 5  体验打磨（更多工具 / 结果回存 / 稳定性）      📋 未开始
```

---

## 阶段 3 · AI 修图（进行中）

| 能力 | 厂商 | 接口 | UI | 备注 |
|---|---|---|---|---|
| 人像分割 | 百度 | ✅ | ✅ | 925ms，抠出人像当蒙版 |
| 去物 | 火山即梦 | ✅ | ✅ | 16~22s，需蒙版 |
| 美颜 | 旷视 | ✅ | ❌ | 925ms，**下一步就做这个** |

### 3.1 旷视美颜接 UI ⭐ 下一个任务

**为什么优先**：接口早就调通了，而且这条链路最简单 ——
不用蒙版、不用公网 URL、不用等 20 秒。

**要做的事**：

1. `album-studio/electron/ai-megvii.js`（新建）
   - 表单直传 `apiKey` / `apiSecret`，**不换 token**
   - 端点是 `/facepp/v2/beautify`（**不是 v3**，v3 返回 `API_NOT_FOUND`）
   - 参数（0~100）：`whitening` `smoothing` `thinface` `enlarge_eye`
     `shrink_face` `remove_acne` `remove_eyebrow` `remove_eyebag`
     `remove_wrinkle` `filter_type`
   - 返回 `{ result: "<base64 JPEG>" }`

2. `main.js` 加 IPC `ai:beautify`
   - 密钥走保险箱：`await vault.get('megvii')`
   - 传 base64 进、base64 出，和 `ai:bodySeg` 保持同一套形状

3. `preload.js` 暴露 `megviiBeautify(b64, params)`

4. `studio.js` 加美颜面板（一组滑块 + 应用按钮）

5. `test/` 加测试 + 更新 `contract.test.mjs`（provider 名要对得上）

**注意**：旷视免费额度**并发约 1**，连续调用要串行 + 加延时，
否则报 `CONCURRENCY_LIMIT_EXCEEDED`（403）。
（这个错误码容易被误读成"功能没开通"。）

---

## 阶段 5 · 体验打磨

### 5.1 更多本地修图工具

按实现难度排序，建议这个顺序：

| 工具 | 难度 | 说明 |
|---|---|---|
| 锐化 / 暗角 / 颗粒 | 低 | 纯 shader，加几个 uniform 就行 |
| 曲线 | 中 | 需要 LUT 或分段函数 |
| HSL | 中 | 分通道调整，shader 里做 |
| 裁剪 / 旋转 | 中 | 几何变换，要改 canvas 逻辑 |
| 液化 | 高 | 需要网格变形，可能要独立 shader pass |
| 透视校正 | 高 | 同上 |

### 5.2 局部调整增强

现在只有画笔蒙版。常见需求还缺：
- **渐变蒙版**（线性渐变，做天空/地面过渡最常用）
- **径向蒙版**（椭圆，做人像提亮）

两者都可以复用现有蒙版引擎：只是换个方式往位图里填内容。

### 5.3 修图结果回存相册

现在导出只存本地文件。加「存回相册」的话：
- 内容寻址天然支持非破坏性 —— 改完的图是新 key，原图还在
- 但要想清楚：改完的图算不算"一张新照片"？会不会污染时间线？
  （建议：存成原照片的一个变体，时间线上不单独出现）

### 5.4 火山任务持久化

现在即梦是同步等待（轮询到出图）。关掉 App 任务就丢。

要更稳的话：D1 加一张任务表，记 `task_id` + 状态，
重开 App 还能取回结果。火山的签名 URL 有效期 24 小时，够用。

---

## 阶段 6 · 安全与运维

### 6.1 密钥轮换（建议尽快）

之前在对话里**以明文贴过**这些密钥：
- 百度 4 个值（3 个 app 的 apiKey/secretKey）
- 旷视 apiKey / apiSecret
- 火山 API Key Secret
- ImageX token

建议去各家控制台轮换一遍，然后：

```bash
cd album-studio
API_PASS=你的口令 node tools/vault-import.mjs
```

脚本会打印指纹，可以和服务端的对比确认换成功了。

### 6.2 会话安全

- 现在会话 Cookie 有效期 30 天，没有刷新机制
- 没有「登出所有设备」的入口
- 如果要在意，可以加一个 session 版本号，改密码时让所有旧会话失效

### 6.3 备份

- D1 有自动备份（Cloudflare 侧）
- R2 的图片**没有备份**。婚纱照是唯一副本的话，建议配一份
  （R2 到另一处，或者定期拉到本地）
- 三个仓库都在 GitHub，算是有异地副本

---

## 明确不做的事

| 事项 | 原因 |
|---|---|
| 安卓 App | 手机上只**看**，不修图。看图用 PWA 就够了 |
| 用户注册 / 多租户 | 就两个人用 |
| 代码签名证书 | 个人自用，Apple 开发者计划 $99/年不值；一次性 `xattr` 能解决 |
| 图片存原图 | 只存 thumb(400w) + preview(1600w)，省空间也够用。修图在 preview 档上做 |
| 换成自建服务器 | Cloudflare 免费额度完全够，运维成本为零 |

---

## 快速验证清单（改完代码后跑）

```bash
# 1. 后端
cd album-api && node test/smoke.mjs                    # 193 项

# 2. 跨仓库契约（改接口必跑）
cd ../xiaobubuya-github-io && node test/contract.test.mjs   # 6 项

# 3. 前端单元
for f in autolayout upload mask; do node test/$f.test.mjs; done   # 103 项

# 4. 桌面
cd ../album-studio && node test/inpaint.test.js        # 20 项

# 5. AI 接口还通不通（真实调用，会产生少量费用）
node tools/ai-probe.mjs

# 6. App 端到端（真实调用火山）
ALBUM_URL=https://muyaya.world/studio.html \
ALBUM_SMOKE_AI=inpaint ALBUM_SMOKE_USER=yuge ALBUM_SMOKE_PASS=你的口令 \
  npx electron . --user-data-dir=/tmp/albumstudio-test
```

浏览器测试见 `HANDOFF.md` 第八节。
