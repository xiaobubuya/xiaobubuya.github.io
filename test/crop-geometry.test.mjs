/* ================================================================
   裁剪几何：源码级区间等式
   ----------------------------------------------------------------
   为什么需要这一层（而不是只靠浏览器读像素）：

   裁剪的纵向朝向靠读像素查了很久才查出来，根因是**判据不够硬**：
   原来的断言是"预览 == 应用后"和"是红或绿就行"。
   这两条都**抓不到朝向错**：
     · 预览和应用后走同一套 uniform，永远一致（一致性当判据没用）
     · 翻转后是顶蓝底红，也是"红或绿"里的一半，宽松阈值能蒙过去

   这一层换个判据：**直接检查采样区间的端点**。
   不读像素、不断言颜色，而是从源码里把 cropRenderPlan 的公式
   取出来，验证它算出的区间**精确等于**取景框对应的那块原图。

   好处是判据是"算出来的唯一正确答案"，没有魔数、没有容差，
   而且比浏览器测试快几千倍。

   ⚠️ 它防不住"烘焙时行序翻错"（那是 applyCrop 里的另一段代码）——
   那一条由 crop-browser.test.mjs 的行编码图断言守住。
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

/* ---------------- 从源码里抠出公式 ---------------- */

const mSX = /const sX = ([^;]+);/.exec(SRC);
const mSY = /const sY = ([^;]+);/.exec(SRC);
const mOffX = /const offX = ([^;]+);/.exec(SRC);
const mOffY = /const offY = ([^;]+);/.exec(SRC);

t('能在 studio.js 里找到 sX / sY / offX / offY 四个公式', () => {
  assert.ok(mSX, '找不到 `const sX = ...` —— 公式改名了就更新这个测试');
  assert.ok(mSY, '找不到 `const sY = ...`');
  assert.ok(mOffX, '找不到 `const offX = ...`');
  assert.ok(mOffY, '找不到 `const offY = ...`');
});

/**
 * 把源码里的公式求值出来。
 * ⚠️ 用 new Function 而不是把公式抄一份到这个文件里 ——
 * 抄一份的话改了 studio.js 这里不会红，测的就是自己抄的那份，
 * 等于没测（这个坑在别处踩过）。
 *
 * ⚠️ sX 的公式引用了上游的 R / apW / apH，所以那几行也必须一起插进来，
 * 否则 new Function 里就是 ReferenceError（踩过：apW is not defined，
 * 报错完全指不到"少插了一行中间变量"）。
 * 这里直接把源码里 R..sY 那一整段搬过来。
 */
function grab(re) {
  const m = re.exec(SRC);
  return m ? m[0] : null;
}

const MID = [
  grab(/const R = [^\n]*/),
  grab(/const apW = [^\n]*/),
  grab(/const apH = [^\n]*/),
  grab(/const insLeft = [^\n]*/),
  grab(/const insBottom = [^\n]*/)
].filter(Boolean);

function makePlanner() {
  const body = `
    "use strict";
    return function (r, ins, box, W0, H0) {
      ${MID.join('\n      ')}
      const sX = ${mSX[1]};
      const sY = ${mSY[1]};
      const offX = ${mOffX[1]};
      const offY = ${mOffY[1]};
      return { sX, sY, offX, offY };
    };
  `;
  return new Function(body)();
}

let planRaw;
try { planRaw = makePlanner(); }
catch (e) { console.log('  ⚠️ 公式求值失败：' + e.message); process.exit(1); }

/**
 * 统一入口。
 * ⚠️ 参数顺序踩过一次坑：包装函数第一版写成 `(r, ins, boxW, boxH, W0, H0)`
 * 却转手调 `planRaw(r, ins, W0, H0)`，调用点又漏传 boxW/boxH，
 * 于是 W0/H0 落到了错的位置 —— 结果全是 NaN，
 * 报出来是"x 跨度应该是 1，实际 NaN"，完全指不到"参数传错"。
 * 现在只保留一个入口，且在入口处就把 box 拿掉，
 * 让调用点的参数个数和签名完全一致。
 */
/* ⚠️ 用 rest 参数数个数，不要用 arguments —— 箭头函数里没有 arguments
   （踩过：报 "arguments is not defined"，看着像语法问题）。 */
const plan = (...a) => {
  if (a.length !== 6) {
    throw new Error('plan 要 6 个参数 (r, ins, boxW, boxH, W0, H0)，'
      + `实际 ${a.length} 个 —— 调用点漏传了`);
  }
  const [r, ins, boxW, boxH, W0, H0] = a;
  return planRaw(r, ins, { W: boxW, H: boxH }, W0, H0);
};

/**
 * 期望的采样区间。
 * ----------------------------------------------------------------
 * 先把 crop.rect（**相对旋转框**的归一化坐标）折算成
 * 「在旋转框里占的比例」：
 *     xN = (1 - insW/boxW)/2 + r.x * (insW/boxW)
 *     wN = r.w * (insW/boxW)
 *
 * ⚠️ 这一步第一版写错了：忘了 rect 是相对**内接矩形**而不是相对**原图**。
 * 0° 时内接矩形 == 原图，看起来没事；但公式里的居中项写成 (1-w)/2
 * 而不是内接矩形的实际位置，全幅时就推出 x∈[1,2] 这种荒谬结果。
 *
 * ⚠️⚠️ 第二版又漏了一层：**目标宽高比**。
 * 取景框的比例不一定放得进内接矩形 —— 放不进时输出会被钳制
 * （`applyCropAspect` / `setCropRect` 都可能留下这种框），
 * 此时**采样区间的宽高比必须跟着输出走**，否则画面被拉长。
 * 所以这里先按目标比例把框"缩进去"，再折算：
 *     图上采样宽 = min(wN·insW, hN·insH·R)     R = 目标宽高比
 *     图上采样高 = 图上采样宽 / R
 *
 * x 方向：屏幕 x 和图片 u 同向
 * y 方向：crop.rect.y 是**屏幕约定**（0 = 画面下边、1 = 上边），
 *         图片 v 反向，所以区间要翻过来。
 */
function expectedSample(r, ins, boxW, boxH) {
  const xN = (1 - ins.w / boxW) / 2 + r.x * (ins.w / boxW);
  const wN = r.w * (ins.w / boxW);
  const yN = (1 - ins.h / boxH) / 2 + r.y * (ins.h / boxH);
  const hN = r.h * (ins.h / boxH);

  const wImg = wN * ins.w;          // 框在原图上的宽（像素）
  const hImg = hN * ins.h;
  const R = wImg / hImg;            // 目标宽高比
  const apW = Math.min(wImg, hImg * R);
  const apH = apW / R;

  const fw = apW / ins.w;           // 折算回"占旋转框的比例"
  const fh = apH / ins.h;
  const xc = xN + wN / 2;
  const yc = yN + hN / 2;           // 屏幕约定下的中心

  return {
    xLo: xc - fw / 2, xHi: xc + fw / 2, fw,
    yLo: 1 - (yc + fh / 2), yHi: 1 - (yc - fh / 2), fh
  };
}

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
  t(`⭐ 0° ${name}：采样区间精确等于取景框那块原图`, () => {
    const q = plan(r, ins0, box0.W, box0.H, W0, H0);
    const ex = expectedSample(r, ins0, box0.W, box0.H);

    // 采样区间 = [0.5 + off - s/2, 0.5 + off + s/2]
    const xLo = 0.5 + q.offX - q.sX / 2;
    const xHi = 0.5 + q.offX + q.sX / 2;
    const yLo = 0.5 + q.offY - q.sY / 2;
    const yHi = 0.5 + q.offY + q.sY / 2;

    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(q.sX, ex.fw),
      `x 跨度应该是 ${ex.fw}，实际 ${q.sX}`);
    assert.ok(near(q.sY, ex.fh),
      `y 跨度应该是 ${ex.fh}，实际 ${q.sY}`);

    assert.ok(near(xLo, ex.xLo) && near(xHi, ex.xHi),
      `x 采样区间应该是 [${ex.xLo}, ${ex.xHi}]，实际 [${xLo}, ${xHi}]`);
    assert.ok(near(yLo, ex.yLo) && near(yHi, ex.yHi),
      `y 采样区间应该是 [${ex.yLo.toFixed(4)}, ${ex.yHi.toFixed(4)}]，`
      + `实际 [${yLo.toFixed(4)}, ${yHi.toFixed(4)}]\n`
      + `     rect.y 是**屏幕约定**：y=0 在画面下边、y=1 在上边`
      + `（框 y=${r.y}~${r.y + r.h}），换算成图片 v 是反过来的`);
  });
}

/* ---------------- 那条曾经错了很久的断言，单独再钉一遍 ---------------- */

t('⭐⭐ 裁画面上半 → 采到的必须是原图的**上半**（v ∈ [0, 0.5]）', () => {
  const r = { x: 0, y: 0.5, w: 1, h: 0.5 };
  const q = plan(r, ins0, box0.W, box0.H, W0, H0);
  const yLo = 0.5 + q.offY - q.sY / 2;
  const yHi = 0.5 + q.offY + q.sY / 2;
  assert.ok(Math.abs(yLo) < 1e-9,
    `采样区间的上端应该是 0（原图最上边），实际 ${yLo.toFixed(4)}`
    + ' —— 偏了就是 offY 少减/多减了 sY/2');
  assert.ok(Math.abs(yHi - 0.5) < 1e-9,
    `采样区间的下端应该是 0.5（原图正中），实际 ${yHi.toFixed(4)}`);
});

t('⭐⭐ 裁画面下半 → 采到的必须是原图的**下半**（v ∈ [0.5, 1]）', () => {
  const r = { x: 0, y: 0, w: 1, h: 0.5 };
  const q = plan(r, ins0, box0.W, box0.H, W0, H0);
  const yLo = 0.5 + q.offY - q.sY / 2;
  const yHi = 0.5 + q.offY + q.sY / 2;
  assert.ok(Math.abs(yLo - 0.5) < 1e-9, `上端应该是 0.5，实际 ${yLo.toFixed(4)}`);
  assert.ok(Math.abs(yHi - 1) < 1e-9, `下端应该是 1，实际 ${yHi.toFixed(4)}`);
});

t('⭐⭐ 采样区间的宽高比必须等于输出的宽高比（防画面被拉长）', () => {
  /* ⚠️ 这条钉的是一个**实际发生过**的 bug：
     cropRenderPlan 原来假设"取景框比例 == 输出比例"，但只要框比
     内接矩形允许的最宽值还宽，输出就会被钳制（比如 2:1 的框配 1:1
     比例 → 输出 400×400），而采样区间还是按 2:1 算的 ——
     纵向只采一半，画面被拉长一倍。
     症状是"裁剪结果的朝向/比例不对"，但根因和朝向无关。 */
  for (const [name, r] of cases0) {
    const q = plan(r, ins0, box0.W, box0.H, W0, H0);
    const ex = expectedSample(r, ins0, box0.W, box0.H);

    // 采样区间在原图上占的像素
    const apWpx = q.sX * W0;
    const apHpx = q.sY * H0;
    // 输出尺寸（导出分支）
    const boxL = { W: box0.W, H: box0.H };
    const viewW = r.w * boxL.W, viewH = r.h * boxL.H;
    const outW = Math.max(1, Math.round(viewW * (ins0.w / boxL.W)));
    const outH = Math.max(1, Math.round(viewH * (ins0.h / boxL.H)));

    const rSample = apWpx / apHpx;
    const rOut = outW / outH;
    assert.ok(Math.abs(rSample - rOut) < 0.01,
      `${name}：采样区间的宽高比 ${rSample.toFixed(3)}（${apWpx.toFixed(1)}×`
      + `${apHpx.toFixed(1)} 原图像素）和输出 ${outW}×${outH} 的比例 `
      + `${rOut.toFixed(3)} 不一致 —— 画面会被拉长`);

    // 顺便确认期望值算的是同一件事
    assert.ok(Math.abs(q.sX - ex.fw) < 1e-9 && Math.abs(q.sY - ex.fh) < 1e-9,
      `${name}：跨度期望 (${ex.fw}, ${ex.fh})，实际 (${q.sX}, ${q.sY})`);
  }
});

t('⭐ 取景框居中时采样区间也居中（不能有系统性偏移）', () => {
  const r = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const q = plan(r, ins0, box0.W, box0.H, W0, H0);
  assert.ok(Math.abs(q.offY) < 1e-9,
    `居中取景框的 offY 应该是 0，实际 ${q.offY}`);
  assert.ok(Math.abs(q.offX) < 1e-9,
    `居中取景框的 offX 应该是 0，实际 ${q.offX}`);
});

t('⭐ 0° 全幅是恒等变换（正常编辑必须不受影响）', () => {
  const q = plan({ x: 0, y: 0, w: 1, h: 1 }, ins0, box0.W, box0.H, W0, H0);
  assert.equal(q.sX, 1, `全幅 sX 应该是 1，实际 ${q.sX}`);
  assert.equal(q.sY, 1, `全幅 sY 应该是 1，实际 ${q.sY}`);
  assert.equal(q.offX, 0, `全幅 offX 应该是 0，实际 ${q.offX}`);
  assert.equal(q.offY, 0, `全幅 offY 应该是 0，实际 ${q.offY}`);
});

/* ---------------- 采样区间不能越出原图 ---------------- */

t('⭐ 合法取景框（在内接矩形内）算出的采样区间不会越界', () => {
  for (const [name, r] of cases0) {
    const q = plan(r, ins0, box0.W, box0.H, W0, H0);
    const xLo = 0.5 + q.offX - q.sX / 2, xHi = 0.5 + q.offX + q.sX / 2;
    const yLo = 0.5 + q.offY - q.sY / 2, yHi = 0.5 + q.offY + q.sY / 2;
    const eps = 1e-9;
    assert.ok(xLo >= -eps && xHi <= 1 + eps,
      `${name}：x 区间 [${xLo}, ${xHi}] 越出 [0,1]`);
    assert.ok(yLo >= -eps && yHi <= 1 + eps,
      `${name}：y 区间 [${yLo}, ${yHi}] 越出 [0,1]`);
  }
});

/* ---------------- 源码级：两个坐标系的约定要写清楚 ---------------- */

t('cropRenderPlan 里写明了 rect 是"屏幕约定（y 向下）"', () => {
  // 这条不是形式主义：约定的方向搞反正是这个 bug 的根因，
  // 而"哪边是上"光看代码看不出来，只能靠注释传递。
  assert.ok(/屏幕约定/.test(SRC),
    'cropRenderPlan 附近没有说明 crop.rect 用的是哪种 y 约定 —— '
    + '下一个人会再踩一次，把注释补回去');
  assert.ok(/图片约定|0 = 图\*?\*?上\*?\*?边|图上边/.test(SRC),
    '没有说明 shader 采样用的是图片约定（v=0 是图上边）');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
