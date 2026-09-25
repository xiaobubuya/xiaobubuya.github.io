/* ================================================================
   行尾一致性 —— 提交前护栏
   ----------------------------------------------------------------
   ⚠️ 为什么需要这个（实际踩过，而且报错完全指不到根因）：

   本机 `core.autocrlf=true`，工作区里的文件行尾是**混的**：
   老的检出是 CRLF，新写的文件是 LF。平时看不出来，
   但下面的东西会因为行尾不一致而**静默失效**：

     · `adjustments-negative.test.mjs` 的变异表里，多行匹配串是按
       LF 写的 → 遇到 CRLF 的文件全部匹配不上，
       报「变异目标片段找不到了（代码改过？）」——
       而代码根本没改过。实测一次假红了 **5 个**变异，
       排查方向被彻底带偏。

     · 用 PowerShell 的 `ReadAllLines` / `WriteAllLines` 改文件会
       **悄悄**把 LF 变成 CRLF（.NET 的 WriteAllLines 恒用
       Environment.NewLine），改完当时看不出来，
       下一轮测试才炸。

   治理分两层：
     ① 仓库根加 `.gitattributes`：`* text=auto eol=lf`，
        保证检出到工作区就是 LF，不再依赖 core.autocrlf 的本机设置。
     ② 这个测试：直接扫工作区，谁带了 CR 就红，并给出怎么修。

   ⚠️ 为什么是"扫描"而不是"读某个文件断言"：
   出问题的从来不是某一个文件，而是**某一批**。逐个文件的断言
   只能守到你已经想到的那个；扫描才能守住"以后新加的文件"。
   ================================================================ */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== 行尾一致性 ===\n');

/* 只看会被 git 当文本处理的那些；图片/字体等二进制不碰 */
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.css', '.html', '.htm', '.md',
  '.json', '.webmanifest', '.txt', '.yml', '.yaml', '.svg'
]);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.wrangler', 'dist', 'build']);

/** 收集工作区里所有文本文件 */
function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collect(path.join(dir, e.name), out);
    } else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const files = collect(ROOT);

t('扫到了要检查的文本文件（护栏本身没瞎）', () => {
  assert.ok(files.length > 20,
    `只扫到 ${files.length} 个文本文件 —— 目录结构变了的话这个测试要跟着改`);
});

t('⭐ 工作区里没有 CRLF（有的话多行匹配的测试会假红）', () => {
  const bad = [];
  for (const f of files) {
    const buf = fs.readFileSync(f);
    // 只看 CR；LF 单独存在是正常的
    if (buf.includes(13)) {
      const n = buf.filter(b => b === 13).length;
      bad.push(`${path.relative(ROOT, f)}（${n} 个 CR）`);
    }
  }
  assert.equal(bad.length, 0,
    `这些文件带了 CR（CRLF 行尾）：\n       ${bad.join('\n       ')}\n`
    + '     ⚠️ 后果不是"不好看"：adjustments-negative 的变异表里多行匹配串\n'
    + '     是按 LF 写的，遇到 CRLF 会**全部匹配不上**，报\n'
    + '     「变异目标片段找不到了（代码改过？）」—— 而代码没改过。\n'
    + '     修法：根目录有 .gitattributes（* text=auto eol=lf），\n'
    + '     跑一次 `git add --renormalize .` 再 `git checkout -- <文件>`，\n'
    + '     或者用 node 而不是 PowerShell 的 WriteAllLines 去改文件。');
});

t('.gitattributes 存在且指定了 LF', () => {
  const p = path.join(ROOT, '.gitattributes');
  assert.ok(fs.existsSync(p),
    '没有 .gitattributes —— 行尾就取决于每台机器的 core.autocrlf，'
    + '换台电脑（或 CI）行为就变了');
  const txt = fs.readFileSync(p, 'utf8');
  assert.ok(/eol=lf/.test(txt),
    '.gitattributes 里没有 eol=lf，行尾仍然不可控');
});

t('.gitattributes 自己也是 LF', () => {
  const buf = fs.readFileSync(path.join(ROOT, '.gitattributes'));
  assert.ok(!buf.includes(13), '.gitattributes 自己带了 CRLF（很讽刺但会发生）');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
