/* ================================================================
   调整项（滑杆 ↔ shader uniform）一致性测试
   ----------------------------------------------------------------
   这个测试不跑 WebGL、不跑浏览器 —— 它静态比对 studio.js 内部的
   三处约定。存在的理由是：这三处**任何一处对不上都是静默失效**。

   典型症状（都是真实踩过的类型）：
     · 加了 ADJUSTMENTS 但 shader 里没声明 uniform
       → 滑杆能拖，画面完全没反应，而且不报错
     · 声明了但 draw() 里忘了 uniform1f
       → 同上。getUniformLocation 返回 null 时，
         gl.uniform1f(null, v) 在 WebGL 里是**静默忽略**，不抛异常
     · 顺序搞错（颗粒放进蒙版混合之前）
       → 涂一小块区域，那块的颗粒被混掉，看起来像破了洞

   还有一条数学约束：锐化必须用**原图**的 texel 步长，
   不能用当前画布的 —— 用画布的话拖一下窗口锐化半径就变了，
   预览和导出也对不上。
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

console.log('\n=== 调整项 ↔ shader uniform 一致性 ===\n');

/* ---------------- 从源码里取出 ADJUSTMENTS ---------------- */
const m = SRC.match(/const ADJUSTMENTS = (\[[\s\S]*?\n  \]);/);
assert.ok(m, '没找到 ADJUSTMENTS 定义');
// 源码是我们自己仓库里的，不是外部输入
const ADJUSTMENTS = new Function('return ' + m[1])();

const FRAG = (() => {
  const f = SRC.match(/const FRAG = `([\s\S]*?)`;/);
  assert.ok(f, '没找到 FRAG shader');
  return f[1];
})();

/* ---------------- 1. 定义本身是否健康 ---------------- */

t('每个调整项都有 key / name / min / max / step / def', () => {
  for (const a of ADJUSTMENTS) {
    for (const k of ['key', 'name', 'min', 'max', 'step', 'def']) {
      assert.ok(a[k] !== undefined, `${a.key || '?'} 缺 ${k}`);
    }
    assert.ok(a.min < a.max, `${a.key} 的 min 不小于 max`);
    assert.ok(a.step > 0, `${a.key} 的 step 必须为正`);
    assert.ok(a.def >= a.min && a.def <= a.max, `${a.key} 的默认值不在范围内`);
  }
});

t('⭐ 每个调整项的默认值都是 0', () => {
  // resetAll() 把 values 设回 a.def，而 draw() 直接把它喂给 uniform。
  // 默认值不是 0 的话，「重置全部调整」之后画面不会是原图 ——
  // 表现是"点了重置但照片还是不对"，很难归因。
  for (const a of ADJUSTMENTS) {
    assert.equal(a.def, 0, `${a.key} 的默认值应该是 0，实际 ${a.def}`);
  }
});

t('key 不重复', () => {
  const keys = ADJUSTMENTS.map(a => a.key);
  assert.equal(new Set(keys).size, keys.length, '有重复的 key');
});

t('每个 key 都以 u 开头（shader uniform 的命名约定）', () => {
  for (const a of ADJUSTMENTS) {
    assert.ok(/^u[A-Z]/.test(a.key), `${a.key} 不符合 uXxx 命名`);
  }
});

t('锐化和颗粒不允许负值', () => {
  // 负锐化是"模糊"，负颗粒没有意义 —— 这两个语义上只能是单向的
  const sharp = ADJUSTMENTS.find(a => a.key === 'uSharpness');
  const grain = ADJUSTMENTS.find(a => a.key === 'uGrain');
  assert.equal(sharp.min, 0, '锐化下限应该是 0');
  assert.equal(grain.min, 0, '颗粒下限应该是 0');
});

t('暗角允许负值（也就是「反暗角」提亮四角）', () => {
  const v = ADJUSTMENTS.find(a => a.key === 'uVignette');
  assert.ok(v.min < 0, '暗角应该允许负值');
  assert.ok(v.max > 0, '暗角应该允许正值');
});

/* ---------------- 2. shader 里声明了 ---------------- */

t('⭐ 每个调整项在 shader 里都有对应的 uniform 声明', () => {
  const missing = ADJUSTMENTS
    .map(a => a.key)
    .filter(k => !new RegExp(`uniform\\s+float\\s+${k}\\b`).test(FRAG)
              && !new RegExp(`uniform\\s+float\\s+[^;]*\\b${k}\\b`).test(FRAG));
  assert.equal(missing.length, 0,
    `这些 key 在 shader 里没有 uniform 声明：${missing.join(', ')}`
    + '（症状：滑杆能拖，画面没反应，而且不报错）');
});

t('shader 里声明的每个 uXxx uniform 都被用到了', () => {
  // 反向检查。声明了不用不致命，但多半是改名时漏改了一处
  const declared = [...FRAG.matchAll(/uniform\s+float\s+([^;]+);/g)]
    .flatMap(mm => mm[1].split(',').map(s => s.trim()))
    .filter(s => /^u[A-Z]/.test(s));
  const unused = declared.filter(k => {
    // 在整个 shader 里除了声明行之外还出现过
    const uses = [...FRAG.matchAll(new RegExp(`\\b${k}\\b`, 'g'))].length;
    return uses <= 1;
  });
  assert.equal(unused.length, 0, `声明了但没用到：${unused.join(', ')}`);
});

/* ---------------- 3. draw() 里赋值了 ----------------
   ⚠️ 这里必须按**大括号配对**抠函数体，不能再用
   `src.indexOf('\n  }')` 截断 —— draw() 现在有嵌套的 if 块
   （几何 uniform 那一段），第一个 `\n  }` 落在块内部，于是
   "找不到 ADJUSTMENTS 的遍历"，报出三条假红。
   顺带：签名改成 draw(planOverride) 之后，也不能再拿
   字面量 'function draw()' 当锚点（它已经不存在了）。 */
function fnBody(src, decl) {
  const i = src.indexOf(decl);
  assert.ok(i >= 0, '找不到 ' + decl);
  const open = src.indexOf('{', i);
  let d = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(open + 1, j); }
  }
  assert.fail(decl + ' 的大括号没闭合');
}

t('⭐ 每个调整项在 draw() 里都被赋值给 uniform', () => {
  const body = fnBody(SRC, 'function draw(');
  // 遍历 ADJUSTMENTS 那行是等价的赋值，单独判
  const loopAssigns = /for\s*\(const a of ADJUSTMENTS\)\s*gl\.uniform1f\(uniforms\[a\.key\]/.test(body);
  assert.ok(loopAssigns, 'draw() 里没有遍历 ADJUSTMENTS 赋值 uniform');
  assert.ok(body.includes('gl.uniform1f'), 'draw() 里没有 uniform1f 调用');
});

t('uTexel / uAspect 也都有赋值（锐化和暗角要用）', () => {
  const body = fnBody(SRC, 'function draw(');
  assert.ok(/uniforms\.uTexel/.test(body), 'draw() 没有设置 uTexel');
  assert.ok(/uniforms\.uAspect/.test(body), 'draw() 没有设置 uAspect');
  assert.ok(/gl\.uniform2f\(uniforms\.uTexel/.test(body), 'uTexel 是 vec2，要用 uniform2f');
});

t('⭐ 锐化的步长用原图尺寸，不是画布尺寸', () => {
  // 用画布尺寸的话，拖一下窗口锐化半径就变了 ——
  // 而且预览（屏幕尺寸）和导出（原图尺寸）会明显不一致
  const body = fnBody(SRC, 'function draw(');
  assert.ok(/uniform2f\(uniforms\.uTexel,\s*1\s*\/\s*img\.width,\s*1\s*\/\s*img\.height\)/.test(body),
    'uTexel 应该用 img.width / img.height（原图），不能用 canvas.width');
  assert.ok(!/uniform2f\(uniforms\.uTexel[^)]*canvas\./.test(body),
    'uTexel 用了 canvas 尺寸 —— 会让锐化半径随窗口大小变化');
});

/* ---------------- 4. 顺序约束（最容易错的地方） ---------------- */

t('⭐ 暗角和颗粒在蒙版混合**之后**', () => {
  // 这两个是"整张照片的收尾处理"，不是"某个区域的调整"。
  // 放进蒙版混合之前的话，涂一小块区域会让那块的暗角/颗粒被混掉，
  // 看起来像照片破了个洞。
  const main = FRAG.slice(FRAG.indexOf('void main()'));
  const maskBlend = main.indexOf('uUseMask > 0.5');
  const vignette = main.indexOf('vignette(c)');
  const grain = main.indexOf('grain(c)');

  assert.ok(maskBlend > -1, '没找到蒙版混合');
  assert.ok(vignette > -1, '没找到暗角调用');
  assert.ok(grain > -1, '没找到颗粒调用');
  assert.ok(vignette > maskBlend,
    '暗角在蒙版混合之前 —— 涂了蒙版的区域暗角会被混掉');
  assert.ok(grain > maskBlend,
    '颗粒在蒙版混合之前 —— 涂了蒙版的区域颗粒会被混掉');
});

t('⭐ 局部调整混的是「锐化后」的源图，不是原始源图', () => {
  // 混原始 src 的话，涂了蒙版的区域锐化会被"混掉"，
  // 表现是「涂哪哪变糊」，正好和用户预期相反
  const main = FRAG.slice(FRAG.indexOf('void main()'));
  const blend = main.match(/mix\(toLinear\((\w+)\),\s*toLinear\(c\)/);
  assert.ok(blend, '没找到局部调整的 mix 调用');
  assert.equal(blend[1], 'sharp',
    `局部调整混的应该是 sharp（锐化后），实际是 ${blend[1]} —— `
    + '混 src 会让改过的区域锐化失效');
});

t('锐化在 grade() 之前', () => {
  const main = FRAG.slice(FRAG.indexOf('void main()'));
  // ⚠️ 必须先断言存在，再比位置。
  // 只比 indexOf 大小的话，把 sharpen 整个删掉时
  // indexOf 返回 -1，而 -1 < 后面那个位置**依然成立** ——
  // 于是这条断言在锐化完全没接上的时候照样通过。
  // （这个漏洞是负向测试发现的：把 sharpen 调用改成 src，测试全绿。）
  //
  // ⚠️ sharpen 现在多带一个 uv 参数（几何变换之后要按变换后的坐标
  //    取邻居），所以匹配的是 sharpen(src, u) 而不是 sharpen(src)。
  assert.ok(/sharpen\(src, u\)/.test(main),
    'main() 里没有调用 sharpen(src, u) —— 锐化根本没接上');
  assert.ok(main.indexOf('sharpen(src, u)') < main.indexOf('grade(sharp)'),
    '锐化应该在调色之前');
});

t('⭐ 锐化不在 grade() 里（否则会被调用两次）', () => {
  // grade() 在局部调整时被调用两次（一次原图、一次调整后）。
  // 锐化每多调一次就多采样 9 次纹理，而且邻域采样会把 grade()
  // 从"逐像素的纯颜色运算"变成"有状态的函数"，后面再加局部调整就会出错。
  //
  // ⚠️ 这里允许 **1 次** 纹理采样 —— 色调曲线的 LUT 查表。
  // 它是单点采样（不是邻域）、固定 1 次、和设备上的纹理读取一样便宜，
  // 和锐化的 3x3 邻域完全是两码事。
  const gradeBody = FRAG.slice(FRAG.indexOf('vec3 grade('),
                                FRAG.indexOf('vec3 sharpen('));
  const samples = [...gradeBody.matchAll(/texture2D\(/g)].length;
  assert.ok(samples <= 1,
    `grade() 里有 ${samples} 次纹理采样 —— 最多只允许 1 次（曲线 LUT 查表）。`
    + ' 邻域采样必须放在 grade() 外面');
  // 而且要确认那一次真的是 LUT 单点，不是邻域
  if (samples === 1) {
    assert.ok(/texture2D\(uCurve/.test(gradeBody),
      'grade() 里唯一允许的采样是 uCurve（LUT）；出现了别的采样源');
  }
  // 反向：锐化那 9 次采样必须在 grade() **外面**
  assert.ok(/vec3 sharpen\(vec3 src, vec2 uv\)/.test(FRAG), '找不到 sharpen()');
});

/* ---------------- 5. 数值健康 ---------------- */

t('⭐ 暗角的符号是「压暗」的（不是单向乘）', () => {
  // 只写 c * (1.0 + amt) 的话正值会**提亮**四角 ——
  // 方向反了（第一版就是这个错：0.9 把四角从 128 抬到 216）。
  //
  // ⚠️ 静态检查只能验「乘的是 1-amt 而不是 1+amt」，
  // **验不了 amt 的符号对不对**（把 uVignette 取负它照样通过）。
  // 真正的方向靠 adjust-browser.test.mjs 读真实像素验 —— 两边分工。
  const vig = FRAG.slice(FRAG.indexOf('vec3 vignette('),
                         FRAG.indexOf('void main()'));
  assert.ok(/c \* \(1\.0 - amt\)/.test(vig),
    '暗角应该乘 (1 - amt) —— 写成 (1 + amt) 会让正值变提亮，方向就反了');
  assert.ok(!/c \* \(1\.0 \+ amt\)/.test(vig),
    '出现了 c * (1.0 + amt) —— 正值会被提亮，方向反了');
  // 提亮（负值）时要收敛，不然四角会糊成一片白
  assert.ok(/uVignette > 0\.0 \? 1\.0 : 0\.6/.test(vig),
    '暗角没有对提亮做收敛（负值幅度应该小于正值）');
});

t('⭐ 暗角用 uAspect 修正距离', () => {
  // 不修正的话，宽图上的圆形暗角会被拉成椭圆（上下先暗）
  const vig = FRAG.slice(FRAG.indexOf('vec3 vignette('),
                         FRAG.indexOf('void main()'));
  assert.ok(/uAspect/.test(vig), '暗角没有用 uAspect 修正 —— 宽图上会变形');
});

t('⭐ 颗粒按亮度调制（暗部不浮灰）', () => {
  // 均匀叠加的话暗部会浮出一层灰雾，亮部完全看不出来
  const g = FRAG.slice(FRAG.indexOf('vec3 grain('),
                       FRAG.indexOf('vec3 vignette('));
  assert.ok(/luma\(c\)/.test(g), '颗粒没有按亮度调制 —— 暗部会浮灰');
});

t('最终结果被 clamp 到 0~1', () => {
  const main = FRAG.slice(FRAG.indexOf('void main()'));
  assert.ok(/clamp\(c,\s*0\.0,\s*1\.0\)/.test(main),
    '缺少 clamp —— 暗角提亮和颗粒都可能把值推出 0~1');
});

t('比较原图时直接返回，不经过任何调整', () => {
  // 按住对比键看到的是**原始图**，不能被锐化/暗角/颗粒影响
  const main = FRAG.slice(FRAG.indexOf('void main()'));
  const origIdx = main.indexOf('uOriginal > 0.5');
  assert.ok(origIdx > -1, '没找到原图分支');
  const branch = main.slice(origIdx, main.indexOf('return;', origIdx));
  assert.ok(!/sharpen|grade|vignette|grain/.test(branch),
    '原图分支里混进了调整调用 —— 按住对比键看到的不是原图');
});

/* ---------------- 6. 导出链路 ---------------- */

t('导出复用同一个 draw()（所见即所得）', () => {
  const body = fnBody(SRC, 'async function exportImage(');
  assert.ok(/draw\(\)/.test(body), '导出没有调用 draw() —— 会和预览不一致');
  assert.ok(/canvas\.width = img\.width/.test(body),
    '导出没有切到原图分辨率');
});

t('导出前会把显示原图关掉', () => {
  // 忘了关的话，按住对比键导出会导出一张没修过的图
  const body = fnBody(SRC, 'async function exportImage(');
  assert.ok(/showingOriginal\s*=\s*false/.test(body),
    '导出前没有重置 showingOriginal —— 按住对比键时导出会得到原图');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
