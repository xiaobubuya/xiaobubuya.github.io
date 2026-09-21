/**
 * 自动排版引擎单元测试
 * 运行：node test/autolayout.test.mjs
 *
 * 这是纯几何模块，不需要浏览器 —— 越界、重叠、裁切这类问题
 * 用肉眼在截图上很难看出来，用断言跑一遍就清楚了。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Auto = require(path.join(HERE, '..', 'autolayout.js'));

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
};

/* ---------- 工具 ---------- */
const rect = s => ({ x: s[0], y: s[1], w: s[2], h: s[3] });
const EPS = 1e-9;

function overlap(a, b) {
  const A = rect(a), B = rect(b);
  const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
  const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
  return ox > EPS && oy > EPS ? { ox, oy } : null;
}

function inCanvas(s, margin = 0) {
  const r = rect(s);
  return r.x >= -EPS && r.y >= -EPS &&
         r.x + r.w <= 1 + EPS && r.y + r.h <= 1 + EPS &&
         r.w > 0 && r.h > 0 &&
         r.x >= margin - EPS && r.y >= margin - EPS &&
         r.x + r.w <= 1 - margin + EPS && r.y + r.h <= 1 - margin + EPS;
}

// 造一批不同宽高比的「照片」
const photos = {};
const dims = {};
for (let i = 0; i < 40; i++) {
  const k = i.toString(16).padStart(2, '0').repeat(8);
  const ars = [[4,3],[3,2],[2,3],[1,1],[16,9],[3,4],[5,4],[9,16]];
  const [w, h] = ars[i % ars.length];
  photos[k] = { w: w * 1000, h: h * 1000 };
  dims[k] = photos[k];
}
const itemsOf = n => Object.keys(photos).slice(0, n).map((k, i) => ({
  id: 'it_' + i, photo: k, x: 0.1, y: 0.1, w: 0.2, h: 0.2,
  rot: 7, z: i, fit: 'cover', radius: 0, caption: 'caption' + i
}));

/* ================================================================
   1. 版式本身的几何合法性
   ================================================================ */
console.log('\n=== 1. 版式几何（每种张数 × 每个比例 × 每套版式）===');
{
  const ratios = [1.5, 1, 0.6667, 1.3333];
  let checked = 0, bad = 0;
  const problems = [];

  for (const ratio of ratios) {
    for (let n = 1; n <= 12; n++) {
      const tpls = Auto.templatesFor(n, ratio);
      for (const tpl of tpls) {
        checked++;
        const tag = `ratio=${ratio} n=${n} ${tpl.id}`;

        if (!tpl.crop && n === 1) continue;      // 单张不裁切版式没有固定槽位

        const slots = tpl.slots;
        if (!slots || slots.length !== n) {
          problems.push(`${tag}: 槽位数 ${slots ? slots.length : 0} ≠ ${n}`);
          bad++; continue;
        }

        for (const s of slots) {
          if (!inCanvas(s, Auto.EDGE - 1e-6)) {
            problems.push(`${tag}: 槽位越界 ${JSON.stringify(s.map(v => +v.toFixed(3)))}`);
            bad++;
          }
        }
        for (let i = 0; i < slots.length; i++) {
          for (let j = i + 1; j < slots.length; j++) {
            const o = overlap(slots[i], slots[j]);
            if (o) {
              problems.push(`${tag}: 槽位 ${i}/${j} 重叠 ${o.ox.toFixed(4)}×${o.oy.toFixed(4)}`);
              bad++;
            }
          }
        }
      }
    }
  }

  ok(bad === 0, `${checked} 套版式全部：不越界、不重叠、张数匹配`,
     problems.slice(0, 4).join(' | '));
  if (problems.length) problems.slice(0, 8).forEach(p => console.log('       ' + p));
}

/* ================================================================
   2. 单张照片：不裁切
   ================================================================ */
console.log('\n=== 2. 单张照片版式：保持原始比例（不裁切）===');
{
  const ratio = 1.5;
  const tpls = Auto.templatesFor(1, ratio);

  for (const tpl of tpls) {
    if (tpl.crop) continue;
    for (const ars of [[4,3],[3,2],[2,3],[1,1],[16,9]]) {
      const items = [{ id: 'a', photo: 'p', x: .1, y: .1, w: .3, h: .3, rot: 30, z: 0,
                       fit: 'cover', radius: 0, caption: '' }];
      const d = { p: { w: ars[0] * 1000, h: ars[1] * 1000 } };
      const out = Auto.layout(items, d, ratio, tpls.indexOf(tpl));
      const it = out.items[0];

      const wantAR = (ars[0] / ars[1]) / ratio;    // 归一化坐标下的期望宽高比
      const gotAR = it.w / it.h;
      ok(Math.abs(gotAR - wantAR) < 0.002,
         `${tpl.name} + ${ars[0]}:${ars[1]} → 比例误差 ${Math.abs(gotAR - wantAR).toFixed(5)}`);
      ok(it.fit === 'contain', `${tpl.name} 用 contain（不裁切）`);
    }
  }
}

/* ================================================================
   3. 多张照片：数量、越界、重叠
   ================================================================ */
console.log('\n=== 3. 多张照片排版结果 ===');
{
  for (let n = 1; n <= 12; n++) {
    const items = itemsOf(n);
    const tpls = Auto.templatesFor(n, 1.5);
    let allGood = true, detail = '';

    for (let ti = 0; ti < tpls.length; ti++) {
      const out = Auto.layout(items, dims, 1.5, ti);
      if (out.items.length !== n) { allGood = false; detail = `元素数 ${out.items.length} ≠ ${n}`; break; }
      for (const it of out.items) {
        if (!inCanvas([it.x, it.y, it.w, it.h], Auto.EDGE - 1e-6)) {
          allGood = false; detail = `越界 ${tpls[ti].id}`; break;
        }
      }
      if (!allGood) break;
      for (let i = 0; i < out.items.length && allGood; i++) {
        for (let j = i + 1; j < out.items.length; j++) {
          const o = overlap([out.items[i].x, out.items[i].y, out.items[i].w, out.items[i].h],
                            [out.items[j].x, out.items[j].y, out.items[j].w, out.items[j].h]);
          if (o) { allGood = false; detail = `${tpls[ti].id} 元素重叠`; break; }
        }
      }
    }
    ok(allGood, `${n} 张照片：全部版式不越界、不重叠、数量正确`, detail);
  }
}

/* ================================================================
   4. 数据完整性：照片/图注不丢，旋转被摆正
   ================================================================ */
console.log('\n=== 4. 数据完整性 ===');
{
  const items = itemsOf(4);
  const out = Auto.layout(items, dims, 1.5, 0);

  const beforePhotos = items.map(i => i.photo).sort().join(',');
  const afterPhotos = out.items.map(i => i.photo).sort().join(',');
  ok(beforePhotos === afterPhotos, '照片全部保留，一张不多一张不少');

  const beforeIds = items.map(i => i.id).sort().join(',');
  const afterIds = out.items.map(i => i.id).sort().join(',');
  ok(beforeIds === afterIds, '元素 id 全部保留');

  ok(out.items.every(i => i.caption && i.caption.startsWith('caption')), '图注保留');
  ok(out.items.every(i => i.rot === 0), '旋转被摆正为 0');

  // 不应该改到传入的原数组
  ok(items.every(i => i.x === 0.1 && i.y === 0.1 && i.rot === 7),
     '没有修改传入的原数组（纯函数）');
}

/* ================================================================
   5. 版式循环
   ================================================================ */
console.log('\n=== 5. 版式序号循环 ===');
{
  const items = itemsOf(3);
  const total = Auto.templatesFor(3, 1.5).length;

  const a = Auto.layout(items, dims, 1.5, 0);
  const b = Auto.layout(items, dims, 1.5, total);      // 超范围应回到 0
  ok(a.templateId === b.templateId, `index=${total} 回绕到 index=0（${a.templateId}）`);

  const c = Auto.layout(items, dims, 1.5, -1);         // 负数应回绕到最后一个
  ok(c.index === total - 1, `index=-1 回绕到 ${total - 1}（${c.templateId}）`);

  // 依次点过去，应该每套都不同
  const ids = new Set();
  for (let i = 0; i < total; i++) ids.add(Auto.layout(items, dims, 1.5, i).templateId);
  ok(ids.size === total, `${total} 套版式互不相同（${[...ids].join(', ')}）`);
}

/* ================================================================
   6. 大槽优先 + 比例最接近的照片
   ================================================================ */
console.log('\n=== 6. 填槽策略：大槽优先，选比例最接近的照片 ===');
{
  const ratio = 1.5;
  // 一张超宽、一张超高的照片，配「一主两副」版式
  const wide  = { k: 'w'.repeat(16), w: 1600, h: 600  };   // 8:3 超宽
  const tall  = { k: 't'.repeat(16), w: 600,  h: 1600 };   // 3:8 超高
  const items = [
    { id: '1', photo: wide.k, x: 0, y: 0, w: .2, h: .2, rot: 0, z: 0, fit: 'cover', radius: 0, caption: '' },
    { id: '2', photo: tall.k, x: 0, y: 0, w: .2, h: .2, rot: 0, z: 1, fit: 'cover', radius: 0, caption: '' },
  ];
  const d = { [wide.k]: { w: wide.w, h: wide.h }, [tall.k]: { w: tall.w, h: tall.h } };
  const out = Auto.layout(items, d, ratio, 0);   // side 版式：两个等大槽

  ok(out.items.length === 2, '两张都排进去了');
  // 等大槽时顺序无所谓，只验证没有崩、都在界内
  ok(out.items.every(i => inCanvas([i.x, i.y, i.w, i.h], Auto.EDGE - 1e-6)), '结果都在界内');

  // 用「一大一小」版式验证大槽确实分给了更合适的照片
  const tplHero = Auto.templatesFor(2, ratio).findIndex(t => t.id === 'hero');
  const hero = Auto.layout(items, d, ratio, tplHero);
  const big = hero.items.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
  const slots = Auto.templatesFor(2, ratio)[tplHero].slots;
  const bigSlotAR = (Math.max(slots[0][2] * slots[0][3], slots[1][2] * slots[1][3]) === slots[0][2] * slots[0][3])
    ? (slots[0][2] / slots[0][3]) * ratio : (slots[1][2] / slots[1][3]) * ratio;
  const bigPhotoAR = big.photo === wide.k ? wide.w / wide.h : tall.w / tall.h;
  // 大槽是竖长的，应该拿到竖照片；或者反过来也要自洽
  ok(Math.abs(Math.log(bigPhotoAR / bigSlotAR)) < Math.log(4),
     `大槽拿到比例较接近的照片（槽 ${bigSlotAR.toFixed(2)}, 照片 ${bigPhotoAR.toFixed(2)}）`);
}

/* ================================================================
   7. 边界情况
   ================================================================ */
console.log('\n=== 7. 边界情况 ===');
{
  const empty = Auto.layout([], {}, 1.5, 0);
  ok(empty.items.length === 0, '空页返回空数组，不报错');

  const one = Auto.layout(itemsOf(1), dims, 1.5, 99);
  ok(one.items.length === 1, '超大 index 不报错，自动回绕');

  const noDims = Auto.layout(itemsOf(2), {}, 1.5, 0);
  ok(noDims.items.length === 2, '缺少照片尺寸信息时用默认 4:3 兜底，不报错');

  for (const r of [0.6667, 1, 1.5, 2]) {
    const out = Auto.layout(itemsOf(6), dims, r, 0);
    ok(out.items.every(i => inCanvas([i.x, i.y, i.w, i.h], Auto.EDGE - 1e-6)),
       `比例 ${r} 下 6 张照片不越界`);
  }
}

/* ================================================================
   汇总
   ================================================================ */
console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(50) + '\n');
process.exit(fail ? 1 : 0);
