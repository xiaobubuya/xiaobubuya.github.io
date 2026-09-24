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

/** 每种变异：改坏一处关键逻辑，看测试会不会红 */
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
  }
];

/** 跑一次被测测试，返回失败项数；被测测试非零退出会抛，所以自己接住 */
function runAdjustmentTests() {
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(HERE, 'adjustments.test.mjs')],
      { encoding: 'utf8', cwd: ROOT });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  const m = /失败 (\d+) 项/.exec(out);
  return m ? Number(m[1]) : 0;
}

for (const mu of MUTATIONS) {
  t(mu.name, () => {
    if (!original.includes(mu.from)) {
      throw new Error(`变异目标片段找不到了（代码改过？）：${mu.from}`);
    }
    fs.writeFileSync(FILE, original.replace(mu.from, mu.to), 'utf8');
    let n;
    try {
      n = runAdjustmentTests();
    } finally {
      // 无论成败都要还原，否则一次失败会把仓库留在坏状态
      fs.writeFileSync(FILE, original, 'utf8');
    }
    assert.ok(n > 0,
      '改坏之后测试居然还是全绿 —— 这条断言是装饰品，抓不到问题');
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
   ================================================================ */

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
