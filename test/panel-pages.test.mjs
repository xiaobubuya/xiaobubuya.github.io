/* ================================================================
   面板分页 —— 竖栏和页面必须对上，滑杆拆页不许丢人
   ----------------------------------------------------------------
   背景：面板从「5 个手风琴叠成一列」改成「图标竖栏 + 6 页」。
   结构改了但**接线漏了**的症状和旧手风琴一模一样 ——
   竖栏看着能点、点了没反应，6 个页面都在 DOM 里只有第一个露出来。
   这类错误运行期完全不报错，只有人真的去点才知道。

   上一版手风琴就是死在这条路上：CSS 写了 `.st-acc.collapsed`，
   但全仓库没有任何 js 去加 `collapsed` 类，5 个标题全是死的。

   判据（静态，快、不用起 Chrome）：
     1. 竖栏按钮和页面一一对应（多的没按钮点、少的点了白点）
     2. HTML 的页面 id 和 studio.js 的 PANEL_PAGES 一致
     3. 竖栏的点击真的接到 showPage（不是又一个死按钮）
     4. 16 个调整项一个都不能因为拆页而消失
     5. 旧手风琴的痕迹彻底清干净
   ================================================================ */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'studio.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'studio.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'studio.css'), 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== 面板分页（竖栏 + 多页）===\n');

/** 抠出 HTML 里 `data-page="x"` 的全部取值（rail 按钮 + 页面块） */
function dataPages(src) {
  return [...src.matchAll(/data-page="([a-z]+)"/g)].map(m => m[1]);
}
const railPages = [...html.matchAll(/class="st-rail-btn[^"]*"[^>]*data-page="([a-z]+)"/g)]
  .map(m => m[1]);
const pageBlocks = [...html.matchAll(/class="st-page[^"]*"[^>]*data-page="([a-z]+)"/g)]
  .map(m => m[1]);

/* ---------------- 1. 竖栏和页面一一对应 ---------------- */

t('竖栏按钮存在（分页要靠它切）', () => {
  assert.ok(railPages.length > 0, 'HTML 里找不到 .st-rail-btn[data-page]');
});

t('每个竖栏按钮都有对应页面', () => {
  const missing = railPages.filter(p => !pageBlocks.includes(p));
  assert.deepEqual(missing, [],
    `这些竖栏按钮点了没有页面可显示：${missing.join(', ')}`);
});

t('每个页面都能在竖栏里点到', () => {
  const orphan = pageBlocks.filter(p => !railPages.includes(p));
  assert.deepEqual(orphan, [],
    `这些页面竖栏里没按钮，用户永远进不来：${orphan.join(', ')}`);
});

t('竖栏按钮没有重复的页', () => {
  const dup = railPages.filter((p, i) => railPages.indexOf(p) !== i);
  assert.deepEqual(dup, [], `重复的竖栏按钮：${dup.join(', ')}`);
});

/* ---------------- 2. HTML ↔ JS 的页 id 一致 ---------------- */

const jsPages = [...js.matchAll(/\{\s*id:\s*'([a-z]+)'\s*,\s*name:\s*'[^']+'\s*\}/g)]
  .map(m => m[1]);

t('studio.js 里有 PANEL_PAGES 定义', () => {
  assert.ok(jsPages.length > 0, 'studio.js 里找不到 PANEL_PAGES 的页定义');
});

t('HTML 的页面和 PANEL_PAGES 完全对上', () => {
  const a = [...pageBlocks].sort();
  const b = [...jsPages].sort();
  assert.deepEqual(a, b, `HTML [${a}] 和 JS [${b}] 不一致`);
});

t('studio.js 的竖栏页 id 和 HTML 一致', () => {
  const a = [...railPages].sort();
  const b = [...jsPages].sort();
  assert.deepEqual(a, b, `竖栏 [${a}] 和 JS [${b}] 不一致`);
});

/* ---------------- 3. 竖栏真的接到了 showPage ---------------- */

t('竖栏按钮的点击接到 showPage', () => {
  assert.ok(/addEventListener\(\s*['"]click['"]\s*,\s*\(\)\s*=>\s*showPage\(\s*b\.dataset\.page\s*\)/.test(js),
    '找不到 `showPage(b.dataset.page)` —— 竖栏按钮又是死的');
});

t('showPage 会切 .st-page.on 和 .st-rail-btn.on', () => {
  assert.ok(/querySelectorAll\(['"]\.st-page['"]\)/.test(js), 'showPage 没切 .st-page');
  assert.ok(/querySelectorAll\(['"]\.st-rail-btn['"]\)/.test(js), 'showPage 没切竖栏高亮');
});

t('面板标题会跟着页面变', () => {
  assert.ok(/\$\('stPageTitle'\)/.test(js), 'showPage 没更新 #stPageTitle');
  assert.ok(html.includes('id="stPageTitle"'), 'HTML 里找不到 #stPageTitle');
});

t('initRail 在启动时被调用', () => {
  assert.ok(/initRail\(\)/.test(js), 'studio.js 里定义了 initRail 但没在 boot() 里调用');
});

/* ---------------- 4. 新面板骨架都在 ---------------- */

t('新面板骨架的容器都在', () => {
  for (const sel of ['id="stPanel"', 'class="st-panel-main"', 'id="stPages"', 'id="stRail"']) {
    assert.ok(html.includes(sel), `HTML 里找不到 ${sel}`);
  }
  for (const sel of ['.st-panel-main{', '.st-pages{', '.st-page{', '.st-page.on{', '.st-rail{', '.st-rail-btn{']) {
    assert.ok(css.includes(sel), `studio.css 里找不到 ${sel}`);
  }
});

/* ---------------- 5. 滑杆拆页不许丢人 ---------------- */

/** 从 ADJUSTMENTS 里抠每个调整项的分组名 */
const adjBlock = /const ADJUSTMENTS\s*=\s*\[([\s\S]*?)\n  \];/.exec(js);
const adjGroups = adjBlock ? [...adjBlock[1].matchAll(/group:\s*'([^']+)'/g)].map(m => m[1]) : [];
const adjCount = adjBlock ? [...adjBlock[1].matchAll(/^\s*\{\s*key:/gm)].length : 0;

/** 从 SLIDER_GROUPS 里抠 { 容器id: [分组] } */
const sgBlock = /const SLIDER_GROUPS\s*=\s*\{([\s\S]*?)\n  \};/.exec(js);
const sliderGroups = {};
if (sgBlock) {
  for (const m of sgBlock[1].matchAll(/(\w+)\s*:\s*\[([^\]]*)\]/g)) {
    sliderGroups[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map(x => x[1]);
  }
}

t('ADJUSTMENTS 有 16 个调整项', () => {
  assert.equal(adjCount, 16, `应该是 16 个，实际 ${adjCount}`);
});

t('SLIDER_GROUPS 覆盖了每一个分组（漏了就是滑杆消失）', () => {
  const all = new Set(Object.values(sliderGroups).flat());
  const missing = [...new Set(adjGroups)].filter(g => !all.has(g));
  assert.deepEqual(missing, [],
    `这些分组的滑杆没落到任何容器里，用户看不到：${missing.join(', ')}`);
});

t('SLIDER_GROUPS 没有多余的分组', () => {
  const all = new Set(Object.values(sliderGroups).flat());
  const extra = [...all].filter(g => !adjGroups.includes(g));
  assert.deepEqual(extra, [],
    `SLIDER_GROUPS 里写了 ADJUSTMENTS 中不存在的分组：${extra.join(', ')}`);
});

t('SLIDER_GROUPS 的每个容器在 HTML 里都存在', () => {
  const missing = Object.keys(sliderGroups).filter(id => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `HTML 里找不到这些容器：${missing.join(', ')}`);
});

t('buildSliders 接了分组过滤', () => {
  assert.ok(/function buildSliders\(\s*\w+\s*,\s*\w+\s*\)/.test(js),
    'buildSliders 还是单容器签名 —— 拆页不生效');
  assert.ok(/groups\.includes\(a\.group\)/.test(js),
    'buildSliders 里没有按分组过滤，两个容器会渲染出重复滑杆');
});

t('启动时有护栏：漏生成的调整项直接报错', () => {
  assert.ok(/a\._show\)/.test(js) && /没生成滑杆/.test(js),
    'boot() 里没有检查「每个调整项都生成了滑杆」');
});

/* ---------------- 6. 局部调整开关跟着选区显隐 ---------------- */

t('#stScope 在 HTML 里存在且默认隐藏', () => {
  const m = /<div class="st-scope"\s+id="stScope"\s+hidden\s*>/.exec(html);
  assert.ok(m, 'HTML 里找不到 `<div class="st-scope" id="stScope" hidden>`');
});

t('有选区时才显示 #stScope（syncMaskUI 里驱动）', () => {
  assert.ok(/const sc = \$\('stScope'\);[\s\S]{0,200}sc\.hidden = mask\.isEmpty/.test(js),
    'syncMaskUI 里没有按 mask.isEmpty 显隐 #stScope');
});

/* ---------------- 7. 旧手风琴的痕迹清干净 ---------------- */

/** 去掉注释再检查：注释里提到 `.st-acc` 是在**说明为什么要删**，
    那不算残留。真正的残留是还有活的 DOM / 选择器引用。 */
const htmlNoComment = html.replace(/<!--[\s\S]*?-->/g, '');
const jsNoComment = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

t('HTML 里没有残留的手风琴节点', () => {
  for (const s of ['st-acc', 'id="stAccPreset"', 'id="stAccBasic"', 'id="stAccAi"', 'id="stAccCrop"', 'id="stAccRot"']) {
    assert.ok(!htmlNoComment.includes(s), `studio.html 里还留着「${s}」`);
  }
});

t('studio.js 里没有残留的手风琴逻辑', () => {
  for (const s of ['stAccPreset', 'stAccBasic', 'stAccAi', 'stAccCrop', 'stAccRot', "querySelectorAll('.st-acc"]) {
    assert.ok(!jsNoComment.includes(s), `studio.js 里还留着「${s}」`);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
