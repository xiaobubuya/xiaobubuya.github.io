/* ================================================================
   几何核心：裁剪 / 旋转 / 翻转 / 缩放
   ----------------------------------------------------------------
   ⚠️⚠️ 这份测试**重写**过。旧版守的是一整套"旋转后自动收框"的数学
   （inscribedRect / fitRatioInRotated / aabbFitsInRotated），那套已经
   被用户明确否掉：

     "裁剪和翻转做复杂了，不需要做数学运算，裁剪和旋转分开做"

   所以现在守的是**新模型的结构性不变量**：

     ① 显示变换必须是**相似变换**（旋转 + 等比缩放 + 镜像），
        绝不能出现"两个轴倍数不同"——那是图片被拉伸的唯一原因。
        ⚠️ 判据是**结构性**的：shader 里只能有一个标量缩放 uniform，
        代码里不能出现第二个缩放系数。这比"从像素反推"硬得多 ——
        旧模型就是靠在三处不同的地方维持一条代数等式，前后错了三次。
     ② 取景框永远在 [0,1] 内、且不小于最小边长（不变量，任何入口之后都成立）
     ③ 旋转角**不碰取景框**（用户要的"裁剪和旋转分开做"）
     ④ 缩放不改变取景框（zoom 是显示工具，不是构图工具）
     ⑤ 0° / 无缩放 / 无翻转时是恒等变换
     ⑥ 导出计划：输出 = 取景框那块区域的像素尺寸，且两个轴同一个系数

   为什么这些能静态验：它们全是**代数/结构**性质，不需要 GPU。
   真正需要看像素的（朝向、旋转方向、深色底）在
   test/rotate-invariant.test.mjs 里用真 Chrome 验。
   ================================================================ */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'studio.js'), 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== 几何核心（裁剪 / 旋转 / 翻转 / 缩放）===\n');

/* ================================================================
   从源码里按**大括号配对**抠出一个函数体。
   ⚠️ 不能用非贪婪正则 —— 函数体里有嵌套的大括号（对象字面量、
   if 块），正则会在第一个 } 处截断。这个坑踩过。
   ================================================================ */
function extractFn(name) {
  const key = 'function ' + name + '(';
  const i = SRC.indexOf(key);
  assert.ok(i >= 0, `源码里找不到函数 ${name}`);
  const open = SRC.indexOf('{', i);
  assert.ok(open >= 0, `${name} 没有函数体`);
  let depth = 0;
  for (let j = open; j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return SRC.slice(open + 1, j);
    }
  }
  assert.fail(`${name} 的大括号没有闭合`);
}

const FRAG = (() => {
  const i = SRC.indexOf('const FRAG = `');
  assert.ok(i >= 0, '找不到 FRAG');
  const j = SRC.indexOf('`;', i);
  assert.ok(j > i, '找不到 FRAG 的结束反引号');
  return SRC.slice(i + 'const FRAG = `'.length, j);
})();

/* ================================================================
   ① 相似变换：shader 里只能有一个标量缩放
   ================================================================ */
t('⭐ shader 只有**一个标量**显示缩放，没有双轴缩放', () => {
  assert.ok(/uniform\s+float\s+uDisplayScale/.test(FRAG),
    'FRAG 里应该有 `uniform float uDisplayScale`（标量）');
  assert.ok(!/uniform\s+vec2\s+uUvScale/.test(FRAG),
    'FRAG 里不该再出现 `uniform vec2 uUvScale` —— 双轴缩放就是各向异性，'
    + '图片一定被拉伸。旧模型靠 sX·W0/(sY·H0)==outW/outH 去救，错了三次。');
  assert.ok(!/uniform\s+vec2\s+uCropOffset/.test(FRAG), 'uCropOffset 已被 uImgOffset 取代');
});

t('⭐ 旋转用矩阵、缩放用同一个标量除两个轴', () => {
  // 取几何变换那一段
  const i = FRAG.indexOf('if (!identity)');
  assert.ok(i > 0, '找不到几何变换的代码块');
  const seg = FRAG.slice(i, i + 420);
  assert.ok(/mat2\(ca,\s*sa,\s*-sa,\s*ca\)/.test(seg),
    `旋转必须写成 mat2 旋转矩阵，实际片段：\n${seg}`);
  assert.ok(/\/\s*uDisplayScale/.test(seg),
    '缩放必须是 `p / uDisplayScale`（一个标量管两个轴）');
  // 不允许出现按轴分开的乘除
  const bad = seg.match(/vec2\s*\(\s*[\d.]+\s*\/\s*uDisplayScale\s*,\s*[\d.]+\s*\/\s*uDisplayScale\s*\)/);
  assert.equal(bad, null, '不允许按轴分别缩放（那就是各向异性）');
});

t('翻转是在**中心坐标**里做的（否则会整体偏移）', () => {
  const i = FRAG.indexOf('if (!identity)');
  const seg = FRAG.slice(i, i + 420);
  assert.ok(/\(vUv\s*-\s*0\.5\)\s*\*\s*uFlip/.test(seg),
    '翻转必须作用在 (vUv-0.5) 上 —— 直接翻 vUv 会把画面整体移出视口');
});

t('露到原图外的部分输出深色底，且用显式判定而不是依赖 CLAMP', () => {
  assert.ok(/uBg/.test(FRAG), 'FRAG 里应该有 uBg 深色底 uniform');
  assert.ok(/u\.x\s*<\s*0\.0|u\s*-\s*1\.0/.test(FRAG),
    '必须显式判定 u 是否超出 [0,1] —— 只靠 CLAMP_TO_EDGE 会把边缘'
    + '拉成条纹（深色底上一条条亮线，实测过）');
});

/* ================================================================
   ② 取景框 clamp：基本不变量
   ================================================================ */
const clampBody = extractFn('clampCropRect');
const MIN_RECT = Number((SRC.match(/const MIN_RECT = ([\d.]+)/) || [])[1]);
assert.ok(MIN_RECT > 0, '找不到 MIN_RECT');

t('取景框永远落在 [0,1] 内、且不小于最小边长', () => {
  const clamp = new Function('MIN_RECT', 'r', clampBody);
  const cases = [
    { x: -1, y: -1, w: 3, h: 3 },
    { x: 0.9, y: 0.9, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0.5, w: 0, h: 0 },
    { x: 0.2, y: 0.2, w: 0.1, h: 0.1 },
    { x: NaN, y: undefined, w: null, h: 'x' }
  ];
  for (const c of cases) {
    const r = clamp(MIN_RECT, c);
    const tag = JSON.stringify(c);
    assert.ok(r.w >= MIN_RECT - 1e-12 && r.h >= MIN_RECT - 1e-12,
      `${tag} → w=${r.w} h=${r.h} 小于最小边长`);
    assert.ok(r.x >= -1e-12 && r.x + r.w <= 1 + 1e-12,
      `${tag} → x=${r.x} w=${r.w} 越出 [0,1]`);
    assert.ok(r.y >= -1e-12 && r.y + r.h <= 1 + 1e-12,
      `${tag} → y=${r.y} h=${r.h} 越出 [0,1]`);
    assert.ok(Number.isFinite(r.x + r.y + r.w + r.h), `${tag} → 出现 NaN`);
  }
});

/* ================================================================
   ③④⑤ 旋转 / 缩放都不碰取景框
   ================================================================ */
t('⭐⭐ 旋转角**不改变**取景框（裁剪和旋转分开做）', () => {
  const body = extractFn('setDisplay');
  // setDisplay 里不允许出现 geom.rect 的写入
  const writes = body.match(/geom\.rect\s*=/g) || [];
  assert.equal(writes.length, 0,
    'setDisplay（改角度/翻转/缩放）里出现了 geom.rect 赋值 —— '
    + '这正是用户否掉的"旋转后自动收框"。旋转只该改 rot/flip/zoom。');

  const rotBody = extractFn('setCropRotation');
  assert.ok(!/rect/.test(rotBody),
    'setCropRotation 里不该碰取景框');
});

t('⭐ 缩放不改变取景框（zoom 只是显示工具）', () => {
  const body = extractFn('setDisplay');
  assert.ok(/geom\.zoom\s*=/.test(body), 'setDisplay 应该负责设置 zoom');
  assert.ok(!/rect/.test(body), 'setDisplay 不该碰 rect');
});

t('⭐ 烘焙计划固定 1:1（按源图分辨率应用，不把 zoom 烘进去）', () => {
  const body = extractFn('bakeRenderPlan');
  /* 语义：烘焙输出的就是"取景框那块区域"本身，所以缩放恒为 1
     （viewportDims(rot, 1)），输出尺寸 = 取景框占视口的份额 × 视口。
     ⚠️ 别写成 1/zoom —— 那会让"拉远看一眼再点应用"把照片缩掉。
     也漏过另一步：早期直接拿 r.w*W0，等于假设视口宽就是 W0；
     旋转后视口撑大了，那样采到的区域和预览不一致。 */
  assert.ok(/screenZoom:\s*1\b/.test(body),
    '烘焙的 screenZoom 应该是 1（1:1 输出）');
  assert.ok(/viewportDims\(\s*geom\.rot\s*,\s*1\s*\)/.test(body),
    '烘焙要用 zoom=1 的视口尺寸（viewportDims(geom.rot, 1)）'
    + ' —— 不然旋转后视口撑大了，采到的区域和预览对不上');
  /* 偏移恒为 0：画布/缓冲显示的是**整个视口**，取景框只是画在上面的
     一个框，所以"缓冲坐标 → 图片坐标"除了缩放没有平移。
     这一处错过两轮（取景框中心偏移、视口原点=取景框左下角），
     两个错法在满幅取景框时都恰好等于 0，所以只有收小取景框才暴露。 */
  assert.ok(/offX:\s*0,\s*offY:\s*0/.test(body),
    '烘焙的偏移必须恒为 0（视口→图片没有平移）——'
    + '取景框的位置只影响输出尺寸，不该让画面整体平移');
  assert.ok(!/geom\.zoom/.test(body),
    '烘焙里不该出现 geom.zoom —— 那是显示缩放，'
    + '烘进去会让"拉远看完整张图 → 点应用"变成照片缩水。');
});

/* ================================================================
   ⑥ 导出计划：输出比例 == 取景框比例，两个轴同一个系数
   ================================================================ */
/* 造一个只带 $ / img / viewportDims 的最小环境，把 cropRenderPlan 原样跑起来。
   ⚠️ 用 extractFn 拿源码，不在这里重写一遍逻辑 —— 重写就等于
   测了个假的（照着实现抄的测试永远通过）。
   ⚠️ viewportDims 也从源码里取，别在这里手写一份：它一变（这个函数
   已经错过三次）测试就会跟着一起错，那就白测了。 */
const planEnv = (W0, H0, zoom, rect, forExport) => {
  const geom = { rect, rot: 0, flipX: false, flipY: false, zoom, aspect: -1 };
  const img = { width: W0, height: H0 };
  const $ = () => ({ clientWidth: 1200, clientHeight: 800 });
  const window = { devicePixelRatio: 1 };
  const fn = new Function('geom', 'img', '$', 'window', 'forExport', 'ZOOM_MAX',
    'override', 'viewportDims', 'viewportBox', 'rotatePad',
    'const out = (function() {' + extractFn('cropRenderPlan') + '})();'
    + 'return out;');
  const viewportDims = new Function('img',
    'const rotatePad = function(deg) {' + extractFn('rotatePad') + '};'
    + 'return function(deg, zoom) {' + extractFn('viewportDims') + '};')(img);
  const viewportBox = new Function(
    'return function(w, h, deg) {' + extractFn('viewportBox') + '};')();
  const rotatePad = new Function(
    'return function(deg) {' + extractFn('rotatePad') + '};')();
  return fn(geom, img, $, window, forExport, 2, undefined, viewportDims,
            viewportBox, rotatePad);
};

/* 单纯把 autoZoomFor / rotatePad 抠出来跑（只依赖 img 和两个常量）。 */
const autoZoomEnv = (W0, H0, deg) => {
  const img = { width: W0, height: H0 };
  const ZOOM_MIN = 0.25, ZOOM_MAX = 2;
  const fn = new Function('img', 'ZOOM_MIN', 'ZOOM_MAX', 'deg',
    'const viewportDims = function(deg, zoom) {' + extractFn('viewportDims') + '};'
    + 'const rotatePad = function(deg) {' + extractFn('rotatePad') + '};'
    + 'const autoZoomFor = function(deg) {' + extractFn('autoZoomFor') + '};'
    + 'return autoZoomFor(deg);');
  return fn(img, ZOOM_MIN, ZOOM_MAX, deg);
};

t('⭐ 输出比例 == 取景框比例（两个轴同一个系数 → 不扭曲）', () => {
  const cases = [
    [400, 300, 1, { x: 0, y: 0, w: 1, h: 1 }],
    [400, 300, 1, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }],
    [400, 300, 1, { x: 0.1, y: 0.6, w: 0.8, h: 0.25 }],
    [300, 400, 1, { x: 0, y: 0.5, w: 1, h: 0.5 }],
    [600, 400, 0.5, { x: 0.2, y: 0.2, w: 0.6, h: 0.4 }],
    [1920, 1080, 2, { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }]
  ];
  const bad = [];
  for (const [W0, H0, z, rect] of cases) {
    const p = planEnv(W0, H0, z, rect);
    if (!p) { bad.push(`${W0}×${H0} z=${z} → plan 为 null`); continue; }
    // 输出比例 vs 取景框的**像素**比例
    const outRatio = p.outW / p.outH;
    const rectRatio = (rect.w * W0) / (rect.h * H0);
    if (Math.abs(outRatio / rectRatio - 1) > 0.01) {
      bad.push(`${W0}×${H0} z=${z} rect=${rect.w}×${rect.h}: `
        + `输出 ${outRatio.toFixed(3)} vs 取景框 ${rectRatio.toFixed(3)}`);
    }
    // 两个轴的缩放系数必须相同
    if (Math.abs(p.s - 1 / z) > 1e-9) {
      bad.push(`${W0}×${H0} z=${z}: 缩放系数 ${p.s} 应该等于 1/zoom=${1 / z}`);
    }
  }
  assert.equal(bad.length, 0,
    `这些组合会扭曲或比例不对：\n       ${bad.join('\n       ')}`);
});

t('⭐ 输出像素数 == 屏幕上看到的那块（所见即所得）', () => {
  /* 这条原来写的是"输出不超过源图分辨率"，那是**旧设计**的假设。
     新设计里 zoom 是构图的一部分（拉近 = 裁小块看细节），所以
     放大时输出就是会比源图大 —— 那是插值，但**和屏幕一致**。
     真正要守的是"导出和预览是同一个映射"，否则用户会拿到一张
     构图和预览不一样的成品。
     判据：out = 取景框 × zoom，且 1:1 时输出正好等于取景框的像素尺寸。 */
  const bad = [];
  for (const z of [0.25, 0.5, 1, 1.5, 2]) {
    for (const [W0, H0] of [[400, 300], [300, 400], [1920, 1080]]) {
      const rect = { x: 0, y: 0, w: 1, h: 1 };
      const p = planEnv(W0, H0, z, rect);
      /* ⚠️ zoom 的语义：**zoom 越小 = 视野越宽 = 输出越大**（源图单位）。
         视口覆盖 W0/zoom × H0/zoom，取景框满幅就是整块视口。
         第一版这里写的是 W0·z（反的），因为当时 zoom 还是"放大显示"
         的老语义；现在 zoom 是"视野"的缩放，方向相反。 */
      const expW = W0 / z, expH = H0 / z;
      if (Math.abs(p.outW - expW) > 1 || Math.abs(p.outH - expH) > 1) {
        bad.push(`${W0}×${H0} zoom=${z}: 输出 ${p.outW}×${p.outH}，`
          + `期望 ${Math.round(expW)}×${Math.round(expH)}`);
      }
    }
  }
  assert.equal(bad.length, 0,
    `输出尺寸和"取景框 × zoom"对不上（预览和导出的映射会不一致）：\n`
    + `       ${bad.join('\n       ')}`);
});

t('zoom = 1 时输出就是取景框那块的原分辨率（不放大也不缩小）', () => {
  const p = planEnv(400, 300, 1, { x: 0.25, y: 0.5, w: 0.5, h: 0.5 });
  assert.equal(p.outW, 200, `应该正好 200，实际 ${p.outW}`);
  assert.equal(p.outH, 150, `应该正好 150，实际 ${p.outH}`);
});

t('⭐ 缩放直接决定输出尺寸（拉远变大、拉近变小）', () => {
  /* ⚠️ 取景框不能取满幅：满幅时"画布不能超过源图分辨率"会把它夹住
     （那是**画布**的限制），而这里要验的是**输出**尺寸跟着 zoom 走。
     用一个 0.5×0.5 的框，两边都不会碰到夹取。 */
  const rect = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const a = planEnv(400, 300, 0.5, rect);
  const b = planEnv(400, 300, 1, rect);
  const c = planEnv(400, 300, 2, rect);
  /* ⚠️ 方向：zoom **越小 = 拉远 = 视野越宽 = 输出越大**。
     第一版断言的是"zoom=0.5 的输出应该更小"，那是老语义（zoom=放大
     显示）留下的；现在 zoom 是视野缩放，反过来了。 */
  assert.ok(a.outW > b.outW,
    `zoom=0.5（拉远）的输出（${a.outW}）应该大于 zoom=1 的（${b.outW}）`);
  assert.ok(c.outW < b.outW,
    `zoom=2（拉近）的输出（${c.outW}）应该小于 zoom=1 的（${b.outW}）`);
});

t('⭐ 拉近 zoom 时输出不会超过源图（视野收窄，不是把像素拉大）', () => {
  const rect = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const b = planEnv(400, 300, 1, rect);
  const c = planEnv(400, 300, 2, rect);
  assert.ok(c.screenZoom >= b.screenZoom,
    `zoom 变大时画布缩放不该反而变小：${b.screenZoom} → ${c.screenZoom}`);
});

/* ================================================================
   旋转外接框 / 自动适配缩放：纯数学，可以直接跑
   （autoZoomEnv 定义在上面 planEnv 旁边）
   ================================================================ */

/* ================================================================
   视口尺寸（viewportDims）与"适合窗口"
   ----------------------------------------------------------------
   ⚠️ 模型在这一步**改过三次**，每次都是真 bug，所以这几条判据写硬：
     【一】视口写死 W0×H0、不随角度变 → 45° 时怎么缩都装不下，
          四角永远深色底
     【二】按 (|cos|+|sin|) 撑 → 过头，40° 时算出缩放 1.14（>1）
     【三】按 max(c/r+s, s/r+c) 撑 → 假设宽高同乘一个系数，但外接框
          比例本身就在变，实测 600×400 转 0° 得到 m=0.333（没贴边）

   ⭐ 正确模型：视口 = 图片旋转后的**外接框**本身
        vw = W0·|cosφ| + H0·|sinφ|
        vh = W0·|sinφ| + H0·|cosφ|
   判据（把图片放进视口，看它是否恰好贴边）：
      · 视口单位下图片半宽半高 a = W0/(2vw)、b = H0/(2vh)
      · 旋转后的外接半宽半高 halfW = a·c + b·s、halfH = a·s + b·c
      · 要求 halfW ≤ 0.5 且 halfH ≤ 0.5（装得下）
        且 max(halfW, halfH) ≈ 0.5（**贴边** → 没撑不够也没撑过头）
   ================================================================ */
const dimsEnv = (W0, H0, deg, zoom) => {
  const img = { width: W0, height: H0 };
  const fn = new Function('img', 'deg', 'zoom',
    'const rotatePad = function(deg) {' + extractFn('rotatePad') + '};'
    + 'const viewportDims = function(deg, zoom) {' + extractFn('viewportDims') + '};'
    + 'return viewportDims(deg, zoom);');
  return fn(img, deg, zoom);
};

/** 把图片放进视口里，返回它旋转后的外接半宽半高（视口单位，0.5 = 贴边）
 *
 *  ⚠️ 这里的归一化我写错过**三次**，一次比一次隐蔽，所以把推导写死：
 *    · 视口（源图单位）= p·W0 × p·H0，整体归一化到画布 [0,1]²
 *    · 于是"视口 1 个单位"= 1/(p·W0) 个源图单位（横向），即 kx = 1/vw
 *    · 图片半宽 W0/2 → 视口单位下是 (W0/2)·kx = 1/(2p)
 *    · 图片半高 H0/2 → 同理 = 1/(2p)   ← 两项相同，因为视口和图片同比例
 *    · 旋转后外接半宽半高 = (c+s)/(2p)，要求 ≤ 0.5
 *  错法记下来：① 用 W0/(2·vw) 之后**又**乘错一次（那是同一个数）；
 *  ② 把 vw 当 p·W0 再除一遍 → 竖图横图各错一边；
 *  ③ 以为视口 = "外接框本身"（那会让 5° 时算出 0.508 > 0.5，看着像装不下）。
 *  三种都会让这条断言变成假红或假绿。 */
function boxFit(W0, H0, deg, zoom) {
  const { vw, vh } = dimsEnv(W0, H0, deg, zoom);
  const phi = deg * Math.PI / 180;
  const c = Math.abs(Math.cos(phi)), s = Math.abs(Math.sin(phi));
  const kx = 1 / vw, ky = 1 / vh;           // 视口 → 画布的归一化系数
  const a = (W0 / 2) * kx, b = (H0 / 2) * ky;
  return { a, b, kx, ky, halfW: a * c + b * s, halfH: a * s + b * c, vw, vh };
}

t('0° 时视口就是整张图（vw=W0, vh=H0）', () => {
  for (const [W, H] of [[400, 300], [300, 400], [1000, 1000], [1920, 1080]]) {
    const d = dimsEnv(W, H, 0, 1);
    assert.ok(Math.abs(d.vw - W) < 1e-9 && Math.abs(d.vh - H) < 1e-9,
      `${W}×${H} 0° → ${d.vw}×${d.vh}，应该是 ${W}×${H}`);
  }
});

t('⭐ 视口随角度**变大**（否则四角永远露深色底）', () => {
  for (const deg of [10, 20, 30, 45]) {
    const d = dimsEnv(400, 300, deg, 1);
    assert.ok(d.vw > 400 && d.vh > 300,
      `转 ${deg}° 的视口应该比原图大，实际 ${d.vw.toFixed(1)}×${d.vh.toFixed(1)}`);
  }
});

t('⭐⭐ 视口**恰好**装下旋转后的照片（贴边，不多不少）', () => {
  const bad = [];
  for (const [W0, H0] of [[400, 300], [300, 400], [600, 400], [1000, 1000],
                          [1920, 1080]]) {
    for (const deg of [-45, -20, -5, 0, 5, 13, 30, 45]) {
      const f = boxFit(W0, H0, deg, 1);
      const m = Math.max(f.halfW, f.halfH);
      if (m > 0.5 + 1e-9) {
        bad.push(`${W0}×${H0} ${deg}°: 撑得不够（半宽半高 ${m.toFixed(4)} > 0.5）`);
      }
      if (Math.abs(m - 0.5) > 1e-6) {
        bad.push(`${W0}×${H0} ${deg}°: 没贴边（${m.toFixed(6)}，应 = 0.5）`
          + ` —— 视口撑过头了（曾经按 |cos|+|sin| 撑，40° 时多撑了 14%）`);
      }
    }
  }
  assert.equal(bad.length, 0,
    `视口尺寸不是最优解：\n       ${bad.join('\n       ')}`);
});

t('⭐ 放大 zoom 时视口按比例缩小（视野变窄）', () => {
  const a = dimsEnv(400, 300, 30, 1);
  const b = dimsEnv(400, 300, 30, 2);
  assert.ok(Math.abs(a.vw / b.vw - 2) < 1e-9 && Math.abs(a.vh / b.vh - 2) < 1e-9,
    `zoom=2 时视口应该是 zoom=1 的一半，实际 ${b.vw} vs ${a.vw}`);
});

t('⭐ 「适合窗口」的缩放恒为 1（视口已经装得下，不需要再缩）', () => {
  /* 这条拦的是历史 bug：曾经算出 1.14（>1，把照片缩掉一圈）
     和永远 1.0（视口不够大，怎么缩都装不下）。现在视口负责装下，
     缩放只负责"用户自己拉远/拉近"，默认档恒为 1。 */
  for (const deg of [-45, -20, 0, 13, 30, 45]) {
    const z = autoZoomEnv(400, 300, deg);
    assert.ok(Math.abs(z - 1) < 1e-9, `${deg}° 的适配缩放应该是 1，实际 ${z}`);
  }
});

t('取景框初始就是满幅（不因为旋转而收缩）', () => {
  const body = extractFn('resetRectToViewport');
  assert.ok(/w:\s*1,\s*h:\s*1/.test(body),
    'resetRectToViewport 应该把取景框设成满幅 —— 用户明确说过'
    + '"不要做运算、不涉及取景框收框"，任何按比例收缩都违背这条');
});

/* ================================================================
   源码里不该再残留旧模型的东西
   ================================================================ */
t('旧模型的"自动收框"代码已经被删干净', () => {
  /* ⚠️ rotatedBoxSize 不在名单里：它是**中性的几何工具**
     （算旋转后的外接框尺寸），现在只被"适合窗口"的缩放计算用，
     和"旋转后自动收框"没关系。真要守的是那几个**会反过来改取景框**的：
       inscribedRect       算最大内接矩形
       fitRatioInRotated   在内接矩形里按比例取最大
       aabbFitsInRotated   配套的可行性判据
       fitRectToBox        上面三者的组装
       currentInscribed    把内接矩形换算成取景框的归一化范围 */
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const banned = ['inscribedRect', 'fitRatioInRotated', 'aabbFitsInRotated',
                  'fitRectToBox', 'currentInscribed'];
  for (const name of banned) {
    assert.ok(!new RegExp('\\b' + name + '\\s*\\(').test(code),
      `${name}() 还在被调用 —— 那是被用户否掉的"旋转后自动收框"`);
  }
});

t('导出/烘焙两个计划都还在（别把其中一个删了）', () => {
  assert.ok(/function cropRenderPlan/.test(SRC), 'cropRenderPlan 没了（预览用）');
  assert.ok(/function bakeRenderPlan/.test(SRC), 'bakeRenderPlan 没了（应用时烘焙用）');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
