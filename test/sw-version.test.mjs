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

   ⚠️⚠️ 这个护栏本身有个**洞**，实际漏过一次：判据只看"相对 HEAD 的
   *工作区*改动"，所以**只要先把外壳改动提交了、再跑测试**，它就看不到
   那次改动 —— 几何重写那一提交（先 commit studio.js、后跑测试）
   它就报了"✅ 通过"，而线上会一直吃旧外壳缓存。

   补的判据（下面第 ② 条）：再看**最近 N 个提交**里有没有"动了外壳
   但没升 SHELL"的组合。不追求完备（很久以前的历史不去追），
   只要求"提交之后漏检"这条路被堵住。
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

/** 把 SHELL 的序号抠成数字，方便比大小 */
const shellNum = s => Number(String(s || '').replace(/\D/g, '')) || 0;

t('① 工作区改了外壳文件 → SHELL 必须同时升（相对 HEAD）', () => {
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
    + `     把 sw.js 里的 SHELL 改成 shell-v${shellNum(oldShell[1]) + 1} 就好了。`
  );
});

t('② 最近 20 个提交里，动了外壳的那次必须也升过 SHELL', () => {
  /* ⚠️ 这条是补 ① 的洞：① 只看**未提交**的改动。一旦先提交再跑测试，
     ① 就什么都看不到（真发生过）。这里往回看 20 个提交。 */
  const N = 20;
  const log = git(['log', `-${N}`, '--format=%H%x09%s']);
  if (!log) { console.log('       ⏭  取不到 git log，跳过这条'); return; }

  const commits = log.split('\n').filter(Boolean).map(l => {
    const [hash, ...rest] = l.split('\t');
    return { hash, subject: rest.join('\t') };
  });

  /* 逐个提交看：它有没有动外壳文件？它有没有升 SHELL？
     规则：**如果某个提交动了外壳、但 SHELL 相对它的父提交没变**，
     那一次就是漏升。（同一次提交里既改外壳又升 SHELL 是允许的。）

     ⚠️ 只看**上一次升 SHELL 之后**的提交：升一次就覆盖它之前的全部
     漏升，所以不能拿"历史遗留"永久卡住这条断言（否则以后谁改
     都会看见同一批旧账）。找到第一个升过 SHELL 的提交就停。 */
  const offenders = [];
  for (const c of commits) {
    const cur = git(['show', `${c.hash}:sw.js`]);
    const prev = git(['show', `${c.hash}^:sw.js`]);
    if (cur === null) continue;
    const curShell = /const\s+SHELL\s*=\s*'([^']+)'/.exec(cur);
    const prevShell = prev === null ? null : /const\s+SHELL\s*=\s*'([^']+)'/.exec(prev);
    if (!curShell) continue;

    // 这次提交升了 SHELL → 之前的旧账一笔勾销，停止回溯
    if (prevShell && shellNum(curShell[1]) > shellNum(prevShell[1])) break;

    const files = git(['show', '--name-only', '--format=', c.hash]);
    if (!files) continue;
    const touched = files.split('\n')
      .map(s => s.trim()).filter(f => cached.has(f));
    if (!touched.length) continue;

    if (prevShell && curShell[1] === prevShell[1]) {
      offenders.push(`${c.hash.slice(0, 8)} ${c.subject} `
        + `（动了 ${touched.join(', ')}，SHELL 仍是 ${curShell[1]}）`);
    }
  }

  assert.equal(offenders.length, 0,
    '这些提交改了外壳文件却没升 SHELL —— 线上会一直吃旧缓存：\n       '
    + offenders.join('\n       ')
    + `\n     → 现在把 SHELL 从「${m[1]}」升一档即可（升一次覆盖前面所有漏升）。`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
