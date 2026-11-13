# AI 姿势参考图库（ai-pose-gallery-zh）部署方案

> 仓库：`git@github.com:anhao/ai-pose-gallery-zh.git`（公开）
> 状态：已 clone 代码部分到 `/root/repos/ai-pose-gallery-zh`，**图片未拉**（662MB）
> 计划：备案通过（muyaya.world 恢复解析）后部署，并嵌入主站

## 项目构成

| 部分 | 内容 | 体积 |
|---|---|---|
| 前端 | `index.html`（单页，零依赖）、内联 CSS/JS | 58 KB |
| 数据 | `data/pose-zh.json`（1439 条，含 `缩略图`/`原图` 相对路径） | 555 KB |
| 缩略图 | `thumbs/*.jpg`（300×400） | 约 100 MB |
| 原图 | `img/*.png`（900×1200） | 约 560 MB |

数据记录字段：`id / 体系 / 姿势编号 / 分类 / 姿势名称 / 角度 / 缩略图 / 原图 / 检索`

## 三个部署方案

### 方案 A：完整部署（图片落地）
- 拉全 662MB 图片 → 部署到 `muyaya.world/pose/`
- 优点：完全独立，不依赖原站
- 缺点：按本机 1~2MB/分钟，拉取需 **5~10 小时**

### 方案 B：代码部署 + 图片外链（推荐，最快）
- 只部署 8.5MB 代码；把 `pose-zh.json` 里 `缩略图`/`原图` 前缀改为
  `https://ai-pose-gallery.anhao.app/`（原作者站点）
- 优点：备案后当天可达；缺点：依赖原站可用性（原站挂了图就没了）

### 方案 C：图片走 jsDelivr CDN
- 图片前缀改为 `https://cdn.jsdelivr.net/gh/anhao/ai-pose-gallery-zh@main/`
- 优点：CDN 快；缺点：jsDelivr 对大仓库/大文件有限制，需实测

## 部署目标（已定）

**子域名：`pose.muyaya.world`**

- DNS：`pose` **A 记录 → 120.48.86.101**（本服务器）
- 站点根目录：`/var/www/pose/`（代码 + `thumbs/` + `img/` 全量，约 662MB）
- 备案：子域名默认继承主域名 `muyaya.world` 的备案号，无需单独备案
- 备案期间**先不配 nginx / 不解析**，避免空壳站点触发核查

### nginx 配置（备案通过后再启用）

```nginx
server {
    listen 80;
    server_name pose.muyaya.world;
    root /var/www/pose;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
    location ~* \.(jpg|jpeg|png|webp)$ {
        expires 30d;
        add_header Cache-Control "public, max-age=2592000";
    }
    add_header X-Content-Type-Options nosniff;
}
```

启用后跑 `certbot --nginx -d pose.muyaya.world` 签证书（主域已有 Let's Encrypt 流程）。

## 嵌入主站

- **iframe 嵌入**（推荐，体验最完整）：
  ```html
  <iframe src="https://pose.muyaya.world/"
          style="width:100%;height:calc(100vh - 120px);border:0"
          loading="lazy" referrerpolicy="no-referrer-when-downgrade"
          allow="clipboard-write"></iframe>
  ```
- 或主站导航加卡片入口（新窗口打开），避免 iframe 内 `←/→/↑/↓/Esc` 键盘事件冲突
  （该画廊的键盘导航在 iframe 内聚焦时才生效，一般无碍）

## 备案前可做的事

1. 本地跑通：`python3 -m http.server` + 打开 `index.html`（需 `data/pose-zh.json` 可访问）
2. 决定方案（A/B/C）
3. 准备图片拉取脚本（方案 A 时用 `git checkout` 分批拉 `thumbs/` 再 `img/`）

## 注意

- 该项目含人体姿势参考图，**备案备注/页面内容需注意合规表述**，避免被判定为敏感内容。
- `index.html` 里 canonical / og / sitemap 都指向 `https://ai-pose-gallery.anhao.app/`，
  部署到自有域名后需要同步替换，否则 SEO 指向原站。
