/* ================================================================
   裁剪 / 旋转 / 翻转 —— 浏览器实测（交互 + 烘焙）
   ----------------------------------------------------------------
   ⚠️ 这份测试**重写**过。旧版守的是旧模型的"旋转后自动收框"
   （内接矩形、采到旋转框哪个位置、预览比例 == 导出比例），
   那套已经被用户否掉：

     "裁剪和翻转做复杂了，不需要做数学运算，裁剪和旋转分开做"

   新模型下这份文件专注**交互与烘焙**（纯几何不变量在
   test/rotate-invariant.test.mjs 和 crop-geometry.test.mjs 里）：

     ① 不在几何编辑时是恒等变换（正常编辑不受影响）
     ② 进裁剪后取景框覆盖整个视口，画布 = 视口
     ③ 拖小取景框**不会让画面平移**（画布中心始终是图片中心）
        —— 这是"uImgOffset 恒为 0"那条不变量的交互面
     ④ 应用裁剪：输出尺寸 = 取景框那块，且内容真的是那一块
     ⑤ 取消不留下任何痕迹
     ⑥ 90° 整转：尺寸互换 + 内容真的转过去了 + 结果和预览一致
   ================================================================ */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, shutdown } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.CROP_PORT || 8896);

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

/* 端口被占就往后找 —— 不能让整个文件静默消失（踩过：run-all 会显示
   "通过 0 失败 0"，看起来像通过）。 */
let ACTUAL_PORT = PORT;
for (let p = PORT; p < PORT + 10; p++) {
  try {
    await new Promise((ok, no) => {
      const onErr = e => { server.removeListener('listening', onOk); no(e); };
      const onOk = () => { server.removeListener('error', onErr); ok(); };
      server.once('error', onErr); server.once('listening', onOk);
      server.listen(p, '127.0.0.1');
    });
    ACTUAL_PORT = p; break;
  } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
}
if (ACTUAL_PORT !== PORT) console.log(`\n  ⚠️ ${PORT} 被占用，改用 ${ACTUAL_PORT}\n`);
const URL = `http://127.0.0.1:${ACTUAL_PORT}/studio.html?v=${Date.now()}`;

let pass = 0, fail = 0;
const rgb = p => 'rgb(' + p.join(',') + ')';
const isDarkBg = p => p[0] < 45 && p[1] < 45 && p[2] < 45;
const isRed = p => p[0] > 150 && p[1] < 90 && p[2] < 90;

const chrome = await launch();
let R = {};
try {
  const page = await openPage(chrome.port, URL);
  await page.eval(`(async () => {
    const dl = Date.now() + 20000;
    while (Date.now() < dl) {
      const s = document.getElementById('stSliders');
      if (window.Studio && window.Studio.enterCrop && s && s.children.length) return true;
      await new Promise(r => setTimeout(r, 60));
    }
    throw new Error('修图页 20 秒没就绪');
  })()`);

  R = await page.eval(`(async () => {
    const S = window.Studio;
    const out = {};

    /** 位置编码图：R = x 位置、G = y 位置、B 恒 90。
     *  ⚠️ 用编码而不是色块：色块只能分象限，"整体偏 0.25"这种错看不出来。 */
    function makePos(W, H) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const im = g.createImageData(W, H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        im.data[i] = Math.round(255 * x / (W - 1));
        im.data[i + 1] = Math.round(255 * y / (H - 1));
        im.data[i + 2] = 90; im.data[i + 3] = 255;
      }
      g.putImageData(im, 0, 0);
      return c;
    }
    /** 四象限纯色：验朝向和 90° 整转 */
    function makeQuad(W, H) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#e02020'; g.fillRect(0, 0, W / 2, H / 2);
      g.fillStyle = '#20c020'; g.fillRect(W / 2, 0, W / 2, H / 2);
      g.fillStyle = '#2040e0'; g.fillRect(0, H / 2, W / 2, H / 2);
      g.fillStyle = '#f0f0f0'; g.fillRect(W / 2, H / 2, W / 2, H / 2);
      return c;
    }
    /** 灰底 + 左上角一个红方块：验"取景框真的只取那一块" */
    function makeMarked(W, H) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#808080'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#ff0000';
      g.fillRect(Math.round(W * 0.02), Math.round(H * 0.02),
                 Math.round(W * 0.20), Math.round(H * 0.20));
      return c;
    }
    async function load(canvas) {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      await S.openFile(new File([blob], 't.png', { type: 'image/png' }));
      S.resetAll();
    }
    /** 读画布上归一化坐标处的像素。
     *  ⚠️ readPixels 的行序是**自下而上**：v=0 是画面**下**边。 */
    function px(u, v) {
      const c = S._canvas();
      const g = c.getContext('webgl', { preserveDrawingBuffer: true });
      const b = new Uint8Array(4);
      g.readPixels(Math.round(u * (c.width - 1)), Math.round(v * (c.height - 1)),
                   1, 1, g.RGBA, g.UNSIGNED_BYTE, b);
      return [b[0], b[1], b[2]];
    }
    const W = 400, H = 300;

    /* ① 不在几何编辑时是恒等变换 */
    await load(makePos(W, H));
    /* ⚠️ 先显式退出几何编辑再量：geom 是模块级状态，前面几次
       enterCrop/enterRotate 可能把它留着（exitCrop(false) 会置 null）。 */
    const geomBeforeExit = JSON.stringify(S.geom);
    S.exitCrop(false);
    const geomAfterExit = JSON.stringify(S.geom);
    /* ⚠️⚠️ 这里必须存**快照**（普通值），不能存 S.geom 这个 getter 的
       求值结果 —— 我为此多花了一轮排查，原因很反直觉：
       CDP 把返回值序列化回测试侧时会**再读一次**所有属性，
       而 S.geom 是 getter，于是它读到的是"整个测试块跑完之后"的状态
       （那时后面的 step 已经把几何建起来了）。断言里打印出来的对象
       和当时真正的值（null）根本不是一个时刻的。
       教训：跨 CDP 边界的断言一律用**即时快照**，不要留 getter。
       ⚠️ 另外：这整段是包在外层模板字符串里的页面脚本，
       注释里不能再出现反引号（会把外层的模板提前闭合，直接语法错）。 */
    const geomSnap = S.geom === null ? null : JSON.parse(JSON.stringify(S.geom));
    const identity = { before: px(0.25, 0.75), canvas: [S._canvas().width, S._canvas().height],
                       geomSnap, geomBeforeExit, geomAfterExit };
    S.enterCrop();
    S.setDisplay({ rotate: 0, flipX: false, flipY: false, zoom: 1 });
    const identityAfter = { after: px(0.25, 0.75), canvas: [S._canvas().width, S._canvas().height],
                            geom: JSON.parse(JSON.stringify(S.geom)) };
    out.identity = { ...identity, ...identityAfter };

    /* ② 取景框初始覆盖整个视口（画布 = 视口） */
    out.initial = {
      rect: { ...S.geom.rect },
      canvas: [S._canvas().width, S._canvas().height],
      plan: (p => p && { outW: p.outW, outH: p.outH, bufW: p.bufW, bufH: p.bufH,
                         off: [p.offX, p.offY], s: p.screenZoom })(S.cropRenderPlan(false))
    };

    /* ③ 拖小取景框不该让画面平移 */
    const before = { c: px(0.5, 0.5), tl: px(0.25, 0.75) };
    S.setCropRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    const after = { c: px(0.5, 0.5), tl: px(0.25, 0.75) };
    out.panTest = { before, after, rect: { ...S.geom.rect },
                    canvas: [S._canvas().width, S._canvas().height],
                    plan: (p => p && { outW: p.outW, outH: p.outH,
                                       off: [p.offX, p.offY] })(S.cropRenderPlan(false)) };

    /* ④ 应用裁剪：输出 = 取景框那块，内容也是那一块 */
    /* ④ 应用裁剪：输出 = 取景框那块，内容也是那一块。
       ⚠️ 这里必须用**位置编码图**（makePos），不能用带红块的灰图 ——
       判据要读 R/G 的数值来钉住方向，红块只能回答"在不在"，
       而且它在图片左上，正好落在某些取景框里，判据不干净。 */
    await load(makePos(W, H));
    S.enterCrop();
    S.setDisplay({ zoom: 1 });
    S.setCropRect({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    const cropCenterBefore = px(0.5, 0.5);
    const beforeApply = S.bakeRenderPlan();
    await S.applyGeometry();
    const cropAfter = {
      beforeApply: beforeApply && { outW: beforeApply.outW, outH: beforeApply.outH,
                                    off: [beforeApply.offX, beforeApply.offY],
                                    s: beforeApply.screenZoom },
      trace: S._trace.slice(-3),
      size: [S.image.width, S.image.height],
      geom: S.geom,
      canvas: [S._canvas().width, S._canvas().height]
    };
    /* 取景框取**画面右上**那 1/4（x:0.5 起、y:0.5 起）。
       ⚠️ 为什么用位置编码图而不是"红块在不在"：
       红块在图片左上，取哪个象限都可能碰上它，判据不干净。
       位置编码图直接读数值：取右半边 → R 应该明显大于左半边，
       取上半边（画面 y 大）→ G 应该偏小。这样一条就同时钉住
       x 和 y 两个方向都没有反。
       结果画布 200×150，取它的四角读 R/G。 */
    const quadOf = (label, u, v) => {
      const c = S._canvas();
      const g = c.getContext('webgl', { preserveDrawingBuffer: true });
      const b = new Uint8Array(4);
      g.readPixels(Math.round(u * (c.width - 1)), Math.round(v * (c.height - 1)),
                   1, 1, g.RGBA, g.UNSIGNED_BYTE, b);
      return { label, u, v, rgb: [b[0], b[1], b[2]] };
    };
    const afterCorners = [
      quadOf('左下', 0.1, 0.1), quadOf('右下', 0.9, 0.1),
      quadOf('左上', 0.1, 0.9), quadOf('右上', 0.9, 0.9)
    ];
    out.applyCrop = { cropCenterBefore, cropAfter, afterCorners };

    /* ⑤ 取消不留下痕迹 */
    await load(makePos(W, H));
    const cancelBefore = px(0.25, 0.75);
    S.enterCrop();
    S.setDisplay({ rotate: 30, zoom: 1 });
    S.setCropRect({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    S.exitCrop(false);
    const cancelAfter = { px: px(0.25, 0.75), geom: S.geom,
                          canvas: [S._canvas().width, S._canvas().height] };
    out.cancel = { before: cancelBefore, ...cancelAfter };

    /* ⑥ 90° 整转 */
    await load(makeQuad(W, H));
    S.enterRotate();
    S.setDisplay({ rotate: 0, flipX: false, flipY: false, zoom: 1 });
    S.setCropRect({ x: 0, y: 0, w: 1, h: 1 });
    const q0 = { tl: px(0.25, 0.75), tr: px(0.75, 0.75),
                 bl: px(0.25, 0.25), br: px(0.75, 0.25) };
    const size0 = [S.image.width, S.image.height];
    await S.rotateQuarter(1);
    S.fitZoomToWindow();
    const q1 = { tl: px(0.25, 0.75), tr: px(0.75, 0.75),
                 bl: px(0.25, 0.25), br: px(0.75, 0.25) };
    out.quarter = { before: q0, after: q1, size0,
                    size: [S.image.width, S.image.height],
                    canvas: [S._canvas().width, S._canvas().height] };

    return out;
  })()`);
  await page.close().catch(() => {});
} finally {
  shutdown(chrome);
  server.close();
}

const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};
const isGreen = p => p[1] > 130 && p[0] < 120 && p[2] < 120;
const isBlue = p => p[2] > 150 && p[0] < 120 && p[1] < 120;
const isWhite = p => Math.min(...p) > 180;

/* ---------------- ① 恒等 ---------------- */
t('⭐ 不在几何编辑时是恒等变换（正常编辑不受影响）', () => {
  assert.equal(R.identity.geomSnap, null,
    '没进几何编辑时 geom 应该是 null，实际 '
    + JSON.stringify(R.identity.geomSnap)
    + '；exitCrop 前=' + R.identity.geomBeforeExit
    + ' 后=' + R.identity.geomAfterExit);
  const d = Math.max(...R.identity.before.map((v, i) =>
    Math.abs(v - R.identity.after[i])));
  assert.ok(d <= 3,
    `进几何编辑（0°/1x/不翻转）后画面不该变：`
    + `${rgb(R.identity.before)} → ${rgb(R.identity.after)}`);
});

/* ---------------- ② 初始状态 ---------------- */
t('进裁剪时取景框覆盖整个视口，画布 = 视口', () => {
  const r = R.initial.rect;
  assert.ok(Math.abs(r.x) < 1e-6 && Math.abs(r.y) < 1e-6
    && Math.abs(r.w - 1) < 1e-6 && Math.abs(r.h - 1) < 1e-6,
    `取景框初始应该是满幅 (0,0,1,1)，实际 ${JSON.stringify(r)}`);
  assert.equal(R.initial.canvas[0], R.initial.plan.bufW,
    '画布宽应该等于视口宽');
  assert.equal(R.initial.canvas[1], R.initial.plan.bufH,
    '画布高应该等于视口高');
});

/* ---------------- ③ 拖框不平移 ---------------- */
t('⭐⭐ 拖小取景框**不会让画面平移**（画布中心始终是图片中心）', () => {
  /* ⚠️ 这条守的是 uImgOffset 恒为 0 那条不变量。
     历史 bug：把 offset 写成"取景框中心相对图片中心的偏移"，
     于是收小取景框时画面整体偏了 0.25 —— 满幅时看不出来。 */
  const d = Math.max(...R.panTest.before.c.map((v, i) =>
    Math.abs(v - R.panTest.after.c[i])));
  assert.ok(d <= 3,
    `取景框收小后画面中心不该变：${rgb(R.panTest.before.c)} → `
    + `${rgb(R.panTest.after.c)}\n`
    + `     rect=${JSON.stringify(R.panTest.rect)} `
    + `plan.off=${JSON.stringify(R.panTest.plan && R.panTest.plan.off)}`);
  assert.equal(R.panTest.plan.off[0], 0, 'offset.x 必须恒为 0');
  assert.equal(R.panTest.plan.off[1], 0, 'offset.y 必须恒为 0');
});

t('取景框收小后输出尺寸跟着变小（输出 = 取景框那块）', () => {
  const p = R.panTest.plan;
  assert.ok(Math.abs(p.outW - 200) <= 1 && Math.abs(p.outH - 150) <= 1,
    `0.5×0.5 的取景框应该输出 200×150，实际 ${p.outW}×${p.outH}`);
});

/* ---------------- ④ 应用裁剪 ---------------- */
t('⭐ 应用裁剪：图片尺寸真的变成取景框那块', () => {
  assert.equal(R.applyCrop.cropAfter.size[0], 200,
    `400×300 取 0.5×0.5 应该得到 200 宽，实际 ${R.applyCrop.cropAfter.size[0]}`
    + `（烘焙计划 ${JSON.stringify(R.applyCrop.cropAfter.beforeApply)}）`);
  assert.equal(R.applyCrop.cropAfter.size[1], 150,
    `应该得到 150 高，实际 ${R.applyCrop.cropAfter.size[1]}`);
  assert.equal(R.applyCrop.cropAfter.geom, null,
    '应用之后几何状态应该清掉（不能留着继续变换）');
});

t('⭐⭐ 应用裁剪取的是**取景框那一块**（读位置编码，两个方向都钉住）', () => {
  /* 取景框取**画面右上**那 1/4。位置编码图 R = 图片 x 位置、G = 图片 y 位置。
     所以结果里应该看到：
       右半边的 R 明显大于左半边（x 方向没取反）
       上下的 G 差一个明显量（y 方向没颠倒）
     ⚠️ 不用"红块在不在"当判据：红块在图片左上，四个象限里有两个都会
     碰上它，判据不干净。位置编码直接读数值，一次钉住两个方向。 */
  const c = R.applyCrop.afterCorners;
  const at = n => c.find(x => x.label === n).rgb;
  const [bl, br, tl, tr] = [at('左下'), at('右下'), at('左上'), at('右上')];
  const msg = c.map(x => `${x.label}=${rgb(x.rgb)}`).join(' ');
  assert.ok(bl[0] < 170 && tl[0] < 170,
    `结果左半边应该是图片左半（R 偏小），实际 ${msg}`);
  assert.ok(br[0] > 200 && tr[0] > 200,
    `结果右半边应该是图片右半（R 偏大），实际 ${msg}`);
  const gTop = (tl[1] + tr[1]) / 2, gBot = (bl[1] + br[1]) / 2;
  assert.ok(gTop < gBot - 20,
    `结果上边应该是图片偏上（G 偏小），实际 上=${gTop.toFixed(0)} `
    + `下=${gBot.toFixed(0)}（${msg}）—— 反了说明 y 方向颠倒了`);
});

/* ---------------- ⑤ 取消 ---------------- */
t('⭐ 取消裁剪后回到恒等变换（不能留下歪的画面）', () => {
  assert.equal(R.cancel.geom, null, '取消后 geom 应该是 null');
  const d = Math.max(...R.cancel.before.map((v, i) =>
    Math.abs(v - R.cancel.px[i])));
  assert.ok(d <= 3,
    `取消后画面应该回到原样：${rgb(R.cancel.before)} → ${rgb(R.cancel.px)}`);
});

/* ---------------- ⑥ 90° 整转 ---------------- */
t('⭐ 90° 整转：尺寸互换', () => {
  assert.deepEqual(R.quarter.size0, [400, 300], '基准尺寸应该是 400×300');
  assert.ok(Math.abs(R.quarter.size[0] - 300) <= 1,
    `转 90° 后宽应该是 300，实际 ${R.quarter.size[0]}`);
  assert.ok(Math.abs(R.quarter.size[1] - 400) <= 1,
    `转 90° 后高应该是 400，实际 ${R.quarter.size[1]}`);
});

t('⭐⭐ 90° 整转：内容真的顺时针转过去了（红从左上到右上）', () => {
  const b = R.quarter.before, a = R.quarter.after;
  assert.ok(isRed(b.tl), `基准左上应该红，实际 ${rgb(b.tl)}`);
  assert.ok(isRed(a.tr),
    `顺时针 90° 后右上应该是红（原来的左上），实际 ${rgb(a.tr)}；`
    + `四象限 = 左上${rgb(a.tl)} 右上${rgb(a.tr)} `
    + `左下${rgb(a.bl)} 右下${rgb(a.br)}`);
  assert.ok(isBlue(a.tl), `左上应该是蓝（原来的左下），实际 ${rgb(a.tl)}`);
  assert.ok(isWhite(a.bl), `左下应该是白（原来的右下），实际 ${rgb(a.bl)}`);
  assert.ok(isGreen(a.br), `右下应该是绿（原来的右上），实际 ${rgb(a.br)}`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
