/* ================================================================
   UI 素材接线（真浏览器）
   ----------------------------------------------------------------
   为什么必须用浏览器测、而不是静态查字符串：

   CSS 里 `url(...)` 指错、或者规则写错，**不会报任何错** ——
   那层背景/水印只是"没出现"。只有拿到 computed style 才看得出。

   ⚠️ 不能用 album.html / share.html 来测：它们**需要登录**，
   没会话时会被重定向回首页（实测踩过 —— 探针里 document.body
   变成了空、请求了 /、/app.js，说明页面早被换掉了，
   于是我在"登录页"上找 .album-cover，永远找不到）。
   所以这里自己拼一个最小页面：只引样式表 + 放一个目标元素。
   ================================================================ */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, shutdown } from './cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ASSET_UI_PORT || 8890);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json'
};

/* 最小页面：两个样式表 + 我们关心的元素各来一个。
   刻意**不引任何 js** —— 免得又被重定向。 */
const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="UTF-8">
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="album.css">
<title>素材接线校验</title>
</head><body>
<img class="brand-mark" src="icon.svg" alt="" width="46" height="46">
<div class="empty"><img class="empty-art" src="icon.svg" alt="" width="72" height="72"></div>
<div class="album-cover empty" style="width:120px;height:80px"></div>
<!-- ⚠️ 两处都要对：类名是 .show（页面里是 <div id="show" class="show">），
     而且不能带 hidden —— hidden 时 display:none，background-image
     算出来是 none，断言会假红。这两个都踩过。 -->
<div id="show" class="show" style="width:200px;height:120px"></div>
</body></html>`;

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/__probe.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
});

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

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== UI 素材接线（真浏览器）===\n');
console.log(`  静态服务 :${ACTUAL}\n`);

const chrome = await launch();
let r;
try {
  const page = await openPage(chrome.port, `http://127.0.0.1:${ACTUAL}/__probe.html?v=${Date.now()}`);

  /* ⚠️ 先等页面就绪再断言，别裸取 naturalWidth。
     踩过：直接 `bm.naturalWidth` 时，bm 为 null 会抛
     "Cannot read properties of null" —— 而这条错误发生在
     `run-all` 里（单独跑却正常），说明是**加载时机**问题。
     这类"单独跑绿、一起跑红"最容易浪费时间，所以：
       ① 显式等 document.readyState + 元素出现
       ② 元素缺失时给出人话错误，而不是让 TypeError 冒出去 */
  await page.eval(`(async () => {
    const dl = Date.now() + 8000;
    while (Date.now() < dl) {
      if (document.readyState === 'complete'
          && document.querySelector('.brand-mark')
          && document.getElementById('show')) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('probe 页面 8 秒内没就绪'
      + '（.brand-mark / #show 没出现）—— 静态服务是不是没起在预期端口？');
  })()`);
  await new Promise(res => setTimeout(res, 600));

  r = await page.eval(`(() => {
    const out = { failed: [] };

    const bm = document.querySelector('.brand-mark');
    out.brandMark = bm ? { w: bm.naturalWidth, complete: bm.complete } : null;
    const ea = document.querySelector('.empty-art');
    out.emptyArt = ea ? { w: ea.naturalWidth } : null;
    const cover = document.querySelector('.album-cover.empty');
    out.albumCoverArt = cover
      ? getComputedStyle(cover, '::after').backgroundImage : null;
    const show = document.getElementById('show');
    out.showBg = show ? getComputedStyle(show).backgroundImage : null;
    // 顺带确认 #show 的兜底底色也在（图片没加载完时不闪白底）
    out.showBgColor = show ? getComputedStyle(show).backgroundColor : null;
    out.sheets = [...document.styleSheets].map(s => (s.href || '').split('/').pop());
    return out;
  })()`);
  await page.close().catch(() => {});
} finally {
  shutdown(chrome);
  server.close();
}

t('两个样式表都加载了（album.css 别漏）', () => {
  assert.ok((r.sheets || []).includes('styles.css'), 'styles.css 没加载');
  assert.ok((r.sheets || []).includes('album.css'),
    `album.css 没加载（实际只有 ${(r.sheets || []).join(', ')}）`);
});

t('⭐ 空相册水印真的生效（::after 有 background-image）', () => {
  const bg = r.albumCoverArt || '';
  assert.ok(bg && bg !== 'none',
    '.album-cover.empty::after 的 background-image 是 none —— '
    + '水印不会显示，而且**不会有任何报错**（只在网络面板里能看到 404，'
    + '或者规则根本没匹配上）');
  assert.ok(/icon\.svg/.test(bg), `水印没用图标的 url，实际 ${bg}`);
});

t('⭐ 幻灯片背景用了 stage-bg.png（不是纯黑）', () => {
  const bg = r.showBg || '';
  assert.ok(/stage-bg\.png/.test(bg),
    `#show 的背景里没有 stage-bg.png，实际 ${bg}\n`
    + '     ⚠️ 路径写错时浏览器静默退回兜底色，看不出问题');
});

t('幻灯片有兜底底色（图片没加载完时不闪白底）', () => {
  const c = r.showBgColor || '';
  assert.ok(c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent',
    `#show 没有兜底 background-color，实际 ${c} —— `
    + '首次打开/离线时图片还没到，会先闪一下白底');
});

t('图标（品牌位 / 空状态）真的解码出来了', () => {
  assert.ok(r.brandMark, '.brand-mark 元素不在页面上');
  assert.ok(r.brandMark.w > 0,
    `品牌位图标没解码出来（naturalWidth=${r.brandMark.w}）`);
  assert.ok(r.emptyArt, '.empty-art 元素不在页面上');
  assert.ok(r.emptyArt.w > 0,
    `空状态插图没解码出来（naturalWidth=${r.emptyArt.w}）`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
