/* ================================================================
   自动排版引擎（纯几何，不碰 DOM）
   ================================================================
   为什么不用大模型直接输出坐标：精确几何不是它擅长的，容易出现
   重叠、越界、比例失调。排版这件事规则引擎做得又稳又快，
   AI 更适合做「哪些照片放一起、写什么图注」这类语义判断。

   核心思路：
     1. 每套版式定义若干「槽位」（占可用区域的比例）
     2. 按当前页的照片数量挑版式，点一下换下一个
     3. 把照片填进槽位 —— 大槽优先，用「宽高比最接近」的照片来填，
        尽量减少裁切
     4. 只有一张照片时，按照片自身比例算框，完全不裁切

   坐标全部是归一化 0~1，与屏幕尺寸无关。

   用法（浏览器）：
     AutoLayout.layout(items, dims, ratio, index)
   用法（Node 测试）：
     直接 require/import，挂在 globalThis.AutoLayout 上
   ================================================================ */
(function (root) {
  'use strict';

  /** 页边距 / 元素间距（相对画布的比例） */
  const EDGE = 0.045;
  const GAP = 0.018;

  const usable = () => ({ x: EDGE, y: EDGE, w: 1 - 2 * EDGE, h: 1 - 2 * EDGE });

  /**
   * 给出某个张数下的全部版式。
   * 槽位是画布归一化坐标 [x, y, w, h]。
   */
  function templatesFor(n, ratio) {
    const u = usable();
    const g = GAP;
    const hw = (u.w - g) / 2;      // 半宽
    const hh = (u.h - g) / 2;      // 半高
    const tw = (u.w - 2 * g) / 3;  // 三分之一宽
    const qw = (u.w - 3 * g) / 4;  // 四分之一宽
    const rh = (u.h - 3 * g) / 4;  // 四分之一高

    if (n === 1) {
      return [
        { id: 'full',   name: '满版',   crop: true,  slots: [[u.x, u.y, u.w, u.h]] },
        { id: 'center', name: '居中留白', crop: false, align: 'center',
          box: [u.w * 0.78, u.h * 0.86] },
        { id: 'left',   name: '偏左留白', crop: false, align: 'left',
          box: [u.w * 0.66, u.h * 0.92] },
        { id: 'mat',    name: '装裱',   crop: false, align: 'center',
          box: [u.w * 0.62, u.h * 0.70] },
      ];
    }

    if (n === 2) {
      return [
        { id: 'side',    name: '左右并排', crop: true,
          slots: [[u.x, u.y, hw, u.h], [u.x + hw + g, u.y, hw, u.h]] },
        { id: 'hero',    name: '一大一小', crop: true,
          slots: [[u.x, u.y, u.w * 0.62, u.h],
                  [u.x + u.w * 0.64, u.y + u.h * 0.54, u.w * 0.36, u.h * 0.46]] },
        { id: 'stagger', name: '错落',   crop: true,
          // 两个槽位必须留出 GAP 的间隙，否则照片会叠在一起（测试会抓）
          slots: [[u.x, u.y + u.h * 0.10, u.w * 0.52, u.h * 0.90],
                  [u.x + u.w * 0.54, u.y, u.w * 0.46, u.h * 0.76]] },
        { id: 'topdown', name: '上下',   crop: true,
          slots: [[u.x, u.y, u.w, hh], [u.x, u.y + hh + g, u.w, hh]] },
      ];
    }

    if (n === 3) {
      return [
        { id: 'pin',   name: '品字',     crop: true,
          slots: [[u.x + u.w * 0.22, u.y, u.w * 0.56, hh],
                  [u.x, u.y + hh + g, hw, hh],
                  [u.x + hw + g, u.y + hh + g, hw, hh]] },
        { id: 'hero2', name: '一主两副', crop: true,
          slots: [[u.x, u.y, u.w * 0.60, u.h],
                  [u.x + u.w * 0.62, u.y, u.w * 0.38, hh],
                  [u.x + u.w * 0.62, u.y + hh + g, u.w * 0.38, hh]] },
        { id: 'row3',  name: '一排三张', crop: true,
          slots: [[u.x, u.y + u.h * 0.12, tw, u.h * 0.76],
                  [u.x + tw + g, u.y, tw, u.h],
                  [u.x + 2 * (tw + g), u.y + u.h * 0.12, tw, u.h * 0.76]] },
      ];
    }

    if (n === 4) {
      return [
        { id: 'grid',  name: '田字',     crop: true,
          slots: [[u.x, u.y, hw, hh],
                  [u.x + hw + g, u.y, hw, hh],
                  [u.x, u.y + hh + g, hw, hh],
                  [u.x + hw + g, u.y + hh + g, hw, hh]] },
        { id: 'hero3', name: '一大三小', crop: true,
          slots: [[u.x, u.y, u.w * 0.58, u.h],
                  [u.x + u.w * 0.60, u.y, u.w * 0.40, rh],
                  [u.x + u.w * 0.60, u.y + rh + g, u.w * 0.40, rh],
                  [u.x + u.w * 0.60, u.y + 2 * (rh + g), u.w * 0.40, rh]] },
        { id: 'row4',  name: '一排四张', crop: true,
          slots: [[u.x, u.y + u.h * 0.18, qw, u.h * 0.64],
                  [u.x + qw + g, u.y, qw, u.h],
                  [u.x + 2 * (qw + g), u.y + u.h * 0.18, qw, u.h * 0.64],
                  [u.x + 3 * (qw + g), u.y, qw, u.h]] },
        { id: 'col4',  name: '一列四张', crop: true,
          slots: [[u.x, u.y, u.w, rh],
                  [u.x, u.y + rh + g, u.w, rh],
                  [u.x, u.y + 2 * (rh + g), u.w, rh],
                  [u.x, u.y + 3 * (rh + g), u.w, rh]] },
      ];
    }

    // 5 张以上：网格。列数按「格子尽量接近 4:3」来选
    return [gridTemplate(n, ratio)];
  }

  function gridTemplate(n, ratio) {
    const u = usable();
    const g = GAP;
    const target = 4 / 3;

    let best = { cols: 1, diff: Infinity };
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c);
      const cw = (u.w - (c - 1) * g) / c;
      const ch = (u.h - (r - 1) * g) / r;
      if (cw <= 0 || ch <= 0) continue;
      // 槽位在画布上的真实宽高比 = (cw/ch) * ratio
      const ar = (cw / ch) * ratio;
      const diff = Math.abs(ar - target);
      if (diff < best.diff) best = { cols: c, rows: r, diff };
    }

    const { cols, rows } = best;
    const cw = (u.w - (cols - 1) * g) / cols;
    const ch = (u.h - (rows - 1) * g) / rows;

    const slots = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      // 最后一行若不满，居中摆放
      const inRow = Math.min(cols, n - r * cols);
      const rowW = inRow * cw + (inRow - 1) * g;
      const x0 = u.x + (u.w - rowW) / 2;
      slots.push([x0 + c * (cw + g), u.y + r * (ch + g), cw, ch]);
    }
    return { id: 'grid' + n, name: `${cols}×${rows} 网格`, crop: true, slots };
  }

  /* ================================================================
     核心：把照片排进槽位
     ================================================================ */

  /** 槽位在画布上的真实宽高比 */
  const slotAR = (s, ratio) => (s[2] / s[3]) * ratio;

  /**
   * 大槽优先，用宽高比最接近的照片填 —— 尽量少裁切。
   * 返回 [{ slot, idx }]
   */
  function assign(slots, items, dims, ratio) {
    const order = slots
      .map((s, i) => ({ i, area: s[2] * s[3] }))
      .sort((a, b) => b.area - a.area);

    const free = items.map((_, i) => i);
    const out = [];

    for (const { i } of order) {
      const want = slotAR(slots[i], ratio);
      let pick = 0, bestDiff = Infinity;
      for (let k = 0; k < free.length; k++) {
        const it = items[free[k]];
        const d = dims[it.photo] || { w: 4, h: 3 };
        const have = d.w / d.h;
        // 用对数比，避免「过宽」和「过高」被不对称地惩罚
        const diff = Math.abs(Math.log(have / want));
        if (diff < bestDiff) { bestDiff = diff; pick = k; }
      }
      out.push({ slot: i, item: free[pick] });
      free.splice(pick, 1);
    }
    return out;
  }

  /** 单张照片：按自身比例算框，完全不裁切 */
  function singleBox(tpl, dims, ratio) {
    const u = usable();
    const d = dims || { w: 4, h: 3 };
    // 照片在归一化坐标下的宽高比
    const ar = (d.w / d.h) / ratio;

    const maxW = tpl.box[0] * u.w;
    const maxH = tpl.box[1] * u.h;
    let w = maxW, h = w / ar;
    if (h > maxH) { h = maxH; w = h * ar; }

    let x = u.x + (u.w - w) / 2;
    if (tpl.align === 'left') x = u.x + u.w * 0.02;

    return [x, u.y + (u.h - h) / 2, w, h];
  }

  /**
   * 主入口
   * @param {Array} items  当前页元素（只读取 photo/id，不改原数组）
   * @param {Object} dims  { [photoKey]: {w,h} }
   * @param {number} ratio 画布宽高比
   * @param {number} index 版式序号（超过范围会取模）
   * @returns {{items:Array, templateId:string, templateName:string, count:number, index:number}}
   */
  function layout(items, dims, ratio, index) {
    const n = items.length;
    if (!n) return { items: [], templateId: 'empty', templateName: '空', count: 0, index: 0 };

    const all = templatesFor(n, ratio);
    const idx = ((index % all.length) + all.length) % all.length;
    const tpl = all[idx];

    let result;

    if (n === 1 && !tpl.crop) {
      // 单张且不裁切：按照片自身比例算框
      const box = singleBox(tpl, dims[items[0].photo], ratio);
      result = [{ src: items[0], x: box[0], y: box[1], w: box[2], h: box[3], fit: 'contain' }];
    } else {
      const slots = tpl.slots;
      const pairs = assign(slots, items, dims, ratio);
      result = pairs.map(({ slot, item }) => {
        const s = slots[slot];
        return { src: items[item], x: s[0], y: s[1], w: s[2], h: s[3], fit: 'cover' };
      });
    }

    return {
      items: result.map(r => ({
        ...r.src,
        x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h),
        rot: 0,                 // 自动排版顺带把照片摆正
        fit: r.fit
      })),
      templateId: tpl.id,
      templateName: tpl.name,
      count: all.length,
      index: idx
    };
  }

  const round = v => Math.round(v * 1000) / 1000;

  const api = { layout, templatesFor, EDGE, GAP, usable };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AutoLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);
