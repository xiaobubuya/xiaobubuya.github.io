/* ================================================================
   Service Worker 外壳版本 —— 提交前护栏
   ----------------------------------------------------------------
   ⚠️ 为什么需要这个：

   `sw.js` 的 `SHELL` 版本号是"重新拉取整个外壳"的唯一开关。
   只要改了 `/studio.js`、`/studio.css` 这些**在 ASSETS 列表里**的文件，
   就必须同时升版本 —— 否则老客户端会一直拿缓存里的旧文件，
   表现是「本地测好了，线上用起来没反应」（而且刷新也不一定好使，
   因为 Service Worker 自己还活着）。

   **这个坑实际踩过。** 裁剪/旋转那两轮
   （4335d06、82f2597）改了 studio.js / studio.css / studio.html
   共 877 行，但忘了升 SHELL —— 线上会一直在跑旧外壳。
   而这类错误**任何现有测试都抓不到**：
   所有测试都是新开一个浏览器上下文（干净缓存），
   永远不会命中"老客户端 + 旧缓存"这条路径。

   ⚠️ 所以这条断言必须**借助 git**：光看文件本身看不出来
   "这次改动有没有配一次版本升级"。判据是
   「相对 HEAD，外壳文件被改了，但 SHELL 没变」。

   边界情况：
     · 不在 git 仓库里 / 没有 git        → 跳过（不误报）
     · git 命令失败（没有 HEAD 等）      → 跳过
     · 一次提交里同时改了外壳和 SHELL    → 通过
     · 只改测试、文档、非外壳文件        → 通过
   ================================================================ */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW = path.join(ROOT, 'sw.js');
const swSrc = fs.readFileSync(SW, 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== Service Worker 外壳版本 ===\n');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/* ---------------- SHELL 本身合法 ---------------- */

const m = /const\s+SHELL\s*=\s*'([^']+)'/.exec(swSrc);

t('sw.js 里有 SHELL 版本号，且形如 shell-vN', () => {
  assert.ok(m, '找不到 `const SHELL = \'...\'` —— 版本号没了外壳就永远不更新');
  assert.match(m[1], /^shell-v\d+$/,
    `SHELL 是「${m[1]}」，不符合 shell-v<数字> —— `
    + '改成别的样子会让版本比较失效');
});

/* ---------------- ASSETS 列表要覆盖所有外壳文件 ---------------- */

// 从 ASSETS 里抠出被缓存的路径
const assetsBlock = /const\s+ASSETS\s*=\s*\[([\s\S]*?)\]/.exec(swSrc);
const cached = new Set(
  (assetsBlock ? assetsBlock[1] : '')
    .split('\n')
    .map(l => /'([^']+)'/.exec(l))
    .filter(Boolean)
    .map(x => x[1].replace(/^\//, ''))
);

t('ASSETS 里列了 studio.js / studio.css / studio.html', () => {
  for (const f of ['studio.js', 'studio.css', 'studio.html']) {
    assert.ok(cached.has(f),
      `${f} 不在 ASSETS 里 —— 离线打开修图页会白屏`);
  }
});

t('⭐ ASSETS 覆盖了仓库根目录下所有会被页面引用的 js/css', () => {
  /* 判据：根目录下所有 .js / .css（除了 sw.js 自己和测试目录）
     都应该在 ASSETS 里。漏一个的症状是「在线能用、离线白屏」，
     而这种只在无网时暴露的问题很难被发现。 */
  const files = fs.readdirSync(ROOT)
    .filter(f => /\.(js|css)$/.test(f))
    .filter(f => f !== 'sw.js');      // sw.js 自己不需要缓存
  const missing = files.filter(f => !cached.has(f));
  assert.equal(missing.length, 0,
    `这些文件没进 ASSETS：${missing.join(', ')} —— 离线时会拿不到`);
});

/* ---------------- ⭐ 版本号必须跟着外壳改动一起升 ---------------- */

t('⭐ 外壳文件改了，SHELL 就必须升（相对 HEAD 判断）', () => {
  const headSw = git(['show', 'HEAD:sw.js']);
  if (headSw === null) {
    console.log('       ⏭  取不到 HEAD:sw.js（不在 git 仓库里？），跳过这条');
    return;
  }

  const changed = git(['diff', '--name-only', 'HEAD', '--'])
    || git(['status', '--porcelain']);
  if (changed === null) {
    console.log('       ⏭  取不到改动列表，跳过这条');
    return;
  }

  const changedFiles = changed.split('\n')
    .map(l => l.trim().replace(/^..\s+/, ''))   // 去掉 porcelain 的状态列
    .filter(Boolean);

  // 这次改动里有没有碰被缓存的外壳文件？
  const touchedShell = changedFiles.filter(f => cached.has(f));
  if (!touchedShell.length) return;   // 没碰外壳，随便改

  const oldShell = /const\s+SHELL\s*=\s*'([^']+)'/.exec(headSw);
  assert.ok(oldShell, 'HEAD 里的 sw.js 没有 SHELL，没法比较');

  assert.notEqual(
    m[1], oldShell[1],
    `改了外壳文件（${touchedShell.join(', ')}）但 SHELL 还是 `
    + `「${oldShell[1]}」没变。\n`
    + '     → 老客户端会一直用缓存里的旧文件，症状是'
    + '「本地测好了、线上没反应」。\n'
    + `     把 sw.js 里的 SHELL 改成 shell-v${
        Number(String(oldShell[1]).replace(/\D/g, '')) + 1
      } 就好了。`
  );
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
