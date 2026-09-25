/* ================================================================
   静态素材护栏
   ----------------------------------------------------------------
   为什么需要它：这几类问题都**不会报错**，只会静默地丑/失效：

   ① **og:image 用了相对路径** —— 微信不认，转发出去没有预览图。
      而且本地浏览器打开完全正常（相对路径浏览器能解析），
      所以靠肉眼看发现不了。
   ② **页面引用了不存在的图标/图片** —— 浏览器只是不显示，
      控制台一条 404，很容易被忽略。
   ③ **icon 退回占位图** —— 曾经的 icon.svg 是个和 PNG 完全不像的
      圆环占位图，于是"主屏用 PNG、标签页用 SVG"看到两个图标。
      这种"不一致"没有任何测试会红。
   ================================================================ */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== 静态素材 ===\n');

/* ---------------- 图标 ---------------- */

const ICONS = ['icon-180.png', 'icon-192.png', 'icon-512.png', 'icon.svg'];

t('四档图标都存在，且不是空文件', () => {
  for (const f of ICONS) {
    const p = path.join(ROOT, f);
    assert.ok(fs.existsSync(p), `${f} 不存在`);
    const n = fs.statSync(p).size;
    // 占位级的小文件是历史问题：icon.svg 曾经只有 305 字节
    assert.ok(n > 400, `${f} 只有 ${n} 字节，像是占位图`);
  }
});

t('分享页兜底封面存在（否则微信预览会裂图）', () => {
  const p = path.join(ROOT, 'og-cover.png');
  assert.ok(fs.existsSync(p),
    'og-cover.png 不存在 —— 分享卡片的兜底图会 404，微信里就是一张裂图');
  assert.ok(fs.statSync(p).size > 5000, 'og-cover.png 太小，像占位图');
});

/* ---------------- og 标签 ---------------- */

/** 抠出某个 html 里所有 og:/twitter: 的 image 与 title */
function ogTags(html) {
  const out = { images: [], titles: [] };
  for (const m of html.matchAll(/<meta\s+(?:property|name)="(og:image|twitter:image|og:title|twitter:title)"\s+content="([^"]*)"/g)) {
    if (/image/.test(m[1])) out.images.push(m[2]);
    else out.titles.push(m[2]);
  }
  return out;
}

for (const file of ['index.html', 'share.html']) {
  t(`${file}：og:image 必须是**绝对 URL**（微信不认相对路径）`, () => {
    const { images } = ogTags(read(file));
    assert.ok(images.length > 0, `${file} 里没有任何 og:image`);
    for (const url of images) {
      assert.ok(/^https:\/\//.test(url),
        `og:image 不是绝对 URL：${url}\n`
        + '     ⚠️ 本地浏览器打开是正常的（相对路径能解析），'
        + '只有微信转发时才暴露，所以必须断言。');
    }
  });

  t(`${file}：og:image 指向的本地文件真的存在`, () => {
    const { images } = ogTags(read(file));
    for (const url of images) {
      // 只检查指向本域的
      const m = /^https:\/\/muyaya\.world\/(.+)$/.exec(url);
      if (!m) continue;
      const local = m[1];
      assert.ok(fs.existsSync(path.join(ROOT, local)),
        `og:image 指向 ${local}，但这个文件不存在 —— 微信会拿到 404，预览图是裂的`);
    }
  });

  t(`${file}：og:title 不是空的，也不是占位符`, () => {
    const { titles } = ogTags(read(file));
    assert.ok(titles.length > 0, `${file} 里没有 og:title`);
    for (const x of titles) {
      assert.ok(x.trim().length > 0, 'og:title 是空的');
      assert.ok(!/{{|\}\}/.test(x),
        `og:title 里还留着占位符：${x} —— 说明模板没被替换过`);
    }
  });
}

/* ---------------- 图标视觉一致（防退回占位图） ---------------- */

t('icon.svg 和 PNG 是同一套视觉（不是旧的圆环占位图）', () => {
  const svg = read('icon.svg');
  /* 旧的占位图特征是「两个同心 circle」。
     现在的图形是两张相框 + 一个 path 心形。 */
  const circles = (svg.match(/<circle/g) || []).length;
  assert.equal(circles, 0,
    'icon.svg 里还有 <circle> —— 看起来是旧的圆环占位图，'
    + '和 icon-*.png 不是一套，主屏和标签页会显示两个不同的图标');
  assert.ok(/<rect/.test(svg), 'icon.svg 里没有相框（rect）');
  assert.ok(/<path/.test(svg), 'icon.svg 里没有心形（path）');
});

t('icon.svg 里没有残留的亮蓝色（旧占位图的痕迹）', () => {
  const svg = read('icon.svg');
  assert.ok(!/#3b82f6|#2563eb|blue/i.test(svg),
    'icon.svg 里还有亮蓝色 —— 那是旧占位图的颜色，和暖色系不一致');
});

/* ---------------- manifest 指向的图标都在 ---------------- */

t('manifest 里列出的图标文件都存在', () => {
  const mf = JSON.parse(read('manifest.webmanifest'));
  for (const ic of mf.icons || []) {
    const src = String(ic.src || '').replace(/^\//, '');
    assert.ok(fs.existsSync(path.join(ROOT, src)),
      `manifest 引用了 ${src}，但文件不存在`);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
