# PhotoCraft 界面中文：现状、实现与踩过的坑

> 记录时间：2026-10-28。起因是"PS 页面（PhotoCraft）界面是英文，能不能中文"。

## 一、结论：引擎原生支持中文，不需要翻译工作

上游 `crates/ui-egui/src/i18n/` 自带 23 种语言目录，中文两份：

| 文件 | 内容 |
|---|---|
| `zh-hans.tsv` | 简体中文，**2884 行**，`complete_menus: true` |
| `zh-hant.tsv` | 繁体中文 |

注册在 `i18n/mod.rs:193`：

```rust
LangInfo { code: "zh-hans", name: "简体中文", source: catalog!("zh-hans"),
           plural: plural_none, complete_menus: true, catalog: OnceLock::new() }
```

`compact: complete_menus: true` 表示菜单全覆盖，且上游有共享测试强制校验每条菜单字符串都有翻译。

翻译质量抽样：

| 英文 | 中文 | 英文 | 中文 |
|---|---|---|---|
| File | 文件 | Layer | 图层 |
| Edit | 编辑 | Select | 选择 |
| Image | 图像 | Filter | 滤镜 |
| Preferences | 首选项 | Interface | 界面 |
| Language | 语言 | Auto | 自动 |

**关键实现细节**：翻译目录在构建时被 deflate 压缩后嵌入 wasm（`build.rs` 的 `pack_catalogs()`，`include_bytes!(... .tsv.deflate)`）。所以：

- 在 wasm 二进制里**搜不到明文中文词**（搜"图层"是 0 次），这不代表没有中文
- 能搜到的是 `LangInfo.name`（"简体中文"，未压缩）和 ICU 的 locale 代码

早期误判"wasm 里没有中文"就是因为不知道这层压缩。

## 二、为什么默认是英文

`interface.language` 默认 `"auto"`。native 构建的 auto 会读 `LANG`/`LC_*`、macOS 首选语言、Windows 用户区域；**web 构建的 auto 不读浏览器语言**（上游文档 `docs/localization-zh-hans.md` 明确写了）。所以 web 落到英文兜底。

手动切换路径：

```
菜单栏 Edit → Preferences → Interface…
   → 分组 Presentation → 下拉 Language → 简体中文
```

注意：`Preferences` 在 **Edit** 菜单子项里，不是顶层菜单；`Language` 是下拉框（`prefs_ui.rs:1718`），选项来自 `Lang::all()`，值就是 `zh-hans` 等代码。

也可以用命令：

```
prefs.set {"path":"interface.language","value":"zh-hans"}
```

## 三、当前实现：默认中文

代码在 `apply-bridge.js`（CI 构建 wasm 时注入）和线上 `photocraft/index.html`（构建产物，两处内容一致）。

**三层机制**：

| 机制 | 位置 | 作用 |
|---|---|---|
| `pc-ui-language-preset` | 独立 module script，**wasm init 之前** | 读 localStorage 的 `photocraft.preferences`，`language` 为 `auto`/缺失时改成 `zh-hans`，引擎 `load_prefs` 时直接读到中文 |
| `pc-ui-language`（fire-and-forget） | Bridge shim 内 | 桥接就绪后用 `execute_command('prefs.set', …)` 设置（**不 await**） |
| 交互兜底 | `pointerdown`/`keydown` 一次性监听 | 新用户（无 prefs）情况下，首次交互必产生帧，命令队列才被消费 |

**尊重用户选择**：只要 `interface.language` 不是 `auto`（比如你手动选了 `en`），三层都完全不动作。

### 为什么必须"不 await"

`execute_command` 的 Promise **永远 pending**：

```rust
// apply-bridge.js 注入的 Rust 实现（修复前）
poll_fn(|_cx: &mut Context<'_>| {
    if done.load(Ordering::Relaxed) { Poll::Ready(...) } else { Poll::Pending }
}).await
```

`poll_fn` 返回 `Pending` 后需要 waker 重新 poll，而 wasm 侧没有触发机制 —— 实测页面加载后、用户点击后都不 resolve。所以任何 `await execute_command(...)` 都会永久卡住。

AI 悬浮球一直能用，正是因为它 fire-and-forget，不依赖返回值。

`apply-bridge.js` 里已加了 `REPAINT` 唤醒（push 命令后调用回调），但那只解决"帧不跑"，不解决"future 不再被 poll"——彻底修需要把 `poll_fn` 换成 `js_sys::Promise` + `setTimeout` 轮询。

## 四、已知问题（未解决，2026-10-28）

**切成 Auto 后刷新仍是英文。**

原因：`pc-ui-language-preset` 只在**已有** `photocraft.preferences` 时改 localStorage。切成 auto 后 prefs 存在（`language: "auto"`），preset 理论上应该把它改成 `zh-hans`，但实测未生效——根因未完全确认（怀疑 `TrunkApplicationStarted` 时序或 preset 执行时引擎已读完 prefs）。

影响：不影响"默认打开是中文"，只影响"主动切成 Auto 期望自动中文"这个边缘操作。

后续要修的话，方向：

1. 确认 preset 的执行时机（在 Trunk script 的 `await init` 前后打点）
2. 或彻底修 `execute_command` 的 Promise（见上一节）
3. 或在引擎启动后调用 `prefs.set` 并强制 `request_repaint` 多帧

## 五、排查踩过的坑（下次动这块必看）

### 坑 1：GitHub Pages 缓存 10 分钟，无痕模式也没用

线上是 GitHub Pages（`server: GitHub.com`），`photocraft/_headers` 是给 Netlify/Cloudflare Pages 的，**GitHub Pages 不认**。`index.html` 用默认头：

```
cache-control: max-age=600
```

改了 `index.html` 后 10 分钟内拿到旧文件；**无痕模式只清 localStorage/cookie，不清 HTTP 缓存**。验证要用 `Ctrl+Shift+R` 或带参数的 URL（`?v=N`）。

### 坑 2：`photocraft/` 是构建产物，直接改会被 CI 覆盖

`photocraft/` 在 `.gitignore` 里，CI 用 `git add -f photocraft/` 提交。直接改线上 `index.html` 只是临时生效；**持久修改必须改 `apply-bridge.js`**（CI 构建时注入）。

### 坑 3：`execute_command` 的 Promise 不可用

见上一节。任何依赖返回值的逻辑都会永久卡住。

### 坑 4：wasm 里搜不到中文 ≠ 没有中文

翻译是 deflate 压缩嵌入的，只能在运行时解压。

## 六、验证清单

```bash
# 1. 线上是英文还是中文：看 shim 标记
curl -s "https://muyaya.world/photocraft/index.html?v=$(date +%s)" \
  | grep -c "pc-ui-language-preset"

# 2. 浏览器控制台
localStorage.getItem('photocraft.preferences')   # 看 interface.language
```

| 场景 | 期望 |
|---|---|
| 全新（无痕、无 prefs）打开 | 中文 |
| 手动选 `zh-hans` 后刷新 | 中文 |
| 手动选 `en` 后刷新 | 英文（尊重选择） |
| 切成 `auto` 后刷新 | **当前仍是英文（已知问题）** |
