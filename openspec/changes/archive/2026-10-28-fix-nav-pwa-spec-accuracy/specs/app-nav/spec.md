## MODIFIED Requirements

### Requirement: 统一的全局导航
系统 SHALL 通过单一 `nav.js` + `nav.css` 提供导航层，桌面（≥900px）顶部顶栏、手机（<900px）底部 tab，二者都渲染到 DOM 并用 CSS 媒体查询切换显示，各页面只引入该脚本而不重复写导航。导航 SHALL 提供 5 个一级入口：照片（`/`）、相册（`/album.html`）、调色（`/photocraft/`）、修图（`/lightcraft/`）、AI 修图（`/ai-agent.html`）；当前所在入口 SHALL 按路径高亮。`href` MUST 带 `.html` 或目录形式（不能用 `/album` 之类的无扩展路径）。

#### Scenario: 桌面顶栏常驻
WHEN 在桌面打开任一页面
THEN 顶部导航常驻显示 5 个一级入口，按当前路径高亮，无需展开菜单。

#### Scenario: 手机底部 tab 常驻
WHEN 在手机上打开任一页面
THEN 底部 tab 常驻显示，当前所在功能有明确高亮。

### Requirement: 页面动作下沉与事件
页面 SHALL 通过声明 `window.AlbumNavPage` 配置导航：`actions` 数组渲染页面级动作，点击以 `nav:action` 事件发到 window 由页面脚本处理；`mode` 支持三态——`full`（默认，品牌 + 5 个 tab + 设置）、`brand`（只显示品牌位，用于分享页）、`none`（完全不渲染）。当页面存在可见的登录层（`#login` 未隐藏）时，导航 SHALL 隐藏（`body.nav-hidden`），登录成功后恢复。

#### Scenario: 页面声明动作被渲染
WHEN 页面声明 `AlbumNavPage.actions`（如「上传」）
THEN 导航层按声明渲染该动作按钮，点击后通过 `nav:action` 事件触达页面处理逻辑。

#### Scenario: 分享页只显示品牌位
WHEN 页面以 `window.AlbumNavPage = { mode: 'brand' }` 启动
THEN 只渲染品牌区，不渲染任何一级 tab，避免误导未登录的亲友。

#### Scenario: 登录层可见时导航隐藏
WHEN 页面显示登录层
THEN 导航被隐藏；登录成功后导航恢复显示。

### Requirement: 沉浸态与导航冲突消解
手机底部 tab SHALL 在沉浸态（大图查看/幻灯片/全屏编辑）中隐藏，避免压在操作栏上；对 `height:100dvh; overflow:hidden` 的页面，导航层 SHALL 通过覆盖 `height: calc(100dvh - 导航高度)` 让内容位于导航之上而非被压住。沉浸态由页面调用 `window.AlbumNav.immersive(true/false)` 切换 `body.nav-immersive`。

#### Scenario: 沉浸态隐藏底部 tab
WHEN 用户进入大图查看器或幻灯片等沉浸态
THEN 底部 tab 隐藏或不与沉浸态操作栏重叠，退出后恢复。

### Requirement: Service Worker 收录导航资源
导航的 `nav.js`/`nav.css` SHALL 被加入 `sw.js` 的 `ASSETS` 外壳缓存清单，否则离线时会出现「在线正常、离线没导航」。

#### Scenario: 离线仍有导航
WHEN 断网后打开缓存的页面外壳
THEN 导航层仍能渲染（nav.js/css 在缓存清单中）。
