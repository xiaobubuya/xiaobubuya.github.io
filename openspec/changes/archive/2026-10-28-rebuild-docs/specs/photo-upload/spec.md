## Purpose

提供在浏览器端把手机照片上传进相册系统的能力：读取文件 → 按内容寻址生成 key → 浏览器端派生缩略图/预览图 → 直传后端 → 登记元数据，并支持去重、进度显示与断点续传。

## ADDED Requirements

### Requirement: 浏览器端生成派生图
系统 SHALL 在浏览器端完成图片解码与派生：读取原文件后按 EXIF 自动旋转，生成 `thumb`（长边 400px WebP）与 `preview`（长边 1600px WebP）两档，实现采用 `createImageBitmap` + `OffscreenCanvas` 缩放 + `convertToBlob({type:'image/webp'})`，不依赖服务端算力。

#### Scenario: 手机选图上传
WHEN 用户在手机相册选择若干张照片发起上传
THEN 逐张在浏览器端解码并派生两档图片，随后开始直传，上传完成后新照片立即出现在时间线。

#### Scenario: HEIC 无法解码兜底
WHEN 浏览器无法解码所选格式（典型：桌面 Chrome/部分安卓打开 iPhone 的 HEIC）
THEN 系统只上传原图并标记派生图待补（`derivativesPending`），该照片在时间线显示占位与「处理中」角标，由本地脚本或定时任务补生成。

### Requirement: 内容寻址去重
系统 SHALL 在上传前计算 `sha256(原图)` 的十六进制前缀作为内容 key，后端按该 key 幂等 upsert；已存在 key 的照片整张跳过，不重复占用存储。

#### Scenario: 重复上传被跳过
WHEN 用户再次上传一张之前已上传过的照片
THEN 系统识别到相同内容 key 而跳过本张，不产生重复存储，仍报告上传完成。

### Requirement: 进度与单张重试
系统 SHALL 在面板中逐张显示状态（等待 / 上传中 x% / 完成 / 失败），失败的单张可单独重试，且不影响其他张。

#### Scenario: 单张失败可单独重试
WHEN 某张照片上传失败
THEN 该张标记为失败并允许单独重试，其余照片不受影响。

### Requirement: 断点续传
上传队列 SHALL 持久化到 IndexedDB，页面中途关闭后重新打开可从断点继续未完成部分，不重复重传已完成内容。

#### Scenario: 中断后恢复
WHEN 用户在批量上传过程中关闭页面
THEN 重新打开站点后上传队列从上次未完成的位置继续，界面不卡死。

### Requirement: 并发限制
系统 SHALL 限制最多 3 张并行上传，避免占满上行带宽把界面拖死。桌面端也支持把文件/文件夹拖入页面任意位置，且走同一套上传链路；非图片文件 SHALL 被过滤，单张超大（>100MB）SHALL 被拒绝并提示。

#### Scenario: 桌面拖拽上传
WHEN 用户在桌面上把多个文件拖入页面
THEN 整页高亮提示，文件经同一套浏览器端派生与直传链路完成上传，且仍受并发上限约束。

#### Scenario: 超大文件被拒绝
WHEN 用户尝试上传超过 100MB 的单张
THEN 系统拒绝并提示，不占用上行带宽过久。
