/* ================================================================
   旋转 / 裁剪：真 Chrome + WebGL 的不变量
   ----------------------------------------------------------------
   ⚠️⚠️ 这份测试**重写**过。旧版守的是"旋转后自动保持原图比例、
   绝不裁切露白"—— 那套已经被用户明确否掉：

     "裁剪和翻转做复杂了，不需要做数学运算，裁剪和旋转分开做"
     "不要做运算，就是单纯的度数旋转，不涉及取景框收框，
      超出取景框范围展示上就是截断即可，
      把图片缩小后可以正常展示完整"

   新模型下要守的是这五条：
     ① 显示变换是**相似变换**：shader 里只有一个标量缩放（不是两个轴各一个）
     ② 恒等：角度 0 / 缩放 1 / 不翻转时，画面和原图完全一致
     ③ **单纯的度数旋转**：转过 θ 之后，画面里某个标记点的位置必须等于
        按 θ 旋转算出来的位置（用**位置**判，不用颜色 —— 颜色判据太粗，
        历史上有 15 项全绿却漏掉"整体偏半格"的记录）
     ④ 露到原图外的部分 = 深色底（不是黑、不是拉伸出来的条纹）
     ⑤ 翻转：水平翻转后左右互换、上下不变；垂直翻转反之
     ⑥ 裁剪取景框真的只取那一块

   ⚠️ 判据为什么用"位置编码图"而不是色块：
   色块只能验"大概是哪个象限"，验不出"偏了 5%"。而几何 bug 的典型
   症状恰恰是"整体偏一点"。位置编码图把坐标变成可读的数字，
   偏多少一目了然。
   ================================================================ */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, shutdown } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
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

console.log('\n=== 旋转 / 裁剪（真 Chrome + WebGL）===\n');

const chrome = await launch();
let R = {};
try {
  const page = await openPage(chrome.port,
    `http://127.0.0.1:${ACTUAL}/studio.html?v=${Date.now()}`);
  await page.eval(`(async () => {
    const dl = Date.now() + 20000;
    while (Date.now() < dl) {
      if (window.Studio && window.Studio.setDisplay
          && document.getElementById('stSliders').children.length) return true;
      await new Promise(r => setTimeout(r, 60));
    }
    throw new Error('修图页 20 秒没就绪');
  })()`);

  R = await page.eval(`(async () => {
    const S = window.Studio;
    const out = {};

    /* ================================================================
       测试图：**位置编码**。
       ----------------------------------------------------------------
       R = x 位置（0=左,255=右），G = y 位置（0=上,255=下），B = 常量。
       ⚠️ 为什么不用色块：色块只能分象限，"整体偏半格"这类错看不出来。
       编码之后一个采样点就能读出"这一像素对应原图哪个位置"。
       ⚠️ B 通道给 90 是为了区分"深色底"（B 很小）和"图片内容"
       （B 恒 90）—— 深色底是 (22,21,20)，B=20，和 90 差得远。
       ================================================================ */
    function makePos(W, H) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const im = g.createImageData(W, H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          im.data[i] = Math.round(255 * x / (W - 1));
          im.data[i + 1] = Math.round(255 * y / (H - 1));
          im.data[i + 2] = 90;
          im.data[i + 3] = 255;
        }
      }
      g.putImageData(im, 0, 0);
      return c;
    }
    /** 纯中灰：用来验"露出来的角是不是深色底" */
    function makeGray(W, H) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#808080'; g.fillRect(0, 0, W, H);
      return c;
    }
    /** 中灰 + 一个**不对称的红标记**：用来验旋转方向。
     *  ⚠️ 位置编码图是中心对称的（R=x、G=y），180° 旋转之后完全一样，
     *  所以它**验不出方向**。标记必须不对称。 */
    function makeMarker(W, H) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#808080'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#ff0000';
      // 偏左上四分之一处的小方块（中心 ≈ 图片 (0.25, 0.25)）
      g.fillRect(Math.round(W * 0.20), Math.round(H * 0.20),
                 Math.round(W * 0.10), Math.round(H * 0.10));
      return c;
    }
    /** 找红标记的重心（返回归一化 canvas 坐标；找不到返回 null）
     *  ⚠️ 判据必须**同时**要"很红"和"明显不是灰"：
     *  位置编码图的红色通道在右边缘就是 255，只判 R>180 会把整条右边缘
     *  当成标记，重心被拉到右边（实测读到 (0.04, 0.96)，而标记其实在
     *  (0.04, 0.04) —— 是**测试**的判据不严，不是渲染错了）。 */
    function markerAt(step) {
      const c = S._canvas();
      const g = c.getContext('webgl', { preserveDrawingBuffer: true });
      const w = c.width, h = c.height;
      const buf = new Uint8Array(w * h * 4);
      g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, buf);
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const i = (y * w + x) * 4;
          const R = buf[i], G = buf[i + 1], B = buf[i + 2];
          if (R > 170 && R - G > 110 && R - B > 110 && G < 110 && B < 110) {
            sx += x; sy += y; n++;
          }
        }
      }
      if (!n) return null;
      return { u: (sx / n) / (w - 1), v: (sy / n) / (h - 1), n };
    }
    /** 四象限不同色：验翻转 */
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
    async function load(canvas) {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      await S.openFile(new File([blob], 't.png', { type: 'image/png' }));
      S.resetAll();
    }
    /** 读画布上归一化坐标 (u,v) 处的像素。
     *  ⚠️ readPixels 用 GL 坐标（y=0 在**下**边），所以 v=0 表示**下**方。 */
    function px(u, v) {
      const c = S._canvas();
      const g = c.getContext('webgl', { preserveDrawingBuffer: true });
      const buf = new Uint8Array(4);
      g.readPixels(Math.round(u * (c.width - 1)), Math.round(v * (c.height - 1)),
                   1, 1, g.RGBA, g.UNSIGNED_BYTE, buf);
      return [buf[0], buf[1], buf[2]];
    }
    const isDarkBg = p => p[2] < 45 && p[0] < 45 && p[1] < 45;

    const W = 400, H = 300;

    /* ================================================================
       ① 显示变换是不是相似变换 —— 直接读 shader uniform
       ================================================================ */
    await load(makePos(W, H));
    S.enterRotate();
    const u0 = S._geometryUniforms();
    S.setDisplay({ rotate: 25 });
    const u25 = S._geometryUniforms();
    out.uniforms = {
      zero: { rot: u0.rot, flip: u0.flip, scale: u0.scale },
      turn: { rot: u25.rot, flip: u25.flip, scale: u25.scale },
    };

    /* ================================================================
       ② 恒等
       ----------------------------------------------------------------
       ⚠️ 两个状态的**画布尺寸不一样**，所以不能直接拿同一个 (u,v) 对比：
         · 不在几何编辑时：画布按"图片比例 contain 进可用空间"建，
           CSS 尺寸和图片的归一化坐标是同一套，但后备缓冲会乘 dpr
           （实测 489×441 而 CSS 宽 400px）。
         · 在几何编辑时：画布 = 视口/zoom，尺寸又换一套。
       第一版直接比同一个 (u,v)，于是"恒等"报出 rgb(97,43,90) →
       rgb(64,64,90) —— 那是**两次量的不是同一个物理点**，不是渲染错了。

       正确做法：选**画布中心**这个两边都界定明确、且不依赖尺寸的点。
       中心在两种状态下都对应"视口中心"，而视口中心在 zoom=1、rect 满幅
       时就是图片中心 —— 所以两边读到的应该都是原图中心 (127,127)。
       ================================================================ */
    await load(makePos(W, H));
    const cvA = S._canvas();
    const idBefore = px(0.5, 0.5);
    const idBeforeSize = [cvA.width, cvA.height, cvA.style.width];
    S.enterRotate();
    S.setDisplay({ rotate: 0, zoom: 1 });
    const idAfter = px(0.5, 0.5);
    out.identity = { before: idBefore, after: idAfter, idBeforeSize,
                     geom: JSON.parse(JSON.stringify(S.geom)),
                     canvas: [S._canvas().width, S._canvas().height],
                     uni: S._geometryUniforms() };

    /* ================================================================
       ③ 旋转方向与角度：用**不对称标记**的重心验
       ----------------------------------------------------------------
       标记在图片的 (0.25, 0.25)（左上偏内）。用 canvas 的 u-v 表示时
       v 向上，所以 0° 时它在画面的 (0.25, 0.75)。
       转过 θ（逆时针为正）之后，画面上的位置是
             dx = P.u - 0.5,  dy = P.v - 0.5      （P = (0.25, 0.75)）
             u' = 0.5 + z·( cosθ·dx - sinθ·dy)
             v' = 0.5 + z·( sinθ·dx + cosθ·dy)
       其中 z 是当时的显示缩放（"适合窗口"那一档）。
       这个式子是从 shader 的映射反解出来的：
         shader 做 u_img = R(-θ)·(uv-0.5)/z + 0.5 + off，
         所以画面点 P 看到的是 R(-θ)P 的内容，等价于图片点 P_img
         出现在画面 R(θ)P_img 上。
       ================================================================ */
    out.marker = [];
    const P = { u: 0.25, v: 0.25 };            // 标记在图片上的位置（左上偏内）
    for (const deg of [0, 20, -20, 35]) {
      await load(makeMarker(W, H));
      S.enterRotate();
      /* 用"适合窗口"的缩放到"整张图都看得见"，这样
          ① 标记一定在画面里（zoom 很小时视口只剩中心一小块）
          ② 期望位置可以直接用恒等式算：图片铺满视口 = 0.5 对齐 0.5
         ⚠️ 不能用写死的 zoom=1：视口只有 1/zoom 那么大，zoom 小时
         标记会跑到画面外，测试就变成"找不到标记"的假红。 */
      const z = S.autoZoomFor(deg);
      S.setDisplay({ rotate: deg, zoom: z });
      await new Promise(r => setTimeout(r, 60));
      const m = markerAt(2);
      const th = deg * Math.PI / 180;
      /* 标记在图片上是 (0.25, 0.25)（图片坐标 y 向下），换算成**画面**坐标
         （v 向上，和 GL readPixels 的 y 同向）就是 (0.25, 0.75)。
         然后按"图片铺满视口 → 半宽半高 = 0.5·z"再逆时针转 θ：
              dx = P.u - 0.5,  dy = P.v - 0.5
              u' = 0.5 + z·( cosθ·dx - sinθ·dy)
              v' = 0.5 + z·( sinθ·dx + cosθ·dy)
         ⚠️ 这里我写错过一次：直接拿图片的 (0.25, 0.25) 当画面坐标，
         于是 0° 时期望出 (0.25, 0.25) 而实测是 (0.25, 0.75) ——
         四个角度全"偏"了，而且正好是镜像关系，看着像 bug 其实是测试错了。 */
      const Pn = { u: P.u, v: 1 - P.v };
      const dx = Pn.u - 0.5, dy = Pn.v - 0.5;
      const eu = 0.5 + z * (Math.cos(th) * dx - Math.sin(th) * dy);
      const ev = 0.5 + z * (Math.sin(th) * dx + Math.cos(th) * dy);
      out.marker.push({ deg, z, m, P: Pn, expect: { u: eu, v: ev } });
    }

    /* ================================================================
       ④ 露出来的角 = 深色底
       ================================================================ */
    await load(makeGray(W, H));
    S.enterRotate();
    S.setDisplay({ rotate: 0, zoom: 1 });
    const noRotCorners = [px(0.005, 0.005), px(0.995, 0.005),
                          px(0.005, 0.995), px(0.995, 0.995)];
    /* 深色底那条用 45°（视口撑到最大，四角明显露底），采样点靠角 0.02 */
    const CC = 0.02;
    S.setDisplay({ rotate: 45, zoom: 1 });
    const rotCorners = [px(CC, CC), px(1 - CC, CC), px(CC, 1 - CC), px(1 - CC, 1 - CC)];
    const rotCenter = px(0.5, 0.5);
    /* ⚠️⚠️ 下面这一条的判据换过**三次**，把每次为什么错记下来：
     *  ① "45° 时四角不该露深色底" —— 错。斜放的正方形四个角本来就
     *     在方形视口外面，那是几何必然。
     *  ② "放到 2 倍时四角该露深色底" —— 也错。视口按 rotatePad 撑大后，
     *     45° 时视口 = 外接框大小；再放大 2 倍，视口只剩图片中心 50%，
     *     四角照样全是内容（深色底在更外面）。
     *  ③ 拿画布**对角**附近的点当"图片边中点" —— 也错：45° 时图片是
     *     斜着放的，画布对角离图片的角更近，那些点根本不在图片上。
     *
     * ✅ 正确判据：图片四条边的**中点**（向里收 5%）必须都落在视口里。
     *    边中点是图片上最靠外的位置，它们都在 → 整张图都在视口里。
     *    做法：把图片坐标 (u, v) 按 R(45°) 转到画面坐标再采样。 */
    S.fitZoomToWindow();
    const fitZoom = S.geom.zoom;
    const th45 = 45 * Math.PI / 180;
    const rot2scr = (u, vUp) => {
      const dx = u - 0.5, dy = vUp - 0.5;
      return [0.5 + Math.cos(th45) * dx - Math.sin(th45) * dy,
              0.5 + Math.sin(th45) * dx + Math.cos(th45) * dy];
    };
    const INSET = 0.05;
    const edgeMids = [
      rot2scr(0.5, 1 - INSET),        // 图片上边中点
      rot2scr(0.5, INSET),            // 图片下边中点
      rot2scr(INSET, 0.5),            // 图片左边中点
      rot2scr(1 - INSET, 0.5)         // 图片右边中点
    ];
    const fitInside = edgeMids.map(([u, v]) => px(u, v));
    const edgeNames = ['上边中点', '下边中点', '左边中点', '右边中点'];
    out.corners = { noRotCorners, rotCorners, rotCenter, fitInside, edgeNames,
                    fitZoom,
                    autoFit45: S.autoZoomFor(45),
                    fitPlan: (p => p && { bufW: p.bufW, bufH: p.bufH,
                      s: p.screenZoom, off: [p.offX, p.offY],
                      vw: p.vw, vh: p.vh })(S.cropRenderPlan(false)),
                    fitCanvas: [S._canvas().width, S._canvas().height] };

    /* ================================================================
       ⑤ 翻转
       ================================================================ */
    await load(makeQuad(W, H));
    S.enterRotate();
    S.setDisplay({ rotate: 0, zoom: 1 });
    const base = { tl: px(0.25, 0.75), tr: px(0.75, 0.75),
                   bl: px(0.25, 0.25), br: px(0.75, 0.25) };
    S.setDisplay({ flipX: true });
    const fx = { tl: px(0.25, 0.75), tr: px(0.75, 0.75),
                 bl: px(0.25, 0.25), br: px(0.75, 0.25) };
    S.setDisplay({ flipX: false, flipY: true });
    const fy = { tl: px(0.25, 0.75), tr: px(0.75, 0.75),
                 bl: px(0.25, 0.25), br: px(0.75, 0.25) };
    S.setDisplay({ flipY: false });
    out.flip = { base, fx, fy };

    /* ================================================================
       ⑥ 裁剪：取景框那块区域 1:1 输出
       ================================================================ */
    await load(makePos(W, H));
    S.enterCrop();
    S.setCropRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    /* ⚠️ 画布的归一化坐标和图片的归一化坐标**不等同**：zoom 会把视野
       收进图片的中心 1/zoom。所以读"取景框中心对应原图哪里"之前，
       先把 zoom 明确设成 1，判定才有确定的期望值。 */
    S.setDisplay({ zoom: 1 });
    const plan = S.cropRenderPlan(true);
    const bake = S.bakeRenderPlan();
    const c = S._canvas();
    const centerPx = px(0.5, 0.5);   // 画布中心（无论行序怎么定义，(0.5,0.5) 都是中心）
    const cuni = S._geometryUniforms();
    out.crop = {
      imgSize: [S.image.width, S.image.height],
      uni: { rot: cuni.rot, s: cuni.scale, off: [cuni.offset[0], cuni.offset[1]] },
      rect: { ...S.geom.rect },
      plan: plan && { outW: plan.outW, outH: plan.outH, offX: plan.offX,
                      offY: plan.offY, screenZoom: plan.screenZoom,
                      bufW: plan.bufW, bufH: plan.bufH },
      bakeOut: bake ? [bake.outW, bake.outH] : null,
      canvas: [c.width, c.height],
      centerPx
    };

    /* ================================================================
       ⑦ 裁剪 + 旋转 + 翻转 一起用：只验"不崩 + 深色底占比合理"
       ================================================================ */
    await load(makeGray(W, H));
    S.enterRotate();
    S.setDisplay({ rotate: 40, flipX: true, zoom: S.autoZoomFor(40) });
    S.setCropRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    const comboPlan = S.cropRenderPlan(true);
    const combo = { tl: px(0.05, 0.95), center: px(0.5, 0.5) };
    out.combo = { plan: comboPlan ? [comboPlan.outW, comboPlan.outH] : null, combo };

    /* ================================================================
       ⑧ 90° 整转：尺寸互换 + 画面真的转过去了
       ================================================================ */
    await load(makeQuad(W, H));
    S.enterRotate();
    /* ⚠️ 必须**显式复位**：前面的组合测试把 geom 留成了
       { flipX: true, rect: 0.8×0.8 }。不复位的话这里量到的"基准象限"
       已经是被翻转过、裁剪过的画面 —— 实测报出"左上应该是红，实际绿"，
       追下去是测试自己没清场，不是代码错。 */
    S.setDisplay({ rotate: 0, flipX: false, flipY: false, zoom: 1 });
    S.setCropRect({ x: 0, y: 0, w: 1, h: 1 });
    const q0 = { tl: px(0.25, 0.75), tr: px(0.75, 0.75),
                 bl: px(0.25, 0.25), br: px(0.75, 0.25) };
    const q0uni = S._geometryUniforms();
    const canvasBefore = [S._canvas().width, S._canvas().height];
    const geomBefore = JSON.parse(JSON.stringify(S.geom));
    const size0 = [S.image.width, S.image.height];
    await S.rotateQuarter(1);
    S.fitZoomToWindow();
    const q1 = { tl: px(0.25, 0.75), tr: px(0.75, 0.75),
                 bl: px(0.25, 0.25), br: px(0.75, 0.25) };
    const quni = S._geometryUniforms();
    out.quarter = { before: q0, after: q1, size0, q0uni: q0uni, canvasBefore, geomBefore, trace: S._trace.slice(-8),
                    size: [S.image.width, S.image.height],
                    canvas: [S._canvas().width, S._canvas().height],
                    geom: JSON.parse(JSON.stringify(S.geom)),
                    uni: { rot: quni.rot, s: quni.scale, off: [quni.offset[0], quni.offset[1]], flip: [quni.flip[0], quni.flip[1]] } };

    return out;
  })()`);
  await page.close().catch(() => {});
} finally {
  shutdown(chrome);
  server.close();
}

const rgb = p => 'rgb(' + p.join(',') + ')';
const isDarkBg = p => p[2] < 45 && p[0] < 45 && p[1] < 45;
const isRed = p => p[0] > 150 && p[1] < 90 && p[2] < 90;
const isGreen = p => p[1] > 130 && p[0] < 120 && p[2] < 120;
const isBlue = p => p[2] > 150 && p[0] < 120 && p[1] < 120;
const isWhite = p => Math.min(...p) > 180;

/* ---------------- ① 相似变换 ---------------- */
t('⭐ shader 上的显示缩放是**一个标量**（结构化判据：不存在双轴缩放）', () => {
  assert.ok(Math.abs(R.uniforms.zero.scale - 1) < 1e-6,
    `默认缩放应该是 1，实际 ${R.uniforms.zero.scale}`);
  assert.ok(Math.abs(R.uniforms.zero.rot) < 1e-6,
    `默认角度应该是 0，实际 ${R.uniforms.zero.rot}`);
  assert.deepEqual([R.uniforms.zero.flip[0], R.uniforms.zero.flip[1]], [1, 1], '默认不该有翻转');
  assert.ok(Math.abs(R.uniforms.turn.rot - 25 * Math.PI / 180) < 1e-4,
    `旋转角应该换算成弧度 25°=0.4363，实际 ${R.uniforms.turn.rot}`);
});

t('0° / 缩放 1 / 不翻转 = 恒等变换（正常编辑不受影响）', () => {
  const d = Math.max(...R.identity.before.map((v, i) =>
    Math.abs(v - R.identity.after[i])));
  assert.ok(d <= 3,
    `恒等状态下画面不该变：${rgb(R.identity.before)} → ${rgb(R.identity.after)}\n`
    + `     渲染前画布=${JSON.stringify(R.identity.idBeforeSize)} `
    + `编辑后画布=${R.identity.canvas} `
    + `几何=${JSON.stringify(R.identity.geom)} `
    + `uniform: rot=${R.identity.uni.rot} scale=${R.identity.uni.scale} `
    + `offset=${JSON.stringify(R.identity.uni.offset)}`);
});

/* ---------------- ③ 旋转方向与角度 ---------------- */
t('⭐ 0° 时标记在原位（恒等的另一种表达）', () => {
  const s = R.marker.find(v => v.deg === 0);
  assert.ok(s && s.m, '0° 时找不到标记 —— 画面可能整个不对');
  /* 标记在图片 (0.25, 0.25)（左上偏内），v 向上也就是画面 (0.25, 0.75)。
     zoom=1 时画面就是整张图，所以应该正好读到那里。 */
  assert.ok(Math.abs(s.m.u - 0.25) < 0.03 && Math.abs(s.m.v - 0.75) < 0.03,
    `0° 时标记应该在 (0.25, 0.75)，实际 (${s.m.u.toFixed(3)}, ${s.m.v.toFixed(3)})`);
});

t('⭐⭐ 旋转是**位置正确**的度数旋转（方向 + 角度都验）', () => {
  /* 判据：标记重心的实测位置 vs 按旋转矩阵算出来的期望位置。
     这条同时抓三种错：
       · 方向反了（顺时针当成逆时针）→ 期望位置在另一侧，差得很大
       · 角度换算错了（度/弧度、漏了 π/180）→ 位置明显偏
       · 旋转不是绕中心（比如绕左下角）→ 中心附近也会偏
     ⚠️ 容差 0.03：标记是 40×30 像素的方块，重心精度足够；
     但浏览器 WebGL 的采样和我的步长抽样会带来一点偏差。 */
  const bad = [];
  for (const s of R.marker) {
    if (!s.m) { bad.push(`${s.deg}°: 找不到标记（可能被深色底盖住了）`); continue; }
    const du = Math.abs(s.m.u - s.expect.u);
    const dv = Math.abs(s.m.v - s.expect.v);
    if (du > 0.03 || dv > 0.03) {
      bad.push(`${s.deg}°: 实测 (${s.m.u.toFixed(3)}, ${s.m.v.toFixed(3)}) `
        + `vs 期望 (${s.expect.u.toFixed(3)}, ${s.expect.v.toFixed(3)})`);
    }
  }
  assert.equal(bad.length, 0,
    `旋转的位置/方向不对：\n       ${bad.join('\n       ')}\n`
    + '     ⚠️ 屏幕坐标是 v 向上；逆时针为正。若两个角度都反了，'
    + '说明旋转矩阵的符号写错（u\'-0.5 那一项该用 -sinθ）。');
});

/* ---------------- ④ 深色底 ---------------- */
t('0° 时四角都是图片内容（没有深色底）', () => {
  for (const p of R.corners.noRotCorners) {
    assert.ok(!isDarkBg(p),
      `0° 时角落不该是深色底，实际 ${rgb(p)}`);
  }
});

t('⭐ 旋转 30° 后四角露出**深色底**（用户接受的行为），中心仍是照片', () => {
  const dark = R.corners.rotCorners.filter(isDarkBg).length;
  assert.equal(dark, 4,
    `转 30° 之后四个角应该都露深色底，实际 ${dark}/4：`
    + R.corners.rotCorners.map(rgb).join(' '));
  assert.ok(!isDarkBg(R.corners.rotCenter),
    `中心必须还是照片，实际 ${rgb(R.corners.rotCenter)}`);
  // 深色底应该是**中性**的深色，不是纯黑（纯黑看着像坏了）
  for (const p of R.corners.rotCorners) {
    assert.ok(p[0] > 8 && p[0] < 60,
      `深色底的亮度应该在 8~60 之间，实际 ${rgb(p)}`);
  }
});

t('⭐⭐ 点「适合窗口」后照片完整落在视口里（边中点也在）', () => {
  /* ⚠️ 判据换过两次，说清为什么：
     旧判据一："45° 时四角不该露深色底" —— 错。斜放的正方形，四个角
       本来就在方形视口外面，那是几何必然。
     旧判据二："放到 2 倍时应该露深色底" —— 也错。视口按 rotatePad
       撑大之后，45° 时视口 = 外接框大小；再放大到 2 倍，视口只剩
       图片中心 50%，四角照样全是内容（深色底在更外面）。
     真正要守的是"**照片整张都看得见**"：在适合窗口那一档，
     图片四条边的中点都必须落在视口内（边中点是最外侧的点，
     它们都在 → 整张图都在）。 */
  const inside = R.corners.fitInside.filter(p => !isDarkBg(p)).length;
  assert.equal(inside, R.corners.fitInside.length,
    `适合窗口之后照片应该完整可见，实际 ${inside}/${R.corners.fitInside.length} `
    + `个采样点是照片：`
    + R.corners.fitInside.map((p, i) => `${R.corners.edgeNames[i]}=${rgb(p)}`).join(' ')
    + `（zoom=${R.corners.fitZoom}，autoFit45=${R.corners.autoFit45}，`
    + `plan=${JSON.stringify(R.corners.fitPlan)}，`
    + `画布=${R.corners.fitCanvas}）`);
});

t('适合窗口的缩放值让视口正好装下旋转后的照片（不多不少）', () => {
  /* 视口撑大之后，45° 时视口本身就是外接框大小 → 缩放应该是 1
     （照片正好铺满，不需要额外缩小）。0° 时也是 1。
     这条守的是"别把 autoZoomFor 写成永远 < 1"那种过头。 */
  assert.ok(Math.abs(R.corners.autoFit45 - 1) < 1e-9,
    `视口已经随角度撑到"装得下整张旋转图"，所以"适合窗口"的缩放`
    + `恒为 1，实际 ${R.corners.autoFit45}`);
});

/* ---------------- ⑤ 翻转 ---------------- */
t('⭐⭐ 水平翻转：左右互换、上下不变', () => {
  const b = R.flip.base, f = R.flip.fx;
  // 原图 左上红 右上绿 左下蓝 右下白
  assert.ok(isRed(b.tl) && isGreen(b.tr) && isBlue(b.bl) && isWhite(b.br),
    `基准四象限不对：${rgb(b.tl)} ${rgb(b.tr)} ${rgb(b.bl)} ${rgb(b.br)}`);
  assert.ok(isGreen(f.tl), `水平翻转后左上应该是绿（原来是右上），实际 ${rgb(f.tl)}`);
  assert.ok(isRed(f.tr), `水平翻转后右上应该是红，实际 ${rgb(f.tr)}`);
  assert.ok(isWhite(f.bl), `水平翻转后左下应该是白，实际 ${rgb(f.bl)}`);
  assert.ok(isBlue(f.br), `水平翻转后右下应该是蓝，实际 ${rgb(f.br)}`);
});

t('⭐⭐ 垂直翻转：上下互换、左右不变', () => {
  const b = R.flip.base, f = R.flip.fy;
  assert.ok(isBlue(f.tl), `垂直翻转后左上应该是蓝（原来是左下），实际 ${rgb(f.tl)}`);
  assert.ok(isWhite(f.tr), `垂直翻转后右上应该是白，实际 ${rgb(f.tr)}`);
  assert.ok(isRed(f.bl), `垂直翻转后左下应该是红，实际 ${rgb(f.bl)}`);
  assert.ok(isGreen(f.br), `垂直翻转后右下应该是绿，实际 ${rgb(f.br)}`);
  // 左右关系不变：左还是红/蓝系，右还是绿/白系
  assert.ok(f.tl[0] > f.tl[1] || f.tl[2] > f.tl[0],
    '垂直翻转后左侧应该仍是原来的左侧内容');
});

/* ---------------- ⑥ 裁剪 ---------------- */
t('⭐ 取景框那块区域按 1:1 输出（输出尺寸 = 取景框像素数）', () => {
  const [w, h] = R.crop.bakeOut;
  assert.equal(w, 200, `400×300 的 0.5×0.5 取景框应该输出 200 宽，实际 ${w}`);
  assert.equal(h, 150, `应该输出 150 高，实际 ${h}`);
  // plan（预览路径）和 bake 在 zoom=1、取景框不大时应该一致
  assert.equal(R.crop.plan.outW, w,
    `预览计划宽应该和烘焙一致：${R.crop.plan.outW} vs ${w}`);
  assert.equal(R.crop.plan.outH, h,
    `预览计划高应该和烘焙一致：${R.crop.plan.outH} vs ${h}`);
});

t('⭐⭐ 裁剪取到的是**取景框那一块**（用中心标记验，不靠颜色猜）', () => {
  /* ⚠️⚠️ 这条的判据换过一次，说清为什么（旧判据是错的）：
     旧版期望"画面中心读到原图中心 (127,127)"，实测读到 (192,191) 就报错。
     但 (192,191) 才是**对的** —— 取景框 0.5×0.5 居中时，画面显示的就是
     原图中心那块，所以画面**中心**压在取景框中心 = 原图 (0.5,0.5) 上，
     而位置编码图里 (0.5,0.5) 正是 (127,127)…… 等等，那是旧模型的算法。

     新模型里画布显示的是**整个视口**（= 整张图，zoom=1 时），
     取景框只是画在上面的那个框。所以画面中心对应原图中心，
     而 uImgOffset 把"视口原点"放在取景框左下角 —— 于是画面中心
     读到的是取景框中心，也就是原图中心。**两边应该一致**。

     旧实现用 uImgOffset=(r.x + r.w/2, …)（取景框中心），所以画面
     中心读到 (0.75, 0.75)；改成 r.x/l 之后应该读到 (0.5, 0.5)。
     这条断言就是钉这个的。 */
  const [rr, gg, bb] = R.crop.centerPx;
  assert.ok(Math.abs(rr - 127.5) < 12 && Math.abs(gg - 127.5) < 12,
    `画面中心应该读到原图中心 (127,127)，实际 (${rr},${gg})\n`
    + `     path=${JSON.stringify(R.crop.plan)} `
    + `画布=${R.crop.canvas} img=${R.crop.imgSize} rect=${JSON.stringify(R.crop.rect)} `
    + `uni=${JSON.stringify(R.crop.uni)}`);
  assert.ok(Math.abs(bb - 90) < 12,
    `B=${bb} 不是图片内容（应该是 90）`);
});

/* ---------------- ⑦ 组合 ---------------- */
t('裁剪 + 旋转 + 翻转 一起用不崩，且中心还是照片', () => {
  assert.ok(R.combo.plan, '组合状态下拿不到导出计划');
  assert.ok(!isDarkBg(R.combo.combo.center),
    `组合状态下中心应该是照片，实际 ${rgb(R.combo.combo.center)}`);
  assert.ok(R.combo.plan[0] > 0 && R.combo.plan[1] > 0,
    `输出尺寸必须为正，实际 ${R.combo.plan}`);
});

/* ---------------- ⑧ 90° 整转 ---------------- */
t('⭐ 90° 整转：画面顺时针转过去了（红从左上到右上）', () => {
  const b = R.quarter.before, a = R.quarter.after;
  assert.ok(isRed(b.tl),
    `基准左上应该红，实际 ${rgb(b.tl)}；`
    + `四象限 = 左上${rgb(b.tl)} 右上${rgb(b.tr)} `
    + `左下${rgb(b.bl)} 右下${rgb(b.br)}；`
    + `画布=${R.quarter.canvasBefore} geom=${JSON.stringify(R.quarter.geomBefore)}`);
  assert.ok(isRed(a.tr),
    `顺时针 90° 后右上应该是红（原来的左上），实际 ${rgb(a.tr)}；`
    + `四象限 = 左上${rgb(a.tl)} 右上${rgb(a.tr)} 左下${rgb(a.bl)} 右下${rgb(a.br)}`
    + `\n     尺寸=${R.quarter.size} 画布=${R.quarter.canvas} `
    + `geom=${JSON.stringify(R.quarter.geom)} uni=${JSON.stringify(R.quarter.uni)}`
    + `\n     trace=${JSON.stringify(R.quarter.trace)}`);
  assert.ok(isBlue(a.tl), `左上应该是蓝（原来的左下），实际 ${rgb(a.tl)}`);
  assert.ok(isWhite(a.bl), `左下应该是白（原来的右下），实际 ${rgb(a.bl)}`);
  assert.ok(isGreen(a.br), `右下应该是绿（原来的右上），实际 ${rgb(a.br)}`);
});

t('⭐ 90° 整转：输出尺寸是旋转外接框，且没有扭转变形', () => {
  /* 400×300 转 90° 的外接框是 300×400。
     ⚠️ 用**外接框**而不是"宽高互换"当判据：这样 90° 和 45° 是同一套逻辑，
     而且能顺带确认没有把图片拉伸（拉伸的话输出比例会跑掉）。
     容差 1px：外接框是 cos/sin 算出来的浮点，取整会有 1 的误差。 */
  const [w0, h0] = R.quarter.size0;
  assert.deepEqual([w0, h0], [400, 300],
    `基准尺寸应该是 400×300，实际 ${w0}×${h0}`);
  const [w, h] = R.quarter.size;
  assert.ok(Math.abs(w - 300) <= 1, `转 90° 后宽应该是 300，实际 ${w}`);
  assert.ok(Math.abs(h - 400) <= 1, `转 90° 后高应该是 400，实际 ${h}`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
