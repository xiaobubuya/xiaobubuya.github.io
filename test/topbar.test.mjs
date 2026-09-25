/* ================================================================
   修图页顶栏：窄窗口下不能溢出 / 不能挤成一坨
   ----------------------------------------------------------------
   起因是用户反馈"右上角有点窄"。查的过程值得记：

   ⚠️ 第一反应是"按钮溢出了"，但**实测五个宽度都不溢出**
   （860 / 900 / 1000 / 1100 / 1184 下 scrollWidth 都没超、
   最后一个按钮也没被裁）。所以那不是布局 bug，是**观感**问题：
   间距只有 8px，四个图标按钮挤成一坨。

   这个测试守两件事：
     ① **真的溢出**（以后加按钮、改字号时会发生）——
        这个必须有测试，否则加一个新按钮就会在窄屏上被裁掉，
        而且用户不一定会反馈
     ② **间距不能太小**（观感问题，量化成"相邻按钮间隙 ≥ 8px"）
   ================================================================ */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, shutdown } from './cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TOPBAR_PORT || 8885);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json'
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

/* ⚠️ 媒体查询看的是**视口宽度**，而视口由 Chrome 启动参数决定 ——
   用 JS 改 body 宽度**不会**触发媒体查询（innerWidth 不变）。
   踩过：给 body 设 width:1000px，结果 matchMedia('(max-width:1100px)')
   还是 false，量到的全是宽屏样式，白测一轮。
   所以每个宽度都**单独启动一次 Chrome**。 */
const WIDTHS = [860, 900, 1000, 1100, 1200];

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== 修图页顶栏（窄窗口）===\n');

const results = [];
for (const w of WIDTHS) {
  const chrome = await launch({ windowSize: `${w},800` });
  try {
    const page = await openPage(chrome.port, `http://127.0.0.1:${ACTUAL}/studio.html?v=${Date.now()}`);
    await page.eval(`(async () => {
      const dl = Date.now() + 15000;
      while (Date.now() < dl) { if (window.Studio) break; await new Promise(r => setTimeout(r, 100)); }
      return true;
    })()`);
    const r = await page.eval(`(() => {
      const bar = document.querySelector('.st-bar');
      const kids = [...bar.children].map(el => {
        const b = el.getBoundingClientRect();
        return { id: el.id || el.tagName.toLowerCase(),
                 text: (el.textContent || '').trim().slice(0, 6),
                 x: Math.round(b.x), w: Math.round(b.width),
                 right: Math.round(b.right) };
      });
      const bb = bar.getBoundingClientRect();
      const gaps = [];
      for (let i = 1; i < kids.length; i++) gaps.push(kids[i].x - kids[i - 1].right);
      return {
        requested: ${w},
        innerWidth: innerWidth,
        mq1100: matchMedia('(max-width:1100px)').matches,
        mq960: matchMedia('(max-width:960px)').matches,
        mq820: matchMedia('(max-width:820px)').matches,
        barW: Math.round(bb.width),
        scrollW: bar.scrollWidth,
        maxRight: Math.max(...kids.map(k => k.right)),
        barRight: Math.round(bb.right),
        kids, gaps: gaps.map(g => Math.round(g)),
        minGap: Math.min(...gaps)
      };
    })()`);
    results.push(r);
    console.log(`  · 窗口${w}px → 实际视口 ${r.innerWidth}px，顶栏 ${r.barW}px，`
      + `内容 ${r.scrollW}px，最小间隙 ${r.minGap}px，间隙=[${r.gaps.join(', ')}]`);
    await page.close().catch(() => {});
  } finally {
    shutdown(chrome);
  }
}

console.log('');

t('⭐ 各宽度下顶栏都不溢出（加按钮时最先坏的往往是这条）', () => {
  for (const r of results) {
    assert.ok(r.scrollW <= r.barW + 1,
      `${r.requested}px 下顶栏内容 ${r.scrollW}px 超过宽度 ${r.barW}px —— `
      + '按钮会被裁掉，而且不报错');
  }
});

t('⭐ 最后一个按钮没有被裁出右边界', () => {
  for (const r of results) {
    assert.ok(r.maxRight <= r.barRight + 1,
      `${r.requested}px 下最右元素到 ${r.maxRight}，`
      + `但顶栏右边界只有 ${r.barRight} —— 被裁了`);
  }
});

t('⭐ 按钮间隙不能小于 8px（"挤成一坨"就是这条）', () => {
  for (const r of results) {
    assert.ok(r.minGap >= 8,
      `${r.requested}px 下最小间隙只有 ${r.minGap}px，`
      + '右边那组图标按钮会挤在一起');
  }
});

t('窄屏下"打开图片/导出"两个主按钮还在（没有被隐藏掉）', () => {
  for (const r of results) {
    const ids = r.kids.map(k => k.id);
    assert.ok(ids.includes('stOpen'), `${r.requested}px 下找不到「打开图片」按钮`);
    assert.ok(ids.includes('stExport'), `${r.requested}px 下找不到「导出」按钮`);
  }
});

t('媒体查询确实按宽度生效了（不然上面量的都是同一套样式）', () => {
  const narrow = results.find(r => r.requested <= 1000);
  const wide = results.find(r => r.requested >= 1100);
  assert.ok(narrow, '没有窄屏样本');
  assert.ok(wide, '没有宽屏样本');
  assert.notEqual(narrow.minGap, wide.minGap,
    `窄屏(${narrow.requested}px)和宽屏(${wide.requested}px)的最小间隙一样`
    + `都是 ${narrow.minGap}px —— 说明断点没生效，测的是同一套样式`);
});

server.close();
console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
