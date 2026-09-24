/* ================================================================
   裁剪 / 旋转 —— 浏览器实测
   ----------------------------------------------------------------
   这是本项目唯一的**几何**变换，也是最容易出错的一块：涉及的
   坐标系有三套（原图 / 旋转框 / 画布），而且旋转后四角会露白。
   单元测试验不了这些 —— 必须在真浏览器里读像素。

   要守住的核心不变量：
     ① 旋转 0° 时必须是**恒等变换**（不然正常编辑就全歪了）
     ② 旋转后四角**不能露白**（取景框必须落在内接矩形里）
     ③ 裁剪输出的**长宽比**要等于取景框的比例
     ④ 裁剪输出的**内容**真的来自取景框那块（不是原图左上角）
     ⑤ 90° 整转后尺寸互换、内容转过去了
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

/* ================================================================
   象限断言的小工具
   ----------------------------------------------------------------
   ⚠️ 必须定义在 **Node 这一侧**。定义在 SETUP 里（页面那边）的话，
   check() 里用不了 —— 那是两个不同的作用域。
   踩过：check 里调 isRed 报 "isRed is not defined"。
   ================================================================ */
const isRed   = p => p[0] > 150 && p[1] < 90 && p[2] < 90;
const isGreen = p => p[1] > 130 && p[0] < 120 && p[2] < 120;
const isBlue  = p => p[2] > 150 && p[0] < 120 && p[1] < 120;
const isWhite = p => Math.min(...p) > 180;
const rgb = p => 'rgb(' + p.join(',') + ')';

async function t(name, body, check) {
  const code = `(async () => {
    await (async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const s = document.getElementById('stSliders');
        if (window.Studio && window.Studio.enterCrop && s && s.children.length) return;
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
  console.log('\n=== 裁剪 / 旋转（真实 Chrome + WebGL）===\n');
  console.log(`  Chrome ${chrome.version.Browser}   静态服务 :${PORT}\n`);

  /* ================================================================
     造一张**四个象限不同颜色**的测试图。
     为什么不用纯色：要验"裁剪出来的内容真的来自那一块"，
     必须让图上有可区分的位置信息 —— 纯色裁哪儿都一样，测不出来。
     ================================================================ */
  const SETUP = `
    const W = 400, H = 300;
    function makeQuad() {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      // 左上红 右上绿 左下蓝 右下白
      x.fillStyle = '#e02020'; x.fillRect(0, 0, W/2, H/2);
      x.fillStyle = '#20c020'; x.fillRect(W/2, 0, W/2, H/2);
      x.fillStyle = '#2040e0'; x.fillRect(0, H/2, W/2, H/2);
      x.fillStyle = '#f0f0f0'; x.fillRect(W/2, H/2, W/2, H/2);
      return c;
    }
    /** 纯中灰，用来验旋转后四角有没有露白 */
    function makeGray() {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      x.fillStyle = '#808080'; x.fillRect(0, 0, W, H);
      return c;
    }
    async function load(canvas) {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      await window.Studio.openFile(new File([blob], 't.png', { type: 'image/png' }));
      window.Studio.resetAll();
    }
    function px(u, v) {
      /* ⚠️ 坐标方向这一段很容易绕，写清楚：
         readPixels 用的是 **GL 坐标**（y=0 在 framebuffer 底部），
         而屏幕显示时 y=0 在**顶部** —— 两者上下相反。
         所以「屏幕上方 v=0」对应 readPixels 的**大** y。

         一开始这里的 (1-v) 是多余的：它把方向又翻了一次，
         于是所有关于"上下"的断言都会错。这个错误之所以长期没暴露，
         是因为我早期用的测试图是**上下对称**的（左右分区），
         换成四象限图（上下左右都不同）之后才显出来。

         正确的三组关系（记牢，别再绕）：
           · readPixels y=0        → 画面底部
           · shader vUv.y=0        → 画面底部（VERT 里做了 0.5 - y*0.5）
           · canvas 的像素坐标 y=0  → 画面顶部 */
      const c = window.Studio._canvas();
      const g = c.getContext('webgl', { preserveDrawingBuffer: true });
      const buf = new Uint8Array(4);
      g.readPixels(Math.round(u*(c.width-1)), Math.round(v*(c.height-1)), 1, 1,
                   g.RGBA, g.UNSIGNED_BYTE, buf);
      return [buf[0], buf[1], buf[2]];
    }
    const lum = p => 0.2126*p[0] + 0.7152*p[1] + 0.0722*p[2];
    /** 测试图四个象限（v 是 GL/纹理方向：0 = 画面**下**方） */
    // 画面左上红 右上绿 左下蓝 右下白
    // → 纹理坐标下：左下角是 y 小
    const QUAD = {
      tl: [0.25, 0.75], tr: [0.75, 0.75],   // v 大 = 画面上方
      bl: [0.25, 0.25], br: [0.75, 0.25]    // v 小 = 画面下方
    };
  `;

  /* ---------------- 前置 ---------------- */

  await t('页面初始化，裁剪 UI 就位', SETUP + `
    return {
      hasStudio: !!window.Studio,
      hasEnterCrop: typeof window.Studio.enterCrop === 'function',
      cropBtn: !!document.getElementById('stCrop'),
      cropOpts: !!document.getElementById('stCropOpts'),
      aspects: document.querySelectorAll('#stCropAspect button').length,
      shaderFailed: /打不开修图功能/.test(
        (document.getElementById('stDrop')||{}).textContent || '')
    };
  `, r => {
    assert.equal(r.hasStudio, true, 'window.Studio 不存在');
    assert.equal(r.shaderFailed, false, 'shader 编译失败');
    assert.equal(r.hasEnterCrop, true, '没有 enterCrop');
    assert.ok(r.cropBtn && r.cropOpts, '裁剪 UI 元素缺失');
    assert.ok(r.aspects >= 6, `比例按钮应该是 6 个，实际 ${r.aspects}`);
  });

  /* ---------------- 恒等性 ---------------- */

  await t('⭐ 不在裁剪模式时是恒等变换（画面和原图一致）', SETUP + `
    await load(makeQuad());
    return {
      tl: px(...QUAD.tl), tr: px(...QUAD.tr),
      bl: px(...QUAD.bl), br: px(...QUAD.br),
      cropActive: !!window.Studio.crop
    };
  `, r => {
    assert.equal(r.cropActive, false, '不该在裁剪模式里');
    // 屏幕方向：上 = 画布画的上半（canvas 2D 的 y=0 也在上）
    assert.ok(isRed(r.tl), `左上应该偏红，实际 ${rgb(r.tl)}`);
    assert.ok(isGreen(r.tr), `右上应该偏绿，实际 ${rgb(r.tr)}`);
    assert.ok(isBlue(r.bl), `左下应该偏蓝，实际 ${rgb(r.bl)}`);
    assert.ok(isWhite(r.br), `右下应该接近白，实际 ${rgb(r.br)}`);
  });

  /* ---------------- 进入裁剪模式 ---------------- */

  await t('进入裁剪模式：画布比例变成取景框比例', SETUP + `
    await load(makeQuad());
    window.Studio.enterCrop();
    const c = window.Studio._canvas();
    const plan = window.Studio.cropRenderPlan(false);
    return {
      cropActive: !!window.Studio.crop,
      canvasAspect: c.width / c.height,
      planAspect: plan.outW / plan.outH,
      rot: window.Studio.crop.rot,
      // 0° 时取景框应该覆盖整个内接矩形 = 整张图
      rect: window.Studio.crop.rect
    };
  `, r => {
    assert.equal(r.cropActive, true, '没有进入裁剪模式');
    assert.equal(r.rot, 0, '初始旋转角应该是 0');
    assert.ok(Math.abs(r.canvasAspect - r.planAspect) < 0.02,
      `画布比例应该和渲染计划一致：${r.canvasAspect.toFixed(3)} vs ${r.planAspect.toFixed(3)}`);
    // 0° 时内接矩形就是整张图，取景框该占满
    assert.ok(r.rect.w > 0.98 && r.rect.h > 0.98,
      `0° 时取景框应该占满画面，实际 w=${r.rect.w.toFixed(3)} h=${r.rect.h.toFixed(3)}`);
  });

  /* ---------------- 旋转 ---------------- */

  await t('⭐ 旋转 0° 时画面不变（恒等），旋转后画面确实变了', SETUP + `
    await load(makeQuad());
    window.Studio.enterCrop();
    const before = px(0.5, 0.5);
    window.Studio.setCropRotation(0);
    const zero = px(0.5, 0.5);
    window.Studio.setCropRotation(20);
    const turned = px(0.5, 0.5);
    return { before, zero, turned, rot: window.Studio.crop.rot };
  `, r => {
    const d0 = Math.max(...r.before.map((v, i) => Math.abs(v - r.zero[i])));
    assert.ok(d0 <= 3, `旋转 0° 应该是恒等，实际最大通道差 ${d0}`);
    assert.equal(r.rot, 20, '旋转角没设上');
    // 中心是四象限交界处，转 20° 之后颜色一定变了
    const d1 = Math.max(...r.zero.map((v, i) => Math.abs(v - r.turned[i])));
    assert.ok(d1 > 10, `旋转 20° 后中心应该明显变化，实际差 ${d1}`);
  });

  await t('⭐ 旋转后四角不露白（取景框在内接矩形内）', SETUP + `
    await load(makeGray());
    window.Studio.enterCrop();
    window.Studio.setCropRotation(30);
    const c = window.Studio._canvas();
    const g = c.getContext('webgl', { preserveDrawingBuffer: true });
    // 取四角和四边中点，都不该出现"透明/黑"（露白）
    const pts = [[0.01,0.01],[0.99,0.01],[0.01,0.99],[0.99,0.99],
                 [0.5,0.01],[0.5,0.99],[0.01,0.5],[0.99,0.5]];
    const out = [];
    for (const [u,v] of pts) {
      const buf = new Uint8Array(4);
      g.readPixels(Math.round(u*(c.width-1)), Math.round((1-v)*(c.height-1)), 1, 1,
                   g.RGBA, g.UNSIGNED_BYTE, buf);
      out.push([buf[0],buf[1],buf[2]]);
    }
    return { out, rot: window.Studio.crop.rot };
  `, r => {
    for (let i = 0; i < r.out.length; i++) {
      const [R, G, B] = r.out[i];
      // 中灰 #808080 经过 sRGB 往返应该在 120~140；露白会是纯黑(0)
      assert.ok(R > 100 && R < 160 && G > 100 && G < 160 && B > 100 && B < 160,
        `第 ${i} 个采样点露白或异常：rgb(${R},${G},${B})，旋转角 ${r.rot}°`);
    }
  });

  await t('小角度旋转时内接矩形接近原图，大角度时明显缩小', SETUP + `
    const W0 = 400, H0 = 300;
    const a = window.Studio.inscribedRect(W0, H0, 5 * Math.PI / 180);
    const b = window.Studio.inscribedRect(W0, H0, 40 * Math.PI / 180);
    const boxA = window.Studio.rotatedBoxSize(W0, H0, 5 * Math.PI / 180);
    const boxB = window.Studio.rotatedBoxSize(W0, H0, 40 * Math.PI / 180);
    return {
      areaA: (a.w * a.h) / (W0 * H0),
      areaB: (b.w * b.h) / (W0 * H0),
      boxAspectA: boxA.W / boxA.H,
      boxAspectB: boxB.W / boxB.H
    };
  `, r => {
    assert.ok(r.areaA > r.areaB,
      `角度越大内接矩形应该越小：5°=${r.areaA.toFixed(3)} 40°=${r.areaB.toFixed(3)}`);
    // 40° 时面积应该明显损失（不该还接近 1）
    assert.ok(r.areaB < 0.8,
      `40° 时内接矩形面积应该明显小于原图，实际 ${r.areaB.toFixed(3)}`);
    // 外接矩形比原图大
    assert.ok(r.boxAspectA !== 1 && r.boxAspectB !== 1, '外接矩形比例不该恒为 1');
  });

  /* ---------------- 裁剪输出 ---------------- */

  await t('⭐ 裁剪输出的长宽比等于取景框比例', SETUP + `
    await load(makeQuad());
    window.Studio.enterCrop();
    window.Studio.setCropRotation(0);
    // 设一个明显的 16:9 取景框
    const box = window.Studio.rotatedBoxSize(400, 300, 0);
    const w = 0.5, h = (w * box.W) / ((16 / 9) * box.H);
    window.Studio.setCropRect({ x: 0.25, y: 0.5 - h / 2, w, h });
    const plan = window.Studio.cropRenderPlan(true);
    return { aspect: plan.outW / plan.outH, outW: plan.outW, outH: plan.outH,
             target: 16 / 9, imgW: window.Studio.image.width,
             imgH: window.Studio.image.height };
  `, r => {
    assert.ok(Math.abs(r.aspect - r.target) < 0.03,
      `导出长宽比应该是 ${r.target.toFixed(3)}，实际 ${r.aspect.toFixed(3)}`
      + `（${r.outW}×${r.outH}）`);
    // 输出尺寸不该超过原图
    assert.ok(r.outW <= r.imgW + 1 && r.outH <= r.imgH + 1,
      `输出不该比原图大：${r.outW}×${r.outH} vs ${r.imgW}×${r.imgH}`);
  });

  await t('⭐ 裁剪真的取了那一块内容（不是原图左上角）', SETUP + `
    await load(makeQuad());
    window.Studio.enterCrop();
    window.Studio.setCropRotation(0);
    /* 把取景框设到**右下半部分**（原图里是白+蓝那块）。
       如果实现有 bug（比如忽略 offset），画面会显示左上角的红色。 */
    window.Studio.setCropRect({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    const plan = window.Studio.cropRenderPlan(false);
    // 重新渲染一帧再读（setCropRect 内部已经 render 了）
    const c = window.Studio._canvas();
    const g = c.getContext('webgl', { preserveDrawingBuffer: true });
    const buf = new Uint8Array(4);
    g.readPixels(Math.round(c.width * 0.5), Math.round(c.height * 0.5),
                 1, 1, g.RGBA, g.UNSIGNED_BYTE, buf);
    return { center: [buf[0], buf[1], buf[2]],
             rect: window.Studio.crop.rect,
             canvas: [c.width, c.height] };
  `, r => {
    // 右下半在中灰图里是"白"（右下象限），不该是红
    const [R, G, B] = r.center;
    assert.ok(Math.min(R, G, B) > 150,
      `取景框在右下半，中心应该接近白，实际 rgb(${R},${G},${B})`
      + ` —— 如果偏红说明忽略裁剪偏移（总是取原图左上角）`);
  });

  /* ---------------- 应用（烘焙） ---------------- */

  await t('⭐ 应用裁剪：图片尺寸真的变了，且和计划一致', SETUP + `
    await load(makeQuad());
    window.Studio.enterCrop();
    window.Studio.setCropRotation(0);
    window.Studio.setCropRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    const plan = window.Studio.cropRenderPlan(true);
    const before = [window.Studio.image.width, window.Studio.image.height];
    const err = await window.Studio.applyCrop().then(() => null, e => String(e && e.message));
    const after = [window.Studio.image.width, window.Studio.image.height];
    return { before, after, plan: [plan.outW, plan.outH], err,
             cropActive: !!window.Studio.crop,
             canvas: [window.Studio._canvas().width, window.Studio._canvas().height] };
  `, r => {
    assert.equal(r.err, null, `applyCrop 抛异常了：${r.err}`);
    assert.equal(r.cropActive, false, '应用后应该退出裁剪模式');
    assert.ok(r.after[0] < r.before[0] && r.after[1] < r.before[1],
      `裁剪后尺寸应该变小：${r.before} -> ${r.after}，计划 ${r.plan}，画布 ${r.canvas}`);
    assert.ok(Math.abs(r.after[0] - r.plan[0]) <= 1 && Math.abs(r.after[1] - r.plan[1]) <= 1,
      `实际尺寸应该等于渲染计划：${r.after} vs ${r.plan}`);
  });

  await t('⭐ 裁剪内容的上下朝向（已知未解决）', SETUP + `
    await load(makeQuad());
    window.Studio.enterCrop();
    window.Studio.setCropRotation(0);
    /* 裁画面**上半**（红 + 绿）。
       ⚠️ 正确结果：整块只有红和绿（左半红、右半绿）。
       当前实现会采到**纵向翻转**的内容（顶蓝底红），
       所以这条断言是红的 —— 这是**已知未解决**的问题，
       不是测试写错。保留一条明确的红，
       而不是删掉或放宽阈值（那等于把问题藏起来）。 */
    window.Studio.setCropRect({ x: 0, y: 0.5, w: 1, h: 0.5 });

    const readTopBottom = (c, g) => {
      const b1 = new Uint8Array(4), b2 = new Uint8Array(4);
      g.readPixels(5, c.height - 5, 1, 1, g.RGBA, g.UNSIGNED_BYTE, b1);
      g.readPixels(5, 5, 1, 1, g.RGBA, g.UNSIGNED_BYTE, b2);
      return { top: [b1[0], b1[1], b1[2]], bottom: [b2[0], b2[1], b2[2]] };
    };
    const c0 = window.Studio._canvas();
    const preview = readTopBottom(c0, c0.getContext('webgl', { preserveDrawingBuffer: true }));

    await window.Studio.applyCrop();
    const c = window.Studio._canvas();
    const applied = readTopBottom(c, c.getContext('webgl', { preserveDrawingBuffer: true }));
    return { preview, applied };
  `, r => {
    const isRG = p => {
      const red = p[0] > 150 && p[1] < 90 && p[2] < 90;
      const green = p[1] > 130 && p[0] < 120 && p[2] < 120;
      return red || green;
    };
    console.log('        [ori] 预览 顶=' + rgb(r.preview.top) + ' 底=' + rgb(r.preview.bottom));
    console.log('        [ori] 应用后 顶=' + rgb(r.applied.top) + ' 底=' + rgb(r.applied.bottom));

    // 先守住"所见即所得"：预览和应用后必须一致（这条是好的）
    const same = Math.max(
      ...r.preview.top.map((v, i) => Math.abs(v - r.applied.top[i])),
      ...r.preview.bottom.map((v, i) => Math.abs(v - r.applied.bottom[i]))
    );
    assert.ok(same <= 3,
      `预览和应用后必须一致（所见即所得），实际最大通道差 ${same}`);

    // 再验内容朝向 —— 这两条当前是红的（已知问题）
    assert.ok(isRG(r.preview.top) && isRG(r.preview.bottom),
      `KNOWN-ISSUE 裁画面上半，结果应该整块只有红/绿（不含蓝/白），`
      + ` 实际 顶=${rgb(r.preview.top)} 底=${rgb(r.preview.bottom)}`
      + ' —— 纵向朝向反了，见 studio.js 里 cropRenderPlan 的说明');
  });

  /* ---------------- 90° 整转 ---------------- */

  await t('⭐ 90° 整转：尺寸互换', SETUP + `
    await load(makeQuad());
    const before = [window.Studio.image.width, window.Studio.image.height];
    await window.Studio.rotateQuarter(1);
    const after = [window.Studio.image.width, window.Studio.image.height];
    return { before, after };
  `, r => {
    assert.equal(r.after[0], r.before[1], `宽应该等于原来的高：${r.after} vs ${r.before}`);
    assert.equal(r.after[1], r.before[0], `高应该等于原来的宽：${r.after} vs ${r.before}`);
  });

  await t('⭐ 90° 整转：内容真的转过去了（红从左上到右上）', SETUP + `
    await load(makeQuad());
    const before = { tl: px(...QUAD.tl), tr: px(...QUAD.tr) };
    await window.Studio.rotateQuarter(1);
    return {
      before,
      afterTL: px(...QUAD.tl), afterTR: px(...QUAD.tr),
      afterBL: px(...QUAD.bl), afterBR: px(...QUAD.br)
    };
  `, r => {
    /* 顺时针 90°：左上的红应该到右上。
       等价地说 afterTL 应该是原来的左下（蓝）。 */
    assert.ok(isRed(r.afterTR),
      `顺时针转 90° 后右上应该是红（原来的左上），实际 ${rgb(r.afterTR)}；`
      + `四象限 = 左上${rgb(r.afterTL)} 右上${rgb(r.afterTR)} `
      + `左下${rgb(r.afterBL)} 右下${rgb(r.afterBR)}`);
    assert.ok(isBlue(r.afterTL),
      `顺时针转 90° 后左上应该是蓝（原来的左下），实际 ${rgb(r.afterTL)}`);
  });

  /* ---------------- 回归 ---------------- */

  await t('取消裁剪后回到恒等变换', SETUP + `
    await load(makeQuad());
    const before = px(0.25, 0.75);
    window.Studio.enterCrop();
    window.Studio.setCropRotation(25);
    const during = px(0.5, 0.5);
    window.Studio.exitCrop(false);
    const after = px(0.25, 0.75);
    return { before, during, after, cropActive: !!window.Studio.crop };
  `, r => {
    assert.equal(r.cropActive, false, '取消后不该还在裁剪模式');
    // ⚠️ 这条防的是"uniform 是全局状态，取消后没重置"——
    // 表现是取消裁剪之后照片还是歪的
    const d = Math.max(...r.before.map((v, i) => Math.abs(v - r.after[i])));
    assert.ok(d <= 3, `取消裁剪后应该回到原样，实际最大通道差 ${d}`);
  });

  await t('回归：裁剪模式下调整功能仍然生效', SETUP + `
    await load(makeQuad());
    window.Studio.enterCrop();
    window.Studio.setCropRotation(0);
    const before = lum(px(0.25, 0.75));
    window.Studio.setValue('uExposure', 1.0);
    const after = lum(px(0.25, 0.75));
    return { before, after };
  `, r => {
    assert.ok(r.after > r.before + 15,
      `裁剪模式下曝光应该仍然生效：${r.before.toFixed(1)} -> ${r.after.toFixed(1)}`);
  });

} finally {
  if (page) await page.close().catch(() => {});
  if (chrome) shutdown(chrome);
  server.close();
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
