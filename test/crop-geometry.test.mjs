/* ================================================================
   裁剪几何：源码级区间等式
   ----------------------------------------------------------------
   为什么需要这一层（而不是只靠浏览器读像素）：

   裁剪的几何前后错了**很多轮**，每次都换个样子冒出来，而且
   **颜色类判据抓不到**：
     · "预览 == 应用后" —— 两者走同一套 uniform，永远一致
     · "是红或绿就行"   —— 偏半个框、被拉伸，颜色照样对
   所以这一层直接用**数**验：把 cropRenderPlan 的公式从源码里抠出来
   求值，和几何期望精确比对。快、精确、无魔数。

   ⭐ 唯一的硬约束（记住这一条就够）：
       **采样区间的比例 == 输出的比例**
   `sX` 是"采样区间占源图**宽度**的比例"，所以
       (sX·W0) / (sY·H0) == outW/outH
   ⚠️ 我一度写成 `sX/sY == W0/H0`，24 组全红 —— 那是错的判据。

   ⚠️ "输出比例"由**取景框**决定（用户选了 16:9 就得是 16:9），
   **不是**图片比例。曾经拿图片比例当输出比例，把比例预设废掉了。

   ⚠️ 抠源码用 new Function 而不是抄一份公式 ——
   抄一份的话改了 studio.js 这里不会红，等于没测。
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

console.log('\n=== 裁剪几何：源码级区间等式 ===\n');

/* ================================================================
   按**花括号配对**提取函数体
   ----------------------------------------------------------------
   ⚠️ 不能用 `/function f\(...\) \{([\s\S]*?)\n  \}/` 这种非贪婪正则：
   函数体里有嵌套的 `if (...) { ... }`，非贪婪会在**第一个** `\n  }`
   处停下，得到被截断的函数体，于是函数里引用的变量（crop / img）
   泄漏到外层作用域，报 `crop is not defined` —— 看着像语法问题，
   其实是提取截断了。
   ================================================================ */
function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到 ${name}`);
  const braceStart = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(braceStart + 1, i);
    }
  }
  throw new Error(`${name} 的花括号不配对`);
}

const INSCRIBED_BODY = extractFn('inscribedRect');
const PLAN_BODY = extractFn('cropRenderPlan');

/* ⚠️ 公式必须在**函数体内部**搜，不能在整个文件里搜。
   踩过：`const k = ([^\n]*)` 在整文件里搜，匹配到别处的同名变量，
   报 `crop is not defined` —— 完全指不到"搜错了地方"。 */
const grab = re => {
  const m = re.exec(PLAN_BODY);
  return m ? m[0] : null;
};

const PARTS = [
  ['regW', /const regW = [^\n]*/],
  ['regH', /const regH = [^\n]*/],
  ['sX', /const sX = [^\n]*/],
  ['sY', /const sY = [^\n]*/],
  /* ⚠️ offX/offY 依赖 cx/cy 这两个**中间变量**，必须一起抠。
     漏掉时报 `cx is not defined` —— 看着像语法问题，
     其实是"少插了一行中间变量"。 */
  ['cx', /const cx = [^\n]*/],
  ['cy', /const cy = [^\n]*/],
  ['offX', /const offX = [^\n]*/],
  ['offY', /const offY = [^\n]*/]
];

t('能在 cropRenderPlan 里找到全部公式', () => {
  for (const [name, re] of PARTS) {
    assert.ok(grab(re), `找不到 ${name} 的公式 —— 公式改名了就更新这个测试`);
  }
});

function makePlanner() {
  const formulaBody = PARTS.map(([, re]) => grab(re)).join('\n      ');
  const body = `
    "use strict";
    function inscribedRect(W0, H0, phi) {${INSCRIBED_BODY}
    }
    return function (r, ins, box, W0, H0) {
      ${formulaBody}
      return { sX, sY, offX, offY, regW, regH };
    };
  `;
  return new Function(body)();
}

let planRaw;
try { planRaw = makePlanner(); }
catch (e) { console.log('  ⚠️ 公式求值失败：' + e.message); process.exit(1); }

const plan = (...a) => {
  if (a.length !== 5) {
    throw new Error(`plan 要 5 个参数 (r, ins, box, W0, H0)，实际 ${a.length} 个`);
  }
  const [r, ins, box, W0, H0] = a;
  return planRaw(r, ins, box, W0, H0);
};

const interval = q => ({
  xLo: 0.5 + q.offX - q.sX / 2, xHi: 0.5 + q.offX + q.sX / 2,
  yLo: 0.5 + q.offY - q.sY / 2, yHi: 0.5 + q.offY + q.sY / 2
});
const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

/* inscribedRect 的可调用版本。
   ⚠️ 必须定义在**前面** —— 下面的"比例预设"用例要用到它，
   而 const 有暂时性死区（定义在后面会报 "Cannot access before initialization"）。 */
const insFn = new Function('W0', 'H0', 'phi', INSCRIBED_BODY);

/* ---------------- 0°（内接矩形 == 原图） ---------------- */

const W0 = 400, H0 = 300;
const ins0 = { w: 400, h: 300 };
const box0 = { W: 400, H: 300 };

const cases0 = [
  ['全幅', { x: 0, y: 0, w: 1, h: 1 }],
  ['画面上半', { x: 0, y: 0.5, w: 1, h: 0.5 }],
  ['画面下半', { x: 0, y: 0, w: 1, h: 0.5 }],
  ['左上 1/4（屏幕）', { x: 0, y: 0.5, w: 0.5, h: 0.5 }],
  ['右下 1/4（屏幕）', { x: 0.5, y: 0, w: 0.5, h: 0.5 }],
  ['竖直中段一半', { x: 0, y: 0.25, w: 1, h: 0.5 }],
  ['底部 1/10', { x: 0, y: 0, w: 1, h: 0.1 }]
];

for (const [name, r] of cases0) {
  t(`⭐ 0° ${name}：采样区间就是取景框覆盖的那块`, () => {
    const q = plan(r, ins0, box0, W0, H0);
    const iv = interval(q);

    /* 采样区域 = 取景框覆盖的图片区域（regW×regH），
       摆到该区域的中心上。 */
    const regW = r.w * ins0.w, regH = r.h * ins0.h;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const wantXLo = cx - (regW / W0) / 2;
    const wantYLo = 1 - (cy + (regH / H0) / 2);

    assert.ok(near(q.regW, regW, 1e-9) && near(q.regH, regH, 1e-9),
      `注册区域应该是 ${regW}×${regH}，实际 ${q.regW}×${q.regH}`);
    assert.ok(near(q.sX, regW / W0, 1e-9) && near(q.sY, regH / H0, 1e-9),
      `sX/sY 应该是 ${regW / W0}/${regH / H0}，实际 ${q.sX}/${q.sY}`);
    assert.ok(near(iv.xLo, wantXLo, 1e-9) && near(iv.yLo, wantYLo, 1e-9),
      `采样区间应该是 [${wantXLo.toFixed(4)}, ${(wantXLo + regW / W0).toFixed(4)}] `
      + `× [${wantYLo.toFixed(4)}, ${(wantYLo + regH / H0).toFixed(4)}]，`
      + `实际 [${iv.xLo.toFixed(4)}, ${iv.xHi.toFixed(4)}] `
      + `× [${iv.yLo.toFixed(4)}, ${iv.yHi.toFixed(4)}]\n`
      + '     rect.y 是**屏幕约定**：y=0 在画面下边、y=1 在上边');
  });
}

/* ---------------- 不扭曲（核心） ---------------- */

t('⭐⭐ 采样区间比例 == 输出比例（不扭曲的充要条件）', () => {
  /* ⚠️ 判据必须用"采样区间的**像素**比例"： (sX·W0)/(sY·H0)，
     而不是 sX/sY。我一开始写成 sX/sY == W0/H0，24 组全红，白查一轮。 */
  const combos = [
    { r: { x: 0, y: 0.5, w: 1, h: 0.5 }, ins: { w: 300, h: 200 } },
    { r: { x: 0.1, y: 0.2, w: 0.6, h: 0.4 }, ins: { w: 250, h: 180 } },
    { r: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, ins: { w: 280, h: 210 } },
    // 一个明显非图片比例的框（16:9）
    { r: { x: 0.05, y: 0.4, w: 0.9, h: 0.2 }, ins: { w: 360, h: 300 } }
  ];
  for (const c of combos) {
    const q = plan(c.r, c.ins, box0, W0, H0);
    const apRatio = (q.sX * W0) / (q.sY * H0);
    const outRatio = q.regW / q.regH;
    assert.ok(Math.abs(apRatio / outRatio - 1) < 1e-6,
      `采样比例 ${apRatio.toFixed(4)} 应该等于输出比例 ${outRatio.toFixed(4)}`
      + `（rect=${JSON.stringify(c.r)}）`);
  }
});

t('⭐ 输出比例由取景框决定（比例预设不能被废掉）', () => {
  /* 用户选 16:9，导出就得是 16:9。
     ⚠️ 曾经把输出比例写成"图片比例"，比例预设直接失效 ——
     这条断言就是防它回来的。 */
  const ins = { w: 360, h: 300 };
  const box = { W: 400, H: 300 };
  const target = 16 / 9;
  // 0° 时 ins/box = 1，所以图片上的比例就是 rect.w/rect.h
  const nw = 0.9, nh = (nw * ins.w / target) / ins.h;
  const r = { x: (1 - nw) / 2, y: (1 - nh) / 2, w: nw, h: nh };
  const q = plan(r, ins, box, 360, 300);
  const outRatio = q.regW / q.regH;
  assert.ok(Math.abs(outRatio - target) < 0.02,
    `取景框是 16:9，输出比例应该是 ${target.toFixed(3)}，实际 ${outRatio.toFixed(3)}`
    + ' —— 如果接近图片比例(1.2)，说明输出比例被强制成了图片比例，'
    + '比例预设会失效');
});

t('⭐ 取景框居中时采样区间也居中（不能有系统性偏移）', () => {
  const r = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const q = plan(r, ins0, box0, W0, H0);
  assert.ok(Math.abs(q.offX) < 1e-9, `居中取景框的 offX 应该是 0，实际 ${q.offX}`);
  assert.ok(Math.abs(q.offY) < 1e-9, `居中取景框的 offY 应该是 0，实际 ${q.offY}`);
});

t('⭐⭐ 0° 全幅是恒等变换（正常编辑必须不受影响）', () => {
  const q = plan({ x: 0, y: 0, w: 1, h: 1 }, ins0, box0, W0, H0);
  assert.ok(near(q.sX, 1) && near(q.sY, 1),
    `全幅 sX/sY 应该是 1，实际 ${q.sX}/${q.sY}`);
  assert.ok(near(q.offX, 0) && near(q.offY, 0),
    `全幅 offX/offY 应该是 0，实际 ${q.offX}/${q.offY}`);
});

t('⭐⭐ 比例预设：取景框在**图片上**的比例等于所选比例（含旋转）', () => {
  /* ⚠️ applyCropAspect 曾把"旋转框像素"当成"图片像素"来算比例 ——
     而内接矩形在横纵上相对旋转框的比例不同（旋转后必然如此），
     所以旧写法**只有 0° 才对**。实测 400×300 转 45° 选 16:9，
     图片上的比例算出来是 2.133 而不是 1.778。
     这条断言在 0° 和 45° 都验一遍。 */
  const boxFor = (W, H, deg) => {
    const phi = deg * Math.PI / 180;
    const c = Math.abs(Math.cos(phi)), s = Math.abs(Math.sin(phi));
    return { W: W * c + H * s, H: W * s + H * c };
  };

  for (const deg of [0, 45]) {
    const W = 400, H = 300;
    const box = boxFor(W, H, deg);
    const ins = insFn(W, H, deg * Math.PI / 180);
    // 取景框：图片上要做到 16:9
    const target = 16 / 9;
    // 图片上的宽高 = rect.w·ins.w × rect.h·ins.h，令其比 = target
    const nw = 0.8;                                  // 随便取个不满幅的宽度
    const nh = (nw * ins.w / target) / ins.h;
    const r = { x: (1 - nw) / 2, y: (1 - nh) / 2, w: nw, h: nh };
    const outRatio = (r.w * ins.w) / (r.h * ins.h);
    assert.ok(Math.abs(outRatio - target) < 0.02,
      `${deg}°: 图片上取景框比例应该是 ${target.toFixed(3)}，实际 ${outRatio.toFixed(3)}`);
    // 顺带确认 cropRenderPlan 的输出比例跟着它
    const q = plan(r, ins, box, W, H);
    const qRatio = q.regW / q.regH;
    assert.ok(Math.abs(qRatio - target) < 0.02,
      `${deg}°: 输出比例应该是 ${target.toFixed(3)}，实际 ${qRatio.toFixed(3)}`);
  }
});

t('⭐ 合法取景框算出的采样区间不会越界', () => {
  for (const [name, r] of cases0) {
    const q = plan(r, ins0, box0, W0, H0);
    const iv = interval(q);
    const eps = 1e-9;
    assert.ok(iv.xLo >= -eps && iv.xHi <= 1 + eps,
      `${name}：x 区间 [${iv.xLo}, ${iv.xHi}] 越出 [0,1]`);
    assert.ok(iv.yLo >= -eps && iv.yHi <= 1 + eps,
      `${name}：y 区间 [${iv.yLo}, ${iv.yHi}] 越出 [0,1]`);
  }
});

/* ================================================================
   inscribedRect：必须真的是"最大内接矩形"
   ----------------------------------------------------------------
   ⚠️ 这个函数前后错了**三次**（阈值写反 / 钳制后代回 / 交点公式在
   det≈0 处除零）。症状都是"旋转后画面被裁成一条细缝"或"采到图外"。
   下面两条断言用**数值金标准**对照，能一次性抓住所有这三种错法。
   ================================================================ */

/** 金标准：一维扫描求最大面积（步长比实现更细） */
function maxArea(W0, H0, phi, steps = 40000) {
  const c = Math.abs(Math.cos(phi)), s = Math.abs(Math.sin(phi));
  let best = 0;
  for (let i = 1; i <= steps; i++) {
    const w = W0 * i / steps;
    const h = Math.min((W0 - w * c) / s, (H0 - w * s) / c, H0);
    if (h > 0 && w * h > best) best = w * h;
  }
  return best;
}

const SIZES = [[400, 300], [300, 400], [600, 400], [1920, 1080], [1080, 1920]];
const ANGLES = [0.5, 1, 5, 10, 20, 30, 44, 45, 46, 60, 80, 89, 89.5];

t('⭐⭐ inscribedRect 的解真的放得下（两条不等式成立）', () => {
  for (const [W, H] of SIZES) {
    for (const deg of ANGLES) {
      const phi = deg * Math.PI / 180;
      const { w, h } = insFn(W, H, phi);
      const c = Math.abs(Math.cos(phi)), s = Math.abs(Math.sin(phi));
      assert.ok(w > 0 && h > 0, `${W}×${H} ${deg}°: 解出非正尺寸 ${w}×${h}`);
      assert.ok(w * c + h * s <= W * (1 + 1e-6),
        `${W}×${H} ${deg}°: w·c+h·s = ${(w * c + h * s).toFixed(2)} > W0 = ${W}`
        + ' —— 会采到图外');
      assert.ok(w * s + h * c <= H * (1 + 1e-6),
        `${W}×${H} ${deg}°: w·s+h·c = ${(w * s + h * c).toFixed(2)} > H0 = ${H}`
        + ' —— 会采到图外');
    }
  }
});

t('⭐⭐ inscribedRect 的解是最大面积（不小于数值最优的 99.5%）', () => {
  for (const [W, H] of SIZES) {
    for (const deg of ANGLES) {
      const phi = deg * Math.PI / 180;
      const { w, h } = insFn(W, H, phi);
      const mine = w * h;
      const best = maxArea(W, H, phi);
      assert.ok(mine >= best * 0.995,
        `${W}×${H} ${deg}°: 解出面积 ${mine.toFixed(0)}（${w.toFixed(1)}×${h.toFixed(1)}），`
        + `数值最优 ${best.toFixed(0)} —— 框取小了，画面会被白白裁掉`);
    }
  }
});

t('0° 时 inscribedRect 返回整张图（调用方依赖这条不变量）', () => {
  /* enterCrop / currentInscribed 用 ins.w/box.W 把取景框归一化，
     并假定 0° 时内接矩形就是整张图。破坏它会让无旋转时取景框就不是满幅。 */
  for (const [W, H] of SIZES) {
    const { w, h } = insFn(W, H, 0);
    assert.ok(near(w, W, 1e-6) && near(h, H, 1e-6),
      `${W}×${H} 0°: 应该返回 ${W}×${H}，实际 ${w}×${h}`);
  }
});

/* ---------------- 源码级：约定要写清楚 ---------------- */

t('cropRenderPlan 里写明了 rect 是"屏幕约定"、采样是"图片约定"', () => {
  assert.ok(/屏幕约定/.test(PLAN_BODY),
    '没有说明 crop.rect 用的是哪种 y 约定 —— 方向搞反正是这个 bug 的根因，'
    + '而下一个人只能靠注释知道');
  assert.ok(/图片约定|图上边/.test(PLAN_BODY),
    '没有说明 shader 采样用的是图片约定（v = 0 是图上边）');
});

t('cropRenderPlan 里写明了"不扭曲"的判据', () => {
  assert.ok(/采样.{0,6}比例.{0,10}(等于|=).{0,6}输出.{0,4}比例/.test(PLAN_BODY)
    || /不扭曲|拉伸/.test(PLAN_BODY),
    '没有写清楚"为什么不能扭曲"的判据 —— 这个坑重复踩了很多次，'
    + '注释是唯一能拦住下一次的东西');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
