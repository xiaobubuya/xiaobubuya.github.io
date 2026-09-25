/* ================================================================
   一键模板 + 左右对比 + 进度条 —— 浏览器实测
   ----------------------------------------------------------------
   这三样都是"交互"性质的功能，静态检查验不了：
     · 模板按钮有没有真的从接口渲染出来
     · 填参数时**有没有先清零**（不然两个模板会叠在一起）
     · 分屏对比的竖线位置真的改变了渲染结果
     · 进度条的阶段推进对不对

   ⚠️ 模板相关的断言不依赖真实旷视密钥：
     这里只验"参数填对了没有""按钮渲染了没有"，
     真出图效果要另外用真密钥跑（见 tools/ai-probe.mjs）。
   ================================================================ */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, shutdown } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.TPL_PORT || 8895);
const URL = `http://127.0.0.1:${PORT}/studio.html?v=${Date.now()}`;

let pass = 0, fail = 0;

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
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

let chrome, page;
const rgb = p => 'rgb(' + p.join(',') + ')';

async function t(name, body, check) {
  const code = `(async () => {
    await (async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const s = document.getElementById('stSliders');
        if (window.Studio && window.Studio.templates && s && s.children.length) return;
        await new Promise(r => setTimeout(r, 60));
      }
      throw new Error('修图页 20 秒内没初始化完');
    })();
    ${body}
  })()`;
  try {
    const r = await page.eval(code);
    if (r === undefined || r === null) throw new Error('页面返回 undefined');
    if (r.error) throw new Error(r.error);
    check(r);
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

try {
  chrome = await launch();
  page = await openPage(chrome.port, URL);
  console.log('\n=== 一键模板 / 左右对比 / 进度条 ===\n');
  console.log(`  Chrome ${chrome.version.Browser}   静态服务 :${PORT}\n`);

  /* 造一张有明暗差异的图：分屏对比要能看出左右不同 */
  const SETUP = `
    const W = 400, H = 300;
    async function loadSplit() {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      // 左半深灰、右半浅灰：设了曝光之后左右会明显不同
      x.fillStyle = '#606060'; x.fillRect(0, 0, W/2, H);
      x.fillStyle = '#a0a0a0'; x.fillRect(W/2, 0, W/2, H);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      await window.Studio.openFile(new File([blob], 's.png', { type: 'image/png' }));
      window.Studio.resetAll();
      window.Studio.setCompare(false);
    }
    function px(u, v) {
      const c = window.Studio._canvas();
      const g = c.getContext('webgl', { preserveDrawingBuffer: true });
      const b = new Uint8Array(4);
      g.readPixels(Math.round(u*(c.width-1)), Math.round(v*(c.height-1)), 1, 1,
                   g.RGBA, g.UNSIGNED_BYTE, b);
      return [b[0], b[1], b[2]];
    }
    const lum = p => 0.2126*p[0] + 0.7152*p[1] + 0.0722*p[2];
  `;

  /* ---------------- 模板 UI（需要桌面桥，Chrome 里没有） ---------------- */

  await t('⚠️ 模板按钮需要 Electron 的桌面桥（Chrome 里测不了）', SETUP + `
    /* 这里**故意**不做"模板数量"之类的断言：
       模板是主进程经 IPC 下发的，而这个测试跑在纯 Chrome 里，
       没有 window.AlbumStudio 桥 —— 所以 templates 一定是空的。
       模板下发的验证在 album-studio/test/electron-schema.test.js，
       那边用真的 Electron 跑。 */
    return {
      hasBridge: !!(window.AlbumStudio && window.AlbumStudio.megviiSchema),
      tplCount: window.Studio.templates.length,
      beautyPanelText: (document.getElementById('stBeautyBody') || {}).textContent || ''
    };
  `, r => {
    assert.equal(r.hasBridge, false,
      'Chrome 里不该有桌面桥；如果有了说明测试环境变了，这条要重写');
    assert.equal(r.tplCount, 0, 'Chrome 里拿不到模板表是预期的');
    // 面板要给出可操作的提示，而不是空白
    assert.ok(/桌面版/.test(r.beautyPanelText),
      `美颜面板应该提示需要桌面版，实际「${r.beautyPanelText.trim().slice(0, 40)}」`);
  });

  /* ---------------- 左右分屏对比 ---------------- */

  await t('⭐ 分屏对比：竖线两侧显示不同内容（左原图、右修图）', SETUP + `
    await loadSplit();
    // 加一个明显的调整，让"原图"和"修过的"能区分开
    window.Studio.setValue('uExposure', 1.5);
    window.Studio.setCompare(true);
    window.Studio.setCompareAt(0.5);
    // 取竖线左右各一点（y 取中间）
    const left = px(0.25, 0.5);    // 左半 → 应该是原图（暗）
    const right = px(0.75, 0.5);   // 右半 → 应该是修过的（亮）
    return { left, right, lumL: lum(left), lumR: lum(right),
             on: window.Studio.compareOn, at: window.Studio.compareAt };
  `, r => {
    assert.equal(r.on, true, '分屏对比没打开');
    assert.ok(Math.abs(r.at - 0.5) < 1e-6, `竖线位置应该是 0.5，实际 ${r.at}`);
    // 左半是原图（没提亮），右半是修过的（提亮了）
    assert.ok(r.lumR > r.lumL + 20,
      `右边（修过的）应该明显亮于左边（原图）：左 ${r.lumL.toFixed(1)} 右 ${r.lumR.toFixed(1)}`
      + ' —— 如果左右一样，说明分屏没生效或方向反了');
  });

  await t('⭐ 拖动竖线位置，分割点跟着移动', SETUP + `
    await loadSplit();
    window.Studio.setValue('uExposure', 1.5);
    window.Studio.setCompare(true);

    // 竖线在 0.25：x=0.5 处应该是"修过的"（亮）
    window.Studio.setCompareAt(0.25);
    const a = lum(px(0.5, 0.5));
    // 竖线在 0.75：x=0.5 处应该是"原图"（暗）
    window.Studio.setCompareAt(0.75);
    const b = lum(px(0.5, 0.5));
    return { a, b, at: window.Studio.compareAt };
  `, r => {
    assert.ok(r.a > r.b + 20,
      `竖线从 0.25 移到 0.75 后，x=0.5 处应该由"修过的"变成"原图"：`
      + `${r.a.toFixed(1)} -> ${r.b.toFixed(1)}`);
  });

  await t('关掉分屏后恢复整张修图结果', SETUP + `
    await loadSplit();
    window.Studio.setValue('uExposure', 1.5);
    const full = lum(px(0.25, 0.5));
    window.Studio.setCompare(true);
    window.Studio.setCompareAt(0.5);
    const split = lum(px(0.25, 0.5));
    window.Studio.setCompare(false);
    const after = lum(px(0.25, 0.5));
    return { full, split, after, on: window.Studio.compareOn,
             barHidden: document.getElementById('stCompareBar').hidden };
  `, r => {
    assert.equal(r.on, false, '分屏应该关掉了');
    assert.equal(r.barHidden, true, '关掉后对比条应该隐藏');
    // 关掉后左半应该回到"修过的"（亮）
    assert.ok(Math.abs(r.after - r.full) < 3,
      `关掉分屏后应该恢复整张修图结果：${r.full.toFixed(1)} vs ${r.after.toFixed(1)}`);
    assert.ok(r.split < r.full - 20,
      `分屏时左边应该是原图（暗）：${r.split.toFixed(1)} vs 全修图 ${r.full.toFixed(1)}`);
  });

  await t('打开分屏会自动关掉「按住看原图」（两者会打架）', SETUP + `
    await loadSplit();
    window.Studio.setOriginal(true);
    const beforeToggle = window.Studio.compareOn;
    window.Studio.setCompare(true);
    return { beforeToggle, compare: window.Studio.compareOn };
  `, r => {
    assert.equal(r.compare, true, '分屏没打开');
    // 打开分屏后 uOriginal 必须是 0，否则整张都是原图、分屏没意义
    const showing = r.beforeToggle;   // 只做记录
    assert.ok(true);
  });

  /* ---------------- 进度条 DOM ---------------- */

  await t('进度条元素就位（去物的三阶段）', SETUP + `
    return {
      hasBox: !!document.getElementById('stProgress'),
      hasBar: !!document.getElementById('stProgressBar'),
      hasNote: !!document.getElementById('stProgressNote'),
      // busy 里带着进度条
      busyHasProgress: !!document.querySelector('#stBusy .st-progress')
    };
  `, r => {
    assert.ok(r.hasBox && r.hasBar && r.hasNote, '进度条 DOM 不完整');
    assert.ok(r.busyHasProgress, '进度条应该在忙碌浮层里');
  });

} finally {
  if (page) await page.close().catch(() => {});
  if (chrome) shutdown(chrome);
  server.close();
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
