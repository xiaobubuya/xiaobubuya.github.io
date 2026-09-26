/* ================================================================
   选区的**可见反馈** —— 真 Chrome 实测
   ----------------------------------------------------------------
   起因（用户原话）：
     "这个选区都工具看着都有点问题，画笔涂抹没有什么反应，
      打开显示选区就是类似这样的渐变"

   查下来**不是蒙版算错了**（探针实测：涂一笔 → 覆盖率 1.2%、
   bbox 正好落在涂的位置、蒙版画布中心 255 边缘 0、边缘是干净的硬边）。
   真正的问题是**用户看不到自己涂了什么**：
     · "显示选区"默认关着 → 进画笔工具后涂出来在画面上一片空白，
       用户当然判断成"没反应"。左下角一直在报"已选 x% · n 笔"，
       但那是文字，不是画面上能看见的反馈
     · 那个红罩只有 0.45，在照片上很淡，再加上画笔默认硬度 0.5
       羽化很宽 → 两点叠加就是"一片看不出边界的渐变"

   所以这个文件守的是**"涂了之后用户能看见"**，不是蒙版数值
   （数值归 mask.test.mjs 的 30 项，那边不起浏览器）：
     ① 进选区工具 → "显示选区"自动打开
     ② 涂过的地方画面上真的变红（读像素，不靠"应该会"）
     ③ 没涂的地方不变红（否则等于整张图罩了层色）
     ④ 画笔光标圈的大小**和实际涂出来的范围一致**
        （用户正是靠这个圈判断"我涂到哪了"）
   ================================================================ */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, shutdown } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.MASKUI_PORT || 8903);

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
if (ACTUAL !== PORT) console.log(`\n  ⚠️ ${PORT} 被占用，改用 ${ACTUAL}\n`);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== 选区可见反馈（真 Chrome）===\n');

const chrome = await launch();
let R = {};
try {
  const page = await openPage(chrome.port,
    `http://127.0.0.1:${ACTUAL}/studio.html?v=${Date.now()}`);
  await page.eval(`(async () => {
    const dl = Date.now() + 20000;
    while (Date.now() < dl) {
      if (window.Studio && window.Studio.paint) return true;
      await new Promise(r => setTimeout(r, 60));
    }
    throw new Error('修图页 20 秒没就绪');
  })()`);

  R = await page.eval(`(async () => {
    const S = window.Studio;
    /* 纯中灰底：红罩在这上面最好量（任何偏红都是选区画出来的） */
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    const g = c.getContext('2d');
    g.fillStyle = '#808080'; g.fillRect(0, 0, 400, 300);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await S.openFile(new File([blob], 't.png', { type: 'image/png' }));
    S.resetAll();

    const cv = S._canvas();
    const gl = cv.getContext('webgl', { preserveDrawingBuffer: true });
    const rd = (u, v) => {
      const b = new Uint8Array(4);
      gl.readPixels(Math.round(u * (cv.width - 1)), Math.round(v * (cv.height - 1)),
                    1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
      return [b[0], b[1], b[2]];
    };
    const out = {};

    /* ① 进工具之前：默认不该开着显示选区 */
    out.showMaskBefore = document.getElementById('stShowMask').checked;
    /* ⚠️ 角落采样点必须**真的在笔刷之外**：半径 0.25 是相对 min(imgW,imgH)，
   400×300 的图就是 75px = 0.1875 归一化。第一版取 (0.15,0.85)，
   离中心只有 0.49 归一化 ≈ 147px，仍然在圈里 —— 于是"没涂的地方
   不该变红"这条假红。取左下角 (0.06,0.06)。 */
    out.beforePixels = { center: rd(0.5, 0.5), corner: rd(0.06, 0.06) };

    /* ② 点画笔 → 显示选区应该自动打开 */
    document.getElementById('stBrush').click();
    out.showMaskAfterBrush = document.getElementById('stShowMask').checked;
    out.brushActive = cv.classList.contains('brushing');

    /* ③ 涂一大块（半径 0.25、硬度 1），画面上该变红。
       ⚠️ 这里**显式**打开显示选区，把"红罩渲染本身对不对"和
       "进工具会不会自动打开它"两件事**分开测** ——
       混在一起的话，自动打开一旦缺失，红罩那条也会跟着红，
       就分不清是渲染坏了还是没人打开它。
       自动打开那件事由上面 ① 那条独立断言守。 */
    S.setShowMask(true);
    S.paint([[0.5, 0.5]], { radius: 0.25, hardness: 1, mode: 'add' });
    out.stats = S.maskStats();
    out.afterPixels = { center: rd(0.5, 0.5), corner: rd(0.06, 0.06) };
    out.paintRadiusUsed = S._mask().radius;

    /* ④ 光标圈 vs 实际半径：圈直径应该 ≈ 2 * 0.25 * min(imgW,imgH) * 显示缩放 */
    const rect = cv.getBoundingClientRect();
    /* ⚠️ 圈是 hidden 的，要先给画布一个指针事件才会显示（measure 前必做） */
    cv.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: rect.left + 40, clientY: rect.top + 40, pointerId: 7
    }));
    const cur = document.querySelector('.st-cursor');
    /* ⚠️ 用**当前笔刷半径**（mask.radius）算，不要用刚才 paint() 传进去的
       那个临时值 —— paint() 是测试辅助，它画完会把半径还原成滑杆上的值。
       第一版拿临时值 0.25 当期望，得到 284px，而真实圈是 45px，
       看着像"圈严重偏小"，其实圈是对的、断言错了。 */
    const imgPxR = S._mask().radius * Math.min(S.image.width, S.image.height);
    const scale = rect.width / S.image.width;
    out.cursor = {
      diameter: cur ? cur.getBoundingClientRect().width : null,
      expect: imgPxR * scale * 2,
      // 屏幕上的实际涂抹范围（归一化 → 屏幕像素）
      paintedPxPerNorm: (minDim) => minDim * scale
    };
    out.imgSize = [S.image.width, S.image.height];
    out.canvasRect = [Math.round(rect.width), Math.round(rect.height)];

    /* ④b 把画布**拉成和图片不同的比例**再看一次圈。
       ⚠️⚠️ 这一步是必须的，否则上面那条断言等于没测：
       画布 757×568 和图片 400×300 都是 1.333，于是
       "用画布短边当基准"和"用图片短边换算"恰好给出同一个 45.4px。
       真实场景里舞台通常更扁（窗口/面板比例所致），这时两者才会分叉 ——
       旧实现用 min(画布宽, 画布高)，画布一扁圈就跟着缩水。 */
    const forceStage = (w, h) => {
      cv.style.width = w + 'px';
      cv.style.height = h + 'px';
      void cv.offsetWidth;                     // 强制同步布局
      return cv.getBoundingClientRect();
    };
    const r2 = forceStage(900, 300);
    cv.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: r2.left + 40, clientY: r2.top + 40, pointerId: 8
    }));
    const cur2 = document.querySelector('.st-cursor');
    out.cursorStretched = {
      canvasCss: [Math.round(r2.width), Math.round(r2.height)],
      diameter: cur2.getBoundingClientRect().width,
      // 按"图片"换算的期望：缩放比取画布显示宽度 / 图片宽度
      expect: imgPxR * (r2.width / S.image.width) * 2
    };
    // 还原画布尺寸，别污染后面的断言
    cv.style.width = ''; cv.style.height = '';
    void cv.offsetWidth;

    /* ⑤ 擦除模式下的圈应该换个颜色（class 切换） */
    document.getElementById('stBrushErase').click();
    cv.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: rect.left + 40, clientY: rect.top + 40, pointerId: 9
    }));
    out.eraseCursorClass = document.querySelector('.st-cursor').className;
    return out;
  })()`);
  await page.close().catch(() => {});
} finally {
  shutdown(chrome);
  server.close();
}

const redder = (p) => p[0] - (p[1] + p[2]) / 2;

t('⭐ 点画笔会**自动打开"显示选区"**（否则涂了什么完全看不见）', () => {
  /* 这是用户"画笔涂抹没有什么反应"的直接根因：
     默认不显示选区 → 涂出来画面一片空白。 */
  assert.equal(R.showMaskBefore, false,
    '前置：默认不该开着显示选区（不然这条测不到东西）');
  assert.equal(R.showMaskAfterBrush, true,
    '点画笔之后"显示选区"应该自动勾上 —— '
    + '不勾的话用户看不到任何反馈，会以为工具坏了');
  assert.equal(R.brushActive, true, '画笔按钮应该进入激活态');
});

t('⭐⭐ 涂过的地方画面上真的变红（读像素，不靠"应该会"）', () => {
  const before = redder(R.beforePixels.center);
  const after = redder(R.afterPixels.center);
  assert.ok(R.stats && R.stats.coverage > 0.1,
    `前置：应该真涂上了，实际覆盖率 ${R.stats && R.stats.coverage}`);
  assert.ok(after > 40,
    `涂过的地方应该明显偏红，实际 rgb(${R.afterPixels.center}) `
    + `（红度 ${after.toFixed(1)}）`);
  assert.ok(after > before + 35,
    `涂之前/之后的红度差太小：${before.toFixed(1)} → ${after.toFixed(1)} —— `
    + '红罩太淡的话用户还是看不出选在哪');
});

t('⭐ 没涂的地方不变红（不能整张图罩一层色）', () => {
  const before = redder(R.beforePixels.corner);
  const after = redder(R.afterPixels.corner);
  assert.ok(Math.abs(after - before) < 12,
    `没涂的角落不该变红：${before.toFixed(1)} → ${after.toFixed(1)} `
    + `（rgb ${R.afterPixels.corner}）`);
});

t('⭐ 画笔光标圈的大小和实际涂出来的范围一致', () => {
  /* 用户是靠这个圈判断"我涂到哪了"。
     ⚠️ 这里曾经错过：圈用**画布短边**算、而涂抹用**图片短边**算，
     两者只在"画布是正方形"时相等 —— 编辑器面板一占宽度圈就偏了。 */
  const d = R.cursor.diameter, e = R.cursor.expect;
  assert.ok(d != null, '没找到画笔光标圈（.st-cursor）');
  const err = Math.abs(d - e) / e;
  assert.ok(err < 0.08,
    `光标圈直径 ${d.toFixed(1)}px 和实际笔下范围 ${e.toFixed(1)}px 差 `
    + `${(err * 100).toFixed(1)}%（图片 ${R.imgSize}、画布 ${R.canvasRect}）—— `
    + '圈偏了用户就会"明明涂在圈里却涂到旁边" '
    + JSON.stringify(R.diag));
});

t('⭐⭐ 画布被拉成非图片比例时，光标圈不跟着画布比例缩水', () => {
  /* 这条才是真正抓住那个 bug 的判据。
     旧写法：`radius * min(画布宽, 画布高) * 2`
       → 画布一扁（舞台比图片更宽），min 落到高度上，圈就小一圈，
         而实际涂抹仍然是按**图片**短边算的 → 圈比笔下范围小，
         用户"明明涂在圈里却涂到旁边"。
     正确写法：换算自图片尺寸，画布只提供缩放比。 */
  const c = R.cursorStretched;
  assert.ok(c && c.diameter > 0, '拉伸画布后拿不到光标圈');
  const err = Math.abs(c.diameter - c.expect) / c.expect;
  assert.ok(err < 0.08,
    `画布拉成 ${c.canvasCss[0]}×${c.canvasCss[1]} 后圈变成 `
    + `${c.diameter.toFixed(1)}px，应该仍是 ${c.expect.toFixed(1)}px`
    + `（差 ${(err * 100).toFixed(1)}%）—— 圈跟着画布比例跑就意味着`
    + '画布一扁圈就缩水，用户会涂到圈外');
});

t('擦除模式下光标圈换样式（能看出现在是擦）', () => {
  assert.ok(/erase/.test(R.eraseCursorClass || ''),
    `擦除模式的光标该带 erase 类，实际 "${R.eraseCursorClass}"`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
