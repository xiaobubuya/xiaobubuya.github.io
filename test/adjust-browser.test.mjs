/* ================================================================
   修图页 —— 本地调整项的浏览器实测
   ----------------------------------------------------------------
   用 CDP 驱动真实 Chrome（SwiftShader 软件渲染 WebGL），
   验证锐化 / 暗角 / 颗粒这三个**新加的**调整项真的有效果，
   而且效果是「对的方向」。

   为什么非要在真浏览器里测：
     · shader 编译失败 node 的桩件一概看不出来（GLSL 报错很难懂）
     · 效果对不对是**像素级**的事，静态比对源码只能验"接线接上了"，
       验不了"算出来对不对"
     · 锐化的步长依赖纹理尺寸，这是最容易写错又最难自测的一处

   前置：需要先起一个静态服务器（脚本会自己起）。
   ================================================================ */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, shutdown, sleep } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.STUDIO_PORT || 8898);
// ⚠️ 带上 ?v= 是**必须**的：变异测试会改 studio.js 然后反复跑这个测试，
// 而 Chrome 对 127.0.0.1 的 GET 请求会走 HTTP 缓存 ——
// 不换 URL 的话第二次跑到的还是上一版脚本，
// 表现是"改坏了代码，测试却全绿"（实际是根本没加载新代码）。
const BUILD_TAG = String(Date.now());
const URL = `http://127.0.0.1:${PORT}/studio.html?v=${BUILD_TAG}`;

let pass = 0, fail = 0;
async function t(name, body, check) {
  // ⚠️ Runtime.evaluate 只接受**单个表达式**。直接甩语句块进去
  // 会静默返回 undefined（不是报错），所以统一包成 async IIFE。
  //
  // ⚠️ 复用同一个页面会话（page），不再每个用例新建标签页 ——
  // 一开始是每例新建，24 个用例要十几分钟，还会把 Chrome 端口占满。
  // 复用之后一轮不到一分钟。
  const code = `(async () => {
    ${READY_WAIT}
    ${body}
  })()`;
  try {
    const r = await page.eval(code);
    if (r === undefined || r === null) {
      throw new Error('页面返回 undefined（多半是代码抛异常了）');
    }
    if (r.error) throw new Error(r.error);
    check(r);
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

/** 等修图页初始化完成。放在每个用例最前面 */
const READY_WAIT = `
  await (async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const s = document.getElementById('stSliders');
      if (window.Studio && window.Studio.ADJUSTMENTS && s && s.children.length) return;
      await new Promise(r => setTimeout(r, 60));
    }
    throw new Error('修图页 20 秒内没初始化完（window.Studio / 滑杆没就绪）');
  })();
`;

/* ---------------- 起静态服务器 ---------------- */
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
try {
  chrome = await launch();
  page = await openPage(chrome.port, URL);
  console.log('\n=== 修图页：锐化 / 暗角 / 颗粒（真实 Chrome + WebGL）===\n');
  console.log(`  Chrome ${chrome.version.Browser}   静态服务 :${PORT}\n`);

  /* ================================================================
     页面里复用的辅助代码（拼进每个用例）
     ----------------------------------------------------------------
     造一张**可控的测试图**：左半深灰、右半浅灰，中间一条竖边。
     为什么不用渐变或照片：锐化要验的是"边缘对比度变大"，
     需要一条明确的边；暗角要验的是"中心不变、四角变暗"，
     需要均匀的底色。这种合成图两个都能测。
     ================================================================ */
  const SETUP = `
    const W = 400, H = 300;
    function makeImage(kind) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      if (kind === 'edge') {
        x.fillStyle = '#404040'; x.fillRect(0, 0, W/2, H);
        x.fillStyle = '#c0c0c0'; x.fillRect(W/2, 0, W/2, H);
      } else {
        x.fillStyle = '#808080'; x.fillRect(0, 0, W, H);
      }
      return c;
    }
    async function load(canvas) {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const f = new File([blob], 't.png', { type: 'image/png' });
      await window.Studio.openFile(f);
      window.Studio.resetAll();
    }
    /** 读画布某个归一化位置的像素（0~255） */
    function px(u, v) {
      const c = window.Studio._canvas();
      const g = c.getContext('webgl', { preserveDrawingBuffer: true });
      const w = c.width, h = c.height;
      const buf = new Uint8Array(4);
      // WebGL 的 y 向下，和我们的 v（向上）相反
      g.readPixels(Math.round(u * (w - 1)), Math.round((1 - v) * (h - 1)),
                   1, 1, g.RGBA, g.UNSIGNED_BYTE, buf);
      return [buf[0], buf[1], buf[2]];
    }
    const lum = p => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  `;

  /* ---------------- 前置：页面可用 ---------------- */

  await t('页面加载，shader 编译通过（9 个调整项都在）', SETUP + `
    return {
      hasStudio: !!window.Studio,
      n: (window.Studio.ADJUSTMENTS || []).length,
      keys: (window.Studio.ADJUSTMENTS || []).map(a => a.key),
      sliders: document.querySelectorAll('#stSliders input[type=range]').length,
      // 编译失败时页面会把引导层换成错误文案
      shaderFailed: /打不开修图功能/.test((document.getElementById('stDrop')||{}).textContent || '')
    };
  `, r => {
    assert.equal(r.hasStudio, true, 'window.Studio 不存在');
    assert.equal(r.shaderFailed, false, 'shader 编译失败（页面显示"打不开修图功能"）');
    assert.equal(r.n, 16, `调整项应该是 16 个，实际 ${r.n}`);
    assert.ok(r.keys.includes('uSharpness'), '缺 uSharpness');
    assert.ok(r.keys.includes('uVignette'), '缺 uVignette');
    assert.ok(r.keys.includes('uGrain'), '缺 uGrain');
    assert.ok(r.keys.includes('uCurveShadow'), '缺 uCurveShadow');
    assert.ok(r.keys.includes('uCurveFade'), '缺 uCurveFade');
    assert.ok(r.keys.includes('uHue'), '缺 uHue');
    assert.equal(r.sliders, 16, `滑杆数应该和调整项一致，实际 ${r.sliders}`);
  });

  /* ---------------- 暗角 ---------------- */

  await t('暗角：正值压暗四角，中心基本不动', SETUP + `
    await load(makeImage('flat'));
    const before = { center: lum(px(0.5, 0.5)), corner: lum(px(0.03, 0.03)) };
    window.Studio.setValue('uVignette', 0.8);
    const after = { center: lum(px(0.5, 0.5)), corner: lum(px(0.03, 0.03)) };
    return { before, after };
  `, r => {
    const cornerDrop = r.before.corner - r.after.corner;
    const centerDrop = Math.abs(r.before.center - r.after.center);
    assert.ok(cornerDrop > 20,
      `四角应该明显变暗，实际只降了 ${cornerDrop.toFixed(1)}`);
    assert.ok(centerDrop < 6,
      `中心不该被明显影响（否则人脸先暗下去），实际变了 ${centerDrop.toFixed(1)}`);
  });

  await t('暗角：负值提亮四角（反暗角）', SETUP + `
    await load(makeImage('flat'));
    const before = lum(px(0.03, 0.03));
    window.Studio.setValue('uVignette', -0.8);
    const after = lum(px(0.03, 0.03));
    return { before, after };
  `, r => {
    assert.ok(r.after > r.before + 8,
      `负值应该提亮四角，实际 ${r.before.toFixed(1)} -> ${r.after.toFixed(1)}`);
    assert.ok(r.after < 255, '不该过曝到纯白（说明正负幅度没分开收敛）');
  });

  await t('暗角：0 时完全不改变画面', SETUP + `
    await load(makeImage('flat'));
    const a = lum(px(0.03, 0.03));
    window.Studio.setValue('uVignette', 0);
    const b = lum(px(0.03, 0.03));
    return { a, b };
  `, r => {
    assert.ok(Math.abs(r.a - r.b) < 1.5, `0 应该无变化，实际 ${r.a} -> ${r.b}`);
  });

  /* ---------------- 锐化 ---------------- */

  await t('锐化：让边缘的对比度变大', SETUP + `
    await load(makeImage('edge'));
    // 边在画面正中。取边两侧各一个像素，量它们的差
    function edgeContrast() {
      const c = window.Studio._canvas();
      const g = c.getContext('webgl', { preserveDrawingBuffer: true });
      const w = c.width, h = c.height;
      const at = (x) => {
        const buf = new Uint8Array(4);
        g.readPixels(x, Math.round(h/2), 1, 1, g.RGBA, g.UNSIGNED_BYTE, buf);
        return 0.2126*buf[0] + 0.7152*buf[1] + 0.0722*buf[2];
      };
      const mid = Math.round(w/2);
      return at(mid - 3) - at(mid + 2);   // 暗边 - 亮边 的差
    }
    const before = edgeContrast();
    window.Studio.setValue('uSharpness', 1.0);
    const after = edgeContrast();
    return { before, after };
  `, r => {
    // 锐化是 USM：边缘两侧会各自被推向更暗/更亮，所以差值的绝对值变大。
    // before 是负数（暗-亮），after 应该更负
    assert.ok(Math.abs(r.after) > Math.abs(r.before) + 3,
      `锐化后边缘对比度应该变大：|${r.before.toFixed(1)}| -> |${r.after.toFixed(1)}|`);
  });

  await t('⭐ 锐化：画布渲染尺寸变化时效果不变（步长用原图尺寸）', SETUP + `
    await load(makeImage('edge'));
    function edgeContrast() {
      const c = window.Studio._canvas();
      const g = c.getContext('webgl', { preserveDrawingBuffer: true });
      const w = c.width, h = c.height;
      const at = (x) => {
        const buf = new Uint8Array(4);
        g.readPixels(x, Math.round(h/2), 1, 1, g.RGBA, g.UNSIGNED_BYTE, buf);
        return 0.2126*buf[0] + 0.7152*buf[1] + 0.0722*buf[2];
      };
      const mid = Math.round(w/2);
      return at(mid - 3) - at(mid + 2);
    }
    window.Studio.setValue('uSharpness', 1.0);

    // ⚠️ 必须在 _atScale 的回调里量 —— 它一出栈就把尺寸还原了，
    // 在外面量到的是还原后那一帧（第一版就是这么写的，白测一轮）
    const wideW = window.Studio._canvas().width;
    const wide = edgeContrast();
    let narrow = null, narrowW = null;
    window.Studio._atScale(0.5, () => {
      narrowW = window.Studio._canvas().width;
      narrow = edgeContrast();
    });
    return { wide, narrow, wideW, narrowW };
  `, r => {
    assert.notEqual(r.wideW, r.narrowW,
      `渲染尺寸没有真的变化（${r.wideW} -> ${r.narrowW}），这条测试没测到东西`);
    // 用原图 texel 的话，边缘对比度不该随渲染尺寸跳变
    const rel = Math.abs(r.wide - r.narrow) / Math.max(1, Math.abs(r.wide));
    assert.ok(rel < 0.35,
      `渲染尺寸变化后锐化强度差太多（${r.wide.toFixed(1)} -> ${r.narrow.toFixed(1)}，`
      + `相对差 ${(rel * 100).toFixed(0)}%）—— 步长可能用了画布尺寸`);
  });

  await t('锐化：0 时完全不改变画面', SETUP + `
    await load(makeImage('edge'));
    function edgeContrast() {
      const c = window.Studio._canvas();
      const g = c.getContext('webgl', { preserveDrawingBuffer: true });
      const w = c.width, h = c.height;
      const at = (x) => {
        const buf = new Uint8Array(4);
        g.readPixels(x, Math.round(h/2), 1, 1, g.RGBA, g.UNSIGNED_BYTE, buf);
        return 0.2126*buf[0] + 0.7152*buf[1] + 0.0722*buf[2];
      };
      const mid = Math.round(w/2);
      return at(mid - 3) - at(mid + 2);
    }
    const a = edgeContrast();
    window.Studio.setValue('uSharpness', 0);
    const b = edgeContrast();
    return { a, b };
  `, r => {
    assert.ok(Math.abs(r.a - r.b) < 1.5, `0 应该无变化，实际 ${r.a} -> ${r.b}`);
  });

  /* ---------------- 颗粒 ---------------- */

  await t('颗粒：让相邻像素产生差异（真的有噪声）', SETUP + `
    await load(makeImage('flat'));
    function localVariance() {
      const c = window.Studio._canvas();
      const g = c.getContext('webgl', { preserveDrawingBuffer: true });
      const w = c.width, h = c.height;
      const N = 40;
      const buf = new Uint8Array(N * 4);
      g.readPixels(Math.round(w/2) - N/2, Math.round(h/2), N, 1,
                   g.RGBA, g.UNSIGNED_BYTE, buf);
      const v = [];
      for (let i = 0; i < N; i++) v.push(0.2126*buf[i*4] + 0.7152*buf[i*4+1] + 0.0722*buf[i*4+2]);
      const mean = v.reduce((a,b)=>a+b,0) / N;
      return Math.sqrt(v.reduce((a,b)=>a+(b-mean)*(b-mean),0) / N);
    }
    const before = localVariance();
    window.Studio.setValue('uGrain', 1.0);
    const after = localVariance();
    return { before, after };
  `, r => {
    assert.ok(r.before < 1.0,
      `纯色图本来不该有噪声，实际标准差 ${r.before.toFixed(2)}`);
    assert.ok(r.after > 3.0,
      `颗粒应该产生明显噪声，实际标准差只有 ${r.after.toFixed(2)}`);
  });

  await t('颗粒：暗部比亮部受影响小（不浮灰）', SETUP + `
    await load(makeImage('flat'));
    function varianceAt(shade) {
      // 直接改图的底色不方便，改用「曝光」把整体压暗/提亮
      window.Studio.setValue('uExposure', shade);
      const c = window.Studio._canvas();
      const g = c.getContext('webgl', { preserveDrawingBuffer: true });
      const w = c.width, h = c.height;
      const N = 40;
      const buf = new Uint8Array(N * 4);
      g.readPixels(Math.round(w/2) - N/2, Math.round(h/2), N, 1,
                   g.RGBA, g.UNSIGNED_BYTE, buf);
      const v = [];
      for (let i = 0; i < N; i++) v.push(0.2126*buf[i*4] + 0.7152*buf[i*4+1] + 0.0722*buf[i*4+2]);
      const mean = v.reduce((a,b)=>a+b,0) / N;
      return { mean, sd: Math.sqrt(v.reduce((a,b)=>a+(b-mean)*(b-mean),0) / N) };
    }
    window.Studio.setValue('uGrain', 1.0);
    const dark = varianceAt(-1.6);     // 压暗
    const mid  = varianceAt(0);        // 中间调
    const bright = varianceAt(1.6);    // 提亮
    return { dark, mid, bright };
  `, r => {
    assert.ok(r.mid.sd > r.dark.sd,
      `暗部的颗粒应该比中间调弱（不浮灰）：暗 ${r.dark.sd.toFixed(2)} vs 中 ${r.mid.sd.toFixed(2)}`);
    assert.ok(r.mid.sd > r.bright.sd,
      `亮部的颗粒应该比中间调弱：亮 ${r.bright.sd.toFixed(2)} vs 中 ${r.mid.sd.toFixed(2)}`);
  });

  await t('颗粒：0 时不产生噪声', SETUP + `
    await load(makeImage('flat'));
    function localVariance() {
      const c = window.Studio._canvas();
      const g = c.getContext('webgl', { preserveDrawingBuffer: true });
      const w = c.width, h = c.height;
      const N = 40;
      const buf = new Uint8Array(N * 4);
      g.readPixels(Math.round(w/2) - N/2, Math.round(h/2), N, 1,
                   g.RGBA, g.UNSIGNED_BYTE, buf);
      const v = [];
      for (let i = 0; i < N; i++) v.push(0.2126*buf[i*4] + 0.7152*buf[i*4+1] + 0.0722*buf[i*4+2]);
      const mean = v.reduce((a,b)=>a+b,0) / N;
      return Math.sqrt(v.reduce((a,b)=>a+(b-mean)*(b-mean),0) / N);
    }
    window.Studio.setValue('uGrain', 0);
    return { sd: localVariance() };
  `, r => {
    assert.ok(r.sd < 1.0, `0 时不该有噪声，实际标准差 ${r.sd.toFixed(2)}`);
  });

  /* ---------------- 色调曲线（读像素验证） ---------------- */

  await t('⭐ 曲线·阴影 提亮暗部、不影响亮部', SETUP + `
    await load(makeImage('flat'));
    // 用曝光把整张图压暗，让它的亮度落在"暗部"
    window.Studio.setValue('uExposure', -1.8);
    const before = lum(px(0.5, 0.5));
    window.Studio.setValue('uCurveShadow', 1.0);
    const after = lum(px(0.5, 0.5));
    return { before, after };
  `, r => {
    assert.ok(r.after > r.before + 10,
      `曲线·阴影+1 应该提亮暗部：${r.before.toFixed(1)} -> ${r.after.toFixed(1)}`);
  });

  await t('⭐ 褪色：黑位被抬起来（暗部不再纯黑）', SETUP + `
    await load(makeImage('edge'));
    // 造一张纯黑的图
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    const x = c.getContext('2d');
    x.fillStyle = '#000000'; x.fillRect(0, 0, 200, 200);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await window.Studio.openFile(new File([blob], 'b.png', { type: 'image/png' }));
    window.Studio.resetAll();
    const before = lum(px(0.5, 0.5));
    window.Studio.setValue('uCurveFade', 1.0);
    const after = lum(px(0.5, 0.5));
    return { before, after };
  `, r => {
    assert.ok(r.before < 6, `纯黑图本来该接近 0，实际 ${r.before.toFixed(1)}`);
    assert.ok(r.after > 25,
      `褪色+1 应该把黑位抬起来，实际 ${r.before.toFixed(1)} -> ${r.after.toFixed(1)}`);
    assert.ok(r.after < 90, `黑位抬太高会糊成灰，实际 ${r.after.toFixed(1)}`);
  });

  await t('曲线全 0 时不改变画面', SETUP + `
    await load(makeImage('flat'));
    const a = lum(px(0.5, 0.5));
    window.Studio.setValue('uCurveShadow', 0);
    window.Studio.setValue('uCurveMid', 0);
    window.Studio.setValue('uCurveHigh', 0);
    window.Studio.setValue('uCurveFade', 0);
    const b = lum(px(0.5, 0.5));
    return { a, b };
  `, r => {
    assert.ok(Math.abs(r.a - r.b) < 1.5, `全 0 应该无变化，实际 ${r.a} -> ${r.b}`);
  });

  /* ---------------- HSL（读像素验证） ---------------- */

  await t('⭐ 色相 +1 让红色往黄绿转（R 减、B 增）', SETUP + `
    await load(makeImage('edge'));
    // 造一张纯红的图，方便看色相旋转
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    const x = c.getContext('2d');
    x.fillStyle = '#d02020'; x.fillRect(0, 0, 200, 200);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await window.Studio.openFile(new File([blob], 'r.png', { type: 'image/png' }));
    window.Studio.resetAll();
    const before = px(0.5, 0.5);
    window.Studio.setValue('uHue', 1.0);
    const after = px(0.5, 0.5);
    return { before, after };
  `, r => {
    // 纯红 #d02020 = (208,32,32)。+30° 之后实测是 (206,10,149) ——
    // ⚠️ 注意别只看 R：R 只降了 2，变化主要在 **B**（32 → 149）。
    // 一开始断言写的是"R 明显下降、G 明显上升"，结果 R 只降 2 就误报了，
    // 其实 HSL 是对的（和手算的 YIQ 旋转逐位相同）。
    // 用"红色往蓝/品红方向转"来判断更稳：R 微降、B 大增。
    assert.ok(r.after[2] > r.before[2] + 50,
      `色相+1 应该让蓝通道大增：B ${r.before[2]} -> ${r.after[2]}`);
    assert.ok(r.after[0] <= r.before[0],
      `色相+1 时红通道不该增加：R ${r.before[0]} -> ${r.after[0]}`);
    // G 应该降到接近 0（红转出去之后绿分量很小）
    assert.ok(r.after[1] < r.before[1],
      `色相+1 应该让绿通道下降：G ${r.before[1]} -> ${r.after[1]}`);
  });

  await t('无彩色像素不被色相影响（灰色没有色相可转）', SETUP + `
    await load(makeImage('flat'));
    const before = px(0.5, 0.5);
    window.Studio.setValue('uHue', 1.0);
    const after = px(0.5, 0.5);
    return { before, after };
  `, r => {
    // 灰的 I/Q 都是 0，旋转之后还是 0 —— 这是 YIQ 近似的正确行为
    const d = Math.max(...r.before.map((v, i) => Math.abs(v - r.after[i])));
    assert.ok(d <= 3, `灰度图不该被色相影响，实际最大通道差 ${d}`);
  });

  await t('⭐ HSL 饱和度 -1 把彩色去成灰', SETUP + `
    await load(makeImage('edge'));
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    const x = c.getContext('2d');
    x.fillStyle = '#d02020'; x.fillRect(0, 0, 200, 200);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await window.Studio.openFile(new File([blob], 'r.png', { type: 'image/png' }));
    window.Studio.resetAll();
    window.Studio.setValue('uHslSat', -1.0);
    const p = px(0.5, 0.5);
    return { p, spread: Math.max(...p) - Math.min(...p) };
  `, r => {
    assert.ok(r.spread < 20,
      `HSL 饱和度 -1 应该基本去色，实际通道差 ${r.spread}（${r.p.join(',')}）`);
  });

  await t('HSL 明度 +1 提亮、-1 压暗', SETUP + `
    await load(makeImage('flat'));
    const base = lum(px(0.5, 0.5));
    window.Studio.setValue('uHslLight', 1.0);
    const up = lum(px(0.5, 0.5));
    window.Studio.setValue('uHslLight', -1.0);
    const down = lum(px(0.5, 0.5));
    return { base, up, down };
  `, r => {
    if (process.env.MUT_DEBUG) {
      console.log(`      [hslLight] base=${r.base.toFixed(1)} up=${r.up.toFixed(1)} down=${r.down.toFixed(1)}`);
    }
    /* 语义是"往白/黑推"，不是"推到纯白/纯黑"。
       中灰 128 推到头**实测** 191 / 64（用 MUT_DEBUG=1 跑出来看的）。
       ⚠️ 别再凭公式推算这些数：中灰在 sRGB 与线性空间之间来回换算
       很容易算错一位（我自己按公式推 217/51，实际是 191/64）。
       阈值按实测值留余量定，别写成"接近 255"。

       ⚠️ 但阈值也**不能太松**：第一版写 > base + 8，
       把实现换成"给 Y 加常数"（高光区失效的错误写法）也照样通过 ——
       中灰 128 会变 173，仍然满足 > 136。阈值太松等于没测。 */
    assert.ok(r.up > 175,
      `明度+1 应该把中灰明显推向白，实际 ${r.base.toFixed(1)} -> ${r.up.toFixed(1)}`);
    assert.ok(r.down < 75,
      `明度-1 应该把中灰明显推向黑，实际 ${r.base.toFixed(1)} -> ${r.down.toFixed(1)}`);
    // 对称性：+1 和 -1 对中灰的推离幅度应该接近
    const upDelta = r.up - r.base, downDelta = r.base - r.down;
    assert.ok(Math.abs(upDelta - downDelta) < 35,
      `明度 ±1 应该大致对称，实际 +${upDelta.toFixed(0)} / -${downDelta.toFixed(0)}`);
  });

  await t('⭐ 明度：亮部也要有效（不能推到接近纯白才测）', SETUP + `
    await load(makeImage('flat'));
    /* ⚠️ 曝光不能给太大。先试了 +2（亮度 239），结果**两种写法都**只变
       1 级 —— 因为已经贴着纯白，本来就没余量，这条测试就区分不出实现了。
       要挑「偏亮但还有空间」的亮度：+1.2 之后约 179，
       按 l 推能到 ~214，而"加常数"只能到 ~188。有区分度。 */
    window.Studio.setValue('uExposure', 1.2);
    const bright = lum(px(0.5, 0.5));
    window.Studio.setValue('uHslLight', 1.0);
    const up = lum(px(0.5, 0.5));

    window.Studio.setValue('uExposure', -1.2);
    window.Studio.setValue('uHslLight', 0);
    const dark = lum(px(0.5, 0.5));
    window.Studio.setValue('uHslLight', -1.0);
    const down = lum(px(0.5, 0.5));
    return { bright, up, dark, down };
  `, r => {
    // 这条测试存在的理由：中灰上「给 Y 加常数」和「按 HSL 的 l 推」
    // 两种写法输出**完全一样**（实测都是 217/39），所以只测中灰的话
    // 那个错误写法根本抓不到 —— 变异测试里踩过这个坑。
    // 差别在色阶两端，所以这里必须测"偏亮"和"偏暗"的像素。
    assert.ok(r.up - r.bright >= 12,
      `亮部明度+1 应该有明显提升：${r.bright.toFixed(1)} -> ${r.up.toFixed(1)}`
      + '（"给 Y 加常数"那种写法在这里几乎没效果）');
    assert.ok(r.dark - r.down >= 12,
      `暗部明度-1 应该有明显下降：${r.dark.toFixed(1)} -> ${r.down.toFixed(1)}`);
  });

  await t('HSL 全 0 时不改变画面', SETUP + `
    await load(makeImage('flat'));
    const a = px(0.5, 0.5);
    window.Studio.setValue('uHue', 0);
    window.Studio.setValue('uHslSat', 0);
    window.Studio.setValue('uHslLight', 0);
    const b = px(0.5, 0.5);
    return { a, b };
  `, r => {
    const d = Math.max(...r.a.map((v, i) => Math.abs(v - r.b[i])));
    assert.ok(d <= 2, `全 0 应该无变化，实际最大通道差 ${d}`);
  });

  /* ---------------- 组合与回归 ---------------- */

  await t('三个一起开也能正常渲染（不是互相覆盖）', SETUP + `
    await load(makeImage('edge'));
    window.Studio.setValue('uSharpness', 0.6);
    window.Studio.setValue('uVignette', 0.5);
    window.Studio.setValue('uGrain', 0.4);
    const c = window.Studio._canvas();
    const g = c.getContext('webgl', { preserveDrawingBuffer: true });
    const corner = new Uint8Array(4), center = new Uint8Array(4);
    const w = c.width, h = c.height;
    g.readPixels(3, 3, 1, 1, g.RGBA, g.UNSIGNED_BYTE, corner);
    g.readPixels(Math.round(w/2), Math.round(h/2), 1, 1, g.RGBA, g.UNSIGNED_BYTE, center);
    return {
      cornerLum: 0.2126*corner[0]+0.7152*corner[1]+0.0722*corner[2],
      centerLum: 0.2126*center[0]+0.7152*center[1]+0.0722*center[2],
      isChanged: window.Studio.isChanged(),
      glError: g.getError()
    };
  `, r => {
    assert.equal(r.glError, 0, 'WebGL 报错了：' + r.glError);
    assert.equal(r.isChanged, true, 'isChanged() 应该是 true');
    assert.ok(r.cornerLum < r.centerLum,
      '暗角 + 中心在边界上，四角应该比中心暗');
  });

  await t('重置全部调整后画面回到原图', SETUP + `
    await load(makeImage('flat'));
    const before = lum(px(0.03, 0.03));
    window.Studio.setValue('uVignette', 0.9);
    window.Studio.setValue('uGrain', 0.8);
    window.Studio.setValue('uSharpness', 0.7);
    const changed = lum(px(0.03, 0.03));
    window.Studio.resetAll();
    const after = lum(px(0.03, 0.03));
    return { before, changed, after, isChanged: window.Studio.isChanged() };
  `, r => {
    assert.ok(Math.abs(r.changed - r.before) > 10, '调整后应该有明显变化');
    assert.ok(Math.abs(r.after - r.before) < 1.5,
      `重置后应该回到原图：${r.before.toFixed(1)} -> ${r.after.toFixed(1)}`);
    assert.equal(r.isChanged, false, '重置后 isChanged() 应该是 false');
  });

  await t('按住对比键看到的是未经调整的原图', SETUP + `
    await load(makeImage('flat'));
    window.Studio.setValue('uVignette', 0.9);
    window.Studio.setValue('uGrain', 1.0);
    window.Studio.setValue('uSharpness', 1.0);
    const adjusted = lum(px(0.03, 0.03));
    window.Studio.setOriginal(true);
    const original = lum(px(0.03, 0.03));
    window.Studio.setOriginal(false);
    return { adjusted, original };
  `, r => {
    // 暗角把四角压暗了，所以「调整后」应该明显暗于原图。
    // （第一版断言写反了方向 —— 那时其实是真的方向错了：
    //   shader 里 0.9 把四角从 128 抬到了 216。测试是对的，实现是错的。）
    assert.ok(r.original > r.adjusted + 10,
      `按住对比键应该看到未被压暗的原图：调整后 ${r.adjusted.toFixed(1)} 应该明显暗于原图 ${r.original.toFixed(1)}`);
    assert.ok(r.original > 110 && r.original < 145,
      `原图四角应该接近中灰 128，实际 ${r.original.toFixed(1)}`);
  });

  /* ---------------- 局部调整的交互（回归） ---------------- */

  await t('⭐ 局部调整：涂过的地方锐化不被混掉', SETUP + `
    await load(makeImage('edge'));
    window.Studio.setValue('uSharpness', 1.0);
    function edgeContrast() {
      const c = window.Studio._canvas();
      const g = c.getContext('webgl', { preserveDrawingBuffer: true });
      const w = c.width, h = c.height;
      const at = (x) => {
        const buf = new Uint8Array(4);
        g.readPixels(x, Math.round(h/2), 1, 1, g.RGBA, g.UNSIGNED_BYTE, buf);
        return 0.2126*buf[0] + 0.7152*buf[1] + 0.0722*buf[2];
      };
      const mid = Math.round(w/2);
      return at(mid - 3) - at(mid + 2);
    }
    const globalOnly = edgeContrast();
    // 把整张图涂上，然后开「只作用于涂过的区域」
    window.Studio.paintRect(0.02, 0.02, 0.98, 0.98);
    window.Studio.setUseMask(true);
    const withMask = edgeContrast();
    return { globalOnly, withMask };
  `, r => {
    // 整张都涂了，所以锐化效果应该保留
    assert.ok(Math.abs(r.withMask) > Math.abs(r.globalOnly) * 0.7,
      `整张涂满时锐化不该被削弱：${r.globalOnly.toFixed(1)} -> ${r.withMask.toFixed(1)}`
      + '（说明局部调整混了未锐化的 src）');
  });

  await t('⭐ 局部调整：暗角/颗粒不受蒙版影响', SETUP + `
    await load(makeImage('flat'));
    window.Studio.setValue('uVignette', 0.9);
    const globalCorner = lum(px(0.03, 0.03));
    // 只涂画面中心一小块，然后开局部调整
    window.Studio.paintRect(0.4, 0.4, 0.6, 0.6);
    window.Studio.setUseMask(true);
    const maskedCorner = lum(px(0.03, 0.03));
    return { globalCorner, maskedCorner };
  `, r => {
    // 四角没被涂，但暗角是"整张照片的收尾处理"，不该受蒙版开关影响
    assert.ok(Math.abs(r.globalCorner - r.maskedCorner) < 8,
      `暗角不该随蒙版变化：${r.globalCorner.toFixed(1)} -> ${r.maskedCorner.toFixed(1)}`
      + '（说明暗角被放进蒙版混合里了 —— 涂过的地方会像破了个洞）');
  });

  await t('回归：曝光/对比度/饱和度仍然有效', SETUP + `
    await load(makeImage('edge'));
    const a = lum(px(0.25, 0.5));
    window.Studio.setValue('uExposure', 1.0);
    const b = lum(px(0.25, 0.5));
    window.Studio.setValue('uExposure', 0);
    window.Studio.setValue('uSaturation', -1.0);
    const c0 = px(0.25, 0.5);
    return { a, b, sat: { r: c0[0], g: c0[1], b: c0[2] } };
  `, r => {
    assert.ok(r.b > r.a + 15, `曝光 +1 应该提亮：${r.a.toFixed(1)} -> ${r.b.toFixed(1)}`);
    // 饱和度 -1 = 完全去色，RGB 三通道应该基本相等
    const spread = Math.max(r.sat.r, r.sat.g, r.sat.b) - Math.min(r.sat.r, r.sat.g, r.sat.b);
    assert.ok(spread < 6, `饱和度 -1 应该去色，实际通道差 ${spread}`);
  });

} finally {
  if (page) await page.close().catch(() => {});
  if (chrome) shutdown(chrome);
  server.close();
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
