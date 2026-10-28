## ADDED Requirements

### Requirement: 浏览器端派生两档图
系统 SHALL 在浏览器端完成图片解码与派生：用 `createImageBitmap(file, {imageOrientation:'from-image'})` 解码并按 EXIF 方向转正，生成 `thumb`（长边 400px、WebP 质量 0.75）与 `preview`（长边 1600px、WebP 质量 0.80）两档；派生优先用 `OffscreenCanvas`，不支持时回退到普通 `<canvas>`，均以 `image/webp` 编码。整个过程不依赖服务端算力。

#### Scenario: 手机选图上传
WHEN 用户在手机相册选择若干张照片发起上传
THEN 逐张在浏览器端解码并派生两档（400/q0.75 与 1600/q0.80），随后直传两档字节并登记元数据，新照片出现在时间线。

#### Scenario: 浏览器无法解码该格式
WHEN 浏览器无法解码所选格式（典型：桌面 Chrome / 部分安卓打开 iPhone 的 HEIC）
THEN 该张上传 SHALL 失败并提示「此浏览器无法解码该格式（HEIC 请用手机上传或本地脚本）」，由用户重试或改用其它入口；系统当前 SHALL NOT 上传原图并标记待补（未实现）。

### Requirement: 内容寻址去重（本地已加载集合）
系统 SHALL 在上传前计算 `sha256(原图)` 的前 16 位十六进制作为内容 key；若该 key 已在当前已加载的时间线 key 集合（`knownKeys`）中，SHALL 整张跳过并标记「已存在」，不重复上传与登记。

#### Scenario: 重复上传被跳过
WHEN 用户再次上传一张当前时间线里已有的照片
THEN 系统识别到相同内容 key 而跳过本张，面板标记「已存在」，不产生重复存储。

### Requirement: 上传状态与单张重试
系统 SHALL 在面板中逐张显示状态（等待 / 计算 / 解码 / 派生 / 上传 / 登记 / 完成 / 已存在 / 失败），显示总体进度条与汇总（成功、已存在、失败张数）；失败的单张 SHALL 可单独重试，且不影响其他张。

#### Scenario: 单张失败可单独重试
WHEN 某张照片上传失败
THEN 该张标记为失败并给出「重试」按钮，重试只处理该张，其余照片不受影响。

### Requirement: 并发与文件过滤
系统 SHALL 限制最多 3 张并行上传（`CONCURRENCY=3`），避免占满上行带宽把界面拖死。文件选择 SHALL 过滤非图片文件（MIME 为图片或扩展名匹配 jpg/jpeg/png/webp/heic/heif）。系统当前 SHALL NOT 实现页面拖拽上传、文件夹递归导入或单张大小上限拦截（均未实现）。

#### Scenario: 并发不超过 3
WHEN 用户一次选择多于 3 张照片
THEN 同时处于上传中的任务不超过 3 个，其余排队等待。

#### Scenario: 非图片文件被过滤
WHEN 用户选中的文件不是图片
THEN 该文件被过滤，不进入上传队列。

## REMOVED Requirements

### Requirement: 浏览器端生成派生图
**Reason**: 原 spec 描述 HEIC 无法解码时「只上传原图并标记待补」，实际实现是直接失败并提示用手机或本地脚本，从未上传原图。
**Migration**: 无代码迁移；由新增的「浏览器端派生两档图」替代。

### Requirement: 内容寻址去重
**Reason**: 去重依据是前端已加载时间线的 key 集合，而非依赖后端整表判断；原描述不准确。
**Migration**: 无代码迁移；由新增的「内容寻址去重（本地已加载集合）」替代。

### Requirement: 进度与单张重试
**Reason**: 状态机比原文更细（计算/解码/派生/上传/登记），需按真实状态描述。
**Migration**: 无代码迁移；由新增的「上传状态与单张重试」替代。

### Requirement: 断点续传
**Reason**: 当前实现没有把上传队列持久化到 IndexedDB，页面关闭后队列即丢失。
**Migration**: 无（该能力从未实现）。

### Requirement: 并发限制
**Reason**: 原 spec 声称支持桌面拖拽/文件夹导入与 100MB 上限，实际均未实现。
**Migration**: 无代码迁移；由新增的「并发与文件过滤」替代。
