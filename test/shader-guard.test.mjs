/* ================================================================
   防再犯：shader 模板字符串里不能出现裸露的反引号
   ----------------------------------------------------------------
   实测踩过：在 GLSL 的注释里写了一个反引号，而整个 shader 是包在
   JS 模板字符串里的 —— 那个反引号提前闭合了字符串，后面的 GLSL
   被当成 JavaScript 执行。

   后果特别难查：报错是「ReferenceError: base is not defined」，
   指到 shader 注释中间一行，完全指不到真正的原因（多了一个反引号），
   而且整个修图页直接打不开（studio.js 一开始就抛异常，
   window.Studio 根本不会挂上去）。

   这个检查很便宜，加在这里当护栏。
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

console.log('\n=== shader 模板字符串护栏 ===\n');

t('studio.js 的反引号成对（奇数就说明模板被提前闭合了）', () => {
  const n = (SRC.match(/`/g) || []).length;
  assert.equal(n % 2, 0,
    `反引号是奇数（${n} 个）—— 多半是 shader 的注释里混进了一个反引号，`
    + '那会提前闭合模板字符串，后面整段 GLSL 被当成 JS 执行。'
    + '症状是整个修图页打不开，报错却指不到原因。');
});

t('⭐ shader 模板字符串内部没有裸露的反引号', () => {
  // 把两个模板字符串（VERT / FRAG）的内容取出来，检查里面有没有反引号
  for (const name of ['VERT', 'FRAG']) {
    const m = SRC.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
    assert.ok(m, `没找到 ${name}`);
    const body = m[1];
    assert.ok(!body.includes('`'),
      `${name} 的内容里出现了反引号 —— 会提前闭合模板字符串`);
  }
});

t('每条调整项的定义行都在 ADJUSTMENTS 数组里（没有被模板截断）', () => {
  // 模板被提前闭合时，后面的代码会被当成 JS 执行，
  // 表现之一就是 ADJUSTMENTS 数组长度不对
  const m = SRC.match(/const ADJUSTMENTS = (\[[\s\S]*?\n  \]);/);
  assert.ok(m, '没找到 ADJUSTMENTS');
  const A = new Function('return ' + m[1])();
  assert.ok(A.length >= 16,
    `ADJUSTMENTS 只有 ${A.length} 项（应该 ≥16）—— 数组可能被截断了`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
