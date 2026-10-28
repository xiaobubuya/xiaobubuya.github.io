## Purpose

提供整个站点的统一导航层，解决「相册/修图藏得太深、切功能丢上下文」的问题：桌面/平板用顶部顶栏分段控件，手机用底部 tab，让三个核心功能（照片 / 相册 / 修图）从任何页面一级可达，导航收敛成一份 `nav.js`/`nav.css` 而非各页重复实现。

## ADDED Requirements

### Requirement: 统一的全局导航
系统 SHALL 通过单一 `nav.js` + `nav.css` 提供导航层，桌面（≥900px）顶部顶栏、手机（<900px）底部 tab，二者都渲染到 DOM 并用 CSS 媒体查询切换显示。各页面只引入该脚本，不在页面内重复写导航。三个核心功能入口（照片 / 相册 / 修图）一级可达。

#### Scenario: 桌面顶栏常驻
WHEN 在桌面打开任一页面
THEN 顶部导航常驻显示，照片 / 相册 / 修图三个入口一级可达，无需展开菜单。

#### Scenario: 手机底部 tab 常驻
WHEN 在手机上打开任一页面
THEN 底部 tab 常驻显示，当前所在功能有明确高亮。

### Requirement: 页面动作下沉与事件
页面 SHALL 通过声明 `window.AlbumNavPage`（含 `actions` 数组）把页面级动作交给导航渲染；点击动作以 `nav:action` 事件发到 window，由页面对应脚本处理，从而页面内容脚本不必依赖动作按钮放在顶栏还是别处。登录界面与分享页（`mode:'brand'`）为特例：分享页只显示品牌位不显示三个 tab；登录页隐藏导航。

#### Scenario: 页面声明动作被渲染
WHEN 页面声明 `AlbumNavPage.actions`（如「上传」）
THEN 导航层按声明渲染该动作按钮，点击后通过 `nav:action` 事件触达页面处理逻辑。

#### Scenario: 分享页只显示品牌位
WHEN 页面以 `window.AlbumNavPage = { mode: 'brand' }` 启动
THEN 只渲染品牌区，不渲染「照片/相册/修图」tab，避免误导未登录的亲友。

### Requirement: 沉浸态与导航冲突消解
手机底部 tab SHALL 在沉浸态（大图查看/幻灯片/全屏编辑）中隐藏，避免压在操作栏上；对 `height:100dvh; overflow:hidden` 的页面，导航层 SHALL 通过覆盖 `height: calc(100dvh - 导航高度)` 让内容位于导航之上而非被压住。

#### Scenario: 沉浸态隐藏底部 tab
WHEN 用户进入大图查看器或幻灯片等沉浸态
THEN 底部 tab 隐藏或不与沉浸态操作栏重叠，退出后恢复。

### Requirement: Service Worker 收录导航资源
导航的 `nav.js`/`nav.css` SHALL 被加入 `sw.js` 的 `ASSETS` 外壳缓存清单，否则离线时会出现「在线正常、离线没导航」。

#### Scenario: 离线仍有导航
WHEN 断网后打开缓存的页面外壳
THEN 导航层仍能渲染（nav.js/css 在缓存清单中）。
