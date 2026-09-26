/* ================================================================
   自动水平校正 —— 真 Chrome 实测（数值正确性）
   ----------------------------------------------------------------
   用户要的："把稍微歪的图片自动修正"。

   ⚠️ 为什么必须读真像素、不能静态测：
   `detectStraightenAngle` 的正确性**完全是数值问题** ——
   "对一张歪了 3° 的图，它要返回 ≈ -3°"。静态只能验"函数在不在"，
   验不了准不准。所以这里在浏览器里**造已知倾斜的图**再量。

   判据（每一条都独立可判对错）：
     ① 造一张倾斜 φ 的图 → 检测结果应该 ≈ -φ（符号：正值=逆时针）
     ② 多个角度都要准（不是只有某个角度碰巧对）
     ③ 已经正了的图 → 返回 0 或不动作（不能"没歪也硬转"）
     ④ 纯色/没边的图 → 返回 null（要有"没把握就不动作"的出口）
     ⑤ 点按钮真的会把角度设到旋转滑杆上（接线，不只是算法）

   ⚠️ 合成图怎么造才公平：只在**频率内容**上模拟真实照片。
   真实照片里的地平线是"两块大面积色块的交界"，所以这里是
   "上半亮下半暗 + 一个夹角"的倾斜分界，而不是画几根细线
   （细线的梯度太强，会让检测器显得比实际更好用）。
   ================================================================ */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, shutdown } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.STRAIGHTEN_PORT || 8902);

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

console.log('\n=== 自动水平校正（真 Chrome，造已知倾斜的图）===\n');

const chrome = await launch();
let R = {};
try {
  const page = await openPage(chrome.port,
    `http://127.0.0.1:${ACTUAL}/studio.html?v=${Date.now()}`);
  await page.eval(`(async () => {
    const dl = Date.now() + 20000;
    while (Date.now() < dl) {
      if (window.Studio && window.Studio.detectStraightenAngle) return true;
      await new Promise(r => setTimeout(r, 60));
    }
    throw new Error('修图页 20 秒没就绪');
  })()`);

  R = await page.eval(`(async () => {
    const S = window.Studio;
    const out = { cases: [], flat: null, edge: null, ui: null };

    /* 造一张"倾斜 φ 度"的照片：上半亮（天空）、下半暗（地面），
       分界线倾斜 φ。
       ⚠️⚠️ 用**直线方程**逐像素画，不要"画正的水平线再转整块 canvas"。
       后者会把画布四个角转出背景色，形成四条**又长又直的边框**——
       那是最强的直线，检测器会去匹配它们而不是地平线。
       实测（第一版就是这么写的）：真实 1.5° 被报成 2.2°、6° 被报成 9°，
       偏差随角度放大得很有规律 —— 看着像"算法不准"，
       其实是**测试图自己长出了假的地平线**。 */
    function makeTilted(W, H, deg, noise) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const tan = Math.tan(deg * Math.PI / 180);
      const im = g.createImageData(W, H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const lineY = H / 2 + tan * (x - W / 2);
          const up = y < lineY;
          let v = up ? 232 : 48;
          if (noise) v += (Math.random() - 0.5) * noise;
          const i = (y * W + x) * 4;
          im.data[i] = v; im.data[i + 1] = v; im.data[i + 2] = v;
          im.data[i + 3] = 255;
        }
      }
      g.putImageData(im, 0, 0);
      return c;
    }

    /** 取一张 canvas 的 ImageData（缩放后），喂给检测器 */
    function probe(canvas, maxSide) {
      const W0 = canvas.width, H0 = canvas.height;
      const k = Math.min(1, (maxSide || 720) / Math.max(W0, H0));
      const w = Math.max(16, Math.round(W0 * k));
      const h = Math.max(16, Math.round(H0 * k));
      const t = document.createElement('canvas');
      t.width = w; t.height = h;
      const g = t.getContext('2d');
      g.drawImage(canvas, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h);
      return S.detectStraightenAngle(d.data, w, h);
    }

    /* ① 多个已知角度 */
    for (const deg of [-6, -3.5, -1.5, 1.5, 3.5, 6]) {
      const r = probe(makeTilted(900, 600, deg, 0));
      out.cases.push({ tilt: deg, got: r ? r.deg : null, score: r ? r.score : null });
    }

    /* ② 已经正了 */
    const flat = probe(makeTilted(900, 600, 0, 0));
    out.flat = { got: flat ? flat.deg : null };

    /* ③ 纯色（没有边）→ 应该返回 null，不动作 */
    {
      const c = document.createElement('canvas');
      c.width = 600; c.height = 400;
      const g = c.getContext('2d');
      g.fillStyle = '#808080'; g.fillRect(0, 0, 600, 400);
      const d = g.getImageData(0, 0, 600, 400);
      out.flatColor = S.detectStraightenAngle(d.data, 600, 400);
    }

    /* ④ 带噪声的真实感图（噪声不该把结果带跑） */
    for (const deg of [-4, 4]) {
      const r = probe(makeTilted(900, 600, deg, 24));
      out.cases.push({ tilt: deg, got: r ? r.deg : null, noisy: true,
                       score: r ? r.score : null });
    }

    /* ⑤ 接线：点按钮真的把角度设到滑杆上 */
    {
      const t2 = makeTilted(900, 600, 3, 0);
      const blob = await new Promise(r => t2.toBlob(r, 'image/png'));
      await S.openFile(new File([blob], 'tilted.png', { type: 'image/png' }));
      S.resetAll();
      S.enterRotate();
      S.setDisplay({ rotate: 0 });
      const clicked = (() => {
        const b = document.getElementById('stStraighten');
        if (!b) return false;
        b.click();
        return true;
      })();
      out.ui = {
        clicked,
        rotAfter: S.geom ? S.geom.rot : null,
        slider: Number(document.getElementById('stCropRot').value)
      };
    }

    return out;
  })()`);
  await page.close().catch(() => {});
} finally {
  shutdown(chrome);
  server.close();
}

const fmt = v => (v == null ? 'null' : Number(v).toFixed(2));

t('⭐ 倾斜 φ 的图，检测结果 ≈ -φ（符号：正值 = 逆时针）', () => {
  const bad = [];
  for (const c of R.cases) {
    if (c.got == null) { bad.push(`倾斜 ${c.tilt}° → 返回 null（没检测出来）`); continue; }
    const err = Math.abs(c.got - (-c.tilt));
    // 容差 0.8°：合成图的量化 + 720 缩略图分辨率带来的极限大概在这
    if (err > 0.8) {
      bad.push(`倾斜 ${c.tilt}° → 得到 ${fmt(c.got)}°（期望 ${fmt(-c.tilt)}°，`
        + `差 ${err.toFixed(2)}°）`);
    }
  }
  assert.equal(bad.length, 0,
    `检测角度不准：\n       ${bad.join('\n       ')}`);
});

t('符号方向正确：顺时针歪的图要往逆时针修', () => {
  /* ⚠️ 这条单独拎出来，因为**符号反了是最容易犯又最容易漏的错**：
     它仍然"看起来在工作"（角度数值差不多），只是越修越歪。
     判据：倾斜 +3.5°（顺时针）→ 修正量应该是负的（逆时针为正的约定下）。 */
  const pos = R.cases.find(c => c.tilt === 3.5);
  const neg = R.cases.find(c => c.tilt === -3.5);
  assert.ok(pos && neg, '没拿到 ±3.5° 的样本');
  assert.ok(pos.got < 0, `倾斜 +3.5° 的修正量应该是负的，实际 ${fmt(pos.got)}`);
  assert.ok(neg.got > 0, `倾斜 -3.5° 的修正量应该是正的，实际 ${fmt(neg.got)}`);
});

t('⭐ 已经正了的图不动它（不能"没歪也硬转"）', () => {
  /* ⚠️ 容差 0.3°：合成图的分界线是阶梯状的（逐像素），
     量化本身带来大约 0.05° 的偏差。0.3° 远小于"人眼能看出的歪"，
     而 autoStraighten 内部还有 0.15° 的"太小就不动"门槛。 */
  assert.ok(R.flat.got != null, '正的图不该返回 null');
  assert.ok(Math.abs(R.flat.got) <= 0.3,
    `已经正了的图应该给出 ≈0 的修正量，实际 ${fmt(R.flat.got)}°`);
});

t('⭐ 纯色图返回 null（有"没把握就不动作"的出口）', () => {
  /* 这条守的是"宁可不做，不要乱做"：
     找不到边就不该硬给一个角度 —— 用户会得到一个莫名其妙歪掉的图。 */
  assert.equal(R.flatColor, null,
    `纯色图应该返回 null，实际 ${JSON.stringify(R.flatColor)}`);
});

t('带噪声也稳（真实照片不会像合成图那么干净）', () => {
  const noisy = R.cases.filter(c => c.noisy);
  assert.ok(noisy.length >= 2, '没拿到带噪声的样本');
  const bad = noisy.filter(c => c.got == null
    || Math.abs(c.got - (-c.tilt)) > 1.2);
  assert.equal(bad.length, 0,
    `带噪声时检测不稳：${bad.map(c => `${c.tilt}°→${fmt(c.got)}`).join(' ')}`);
});

t('⭐ 点「自动水平校正」真的把角度设到旋转滑杆上（接线）', () => {
  assert.equal(R.ui.clicked, true, '没找到 #stStraighten 按钮');
  assert.ok(R.ui.rotAfter != null,
    '点完之后 geom 不该是 null（说明自动校正没生效）');
  /* 倾斜 +3° → 修正量应该 ≈ -3° */
  assert.ok(Math.abs(R.ui.rotAfter - (-3)) < 1.2,
    `倾斜 3° 的图点自动校正后 rot 应该 ≈ -3°，实际 ${fmt(R.ui.rotAfter)}°`);
  assert.ok(Math.abs(R.ui.slider - R.ui.rotAfter) < 1.01,
    `滑杆（${R.ui.slider}）应该跟着显示实际角度（${fmt(R.ui.rotAfter)}）`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
