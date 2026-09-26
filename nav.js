/* ================================================================
   nav.js —— 全局导航（桌面顶栏 / 手机底部 tab）
   ----------------------------------------------------------------
   为什么单独抽一个文件（而不是每个页面各写一遍）：
   现在四个页面（index / album / studio / share）各自有一套顶栏，
   相册和修图还藏在 index 的「⋯」菜单里 —— 用户的原话是
   "现在相册和修图藏得太深了"。四个页面各写一遍导航，迟早不一致，
   而且新加一个页面就要记得再抄一遍。所以收敛成**一份**：
   按当前路径算高亮，各页面只负责引这个脚本。

   ⚠️ 为什么不直接合并成一个单页应用（壳 + 三个视图容器）：
   那是最终形态（见 docs/PRD-NAV.md §7），但它要求
   "切 tab 不重载 + 上下文留存"，会牵动 album.js / app.js /
   studio.js 三套初始化逻辑，一步做完风险太大。
   这里先做**零风险**的那半步：导航层统一 + 三个核心功能一级可达。
   顺着导航点过去仍然是整页跳转，但入口不再藏在菜单里。

   渲染策略：
     · 顶栏和底部 tab **都**输出到 DOM，用 CSS 媒体查询决定显示哪个。
       好处是导航随时可达、可测（不用改窗口就能断言"结构在不在"），
       代价是多几十个字节的 HTML。
     · 底部 tab 在 `#viewer` / `#show` 这类沉浸态里要隐藏 ——
       那两处底栏本来就在屏幕底部，叠一起会打架。见下面的
       `body.nav-immersive` 约定。
   ================================================================ */
(function () {
  'use strict';

  /* 三个核心功能。⚠️ 顺序就是用户的心智顺序：先看照片，再排相册，
     最后精修。改顺序要连着 PRD 一起改。
     ⚠️⚠️ href 必须带 `.html`。第一版写的是 `/album`、`/studio`
     （想当然地当成服务端路由），但这是 **GitHub Pages 静态托管**，
     没有重写规则，`/album` 会直接 404 —— 点一下就白屏。
     顺带：`currentKey()` 里两种形式都要认（见那段注释）。 */
  var ITEMS = [
    { key: 'photos', href: '/',             label: '照片', icon: '▦', desc: '看照片和上传' },
    { key: 'album',  href: '/album.html',   label: '相册', icon: '▤', desc: '把照片排成册' },
    { key: 'studio', href: '/studio.html',  label: '修图', icon: '✦', desc: '精修单张照片' }
  ];

  var SETTINGS_LABEL = '设置';

  /* ⚠️ 这个变量在 openMore 里赋值、closeMore 里清空 —— 只能有一个
     弹出层，所以不需要栈。声明要放在两个函数**前面**（var 提升会让
     它在下面也能跑，但放在前面对读者更清楚）。 */
  var btn = null;

  /** 当前在哪个 tab：按路径判断。
   *  ⚠️ 用"前缀 + 边界"匹配而不是 includes —— `/album` 能被
   *  `/album-2` 这类路径误命中；边界用 `/` 或结束符锚定。
   *  ⚠️ studio 走的是 `studio.html`（带扩展名），
   *  所以两边都要认。
   *  ⚠️ 最后那个 `path` 覆盖是**给测试装置用的**：test/fixtures/nav.html
   *  这个路径不对应任何真实页面，高亮会全是 null。让装置能用
   *  `?path=/album.html` 声明"假装我在相册页"，这样高亮逻辑
   *  （正式代码）就能在装置里被真实验证，而不是靠测试自己重算一遍。 */
  function currentKey() {
    var cfg = window.AlbumNavPage || {};
    var p = cfg.path || location.pathname;
    p = p.replace(/\/+$/, '') || '/';
    var file = p.split('/').pop() || '';
    if (p === '/' || file === 'index.html') return 'photos';
    if (/^\/?album/.test(p) || file === 'album.html') return 'album';
    if (/^\/?studio/.test(p) || file === 'studio.html') return 'studio';
    return null;                       // share 等页面：不高亮任何一个
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** 造一组 tab 链接。
   *  ⚠️ 高亮用 `aria-current="page"` + class，两样都给：
   *  class 给样式，aria 给读屏，测试断言哪个都行。 */
  function buildTabs(clsPrefix) {
    var frag = document.createDocumentFragment();
    var cur = currentKey();
    ITEMS.forEach(function (it) {
      var a = el('a', 'nav-tab' + (it.key === cur ? ' on' : ''));
      a.href = it.href;
      a.title = it.desc;
      if (it.key === cur) a.setAttribute('aria-current', 'page');
      a.appendChild(el('span', 'nav-tab-icon', it.icon));
      a.appendChild(el('span', 'nav-tab-label', it.label));
      frag.appendChild(a);
    });
    return frag;
  }

  /** 桌面顶栏左侧的品牌位。⚠️ 它同时是"回首页"的入口。 */
  function buildBrand() {
    var a = el('a', 'nav-brand');
    a.href = '/';
    a.title = '回照片';
    var mark = el('img', 'nav-brand-mark');
    mark.src = '/icon.svg';
    mark.alt = '';
    mark.width = 24; mark.height = 24;
    a.appendChild(mark);
    a.appendChild(el('span', 'nav-brand-name', '我们的婚纱照'));
    return a;
  }

  /* ================================================================
     页面自己的动作按钮
     ----------------------------------------------------------------
     ⚠️ 让页面**声明**、导航来渲染，而不是各页面自己去操作 DOM：
       · 各页面手写的话，"上传"在照片页、以后相册页也要用，
         就会变成两份实现（文案/图标/尺寸迟早不一致）
       · 声明式还让测试能一次性断言"三个页面都接了上传"
     页面只要在引 nav.js **之前**写：
         window.AlbumNavPage = { actions: [
           { key: 'upload', label: '上传', icon: '＋', kind: 'primary' } ] };
     然后监听 `nav:action`（window 上）就能收到点击。
     ================================================================ */
  function pageActions() {
    var cfg = window.AlbumNavPage || {};
    return Array.isArray(cfg.actions) ? cfg.actions : [];
  }

  function buildActions() {
    var frag = document.createDocumentFragment();
    pageActions().forEach(function (a) {
      var b = el('button', 'nav-act' + (a.kind === 'primary' ? ' primary' : ''));
      b.type = 'button';
      b.dataset.action = a.key;
      b.title = a.title || a.label;
      if (a.label) b.appendChild(el('span', 'nav-act-label', a.label));
      if (a.icon) b.appendChild(el('span', 'nav-act-icon', a.icon));
      frag.appendChild(b);
    });
    return frag;
  }

  /**
   * 导航模式。页面用 window.AlbumNavPage.mode 声明：
   *   'full'（默认）—— 品牌 + 三个 tab + ⋯ 设置。给登录后的自己人用
   *   'brand'        —— 只有品牌位（回首页）。给**分享页**用：
   *                     亲友点开一本相册，给他们"照片/相册/修图"三个
   *                     tab 没有意义（点了会被弹回登录），
   *                     但"这是谁家做的、怎么回首页"要有。
   *   'none'         —— 完全不渲染。
   * ⚠️ 默认必须是 'full'：忘了声明的页面应该拿到完整导航，而不是悄悄没了。
   */
  function navMode() {
    var cfg = window.AlbumNavPage || {};
    var m = cfg.mode;
    return (m === 'brand' || m === 'none') ? m : 'full';
  }

  function render() {
    if (document.querySelector('.nav-top')) return;   // 幂等，别渲染两次
    var mode = navMode();
    if (mode === 'none') return;

    /* ---------- 桌面：顶栏 ---------- */
    var top = el('nav', 'nav-top');
    top.setAttribute('aria-label', '主导航');

    var inner = el('div', 'nav-top-inner');
    inner.appendChild(buildBrand());

    if (mode === 'full') {
      var seg = el('div', 'nav-seg');
      seg.setAttribute('role', 'list');
      seg.appendChild(buildTabs('top'));
      inner.appendChild(seg);

      /* 右侧：页面自己往这里塞操作（上传、新建相册…）。
         ⚠️ 用"插槽"而不是让导航知道每个页面的按钮：
         导航只负责"我在哪、能去哪"，具体动作归各页面。 */
      var slot = el('div', 'nav-slot');
      slot.id = 'navActions';
      slot.appendChild(buildActions());
      /* 页面动作的点击统一转成 `nav:action` 事件 —— 页面不用知道
         按钮是怎么渲染出来的（桌面在顶栏、手机在别处也一样能用）。 */
      slot.addEventListener('click', function (e) {
        var t = e.target.closest('[data-action]');
        if (!t) return;
        window.dispatchEvent(new CustomEvent('nav:action', {
          detail: { action: t.dataset.action }
        }));
      });
      inner.appendChild(slot);

      var btnEl = el('button', 'nav-more');
      btnEl.type = 'button';
      btnEl.id = 'navMore';
      btnEl.title = SETTINGS_LABEL;
      btnEl.setAttribute('aria-label', SETTINGS_LABEL);
      btnEl.setAttribute('aria-expanded', 'false');
      btnEl.textContent = '⋯';
      inner.appendChild(btnEl);
    }

    top.appendChild(inner);

    /* ---------- 手机：底部 tab（brand 模式下没有 tab，就不渲染） ---------- */
    var bot = null;
    if (mode === 'full') {
      bot = el('nav', 'nav-bottom');
      bot.setAttribute('aria-label', '主导航（手机）');
      var botInner = el('div', 'nav-bottom-inner');
      botInner.appendChild(buildTabs('bottom'));
      bot.appendChild(botInner);
    }

    if (bot) document.body.insertBefore(bot, document.body.firstChild);
    document.body.insertBefore(top, document.body.firstChild);
    document.body.classList.add('has-nav');
    document.body.classList.add('nav-mode-' + mode);

    /* ⚠️ 登录页不该出现导航（它能点去相册/修图，但那时还没登录，
       过去只会被弹回来，体验很怪）。
       判据：页面有登录层（#login）且它当前是可见的 → 先藏起来，
       等 app.js 登录成功调 AlbumNav.show(true)。
       没有登录层的页面（album/studio/share）直接显示。 */
    var login = document.getElementById('login');
    var needLogin = !!(login && !login.hidden);
    show(!needLogin);

    /* 顶栏高度写进 CSS 变量：各页面如果有 sticky 元素（比如
       album 的 .edit-bar），靠这个变量定位，别各写各的魔数。 */
    document.documentElement.style.setProperty('--nav-h',
      'calc(56px + env(safe-area-inset-top, 0px))');
  }

  /** 显示 / 隐藏整层导航（登录页要藏） */
  function show(on) {
    document.body.classList.toggle('nav-hidden', !on);
  }

  /* ================================================================
     设置菜单（顶栏右侧的 ⋯）
     ----------------------------------------------------------------
     ⚠️ 它和 index 原来那个 `#menu` 是**两件事**，别合并：
       · 这里的 ⋯ 放"全局设置"：幻灯片 / 重新加载 / 退出登录
         （和当前在哪个 tab 无关）
       · 页面自己的 `#menu` 保留它原有的页面内动作
     两边都留会让 ⋯ 重复。所以约定：**页面只往 navActions 插槽塞
     动作按钮，不要再自己画一个 ⋯**。index 那个旧 `#menu`
     等 P1 阶段连同它的"相册/修图"两项一起去掉。
     ================================================================ */
  function openMore(anchorBtn) {
    var sheet = document.getElementById('navSheet');
    if (sheet) { closeMore(); return; }

    sheet = el('div', 'nav-sheet');
    sheet.id = 'navSheet';
    var mask = el('div', 'nav-sheet-mask');
    mask.addEventListener('click', closeMore);
    sheet.appendChild(mask);

    var body = el('div', 'nav-sheet-body');
    body.appendChild(el('div', 'nav-sheet-title', SETTINGS_LABEL));

    /* 全局动作 —— 用事件而不是硬编码 href，方便其它页面复用 */
    var actions = [
      { key: 'slideshow', label: '▶︎　幻灯片播放' },
      { key: 'reload',    label: '↻　重新加载' },
      { key: 'logout',    label: '⎋　退出登录', danger: true }
    ];
    actions.forEach(function (a) {
      var b = el('button', 'nav-sheet-item' + (a.danger ? ' danger' : ''), a.label);
      b.type = 'button';
      b.dataset.action = a.key;
      body.appendChild(b);
    });
    var cancel = el('button', 'nav-sheet-item', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', closeMore);
    body.appendChild(cancel);

    sheet.appendChild(body);
    document.body.appendChild(sheet);

    btn = anchorBtn;
    btn.setAttribute('aria-expanded', 'true');
    /* 关闭：让页面自己监听 'nav:action'，不用知道菜单怎么实现的 */
    body.addEventListener('click', function (e) {
      var t = e.target.closest('[data-action]');
      if (!t) return;
      closeMore();
      window.dispatchEvent(new CustomEvent('nav:action', {
        detail: { action: t.dataset.action }
      }));
    });
    /* Esc 关闭 —— 桌面端习惯 */
    document.addEventListener('keydown', onKey);
  }

  function onKey(e) { if (e.key === 'Escape') closeMore(); }
  function closeMore() {
    var sheet = document.getElementById('navSheet');
    if (sheet) sheet.remove();
    if (btn) { btn.setAttribute('aria-expanded', 'false'); btn = null; }
    document.removeEventListener('keydown', onKey);
  }

  /* ================================================================
     对外接口
     ================================================================ */
  window.AlbumNav = {
    items: ITEMS,
    current: currentKey,
    /** 显示 / 隐藏整层导航（登录页、沉浸态用得上） */
    show: show,
    /** 页面往顶栏右侧塞动作按钮用的容器（可能为 null） */
    slot: function () { return document.getElementById('navActions'); },
    /** 沉浸态（大图/幻灯片）时把导航藏起来 —— 见 nav.css 的说明 */
    immersive: function (on) {
      document.body.classList.toggle('nav-immersive', !!on);
    },
    openMore: openMore,
    closeMore: closeMore
  };

  function boot() {
    render();
    var b = document.getElementById('navMore');
    if (b) b.addEventListener('click', function () { openMore(b); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
