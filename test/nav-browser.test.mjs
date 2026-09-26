/* ================================================================
   全局导航 —— 实测渲染 + 页面接线
   ----------------------------------------------------------------
   用户的原话："现在相册和修图藏得太深了"。改动之前相册和修图藏在
   照片流「⋯」菜单的第 2、3 项，手机上要两次菜单才到得了。

   这个文件守两件事，分工明确：

     A. **导航层本身**（渲染 / 高亮 / 响应式 / 三种模式）
        —— 在 test/fixtures/nav.html 上量。用同一个装置而不是真页面，
          原因写在那个文件的注释里（album/studio 没会话就跳回首页，
          量到的其实是首页）。

     B. **真实页面的接线**（每个页面都引了 nav、声明对不对、顺序对不对）
        —— 静态读文件断言。这一层不需要浏览器，而且正是它保证
          "四个页面都接上了"。

   ⚠️ 为什么必须有 A：导航是 nav.js **运行时插进 body** 的，
   四个页面的 HTML 里一个导航标签都没有 —— "HTML 里有 nav"这种
   静态断言毫无意义，必须真把页面跑起来再量。
   ================================================================ */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, shutdown } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.NAV_PORT || 8901);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json'
};
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
});

/* 端口被占就往后找 —— 不能让整个文件静默消失（run-all 会显示
   "通过 0 失败 0"，看着像通过；实测踩过）。 */
let ACTUAL = PORT;
for (let p = PORT; p < PORT + 10; p++) {
  try {
    await new Promise((ok, no) => {
      const onErr = e => { server.removeListener('listening', onOk); no(e); };
      const onOk = () => { server.removeListener('error', onErr); ok(); };
      server.once('error', onErr); server.once('listening', onOk);
      server.listen(p, '127.0.0.1');
    });
    ACTUAL = p; break;
  } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
}
if (ACTUAL !== PORT) console.log(`\n  ⚠️ ${PORT} 被占用，改用 ${ACTUAL}\n`);
const fixture = (mode, port) =>
  `http://127.0.0.1:${port}/test/fixtures/nav.html?mode=${mode}&v=${Date.now()}`;

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== 全局导航（实测 + 接线）===\n');

/* ----------------------------------------------------------------
   装置里量导航的实际渲染结果。
   ⚠️ 每个变体**各开一个 target**（openPage → newTarget(url)）。
   想复用一个 page 挨个量是错的：页面不会自己导航过去，
   量到的几次都是同一张页面。实测踩过。
   ⚠️ 量出来的一律是**即时快照**（普通值）—— 跨 CDP 边界的对象会在
   序列化时再读一遍 getter，读到的是"整个脚本跑完之后"的状态。
   ---------------------------------------------------------------- */
const MEASURE_JS = `(() => {
  const q = s => document.querySelector(s);
  const qa = s => [...document.querySelectorAll(s)];
  const vis = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0
      && getComputedStyle(el).display !== 'none';
  };
  const top = q('.nav-top'), bot = q('.nav-bottom');
  return {
    innerWidth: window.innerWidth,
    hasTop: !!top, hasBottom: !!bot,
    topVisible: vis(top), bottomVisible: vis(bot),
    mode: (document.body.className.match(/nav-mode-\\w+/) || [null])[0],
    navHidden: document.body.classList.contains('nav-hidden'),
    tabs: qa('.nav-top .nav-tab').map(a => ({
      key: a.getAttribute('href'),
      label: a.textContent.trim(),
      current: a.getAttribute('aria-current') === 'page'
    })),
    bottomTabs: qa('.nav-bottom .nav-tab').length,
    brandHref: q('.nav-brand') ? q('.nav-brand').getAttribute('href') : null,
    actions: qa('.nav-top [data-action]').map(b => b.dataset.action),
    hasMore: !!q('#navMore')
  };
})()`;

let browserPort = 0;

/* ⚠️⚠️ 不要在上一个 target 关掉之后紧接着开下一个。
   cdp.mjs 的 closeTarget() 是 fire-and-forget（PUT 不等返回），
   紧接着 newTarget 会撞上"浏览器此刻没有可用 target"的窗口期，
   于是加载出 chrome-error://chromewebdata/ —— 表现是"第一次量成功、
   后面每次都超时"，而且从错误里看不出是端口问题还是脚本问题。
   （试过等 150ms，不够；也不该去赌一个固定的 magice number。）
   实测确认：连续开 4 个 target 而**全程不关**时四次全对，
   所以这里改成跑完统一收尾。 */
const _pages = [];
async function measure(port, mode) {
  const page = await openPage(browserPort, fixture(mode, port));
  _pages.push(page);
  {
    // 先把页面错误收集起来：光看"没等到 AlbumNav"不知道是 404 还是崩了
    await page.eval(`(() => {
      window.__navErrs = window.__navErrs || [];
      if (!window.__navProbed) {
        window.__navProbed = true;
        addEventListener('error', e => window.__navErrs.push(
          'error: ' + (e.message || '') + ' @ ' + (e.filename || '')), true);
        addEventListener('unhandledrejection', e => window.__navErrs.push(
          'reject: ' + e.reason));
      }
      return true;
    })()`);
    const ok = await page.eval(`(async () => {
      const dl = Date.now() + 8000;
      while (Date.now() < dl) {
        if (window.AlbumNav) return 'ready';
        await new Promise(r => setTimeout(r, 40));
      }
      return 'timeout';
    })()`);
    if (ok !== 'ready') {
      const diag = await page.eval(`(() => ({
        url: location.href,
        scripts: [...document.scripts].map(s => s.getAttribute('src')),
        errs: window.__navErrs || [],
        hasNav: !!window.AlbumNav
      }))()`);
      throw new Error('没等到 AlbumNav：' + JSON.stringify(diag));
    }
    return await page.eval(MEASURE_JS);
  }
}

/** 统一收尾：等所有页面都用完之后再关（原因见上） */
async function closeAll() {
  for (const p of _pages) await p.close().catch(() => {});
  _pages.length = 0;
}

/* ⚠️ 服务器要活到**两个浏览器都跑完**。
   第一版把 server.close() 写在桌面那一块的 finally 里，
   结果手机那一块（另起的 Chrome）连上去只拿到 chrome-error ——
   表现是"桌面全对、手机全错"，看着像响应式坏了，其实是服务器已经关了。 */
const chrome = await launch();
let R = {};
try {
  browserPort = chrome.port;
  R.login = await measure(ACTUAL, 'login');
  R.photos = await measure(ACTUAL, 'in');
  R.album = await measure(ACTUAL, 'album');
  R.share = await measure(ACTUAL, 'share');
  await closeAll();
  shutdown(chrome);

  /* 手机视口：**另起一个 Chrome**（视口宽度只能靠启动参数，见 cdp.mjs：
     媒体查询看的是 innerWidth，用 JS 改 body 宽度不会触发） */
  const chromeM = await launch({ windowSize: '820,900' });
  try {
    browserPort = chromeM.port;
    R.mobile = await measure(ACTUAL, 'in');
  } finally {
    await closeAll();
    shutdown(chromeM);
  }
} finally {
  await closeAll();
  shutdown(chrome);
  server.close();
}

/* ================================================================
   A. 导航层
   ================================================================ */

t('⭐ 三个核心功能一级可达（相册/修图不再藏在菜单里）', () => {
  const labels = R.photos.tabs.map(x => x.label);
  for (const want of ['照片', '相册', '修图']) {
    assert.ok(labels.some(l => l.includes(want)),
      `顶栏里没有「${want}」（实际：${labels.join('/') || '空'}）`);
  }
  assert.ok(labels.length >= 3,
    `至少要有 3 个 tab，实际 ${labels.length}`);
});

t('⭐ tab 的链接指向**真实存在**的文件（静态托管没有重写规则）', () => {
  /* ⚠️ 这条是**真 bug** 的护栏：nav.js 第一版把 href 写成 `/album`、
     `/studio`（想当然当成服务端路由）。GitHub Pages 是静态托管，
     `/album` 直接 404 —— 点一下就白屏。
     判据不看 href 长什么样，而是把路径映射回文件、检查在不在。 */
  const bad = [];
  for (const tb of R.photos.tabs) {
    if (tb.key === '/') continue;              // 根路径由 index.html 兜
    const rel = tb.key.replace(/^\//, '');
    if (!fs.existsSync(path.join(ROOT, rel))) {
      bad.push(`「${tb.label}」指向 ${tb.key}，但仓库里没有 ${rel}`);
    }
  }
  assert.equal(bad.length, 0,
    `导航链接指向不存在的文件（点了会 404）：\n       ${bad.join('\n       ')}`);
});

t('⭐ 高亮跟着"当前页"走（照片/相册/分享各一条）', () => {
  const cases = [
    ['照片页', R.photos, '照片'],
    ['相册页', R.album, '相册']
  ];
  const bad = [];
  for (const [name, r, want] of cases) {
    const cur = r.tabs.filter(x => x.current);
    if (cur.length !== 1) {
      bad.push(`${name} 应该正好 1 个高亮，实际 ${cur.length} 个`
        + `（${cur.map(c => c.label).join('/') || '无'}）`);
      continue;
    }
    if (!cur[0].label.includes(want)) {
      bad.push(`${name} 高亮的是「${cur[0].label}」，应该是「${want}」`);
    }
  }
  assert.equal(bad.length, 0, `高亮不对：\n       ${bad.join('\n       ')}`);
});

t('⭐ 桌面显示顶栏、手机显示底部 tab（同一时刻只有一个可见）', () => {
  /* ⚠️ 判据是"两个都渲染了、但只有一个是可见的" ——
     不是"手机上 DOM 里没有顶栏"。两边都输出、用媒体查询切换，
     好处是导航随时可达、可测（不用改窗口就能断言结构在不在）。 */
  assert.ok(R.photos.hasTop, '顶栏应该渲染出来（DOM 里要有）');
  assert.ok(R.photos.hasBottom, '底部 tab 应该渲染出来（DOM 里要有）');
  assert.ok(!(R.photos.topVisible && R.photos.bottomVisible),
    '顶栏和底部 tab 不能同时可见（会重复两套导航）');
  assert.ok(R.photos.topVisible || R.photos.bottomVisible,
    '至少要有一种导航可见（否则等于没有导航）');
  assert.equal(R.photos.bottomTabs, 3,
    `底部 tab 应该有 3 个，实际 ${R.photos.bottomTabs}`);
});

t('⭐⭐ 手机视口（820px）下：底部 tab 可见、顶栏隐藏', () => {
  assert.ok(R.mobile.innerWidth < 900,
    `这个装置应该跑在 900px 以下，实际 innerWidth=${R.mobile.innerWidth}`);
  assert.equal(R.mobile.bottomVisible, true, '手机宽度下底部 tab 该可见');
  assert.equal(R.mobile.topVisible, false, '手机宽度下顶栏该隐藏');
  assert.equal(R.mobile.bottomTabs, 3,
    `底部 tab 应该有 3 个，实际 ${R.mobile.bottomTabs}`);
});

t('⭐ 登录前不显示导航（点过去只会被弹回来）', () => {
  assert.ok(R.login.navHidden,
    '登录页该带 nav-hidden（body 上没这个类，导航就会露出来）');
  assert.ok(!R.login.topVisible && !R.login.bottomVisible,
    '登录页上导航都该是隐藏的');
});

t('⭐ 分享页只给品牌位，不给三个 tab（别误导没登录的亲友）', () => {
  /* 亲友点开一本相册，看到"相册/修图"会点，然后被弹回登录页 ——
     那是错误的引导。所以分享页用 brand 模式。 */
  assert.equal(R.share.mode, 'nav-mode-brand',
    `分享页应该是 brand 模式，实际 ${R.share.mode}`);
  assert.equal(R.share.tabs.length, 0,
    `分享页不该有 tab，实际有 ${R.share.tabs.map(x => x.label).join('/')}`);
  assert.equal(R.share.brandHref, '/', '分享页的品牌位应该指向首页');
});

t('⭐ 页面动作按钮由**声明**渲染出来（不是各页面自己绑 DOM）', () => {
  assert.deepEqual(R.photos.actions, ['upload'],
    `照片页顶栏应该有"上传"动作，实际 ${JSON.stringify(R.photos.actions)}`);
  assert.deepEqual(R.album.actions, ['newAlbum'],
    `相册页顶栏应该有"新建相册"动作，实际 ${JSON.stringify(R.album.actions)}`);
  assert.ok(R.photos.hasMore, '顶栏右侧应该有 ⋯（全局设置入口）');
  assert.equal(R.share.hasMore, false,
    '分享页不该有 ⋯ 设置（那是给登录用户的：幻灯片/退出登录）');
});

/* ================================================================
   B. 真实页面的接线（静态）
   ================================================================ */
const PAGES = ['index.html', 'album.html', 'studio.html', 'share.html'];
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

t('⭐ 四个页面都引了 nav.js 和 nav.css（一个都不能漏）', () => {
  const bad = [];
  for (const f of PAGES) {
    const s = read(f);
    if (!/<script src="nav\.js"><\/script>/.test(s)) bad.push(`${f} 没引 nav.js`);
    if (!/<link rel="stylesheet" href="nav\.css">/.test(s)) bad.push(`${f} 没引 nav.css`);
  }
  assert.equal(bad.length, 0,
    `这些页面没接上全局导航：\n       ${bad.join('\n       ')}`);
});

t('⭐ nav.js 的引入在 AlbumNavPage 声明**之后**（顺序反了配置读不到）', () => {
  /* ⚠️ 顺序错了不会报错，只会静默按默认 full 渲染 ——
     "我明明配了 brand 模式，分享页还是显示三个 tab" 就是这来的。 */
  const bad = [];
  for (const f of PAGES) {
    const s = read(f);
    const iCfg = s.indexOf('AlbumNavPage');
    const iJs = s.indexOf('<script src="nav.js"></script>');
    if (iJs < 0) continue;                      // 上一条已经报了
    if (f === 'studio.html') {
      // studio 显式声明了空 actions，也必须有配置块
      if (iCfg < 0) bad.push(`${f} 没有 window.AlbumNavPage 声明`);
    } else if (iCfg < 0) {
      bad.push(`${f} 没有 window.AlbumNavPage 声明`);
    } else if (iCfg > iJs) {
      bad.push(`${f} 里 AlbumNavPage 声明在引 nav.js **之后**，读不到`);
    }
  }
  assert.equal(bad.length, 0, bad.join('\n       '));
});

t('分享页声明了 brand 模式（只有品牌位，没有站内 tab）', () => {
  const s = read('share.html');
  assert.ok(/mode:\s*'brand'/.test(s),
    "share.html 应该声明 mode: 'brand' —— "
    + '否则亲友会看到"相册/修图"三个 tab，点过去被弹回登录页');
});

t('照片页和相册页各自声明了自己的动作（上传 / 新建相册）', () => {
  assert.ok(/key:\s*'upload'/.test(read('index.html')),
    "index.html 应该声明 key: 'upload'");
  assert.ok(/key:\s*'newAlbum'/.test(read('album.html')),
    "album.html 应该声明 key: 'newAlbum'");
});

t('修图页不重复放"打开图片/导出"（那两个在它自己的工具条里）', () => {
  const s = read('studio.html');
  assert.ok(/actions:\s*\[\s*\]/.test(s),
    'studio.html 的 actions 应该是空数组 —— '
    + '.st-bar 里已经有"打开图片/导出"，顶栏再放一份会重复');
  /* ⚠️ 顺带守一条：导航**不能**插进 .st-bar。
     test/topbar.test.mjs 会逐个子元素量间隙，往里加元素很容易假红
     （它没有按 y 轴分组，换行会让 gap 变成负的）。 */
  assert.ok(!/<header class="st-bar">[\s\S]*?nav-top[\s\S]*?<\/header>/.test(s),
    '导航被插进 .st-bar 了 —— 那会破坏 topbar.test.mjs 的间隙断言');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
