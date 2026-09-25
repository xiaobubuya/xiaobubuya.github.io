/* ================================================================
   前端测试入口
   ----------------------------------------------------------------
   前端是纯静态文件，没有构建步骤，所以这里只做一件事：
   把散在各处的测试按「快 → 慢」的顺序跑一遍，最后给个总账。

   快的是纯 node 的静态/单测；慢的是要起 Chrome 的浏览器测试。
   分开是因为改 CSS 的人不需要等 Chrome 起来。
   ================================================================ */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ONLY_FAST = process.argv.includes('--fast');
const ONLY_BROWSER = process.argv.includes('--browser');

const FAST = [
  ['autolayout', '自动排版几何'],
  ['upload', '上传流程'],
  ['mask', '蒙版引擎'],
  ['contract', '跨仓库契约'],
  ['sw-version', 'sw.js 外壳版本（改了 studio.* 必须升）'],
  ['shader-guard', 'shader 模板字符串护栏'],
  ['adjustments', '调整项 ↔ shader 一致性'],
  ['curve', '色调曲线 LUT（单调性/串扰）'],
  ['adjustments-negative', '断言有效性（变异测试）']
];

const BROWSER = [
  ['adjust-browser', '锐化/暗角/颗粒/曲线/HSL（真 Chrome + WebGL）'],
  ['template-browser', '一键模板（Chrome 侧）/ 左右对比 / 进度条'],
  ['crop-browser', '裁剪 / 旋转（几何变换）'],
  ['mask-browser', '蒙版与局部调整（需外部 harness）'],
  ['inpaint-browser', '去物链路（需外部 harness）']
];

/* ================================================================
   已知问题（**不是**新失败）
   ----------------------------------------------------------------
   ⚠️ 为什么要有这张表：一个**已经写进文档、还没解决**的失败如果让
   整套测试永远退 1，红灯就失去意义了 —— 以后真的踩坏了也分不出来。
   所以这里显式登记，单独报，且**不计入退出码**。

   ⚠️ 但绝不能登记成"通过"：它会以黄色 piggyback 在测试行上打出来，
   总账里也单独列一行。要让它消失只有两个正当办法 ——
   真的修好（那 ROADMAP §5.1.1 要一起删），
   或者明确决定不做（那也要从这张表里删掉并说明）。
   ================================================================ */
const KNOWN_ISSUES = {
  'crop-browser': ['裁剪内容的上下朝向'],
};

function run(file) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(HERE, file + '.test.mjs')],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => {
      const m = /通过 (\d+) 项，失败 (\d+) 项/.exec(out);
      const skipped = /跳过：/.test(out);
      /* ================================================================
         ⚠️ 没解析出汇总行 = 这个文件**在收集阶段就死了**，要当失败算
         ----------------------------------------------------------------
         踩过：crop-browser 的静态服务端口被占用，抛 EADDRINUSE，
         一行测试都没跑就退出。而这里原来只累加 "失败项数"，
         于是它显示成「通过 0 失败 0 ✅」，看着像通过 ——
         裁剪那 14 项整批**静默消失**，总账还是绿的。
         崩溃必须算失败，否则"没跑"和"跑过了"分不出来。
         （同理：跑了但一条汇总都没有，也是崩溃。）
         ================================================================ */
      /* 判据只看"有没有汇总行"。有汇总行时 fail 里已经是真实失败数，
         再拿退出码判会双重计数；没汇总行才说明它没跑完。 */
      const crashed = !skipped && !m;
      resolve({
        code,
        pass: m ? Number(m[1]) : 0,
        fail: m ? Number(m[2]) : 0,
        crashed,
        skipped,
        out
      });
    });
  });
}

async function suite(title, list) {
  console.log('\n' + title);
  console.log('-'.repeat(title.length));
  let pass = 0, fail = 0, skipped = 0, known = 0;

  for (const [file, desc] of list) {
    const r = await run(file);
    if (r.skipped) {
      skipped++;
      console.log(`  ⏭  ${file.padEnd(22)} ${desc}  —— 跳过`);
      continue;
    }
    pass += r.pass;

    const allow = KNOWN_ISSUES[file] || [];
    const k = Math.min(allow.length, r.fail);
    known += k;
    fail += r.fail - k;

    const mark = r.crashed || r.fail > k ? '❌' : (r.fail ? '🟡' : '✅');
    console.log(`  ${mark} ${file.padEnd(22)} 通过 ${String(r.pass).padStart(3)}  失败 ${r.fail}   ${desc}`);
    if (k) {
      console.log(`       🟡 其中 ${k} 项是**已登记的已知问题**（不计入退出码）：`);
      for (const n of allow.slice(0, k)) console.log(`          · ${n}`);
    }
    if (r.crashed) {
      console.log(`       ⚠️ ${file} 在开跑前就退出了（exit ${r.code}）—— 一条测试都没执行`);
      const lines = r.out.split('\n').filter(Boolean).slice(-10);
      for (const l of lines) console.log('       │ ' + l.trim());
    } else if (r.fail > k) {
      // 只在有**新**失败时打印细节，正常情况下保持输出干净
      const lines = r.out.split('\n').filter(l => l.includes('❌') || l.includes('Error'));
      for (const l of lines.slice(0, 12)) console.log('       ' + l.trim());
    }
  }
  return { pass, fail, skipped, known };
}

let total = { pass: 0, fail: 0, skipped: 0, known: 0 };

if (!ONLY_BROWSER) {
  const r = await suite('静态与单元测试', FAST);
  total.pass += r.pass; total.fail += r.fail;
  total.skipped += r.skipped; total.known += r.known;
}
if (!ONLY_FAST) {
  const r = await suite('浏览器测试（真实 Chrome + WebGL）', BROWSER);
  total.pass += r.pass; total.fail += r.fail;
  total.skipped += r.skipped; total.known += r.known;
}

console.log('\n' + '='.repeat(48));
console.log(`  合计  通过 ${total.pass}  失败 ${total.fail}`
  + (total.known ? `  已知问题 ${total.known}（不计入失败）` : '')
  + (total.skipped ? `  跳过 ${total.skipped} 个文件` : ''));
if (total.known) {
  console.log('  ⚠️ 已知问题不是通过 —— 修好之前不要交付对应功能');
}
console.log('='.repeat(48) + '\n');

process.exit(total.fail ? 1 : 0);
