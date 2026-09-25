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

/* ================================================================
   启动自检：如果 studio.js 是"脏"的（上一次跑被中途打断），先还原
   ----------------------------------------------------------------
   ⚠️⚠️ 这一条是踩出来的，代价是整个测试套件假红一轮：

   变异测试的还原写在 `finally` 里，但 **finally 挡不住进程被杀** ——
   我中途 abort 了一次 `node test/run-all.mjs`，那一下正好切在某个变异
   生效的瞬间，于是 studio.js 被留在"改坏"的状态里。下一次跑
   run-all 时：
     · 这个文件把"坏掉的 studio.js"当成了 original 存起来
     · 后面的还原检查自然认为"已还原"
     · 而真正受害的是别的测试：curve 的褪色、adjust-browser 的
       阴影提亮一起假红（看上去像是我刚改的几何把它弄坏了）

   所以启动时先看 git 有没有未提交改动；有就还原，让这一轮从干净
   状态开始。这样"上一次被打断"不会污染"这一次"。

   ⚠️ 副作用要知道：**如果你正好有 studio.js 的未提交改动，会被还原掉**。
   所以只在真的脏的时候动手，并且把这件事明确打印出来（不静默）。
   ================================================================ */
function isDirty(file) {
  try {
    execFileSync('git', ['diff', '--quiet', '--', file],
      { cwd: ROOT, stdio: 'ignore' });
    return false;                       // 退出码 0 = 没有差异
  } catch (e) {
    // 退出码 1 = 有差异；其它（没有 git / 不在仓库里）= 未知，按"干净"处理
    return e && e.status === 1;
  }
}

function restoreFromHead(file) {
  try {
    const clean = execFileSync('git', ['show', `HEAD:${file}`],
      { cwd: ROOT, encoding: 'utf8' });
    fs.writeFileSync(path.join(ROOT, file), clean, 'utf8');
    return true;
  } catch {
    return false;
  }
}

if (isDirty('studio.js')) {
  const ok = restoreFromHead('studio.js');
  console.log(`  ⚠️  studio.js 有未提交改动${ok ? '，已从 HEAD 还原' : '，且还原失败'}`
    + `\n     （上一次变异测试大概是被中途打断了。`
    + `如果你本来就有未提交的改动，它已被覆盖 —— 抱歉，这是为了隔离上一轮的污染。）\n`);
}

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
    from: 'vec3 sharp = sharpen(src, u);',
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

  /* ---------------- HSL（OKLab） ---------------- */
  {
    name: 'HSL 把色相旋转的弧度写成角度（转了 57 倍）',
    from: 'float ang = uHue * 0.5236;',
    to: 'float ang = uHue * 30.0;',
    tests: ['adjust-browser.test.mjs']
  },
  {
    name: 'HSL 漏掉 OKLab -> 线性 sRGB 的还原（画面直接变成 Lab 分量）',
    from: `        vec3 linOut = vec3(
           dot(cube, vec3( 4.0767416621, -3.3077115913,  0.2309699292)),
          dot(cube, vec3(-1.2684380046,  2.6097574011, -0.3413193965)),
          dot(cube, vec3(-0.0041960863, -0.7034186147,  1.7076147010))
        );`,
    to: '        vec3 linOut = vec3(L, A, B);',
    tests: ['adjust-browser.test.mjs']
  },
  {
    name: 'HSL 的 OKLab 输入忘了转线性（把 gamma 编码当线性用）',
    // 感知色彩空间的前提是**线性光**输入。喂 sRGB 进去会让
    // 暗部被过度处理（因为 gamma 编码在暗部压缩得厉害）
    from: '        vec3 lin = toLinear(c);\n',
    to: '',
    tests: ['adjust-browser.test.mjs']
  },
  {
    name: 'HSL 去色时也套"保护"系数（-1 只降一半，去不了色）',
    // 第一版就是这样：正负共用一个 room 系数，实测纯红 -1 之后
    // OKLab chroma 还剩 53%，根本不是"去色"。用 OKLab chroma
    // 当指标才测得出来（RGB 通道差会被色相影响，定不准阈值）。
    from: `          A *= 1.0 + uHslSat;
          B *= 1.0 + uHslSat;`,
    to: `          float chroma2 = sqrt(A * A + B * B);
          float room2 = 1.0 - clamp(chroma2 / 0.30, 0.0, 0.85);
          A *= 1.0 + uHslSat * room2;
          B *= 1.0 + uHslSat * room2;`,
    tests: ['adjust-browser.test.mjs']
  },
  {
    name: 'HSL 明度没做正负分支（只能提亮不能压暗）',
    from: `        if (uHslLight > 0.0)      L = mix(L, 1.0, uHslLight);
        else if (uHslLight < 0.0) L = mix(L, 0.0, -uHslLight);`,
    to: '        if (uHslLight > 0.0) L = mix(L, 1.0, uHslLight);',
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
  const t0 = Date.now();
  let out = '', err = null;
  try {
    out = execFileSync(process.execPath, [path.join(HERE, file)],
      { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    err = e;
  }
  if (process.env.MUT_DEBUG) {
    lastRaw = { file, len: out.length, ms: Date.now() - t0, tail: out.slice(-160), threw: !!err };
  }
  const m = /失败 (\d+) 项/.exec(out);
  return m ? Number(m[1]) : 0;
}
let lastRaw = null;

for (const mu of MUTATIONS) {
  t(mu.name, () => {
    if (!original.includes(mu.from)) {
      /* ⚠️ 这个错误有两种完全不同的原因，别只往"代码改过"上想：
         ① 代码真的改了（变异表要跟着更新）
         ② **文件的 CR 数量是 0，但这里的目标片段是按 LF 写的，
            而文件在工作区里是 CRLF** —— 多行片段会全部匹配不上，
            表现成"5 个变异一起假红"。实测踩过。
         所以先把行尾情况打出来，省得下次又排查半天。

         ⚠️ 用 `hasCR = ...` 而不是把目标片段打出来对比 ——
         片段可能很长，打在终端里根本看不出哪一行的行尾不一样。 */
      const hasCR = original.includes('\r\n');
      const multiLine = mu.from.includes('\n');
      const hint = hasCR
        ? `\n     ⚠️ 文件里有 CRLF 行尾，而这个片段是多行匹配`
          + `${multiLine ? '' : '（单行的其实不受影响，另找原因）'}。\n`
          + '     修：根目录 .gitattributes 已声明 eol=lf，'
          + '跑 `git add --renormalize .` 重新检出；\n'
          + '     或者别用 PowerShell 的 WriteAllLines 改文件'
          + '（它会把 LF 变成 CRLF）。'
        : `\n     （文件里没有 CRLF，所以不是行尾问题）`;
      throw new Error(`变异目标片段找不到了（代码改过？）：${mu.from}${hint}`);
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
        console.log(`      [debug] ${mu.name.slice(0, 24)} → ${counts.join(' ')}`);
        if (lastRaw) console.log(`      [time] ${lastRaw.file} ${lastRaw.ms}ms`);
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
