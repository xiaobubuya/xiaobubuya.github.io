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
  ['shader-guard', 'shader 模板字符串护栏'],
  ['adjustments', '调整项 ↔ shader 一致性'],
  ['curve', '色调曲线 LUT（单调性/串扰）'],
  ['adjustments-negative', '断言有效性（变异测试）']
];

const BROWSER = [
  ['adjust-browser', '锐化/暗角/颗粒（真 Chrome + WebGL）'],
  ['mask-browser', '蒙版与局部调整（需外部 harness）'],
  ['inpaint-browser', '去物链路（需外部 harness）']
];

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
      resolve({
        code,
        pass: m ? Number(m[1]) : 0,
        fail: m ? Number(m[2]) : 0,
        skipped,
        out
      });
    });
  });
}

async function suite(title, list) {
  console.log('\n' + title);
  console.log('-'.repeat(title.length));
  let pass = 0, fail = 0, skipped = 0;

  for (const [file, desc] of list) {
    const r = await run(file);
    if (r.skipped) {
      skipped++;
      console.log(`  ⏭  ${file.padEnd(22)} ${desc}  —— 跳过`);
      continue;
    }
    pass += r.pass; fail += r.fail;
    const mark = r.fail ? '❌' : '✅';
    console.log(`  ${mark} ${file.padEnd(22)} 通过 ${String(r.pass).padStart(3)}  失败 ${r.fail}   ${desc}`);
    if (r.fail) {
      // 只在失败时打印细节，正常情况下保持输出干净
      const lines = r.out.split('\n').filter(l => l.includes('❌') || l.includes('Error'));
      for (const l of lines.slice(0, 12)) console.log('       ' + l.trim());
    }
  }
  return { pass, fail, skipped };
}

let total = { pass: 0, fail: 0, skipped: 0 };

if (!ONLY_BROWSER) {
  const r = await suite('静态与单元测试', FAST);
  total.pass += r.pass; total.fail += r.fail; total.skipped += r.skipped;
}
if (!ONLY_FAST) {
  const r = await suite('浏览器测试（真实 Chrome + WebGL）', BROWSER);
  total.pass += r.pass; total.fail += r.fail; total.skipped += r.skipped;
}

console.log('\n' + '='.repeat(48));
console.log(`  合计  通过 ${total.pass}  失败 ${total.fail}`
  + (total.skipped ? `  跳过 ${total.skipped} 个文件` : ''));
console.log('='.repeat(48) + '\n');

process.exit(total.fail ? 1 : 0);
