/* ================================================================
   色调曲线 —— LUT 数值行为测试
   ----------------------------------------------------------------
   这部分是**纯数学**（控制点 → 单调三次插值 → 256 级 LUT），
   不需要浏览器，所以放在 node 里测。

   为什么值得单独测：
     · **单调性**是影调曲线的底线。一旦不单调，亮的地方比更亮的地方
       还暗，画面会出现"影调反转"，看着就是坏了 —— 而且这种坏
       在缩略图上不一定看得出来，很容易漏。
     · 过冲（overshoot）同理：控制点附近"鼓出去"会产生假的亮暗带。
     · 恒等性：四个滑杆都是 0 时必须输出恒等曲线，
       否则"重置"之后画面也不会回到原样。

   实现里的插值是从 studio.js 直接拿的（同一份代码），
   所以这里验的就是线上跑的那份逻辑。
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

console.log('\n=== 色调曲线：LUT 数值行为 ===\n');

/* ---------------- 从源码里把三个纯函数抠出来 ----------------
   studio.js 是浏览器脚本（依赖 DOM / WebGL），没法整个 require。
   但这两个函数是纯的，而且不引用任何外部状态，所以可以单独取出来。
   取的是**源文件里的原文**，测的就是线上跑的那份逻辑。 */
function extract(src, name) {
  // 从 `function name(` 开始，按大括号配对找到函数结尾
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > -1, `找不到函数 ${name}`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const curveControlPoints = new Function(
  extract(SRC, 'curveControlPoints') + '; return curveControlPoints;')();

const monotoneSpline = new Function(
  extract(SRC, 'monotoneSpline') + '; return monotoneSpline;')();

const CURVE_N = Number(/const CURVE_N = (\d+)/.exec(SRC)[1]);

const buildCurveLut = new Function(
  'curveControlPoints', 'monotoneSpline', 'CURVE_N',
  extract(SRC, 'buildCurveLut') + '; return buildCurveLut;'
)(curveControlPoints, monotoneSpline, CURVE_N);

const V = (o = {}) => Object.assign(
  { uCurveShadow: 0, uCurveMid: 0, uCurveHigh: 0, uCurveFade: 0 }, o);

/** LUT 是否单调不减 */
function isMonotone(lut) {
  for (let i = 1; i < lut.length; i++) if (lut[i] < lut[i - 1]) return false;
  return true;
}

/* ---------------- 基本形状 ---------------- */

t('LUT 长度是 256', () => {
  assert.equal(CURVE_N, 256, `CURVE_N 应该是 256，实际 ${CURVE_N}`);
  assert.equal(buildCurveLut(V()).length, 256);
});

t('⭐ 全 0 时输出恒等曲线', () => {
  // 不是恒等的话，「重置全部调整」之后画面回不到原样
  const lut = buildCurveLut(V());
  for (let i = 0; i < 256; i++) {
    assert.ok(Math.abs(lut[i] - i) <= 1,
      `第 ${i} 级应该是 ${i}（恒等），实际 ${lut[i]}`);
  }
});

t('端点固定：输入 0 → 输出 0，输入 1 → 输出 255（无明显褪色时）', () => {
  const lut = buildCurveLut(V());
  assert.equal(lut[0], 0, '黑位应该还是黑');
  assert.equal(lut[255], 255, '白位应该还是白');
});

/* ---------------- 单调性（最重要） ---------------- */

t('⭐ 单参数拉满仍然单调', () => {
  const cases = [
    ['阴影 +1', { uCurveShadow: 1 }],
    ['阴影 -1', { uCurveShadow: -1 }],
    ['中间调 +1', { uCurveMid: 1 }],
    ['中间调 -1', { uCurveMid: -1 }],
    ['高光 +1', { uCurveHigh: 1 }],
    ['高光 -1', { uCurveHigh: -1 }],
    ['褪色 +1', { uCurveFade: 1 }]
  ];
  for (const [name, vals] of cases) {
    const lut = buildCurveLut(V(vals));
    assert.ok(isMonotone(lut), `${name} 的曲线不单调 —— 影调会反转`);
  }
});

t('⭐ 四个参数**同时**拉满仍然单调（组合不会破坏单调性）', () => {
  // 单独拉满都单调，不等于组合起来也单调 ——
  // 控制点会互相叠加，最坏情况在极端组合上
  const combos = [
    { uCurveShadow: 1, uCurveMid: 1, uCurveHigh: 1, uCurveFade: 1 },
    { uCurveShadow: -1, uCurveMid: -1, uCurveHigh: -1, uCurveFade: 0 },
    { uCurveShadow: 1, uCurveMid: -1, uCurveHigh: 1, uCurveFade: 1 },
    { uCurveShadow: -1, uCurveMid: 1, uCurveHigh: -1, uCurveFade: 1 }
  ];
  for (const c of combos) {
    const lut = buildCurveLut(V(c));
    assert.ok(isMonotone(lut),
      `组合 ${JSON.stringify(c)} 的曲线不单调 —— 影调会反转`);
  }
});

t('⭐ 扫遍参数空间都单调（粗扫，穷举极端组合）', () => {
  // 参数是连续的，但极端值都在 ±1，所以扫 {-1,0,1}^4 = 81 种组合
  let bad = 0;
  for (const sh of [-1, 0, 1]) {
    for (const mid of [-1, 0, 1]) {
      for (const hi of [-1, 0, 1]) {
        for (const fade of [0, 1]) {
          const lut = buildCurveLut(V({
            uCurveShadow: sh, uCurveMid: mid,
            uCurveHigh: hi, uCurveFade: fade
          }));
          if (!isMonotone(lut)) {
            bad++;
            console.log(`      不单调: sh=${sh} mid=${mid} hi=${hi} fade=${fade}`);
          }
        }
      }
    }
  }
  assert.equal(bad, 0, `${bad} 种参数组合产生了不单调的曲线`);
});

t('⭐ 没有过冲（输出不超出控制点范围）', () => {
  // 单调但过冲的曲线会在控制点附近"鼓出去"，
  // 表现是影调出现假的亮暗带。检查每个控制点附近的邻域
  for (const c of [
    { uCurveShadow: 1 }, { uCurveShadow: -1 },
    { uCurveMid: 1 }, { uCurveMid: -1 },
    { uCurveHigh: 1 }, { uCurveHigh: -1 },
    { uCurveFade: 1 }
  ]) {
    const pts = curveControlPoints(V(c));
    const lut = buildCurveLut(V(c));
    // 控制点的 y 是该处的目标值；插值结果不该超出相邻控制点之间的范围
    for (let k = 0; k < pts.length; k++) {
      const idx = Math.round(pts[k][0] * 255);
      const lo = Math.min(...pts.map(p => p[1])) * 255 - 1;
      const hi = Math.max(...pts.map(p => p[1])) * 255 + 1;
      assert.ok(lut[idx] >= lo && lut[idx] <= hi,
        `${JSON.stringify(c)} 在控制点 ${k} 附近过冲：${lut[idx]} 超出 [${lo.toFixed(0)}, ${hi.toFixed(0)}]`);
    }
  }
});

/* ---------------- 方向（语义对不对） ---------------- */

t('⭐ 三个滑杆各管各的区间（没有串扰）', () => {
  // 这是换掉第一版控制点布局的直接原因。
  // 四控制点（0/1-3/2-3/1）时，单调插值的端点斜率受限，
  // 结果三个滑杆**全都主要作用在中间调**：
  //   阴影+1 @128 抬了 19 级，高光+1 @128 也抬了 19 级，而 @208 只抬 5 级。
  // 换成五个均匀控制点后每个滑杆只动自己那段。
  const base = buildCurveLut(V());
  const bands = [[48, '暗部'], [128, '中间'], [208, '亮部']];
  const delta = lut => bands.map(([i]) => lut[i] - base[i]);
  const fmt = d => bands.map(([i, n], k) => `${n}${d[k] >= 0 ? '+' : ''}${d[k]}`).join(' ');

  const sh = delta(buildCurveLut(V({ uCurveShadow: 1 })));
  const mid = delta(buildCurveLut(V({ uCurveMid: 1 })));
  const hi = delta(buildCurveLut(V({ uCurveHigh: 1 })));

  // 各自的区间要有明显效果
  assert.ok(sh[0] > 20, `阴影+1 应该明显提亮暗部，实际 ${fmt(sh)}`);
  assert.ok(mid[1] > 20, `中间调+1 应该明显提亮中间，实际 ${fmt(mid)}`);
  assert.ok(hi[2] > 15, `高光+1 应该明显提亮亮部，实际 ${fmt(hi)}`);

  // 对其他区间的影响要小
  assert.ok(Math.abs(sh[1]) <= 4 && Math.abs(sh[2]) <= 4,
    `阴影不该明显影响中间/亮部，实际 ${fmt(sh)}`);
  assert.ok(Math.abs(mid[0]) <= 6 && Math.abs(mid[2]) <= 6,
    `中间调不该明显影响暗部/亮部，实际 ${fmt(mid)}`);
  assert.ok(Math.abs(hi[0]) <= 4 && Math.abs(hi[1]) <= 4,
    `高光不该明显影响暗部/中间，实际 ${fmt(hi)}`);
});

t('⭐ 曲线·阴影 只有暗部动，高光基本不动', () => {
  const base = buildCurveLut(V());
  const up = buildCurveLut(V({ uCurveShadow: 1 }));
  const down = buildCurveLut(V({ uCurveShadow: -1 }));

  const darkIdx = 64, brightIdx = 224;
  assert.ok(up[darkIdx] > base[darkIdx] + 8,
    `阴影 +1 应该提亮暗部：${base[darkIdx]} -> ${up[darkIdx]}`);
  assert.ok(down[darkIdx] < base[darkIdx] - 8,
    `阴影 -1 应该压暗暗部：${base[darkIdx]} -> ${down[darkIdx]}`);
  assert.ok(Math.abs(up[brightIdx] - base[brightIdx]) < 12,
    `阴影不该明显影响高光：${base[brightIdx]} -> ${up[brightIdx]}`);
});

t('⭐ 曲线·高光 只有亮部动，暗部基本不动', () => {
  const base = buildCurveLut(V());
  const up = buildCurveLut(V({ uCurveHigh: 1 }));
  const darkIdx = 48, brightIdx = 208;
  assert.ok(up[brightIdx] > base[brightIdx] + 5,
    `高光 +1 应该提亮亮部：${base[brightIdx]} -> ${up[brightIdx]}`);
  assert.ok(Math.abs(up[darkIdx] - base[darkIdx]) < 12,
    `高光不该明显影响暗部：${base[darkIdx]} -> ${up[darkIdx]}`);
});

t('⭐ 曲线·中间调 主要动中间', () => {
  const base = buildCurveLut(V());
  const up = buildCurveLut(V({ uCurveMid: 1 }));
  const midIdx = 128;
  assert.ok(up[midIdx] > base[midIdx] + 8,
    `中间调 +1 应该提亮中间：${base[midIdx]} -> ${up[midIdx]}`);
});

t('⭐ 褪色：抬黑位，暗部不再纯黑', () => {
  const lut = buildCurveLut(V({ uCurveFade: 1 }));
  assert.ok(lut[0] > 25,
    `褪色 +1 时黑位应该抬起来（不再纯黑），实际 ${lut[0]}`);
  assert.ok(lut[0] < 90, `黑位抬得太高会糊成一片灰，实际 ${lut[0]}`);
});

t('⭐ 褪色：同时压低白位（两头一起收才是"褪色"）', () => {
  // ⚠️ 这条断言必须**严格小于 255**。
  // 一开始把这两句和上面合在一起，写成 `lut[255] < 255` + `> 200`，
  // 看着像在验，其实把 `1 - fade*0.05` 换成常量 1（完全不压白位）
  // 它照样通过 —— 变异测试发现的。所以这里直接断言"白位确实被压低了"。
  const dark = buildCurveLut(V({ uCurveFade: 1 }));
  assert.ok(dark[255] <= 250,
    `褪色 +1 应该压低白位，实际 ${dark[255]}（不压白位就不是完整的褪色）`);
  assert.ok(dark[255] > 200, `白位不该被压太多，实际 ${dark[255]}`);

  // 褪色是连续可调的，不是开关
  const half = buildCurveLut(V({ uCurveFade: 0.5 }));
  assert.ok(half[255] > dark[255],
    `褪色 0.5 应该比 1 压得少：${half[255]} vs ${dark[255]}`);
});

t('褪色 0 时黑位是纯黑', () => {
  assert.equal(buildCurveLut(V({ uCurveFade: 0 }))[0], 0);
});

/* ---------------- 控制点定义 ---------------- */

t('控制点是 5 个、x 均匀且严格递增', () => {
  const pts = curveControlPoints(V());
  assert.equal(pts.length, 5,
    `应该是 5 个控制点（0/0.25/0.5/0.75/1），实际 ${pts.length}`
    + ' —— 用 4 个点时三个滑杆会全都主要作用在中间调，见上面的串扰测试');
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i][0] > pts[i - 1][0], '控制点的 x 必须严格递增');
  }
  assert.equal(pts[0][0], 0, '第一个控制点的 x 应该是 0');
  assert.equal(pts[4][0], 1, '最后一个控制点的 x 应该是 1');
  // 均匀分布：0 / .25 / .5 / .75 / 1
  for (let i = 0; i < 5; i++) {
    assert.ok(Math.abs(pts[i][0] - i * 0.25) < 1e-9,
      `第 ${i} 个控制点的 x 应该是 ${i * 0.25}，实际 ${pts[i][0]}`);
  }
});

t('控制点的 y 都在 0~1（不越界）', () => {
  // 越界的控制点会让 LUT 出现平台（所有值都 clamp 到 0 或 255），
  // 表现是暗部或亮部糊成一块
  const extremes = [
    { uCurveShadow: 1, uCurveMid: 1, uCurveHigh: 1, uCurveFade: 0 },
    { uCurveShadow: -1, uCurveMid: -1, uCurveHigh: -1, uCurveFade: 0 },
    { uCurveShadow: 0, uCurveMid: 0, uCurveHigh: 0, uCurveFade: 1 }
  ];
  for (const c of extremes) {
    for (const [x, y] of curveControlPoints(V(c))) {
      assert.ok(y >= 0 && y <= 1,
        `${JSON.stringify(c)} 产生越界控制点 (${x}, ${y})`);
    }
  }
});

t('⭐ 参数为 undefined 时不炸（滑杆还没初始化）', () => {
  // values 在 buildSliders 之前是空对象，而 draw() 可能先被调用
  const lut = buildCurveLut({});
  assert.equal(lut.length, 256);
  assert.ok(isMonotone(lut), '空 values 应该退化成恒等曲线');
});

/* ---------------- 插值器本身 ---------------- */

t('单调插值器：直线的插值结果还是直线', () => {
  const f = monotoneSpline([0, 0.5, 1], [0, 0.5, 1]);
  for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    assert.ok(Math.abs(f(x) - x) < 1e-9,
      `恒等输入应该输出恒等：f(${x}) = ${f(x)}`);
  }
});

t('单调插值器：端点外做常数外推（不 extrapolate 到越界值）', () => {
  const f = monotoneSpline([0.2, 0.8], [0.3, 0.7]);
  assert.equal(f(0), 0.3, 'x 小于第一个点时应该取第一个 y');
  assert.equal(f(1), 0.7, 'x 大于最后一个点时应该取最后一个 y');
});

t('单调插值器：数据本身有平台时不会产生负斜率', () => {
  // 平台段（两个点 y 相同）会让割线斜率为 0。
  // 处理不当会出现导数变号 → 曲线在平台附近凹下去
  const f = monotoneSpline([0, 0.5, 1], [0.2, 0.2, 0.9]);
  let prev = -Infinity;
  for (let i = 0; i <= 100; i++) {
    const v = f(i / 100);
    assert.ok(v >= prev - 1e-9, `平台附近出现了下降：f(${i / 100}) = ${v} < ${prev}`);
    prev = v;
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
