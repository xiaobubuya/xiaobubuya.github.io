/* ================================================================
   裁剪映射探针 —— 一次运行、同一份代码、可自洽核对
   ----------------------------------------------------------------
   ⚠️ 这个文件曾经有个"v1"，是分好几轮跑的版本，而中间改过 studio.js，
   于是"这一轮测的"和"上一轮测的"混在一起看，得出了自相矛盾的结论
   （同一个 rect 那次说中心偏 +0.125、这次说偏 -0.25），
   白绕了很久。**v1 已删除** —— 留着只会让人再去读它。
   教训：**在改代码的过程中不要跨轮次比较数字**，
   要么一次跑完全部场景，要么每轮都记下当时的代码状态。

   这个版本一次跑完全部场景，并在同一份代码下把
   「shader 实收的 uniform」和「实测采样区间」放在一起对照。

   做法：造一张纯"行编码"图（绿通道 = 图像行位置 0..1），
   裁剪后扫输出画布的上下两边，直接读出采到的 srcV 区间，
   再和公式 `[0.5 + offY - sY/2, 0.5 + offY + sY/2]` 对比。

   用法：node test/_probe-crop-map.mjs
   ================================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, shutdown } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.CROP_PROBE_PORT || 8892);

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
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(p, '127.0.0.1');
    });
    ACTUAL = p; break;
  } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
}

const URL_ = `http://127.0.0.1:${ACTUAL}/studio.html?v=${Date.now()}`;
console.log(`\n裁剪映射探针 v2   静态服务 :${ACTUAL}\n`);

const SCRIPT = `(async () => {
  const out = { cases: [] };
  const dl = Date.now() + 20000;
  while (Date.now() < dl) {
    const s = document.getElementById('stSliders');
    if (window.Studio && window.Studio.enterCrop && s && s.children.length) break;
    await new Promise(r => setTimeout(r, 60));
  }
  if (!window.Studio || !window.Studio.enterCrop) return { error: 'no Studio.enterCrop' };

  const W = 400, H = 300;

  /* 行编码图：绿通道 = 图像行位置（0 = 图上边） */
  function makeRowCoded() {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const im = g.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const gv = Math.round(255 * y / (H - 1));
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        im.data[i] = 0; im.data[i + 1] = gv; im.data[i + 2] = 0; im.data[i + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
    return c;
  }

  async function load(canvas) {
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    await window.Studio.openFile(new File([blob], 'rowcoded.png', { type: 'image/png' }));
    window.Studio.resetAll();
    await new Promise(r => setTimeout(r, 120));
  }

  /** 输出画布某一竖列(取 x=中)的采样 v 随 outY 的变化 */
  function column(c) {
    const gl = c.getContext('webgl', { preserveDrawingBuffer: true });
    const x = Math.floor(c.width / 2);
    const vals = [];
    const N = 9;
    for (let j = 0; j < N; j++) {
      const outY = j / (N - 1);
      // outY=0 是画面**顶** → framebuffer 行号最大
      const glY = Math.round((c.height - 1) * (1 - outY));
      const b = new Uint8Array(4);
      gl.readPixels(x, glY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
      vals.push({ outY: +outY.toFixed(3), G: b[1], srcV: +(b[1] / 255).toFixed(3) });
    }
    return { w: c.width, h: c.height, vals };
  }

  async function run(name, rect, rot) {
    await load(makeRowCoded());
    window.Studio.enterCrop();
    window.Studio.setCropRotation(rot || 0);
    window.Studio.setCropRect(rect);
    const plan = window.Studio.cropRenderPlan(false);
    const uni = window.Studio._geometryUniforms();
    const col = column(window.Studio._canvas());
    const rectNow = window.Studio.crop.rect;

    // 应用后（烘焙）再看一次：img 本身的行映射
    let baked = null;
    if (!rot) {
      await window.Studio.applyCrop();
      const bi = window.Studio.image;
      const c2 = document.createElement('canvas');
      c2.width = bi.width; c2.height = bi.height;
      const g2 = c2.getContext('2d');
      g2.drawImage(bi, 0, 0);
      const xm = Math.floor(bi.width / 2);
      baked = {
        size: [bi.width, bi.height],
        topV: +(g2.getImageData(xm, 1, 1, 1).data[1] / 255).toFixed(3),
        botV: +(g2.getImageData(xm, bi.height - 2, 1, 1).data[1] / 255).toFixed(3)
      };
    }

    out.cases.push({
      name, rectIn: rect, rectNow, rot: rot || 0,
      plan: plan ? { outW: plan.outW, outH: plan.outH,
        sX: +plan.sX.toFixed(4), sY: +plan.sY.toFixed(4),
        offX: +plan.offX.toFixed(4), offY: +plan.offY.toFixed(4) } : null,
      uni: { scale: uni.scale, offset: uni.offset, canvas: uni.canvas, viewport: uni.viewport },
      col, baked
    });
  }

  // 0°：整幅 / 取上半 / 取下半 / 左上 1/4 / 右下 1/4 / 中间一半
  await run('0° 全幅',        { x: 0, y: 0, w: 1, h: 1 });
  await run('0° 画面上半',     { x: 0, y: 0.5, w: 1, h: 0.5 });
  await run('0° 画面下半',     { x: 0, y: 0, w: 1, h: 0.5 });
  await run('0° 左上 1/4',     { x: 0, y: 0.5, w: 0.5, h: 0.5 });
  await run('0° 右下 1/4',     { x: 0.5, y: 0, w: 0.5, h: 0.5 });
  await run('0° 竖直中段一半',  { x: 0, y: 0.25, w: 1, h: 0.5 });

  return out;
})()`;

const chrome = await launch();
const page = await openPage(chrome.port, URL_);
const r = await page.eval(SCRIPT);
await page.close().catch(() => {});
shutdown(chrome);
server.close();

if (r.error) { console.log('页面报错：' + r.error); process.exit(1); }

for (const c of r.cases) {
  console.log('━'.repeat(72));
  console.log(`【${c.name}】  输入 rect=${JSON.stringify(c.rectIn)}  rot=${c.rot}`);
  console.log(`   生效 rect=${JSON.stringify(c.rectNow)}`);
  if (c.plan) {
    console.log(`   计划 outW=${c.plan.outW} outH=${c.plan.outH} `
      + `sX=${c.plan.sX} sY=${c.plan.sY} offX=${c.plan.offX} offY=${c.plan.offY}`);
  }
  console.log(`   shader 实收 scale=[${c.uni.scale[0]}, ${c.uni.scale[1]}] `
    + `offset=[${c.uni.offset[0]}, ${c.uni.offset[1]}]  canvas=${c.uni.canvas} viewport=${c.uni.viewport}`);

  if (c.plan) {
    const expTop = 0.5 + c.plan.offY - c.plan.sY / 2;   // outY=0（画面顶）
    const expBot = 0.5 + c.plan.offY + c.plan.sY / 2;   // outY=1（画面底）
    console.log(`   公式预期 srcV: 顶=${expTop.toFixed(3)} 底=${expBot.toFixed(3)}`);
  }
  const first = c.col.vals[0], last = c.col.vals[c.col.vals.length - 1];
  console.log(`   实测 srcV:     顶=${first.srcV} 底=${last.srcV}   `
    + `(画布 ${c.col.w}×${c.col.h})`);
  console.log('   逐点: ' + c.col.vals.map(v => `${v.outY}→${v.srcV}`).join('  '));
  if (c.baked) {
    console.log(`   烘焙后 ${c.baked.size[0]}×${c.baked.size[1]}：顶部 srcV=${c.baked.topV} `
      + `底部 srcV=${c.baked.botV}`);
  }
}
console.log('');

process.exit(0);
