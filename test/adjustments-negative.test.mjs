/* ================================================================
   负向测试：确认 adjustments.test.mjs 的断言真的抓得到问题
   ----------------------------------------------------------------
   为什么值得单独留一个文件：上一轮 window.AlbumStudio 大小写那次
   教训是「三层测试全绿，功能完全不能用」。断言写得太松的话，
   测试会变成"永远绿"的装饰品。所以对关键的几条断言做变异测试 ——
   故意改坏代码，确认测试真的会红。

   ⚠️ 这里用 node + UTF-8 做文件替换，**不要用 PowerShell 的
   Get-Content / Set-Content**：PS 5.1 会按 ANSI(GBK) 读 UTF-8 文件，
   把里面的中文不可逆地损坏掉。这个坑实际踩过一次，
   studio.js 被毁了 329 行，只能从 git 重建。
   ================================================================ */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FILE = path.join(ROOT, 'studio.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== 负向测试：断言真的抓得到问题吗 ===\n');

const original = fs.readFileSync(FILE, 'utf8');

/** 每种变异：改坏一处关键逻辑，看**对应的**测试会不会红
 *
 *  ⚠️ 关键是 tests 要写对。每类逻辑归哪个文件验是不一样的：
 *    · uniform 接线、顺序约束        → adjustments.test.mjs（静态）
 *    · 曲线 LUT 的数值行为           → curve.test.mjs（纯数学）
 *    · 方向/幅度/边界（要读像素）    → adjust-browser.test.mjs
 *  一开始全都只跑 adjustments.test.mjs，结果曲线的变异"永远抓不到" ——
 *  不是断言太松，是**跑错了测试文件**。
 */
const MUTATIONS = [
  {
    name: '局部调整混 src 而不是 sharp（会让涂过的地方锐化失效）',
    from: 'mix(toLinear(sharp), toLinear(c), m)',
    to: 'mix(toLinear(src), toLinear(c), m)'
  },
  {
    name: 'uTexel 改用画布尺寸（锐化半径会随窗口大小变）',
    from: 'uniform2f(uniforms.uTexel, 1 / img.width, 1 / img.height)',
    to: 'uniform2f(uniforms.uTexel, 1 / canvas.width, 1 / canvas.height)'
  },
  {
    name: '移除 uGrain 的 uniform 声明（颗粒滑杆静默失效）',
    from: 'uniform float uSharpness, uVignette, uGrain;',
    to: 'uniform float uSharpness, uVignette;'
  },
  {
    name: '颗粒不按亮度调制（暗部浮一层灰雾）',
    from: 'float mid = 1.0 - abs(luma(c) - 0.5) * 2.0;',
    to: 'float mid = 1.0;'
  },
  {
    name: '暗角不区分正负（提亮时不收敛）',
    from: 'float amt = uVignette * w * (uVignette > 0.0 ? 1.0 : 0.6);',
    to: 'float amt = uVignette * w;'
  },
  {
    name: '锐化整个没接上（main 里直接用 src）',
    from: 'vec3 sharp = sharpen(src);',
    to: 'vec3 sharp = src;'
  },

  /* ---------------- 色调曲线 ---------------- */
  {
    name: '曲线不再强制控制点单调（相邻滑杆反向拉会影调反转）',
    // 这是实测踩到的：中间调+1 把 0.5 抬到 0.65，高光-1 把 0.75 压到 0.63，
    // 控制点本身先跌再涨 → 插值出来的曲线在中间是下降的。
    // ⚠️ 抓它的是 **curve.test.mjs**（曲线 LUT 的数值行为），
    // 不是 adjustments.test.mjs（那个只管 uniform 接线）。
    tests: ['curve.test.mjs'],
    from: `    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < y.length - 1; i++) {
        y[i] = Math.min(Math.max(y[i], y[i - 1]), y[i + 1]);
      }
    }`,
    to: '    // （变异：去掉单调约束）'
  },
  {
    name: '褪色只抬黑位、不压白位（不是完整的"褪色"）',
    tests: ['curve.test.mjs'],
    from: 'Math.min(1, 1 - fade * 0.05)',
    to: '1'
  },

  /* ---------------- HSL ---------------- */
  {
    name: 'HSL 把色相旋转的弧度写成角度（转了 57 倍）',
    from: 'float ang = uHue * 0.5236;',
    to: 'float ang = uHue * 30.0;',
    tests: ['adjust-browser.test.mjs']
  },
  {
    name: 'HSL 漏掉 YIQ -> RGB 的还原（画面直接变成 YIQ 分量）',
    from: `          c = vec3(
            yy + 0.9563 * i2 + 0.6210 * q2,
            yy - 0.2721 * i2 - 0.6474 * q2,
            yy - 1.1070 * i2 + 1.7046 * q2
          );`,
    to: '          c = vec3(yy, i2, q2);',
    tests: ['adjust-browser.test.mjs']
  },
  {
    name: 'HSL 明度丢了两端权重（高光/暗部推不动）',
    /* ⚠️ 这条变异特意只去掉 **l 权重**，不是退回「给 Y 加常数」那种写法。
       原因：加常数那种写法在中灰上和正确写法输出**完全一样**
       （实测都是 217/39），所以 `HSL 明度 +1 提亮、-1 压暗` 那条断言
       根本区分不出来 —— 变异测试里试过，那是**变异无效**，不是断言太松。
       区别只在接近白/接近暗的像素上显出来，见
       adjust-browser.test.mjs 的「高光区也要有效」那条。 */
    from: '            c += c * (uHslLight * l);',
    to: '            c += c * uHslLight;',
    tests: ['adjust-browser.test.mjs']
  },
  {
    name: '褪色用比例缩放而非加法（纯黑抬不起来 —— 真实踩过的 bug）',
    // 这条是这次实际遇到的：按比例缩放时 y=0 会除零，加了保护之后
    // 纯黑那个像素正好被跳过，褪色对纯黑完全无效。
    // 静态测试看不出来（shader 里确实"有"曲线逻辑），只有读像素能抓。
    from: 'float delta = lut - y;',
    to: 'float delta = (y > 0.0001) ? (lut - y) * 0.0 : 0.0;',
    tests: ['adjust-browser.test.mjs']
  }
];

/** 跑一次被测测试，返回失败项数；被测测试非零退出会抛，所以自己接住 */
function runTest(file) {
  let out = '', err = null;
  try {
    out = execFileSync(process.execPath, [path.join(HERE, file)],
      { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    err = e;
  }
  if (process.env.MUT_DEBUG) {
    lastRaw = { file, len: out.length, tail: out.slice(-160), threw: !!err };
  }
  const m = /失败 (\d+) 项/.exec(out);
  return m ? Number(m[1]) : 0;
}
let lastRaw = null;

for (const mu of MUTATIONS) {
  t(mu.name, () => {
    if (!original.includes(mu.from)) {
      throw new Error(`变异目标片段找不到了（代码改过？）：${mu.from}`);
    }
    fs.writeFileSync(FILE, original.replace(mu.from, mu.to), 'utf8');
    let n, failedRaw = null;
    try {
      // 跑这个变异**对应的**测试文件（默认只有静态那个）
      const files = mu.tests || ['adjustments.test.mjs'];
      const counts = [];
      n = 0;
      for (const f of files) {
        const c = runTest(f);
        counts.push(`${f.replace('.test.mjs', '')}=${c}`);
        n += c;
      }
      if (process.env.MUT_DEBUG) {
        console.log(`      [debug] ${mu.name} → ${counts.join(' ')}`);
      }
      // 变异后如果测试仍然全绿，把被测测试的原始输出吐出来 ——
      // 否则只能看到"抓不到"，看不到**为什么**没抓到
      if (n === 0) failedRaw = lastRaw;
    } finally {
      // 无论成败都要还原，否则一次失败会把仓库留在坏状态
      fs.writeFileSync(FILE, original, 'utf8');
    }
    assert.ok(n > 0,
      `改坏之后 ${(mu.tests || ['adjustments.test.mjs']).join(' / ')} 居然还是全绿 —— `
      + '这条断言是装饰品，抓不到问题'
      + (failedRaw ? `\n     被测测试输出尾部：${JSON.stringify(failedRaw.tail)}` : ''));
  });
}

/* ---------------- 还原检查（顺带防住上面那个 PowerShell 坑） ---------------- */

t('变异测试结束后 studio.js 原样还原', () => {
  const now = fs.readFileSync(FILE, 'utf8');
  assert.equal(now, original, '文件没还原干净 —— 变异测试污染了工作区');
});

t('studio.js 没有编码损坏字符', () => {
  // 防的是「用 PowerShell 读写 UTF-8」把中文弄坏
  const now = fs.readFileSync(FILE, 'utf8');
  const bad = (now.match(/\uFFFD/g) || []).length;
  assert.equal(bad, 0, `有 ${bad} 个 U+FFFD 替换字符 —— 文件被非 UTF-8 工具改过`);
});

/* ================================================================
   静态检查的边界（写清楚，免得下次误以为静态测试够了）
   ----------------------------------------------------------------
   有一类错误**静态比对抓不到**，必须读真实像素：

     把 `float amt = uVignette * w * (...)` 改成
     `float amt = -uVignette * w * (...)`

   这是把暗角方向整个反过来（正值变提亮）。静态断言只看
   `c * (1.0 - amt)` 这个子串在不在 —— 它在，所以照样通过。

   实测过：加上这个变异，adjustments.test.mjs 仍然 22 项全绿。
   抓住它的是 adjust-browser.test.mjs（读四角像素，期望变暗）。

   结论：**「接线对不对」用静态检查，「算出来对不对」必须读像素。**
   两边分工，缺一不可。

   另一个教训：**断言写太松等于没写。**
   「褪色」那条本来写成 `lut[255] < 255` 加 `> 200`，看着像在验，
   其实把"压白位"整个删掉它照样通过 —— 是变异测试抓出来的。
   所以这里每加一个断言，都该问一句：把它对应的逻辑删掉，测试会红吗？
   ================================================================ */

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
