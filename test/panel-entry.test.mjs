/* ================================================================
   面板入口 —— 声明成 disabled 就必须有人来放开
   ----------------------------------------------------------------
   症状：按钮永久灰着、点不动，整块功能静默失效，**不报任何错**。

   实际踩过：`stRotateBtn` 在 studio.html 里写成 `disabled`，
   而 `enableUI()` 只放开了 `stCrop` —— 旋转/翻转/缩放整个面板
   点不进来。下游 `enterRotate()` / `rotateQuarter()` / 翻转 /
   自动水平校正全实现了，就入口被焊死。
   用户问"旋转翻转该怎么用"才暴露：以为是用法问题。

   为什么值得单独一条护栏：这类错误**运行期完全不报错**，
   只有人真的去点才知道。浏览器测试也不会点它（不知道有这按钮）。

   判据（静态）：HTML 里 `disabled` 的元素，其 id 必须能在 JS 里
   被某个 `.disabled =` 赋值覆盖到 —— 直接按 id 取，或者先存进
   **同一函数作用域**内的局部变量再用。

   ⚠️ 别名必须按函数作用域解析，不能全文裸词匹配。
      第一版就是这么写的，然后**假阴性**了：showRotateUI 里
      `const b = $('stRotateBtn')`，而 enableUI 里 `const b = $('stBrush')`
      跟着一句 `b.disabled = !on` —— 裸词 `b` 一匹配，
      焊死的 stRotateBtn 就被判成"有人放开"，护栏形同虚设。
      这种"护栏假装在守护"比没有护栏更坏。
   ================================================================ */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'studio.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'studio.js'), 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== 面板入口按钮 ===\n');

/** HTML 里所有带 disabled 的元素 id */
const disabledIds = [...html.matchAll(/<\w+[^>]*\bid="([^"]+)"[^>]*\bdisabled\b[^>]*>/g)]
  .map(m => m[1]);

/** 按花括号配对切出每个 `function name(...) { ... }` 的函数体 */
function functionBodies(src) {
  const out = [];
  const re = /\bfunction\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1, i = start;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    out.push({ name: m[1], body: src.slice(start, i - 1) });
  }
  return out;
}

/**
 * 这个 id 在 JS 里被 `.disabled =` 赋值过吗？
 *  · 直接：$('id').disabled = ...
 *  · 中转：同一函数作用域内 const X = $('id')，且 X 在该作用域只声明一次
 */
function clearsDisabled(id) {
  if (new RegExp(`\\$\\(\\s*['"]${id}['"]\\s*\\)\\.disabled\\s*=[^=]`).test(js)) return true;
  return functionBodies(js).some(({ body }) => {
    const m = new RegExp(`\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*\\$\\(\\s*['"]${id}['"]\\s*\\)`).exec(body);
    if (!m) return false;
    const alias = m[1];
    const declares = body.match(new RegExp(`\\b(?:const|let|var)\\s+${alias}\\b`, 'g')) || [];
    if (declares.length !== 1) return false;
    return new RegExp(`\\b${alias}\\b\\.disabled\\s*=[^=]`).test(body);
  });
}

t('HTML 里能找到一批声明成 disabled 的控件（护栏得有输入）', () => {
  assert.ok(disabledIds.length >= 10,
    `只找到 ${disabledIds.length} 个，护栏可能没扫到对的东西`);
});

t('每个声明成 disabled 的控件都有代码放开它', () => {
  const stuck = disabledIds.filter(id => !clearsDisabled(id));
  assert.equal(stuck.length, 0,
    `这些控件声明成 disabled 但 JS 里没人给它们赋 disabled，会永久点不动：`
    + `${stuck.join(', ')} —— 症状是"这个功能怎么用"，其实是入口被焊死`);
});

t('没有"无保护地置 disabled = false"（会永久锁死按钮）', () => {
  const all = [...js.matchAll(/\.disabled\s*=\s*false/g)];
  const bad = all.filter(m => {
    const start = Math.max(0, m.index - 260);
    return !/\bif\s*\(/.test(js.slice(start, m.index));
  });
  assert.equal(bad.length, 0,
    `${bad.length} 处把 disabled 无条件置回 false —— `
    + `用户关掉之后它会自己又亮起来`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
