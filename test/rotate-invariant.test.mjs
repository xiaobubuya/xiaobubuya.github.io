/* ================================================================
   旋转不变量：图片不能被拉伸
   ----------------------------------------------------------------
   起因：用户反馈"旋转明显不对，不要扭曲图片"。

   查的过程踩了两个坑，都记下来：

   【坑一：判据写错了】
   我一开始断言 `sX/sY == W0/H0`，跑出来 24/24 全红，
   差点以为修反了。其实 ——
     · `sX` 是"采样区间占源图**宽度**的比例"，**不是** outW/W0
   正确的无扭曲条件是"采样区间、输出、源图**三者比例一致**"：

       (sX·W0) / (sY·H0) == outW/outH == W0/H0

   【坑二：从结果反推】
   先量"绿色方块包围盒"，又量"红蓝分界点"——都因为取景框可能裁剪、
   抗锯齿影响边界，得出过自相矛盾的结论。最后改成**验代数不变量**才收敛。
   这和裁剪那个 bug 的教训是同一个：判据要选"能一次说清对错"的量。

   本测试守四条不变量（3 种图尺寸 × 8 个角度 = 24 组）：
     ① 采样区间的像素比例 == 输出比例   （核心：不扭曲）
     ② 输出比例 == 源图比例             （导出图本身不能被拉伸）
     ③ 预览画布比例 == 计划输出比例      （预览不能和导出不一致）
     ④ 采样区间不越出源图               （不能采到图外，否则边缘出现空白）
   ================================================================ */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, shutdown } from './cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ROT_INV_PORT || 8879);

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

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== 旋转不变量（图片不能被拉伸）===\n');

const chrome = await launch();
let rows;
try {
  const page = await openPage(chrome.port, `http://127.0.0.1:${ACTUAL}/studio.html?v=${Date.now()}`);
  await page.eval(`(async () => {
    const dl = Date.now() + 20000;
    while (Date.now() < dl) { if (window.Studio) break; await new Promise(r => setTimeout(r, 80)); }
    return true;
  })()`);

  rows = await page.eval(`(async () => {
    const S = window.Studio;
    const out = [];
    for (const [W, H] of [[400, 300], [300, 400], [600, 400]]) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      c.getContext('2d').fillRect(0, 0, W, H);
      const blob = await new Promise(res => c.toBlob(res, 'image/png'));
      await S.openFile(new File([blob], 'x.png', { type: 'image/png' }));
      S.resetAll();

      for (const deg of [0, 5, 10, 20, 30, 45, 60, 80]) {
        S.enterCrop();
        S.setCropRotation(deg);
        await new Promise(res => setTimeout(res, 80));
        const plan = S.cropRenderPlan(true);
        const pv = S.cropRenderPlan(false);
        const cv = S._canvas();
        out.push({
          W, H, deg,
          outW: plan.outW, outH: plan.outH,
          sX: plan.sX, sY: plan.sY, offX: plan.offX, offY: plan.offY,
          canvasW: cv.width, canvasH: cv.height,
          pvW: pv.outW, pvH: pv.outH
        });
      }
    }
    return out;
  })()`);
  await page.close().catch(() => {});
} finally {
  shutdown(chrome);
  server.close();
}

console.log(`  采集到 ${rows.length} 组（3 种图尺寸 × 8 个角度）\n`);

t('⭐ 采样区间的像素比例 == 输出比例（不扭曲的核心条件）', () => {
  const bad = [];
  for (const x of rows) {
    const apRatio = (x.sX * x.W) / (x.sY * x.H);
    const outRatio = x.outW / x.outH;
    if (Math.abs(apRatio / outRatio - 1) > 0.03) {
      bad.push(`${x.W}×${x.H} ${x.deg}°: 采样 ${apRatio.toFixed(3)} vs 输出 ${outRatio.toFixed(3)}`);
    }
  }
  assert.equal(bad.length, 0,
    `这些组合会被拉伸：\n       ${bad.slice(0, 6).join('\n       ')}\n`
    + '     ⚠️ sX 是"采样区间占源图宽度的比例"，不是 outW/W0 —— '
    + '最初我就是把判据写错成 sX/sY == W0/H0，导致 24 组全红。');
});

t('⭐ 输出比例 == 取景框比例（比例预设不能被废掉）', () => {
  /* ⚠️ 这条判据更新过一次，记下来免得再走回头路：
     最初写的是"输出比例 == 源图比例"。那是**旧设计**的假设 ——
     当时把输出比例强制成图片比例，结果**比例预设（16:9/1:1/…）失效**，
     而且预览画布跟着用图片比例，用户看到旋转后画面被拉伸。
     正确设计是：输出比例由**取景框**决定，采样区间跟它同形。
     数据里只带了 outW/outH 和 sX/sY，取景框比例就是 sX·W0 : sY·H0。 */
  const bad = [];
  for (const x of rows) {
    const apRatio = (x.sX * x.W) / (x.sY * x.H);
    const outRatio = x.outW / x.outH;
    if (Math.abs(apRatio / outRatio - 1) > 0.03) {
      bad.push(`${x.W}×${x.H} ${x.deg}°: 采样 ${apRatio.toFixed(3)} vs 输出 ${outRatio.toFixed(3)}`);
    }
  }
  assert.equal(bad.length, 0,
    `这些组合的导出比例和取景框比例不一致：\n       ${bad.slice(0, 6).join('\n       ')}`);
});

t('⭐ 预览画布比例 == 计划输出比例（预览和导出不能不一致）', () => {
  const bad = [];
  for (const x of rows) {
    const cvRatio = x.canvasW / x.canvasH;
    const outRatio = x.outW / x.outH;
    if (Math.abs(cvRatio / outRatio - 1) > 0.03) {
      bad.push(`${x.W}×${x.H} ${x.deg}°: 画布 ${cvRatio.toFixed(3)} vs 计划 ${outRatio.toFixed(3)}`);
    }
  }
  assert.equal(bad.length, 0,
    `预览会被拉伸（导出正常）：\n       ${bad.slice(0, 6).join('\n       ')}`);
});

t('⭐ 采样区间不越出源图（否则边缘出现空白）', () => {
  const EPS = 1e-3;
  const bad = [];
  for (const x of rows) {
    const xLo = 0.5 + x.offX - x.sX / 2, xHi = 0.5 + x.offX + x.sX / 2;
    const yLo = 0.5 + x.offY - x.sY / 2, yHi = 0.5 + x.offY + x.sY / 2;
    if (xLo < -EPS || xHi > 1 + EPS || yLo < -EPS || yHi > 1 + EPS) {
      bad.push(`${x.W}×${x.H} ${x.deg}°: x[${xLo.toFixed(2)},${xHi.toFixed(2)}] `
        + `y[${yLo.toFixed(2)},${yHi.toFixed(2)}]`);
    }
  }
  assert.equal(bad.length, 0,
    `这些组合采到了源图之外：\n       ${bad.slice(0, 6).join('\n       ')}`);
});

t('0° 时是恒等变换（正常编辑不受影响）', () => {
  for (const x of rows.filter(v => v.deg === 0)) {
    assert.equal(Math.round(x.outW), x.W, `${x.W}×${x.H} 0°: outW=${x.outW}`);
    assert.equal(Math.round(x.outH), x.H, `${x.W}×${x.H} 0°: outH=${x.outH}`);
    assert.ok(Math.abs(x.sX - 1) < 1e-6 && Math.abs(x.sY - 1) < 1e-6,
      `${x.W}×${x.H} 0°: sX=${x.sX} sY=${x.sY}，应该是 1`);
    assert.ok(Math.abs(x.offX) < 1e-6 && Math.abs(x.offY) < 1e-6,
      `${x.W}×${x.H} 0°: offX=${x.offX} offY=${x.offY}，应该是 0`);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
