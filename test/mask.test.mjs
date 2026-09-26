/* ================================================================
   蒙版引擎测试
   ----------------------------------------------------------------
   在 node 里跑，用一个最小的 canvas 桩件顶替 DOM。

   为什么不用真浏览器跑：这个测试要验的是**数学**（笔画坐标、
   覆盖率、反选、撤销后的状态），这些全在被测代码自己算的数值里，
   和渲染质量无关。桩件能跑得更快也更稳。

   真浏览器那边另外用 CDP 验「画出来对不对」——两边分工。
   ================================================================ */
import { strict as assert } from 'node:assert';

/* ---------------- 最小 canvas 桩件 ---------------- */
function makeCtx(canvas) {
  const px = new Float32Array(canvas.width * canvas.height);   // 灰度，1 = 白
  // tx/ty/sx/sy 是仿射变换。渐变/径向蒙版靠 translate+scale 把圆拉成椭圆，
  // 不实现这两个的话，径向蒙版在测试里根本画不出来。
  const st = { gco: 'source-over', alpha: 1, fill: '#fff', tx: 0, ty: 0, sx: 1, sy: 1 };
  const stack = [];

  const inBounds = (x, y) => x >= 0 && y >= 0 && x < canvas.width && y < canvas.height;

  /** fillStyle 在设备像素 (dx, dy) 处的透明度。
   *  渐变是在**填充坐标**里定义的，所以先把设备坐标反变换回填充坐标。 */
  function fillAlpha(f, dx, dy) {
    const x = (dx - st.tx) / st.sx, y = (dy - st.ty) / st.sy;
    if (f && f._linear) {
      const ax = f.x2 - f.x1, ay = f.y2 - f.y1;
      const len2 = ax * ax + ay * ay;
      const t = len2 < 1e-9 ? 1 : Math.min(1, Math.max(0, ((x - f.x1) * ax + (y - f.y1) * ay) / len2));
      return 1 - t;                        // stop 0 = 白，stop 1 = 透明
    }
    if (f && f._radial) {
      const r = Math.hypot(x - f.cx, y - f.cy);
      if (r <= f.r0) return 1;
      if (r >= f.r1) return 0;
      return 1 - (r - f.r0) / Math.max(1e-6, f.r1 - f.r0);
    }
    return 1;                              // 纯色
  }

  function stamp(cx, cy, r, hard) {
    const solid = r * (hard == null ? 0.5 : hard);
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(canvas.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(canvas.height - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d > r) continue;
        // 径向渐变：实心区 1，羽化区线性衰减
        let a = d <= solid ? 1 : 1 - (d - solid) / Math.max(1e-6, r - solid);
        a *= st.alpha;
        const i = y * canvas.width + x;
        if (st.gco === 'destination-out') px[i] = px[i] * (1 - a);
        else px[i] = Math.max(px[i], a);
      }
    }
  }

  return {
    _px: px,
    save() { stack.push(Object.assign({}, st)); },
    restore() { if (stack.length) Object.assign(st, stack.pop()); },
    translate(x, y) { st.tx += x * st.sx; st.ty += y * st.sy; },
    scale(sx, sy) { st.sx *= sx; st.sy *= sy; },
    set globalCompositeOperation(v) { st.gco = v; },
    get globalCompositeOperation() { return st.gco; },
    set globalAlpha(v) { st.alpha = v; },
    get globalAlpha() { return st.alpha; },
    set fillStyle(v) { st.fill = v; },
    get fillStyle() { return st.fill; },
    clearRect() { px.fill(0); },
    // 矩形在**填充坐标**里：先正向变换四个角取设备包围盒，
    // 再逐**设备**像素反变换采样。
    // ⚠️ 必须逐设备像素采样：scale 之后相邻两个用户整数行可能落在
    //    同一个设备行上，逐用户行采样会被 lighter 叠加 N 次，
    //    径向蒙版整块饱和 —— 和真实 canvas 的抗锯齿积分完全不是回事
    fillRect(x, y, w, h) {
      const a0 = Math.min(x * st.sx + st.tx, (x + w) * st.sx + st.tx);
      const a1 = Math.max(x * st.sx + st.tx, (x + w) * st.sx + st.tx);
      const b0 = Math.min(y * st.sy + st.ty, (y + h) * st.sy + st.ty);
      const b1 = Math.max(y * st.sy + st.ty, (y + h) * st.sy + st.ty);
      const x0 = Math.max(0, Math.floor(a0)), x1 = Math.min(canvas.width, Math.ceil(a1));
      const y0 = Math.max(0, Math.floor(b0)), y1 = Math.min(canvas.height, Math.ceil(b1));
      for (let py = y0; py < y1; py++) {
        for (let pxi = x0; pxi < x1; pxi++) {
          const a = st.alpha * fillAlpha(st.fill, pxi + 0.5, py + 0.5);
          const o = py * canvas.width + pxi;
          if (st.gco === 'destination-out') px[o] *= (1 - a);
          // ⚠️ lighter 是**加法**（min(1, dst+src)），不是 max ——
          // 写成 max 会让重复填充变成幂等，正好掩盖渐变累加的 bug
          else px[o] = Math.min(1, px[o] + a);
        }
      }
    },
    beginPath() { this._c = null; },
    arc(x, y, r) { this._c = { x, y, r }; },
    fill() {
      if (!this._c) return;
      // 桩件必须模拟「渐变的锚点」这件事：
      // 真实 canvas 里 createRadialGradient(x,y,...) 一旦建好就固定
      // 在画布坐标上，用它去盖别的位置的章，只有锚点附近会被画上。
      // 不模拟这一点的话，_paintSegment 那个"只画端点"的 bug
      // 在测试里会假装通过。
      const g = st.fill;
      if (g && g._grad) {
        const anchor = g._anchor;
        if (anchor) {
          const d = Math.hypot(this._c.x - anchor.x, this._c.y - anchor.y);
          if (d > this._c.r) return;   // 落在渐变半径之外 → 透明，不画
        }
      }
      const hard = g && g._grad ? 0.5 : 0.99;
      stamp(this._c.x, this._c.y, this._c.r, hard);
    },
    createRadialGradient(x, y, r0, x1, y1, r1) {
      // 原生签名有 6 个参数：锚点是 (x, y)，(x1, y1, r1) 是外圈
      // _grad/_anchor/_r1 给 fill() 的锚点判定用（羽化笔刷那条路径）；
      // _radial 给 fillRect 的逐像素渐变用（径向蒙版那条路径）
      return { _grad: true, _anchor: { x, y }, _r1: r1,
               _radial: true, cx: x, cy: y, r0, r1, addColorStop() {} };
    },
    createLinearGradient(x1, y1, x2, y2) {
      return { _linear: true, x1, y1, x2, y2, addColorStop() {} };
    },
    getImageData(x, y, w, h) {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const v = Math.round((px[j * canvas.width + i] || 0) * 255);
          const o = (j * w + i) * 4;
          d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255;
        }
      }
      return { data: d, width: w, height: h };
    },
    putImageData(img) {
      for (let i = 0; i < img.data.length; i += 4) {
        px[i / 4] = img.data[i] / 255;
      }
    },
    // drawImage 必须真的实现 —— 反选就是靠 destination-out + drawImage
    // 做的，桩成空函数的话反选永远"成功"但内容没变，
    // 测试会假通过。这是桩件最容易骗人的地方。
    drawImage(src, dx = 0, dy = 0, dw, dh) {
      const sp = src._ctx ? src._ctx._px : null;
      if (!sp) return;
      const sw = src.width, sh = src.height;
      const tw = dw == null ? sw : dw, th = dh == null ? sh : dh;
      for (let j = 0; j < th; j++) {
        for (let i = 0; i < tw; i++) {
          const sx = Math.min(sw - 1, Math.floor(i * sw / tw));
          const sy = Math.min(sh - 1, Math.floor(j * sh / th));
          const v = sp[sy * sw + sx];
          const x = dx + i, y = dy + j;
          if (!inBounds(x, y)) continue;
          const o = y * canvas.width + x;
          if (st.gco === 'destination-out') px[o] = px[o] * (1 - v * st.alpha);
          else px[o] = px[o] * (1 - st.alpha) + v * st.alpha;
        }
      }
    },
    fillText() {}
  };
}

/* ---------------- 最小 DOM 桩件 ---------------- */
global.document = {
  createElement(tag) {
    if (tag !== 'canvas') return {};
    const c = { width: 300, height: 150, _ctx: null };
    Object.defineProperty(c, 'getContext', {
      value: () => (c._ctx || (c._ctx = makeCtx(c)))
    });
    c.toDataURL = () => 'data:image/png;base64,stub';
    return c;
  }
};
global.window = global;
global.Image = class { set src(v) { this._s = v; } };

const { default: fs } = await import('node:fs');
const src = fs.readFileSync(new URL('../mask.js', import.meta.url), 'utf8');
// mask.js 是 IIFE 挂到 window 上，直接在全局跑一遍
new Function(src)();

const Mask = global.Mask;
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== 蒙版引擎 ===\n');

t('resize 建立位图，长边不超过 1024', () => {
  const m = new Mask();
  m.resize(4000, 3000);
  assert.equal(m.canvas.width, 1024);
  assert.equal(m.canvas.height, 768);
});

t('小图不放大（scale 上限为 1）', () => {
  const m = new Mask();
  m.resize(200, 150);
  assert.equal(m.canvas.width, 200);
});

t('新蒙版是空的', () => {
  const m = new Mask();
  m.resize(1000, 1000);
  assert.equal(m.isEmpty, true);
  assert.equal(m.coverage(), 0);
});

t('涂一笔后不再为空，覆盖率 > 0', () => {
  const m = new Mask();
  m.resize(1000, 1000);
  m.begin(0.5, 0.5);
  m.end();
  assert.equal(m.isEmpty, false);
  assert.ok(m.coverage() > 0, '覆盖率应该大于 0');
});

t('归一化坐标：同一位置在不同分辨率下覆盖率一致', () => {
  const a = new Mask(); a.resize(1000, 1000);
  const b = new Mask(); b.resize(2000, 2000);
  for (const m of [a, b]) { m.begin(0.5, 0.5); m.end(); }
  // 半径是归一化的，所以两边的相对覆盖率应该接近。
  // 允许 25% 误差：位图分辨率不同，边缘像素的舍入不一样。
  const ra = a.coverage(), rb = b.coverage();
  assert.ok(Math.abs(ra - rb) / Math.max(ra, rb) < 0.25,
    `覆盖率差太多: ${ra.toFixed(4)} vs ${rb.toFixed(4)}`);
});

t('extend 有最小步长限制（抖动不产生多余点）', () => {
  const m = new Mask();
  m.resize(1000, 1000);
  m.begin(0.5, 0.5);
  const moved1 = m.extend(0.5001, 0.5001);   // 远小于步长
  assert.equal(moved1, false, '距离太近不该加点');
  const moved2 = m.extend(0.6, 0.5);          // 远大于步长
  assert.equal(moved2, true, '距离够远应该加点');
  assert.equal(m._cur.points.length, 2);
  m.end();
});

t('点和点之间是连续覆盖，不是断开的', () => {
  const m = new Mask();
  m.resize(1000, 1000);
  m.begin(0.2, 0.5);
  m.extend(0.8, 0.5);
  m.end();
  // 取轨迹中点必须被覆盖
  const d = m.toTextureData().data;
  const mid = (Math.floor(500 * 1000 + 500)) * 4;
  assert.ok(d[mid] > 200, `中点应该被涂到，实际 R=${d[mid]}`);
});

t('长线整条都被涂上（回归：只有端点有印子）', () => {
  // 羽化渐变如果只按起点算一次，一条线上就只剩两个端点的圆点。
  // 这个 bug 曾经让「局部调整」看起来像蒙版没生效。
  const m = new Mask();
  m.resize(1000, 1000);
  m.hardness = 0.5;               // 故意用羽化笔刷，硬笔刷不走渐变路径
  m.begin(0.1, 0.5);
  m.extend(0.9, 0.5);
  m.end();
  const d = m.toTextureData().data;
  const W = m.canvas.width;
  const row = 500;
  for (const nx of [0.2, 0.35, 0.5, 0.65, 0.8]) {
    const v = d[(row * W + Math.round(nx * (W - 1))) * 4];
    assert.ok(v > 200, `x=${nx} 处应该被涂到，实际 R=${v}`);
  }
});

t('硬笔刷整条线也连续', () => {
  const m = new Mask();
  m.resize(1000, 1000);
  m.hardness = 1.0;
  m.begin(0.1, 0.5);
  m.extend(0.9, 0.5);
  m.end();
  const d = m.toTextureData().data;
  const W = m.canvas.width;
  for (const nx of [0.25, 0.5, 0.75]) {
    const v = d[(500 * W + Math.round(nx * (W - 1))) * 4];
    assert.ok(v > 200, `x=${nx} 处应该被涂到，实际 R=${v}`);
  }
});

t('撤销弹出最后一笔', () => {
  const m = new Mask();
  m.resize(1000, 1000);
  m.begin(0.3, 0.3); m.end();
  m.begin(0.7, 0.7); m.end();
  assert.equal(m.strokes.length, 2);
  assert.equal(m.undo(), true);
  assert.equal(m.strokes.length, 1);
  assert.equal(m.undo(), true);
  assert.equal(m.strokes.length, 0);
  assert.equal(m.undo(), false, '空的时候撤销应该返回 false');
});

t('撤销后画面确实少了那部分', () => {
  const m = new Mask();
  m.resize(1000, 1000);
  m.begin(0.5, 0.5); m.end();
  const full = m.coverage();
  m.begin(0.2, 0.2); m.end();
  const two = m.coverage();
  m.undo();
  const back = m.coverage();
  assert.ok(two > full, '两笔应该覆盖更多');
  assert.ok(Math.abs(back - full) < 0.005, `撤销后应回到一笔的状态: ${back} vs ${full}`);
});

t('擦除把选区抠掉', () => {
  const m = new Mask();
  m.resize(1000, 1000);
  m.begin(0.5, 0.5); m.end();
  const before = m.coverage();
  m.mode = 'erase';
  m.paint = null;
  m.begin(0.5, 0.5); m.end();
  const after = m.coverage();
  assert.ok(after < before, `擦除后应该变小: ${before} → ${after}`);
  assert.ok(after < 0.01, `正中间擦掉应该基本归零，实际 ${after}`);
});

t('clear 清空所有笔画和内容', () => {
  const m = new Mask();
  m.resize(1000, 1000);
  m.begin(0.5, 0.5); m.end();
  assert.equal(m.clear(), true);
  assert.equal(m.isEmpty, true);
  assert.equal(m.coverage(), 0);
});

t('反选：覆盖率变成 1 - 原覆盖率', () => {
  const m = new Mask();
  m.resize(400, 400);
  m.begin(0.5, 0.5); m.end();
  const before = m.coverage();
  m.invert();
  const after = m.coverage();
  assert.ok(Math.abs((before + after) - 1) < 0.05,
    `反选前后应互补: ${before.toFixed(3)} + ${after.toFixed(3)} = ${(before + after).toFixed(3)}`);
});

t('反选后中间变空、角落变实', () => {
  const m = new Mask();
  m.resize(400, 400);
  m.begin(0.5, 0.5); m.end();
  m.invert();
  const d = m.toTextureData().data;
  const W = 400;
  const center = d[(200 * W + 200) * 4];
  const corner = d[(5 * W + 5) * 4];
  assert.ok(center < 40, `中心应该是空的，实际 ${center}`);
  assert.ok(corner > 200, `角落应该是实的，实际 ${corner}`);
});

t('反选结果能继续被擦除（位图描边参与重绘）', () => {
  const m = new Mask();
  m.resize(400, 400);
  m.begin(0.5, 0.5); m.end();
  m.invert();
  const before = m.coverage();
  m.mode = 'erase';
  m.begin(0.05, 0.05); m.end();
  const after = m.coverage();
  assert.ok(after < before, `反选后擦除应该生效: ${before} → ${after}`);
});

t('超过 MAX_STROKES 丢最老的', () => {
  const m = new Mask();
  m.resize(200, 200);
  for (let i = 0; i < 210; i++) {
    m.begin(0.02 + i * 0.0001, 0.5);
    m.end();
  }
  assert.ok(m.strokes.length <= 200, `笔画数应该被限制，实际 ${m.strokes.length}`);
});

t('abort 放弃未完成的笔画', () => {
  const m = new Mask();
  m.resize(400, 400);
  m.begin(0.5, 0.5);
  assert.equal(m.isEmpty, false, '画到一半不算空');
  m.abort();
  assert.equal(m.isEmpty, true, 'abort 后应该回到空');
  assert.equal(m.strokes.length, 0);
});

t('没 resize 就画不会崩', () => {
  const m = new Mask();
  m.begin(0.5, 0.5);
  m.extend(0.6, 0.6);
  m.end();
  assert.equal(m.canvas, null);
  assert.equal(m.coverage(), 0);
});

t('toTextureData 返回 RGBA 且尺寸匹配', () => {
  const m = new Mask();
  m.resize(600, 400);
  m.begin(0.5, 0.5); m.end();
  const d = m.toTextureData();
  assert.equal(d.width, m.canvas.width);
  assert.equal(d.height, m.canvas.height);
  assert.equal(d.data.length, m.canvas.width * m.canvas.height * 4);
});

t('笔刷大小影响覆盖面积', () => {
  const small = new Mask(); small.resize(1000, 1000);
  small.radius = 0.02; small.begin(0.5, 0.5); small.end();
  const big = new Mask(); big.resize(1000, 1000);
  big.radius = 0.10; big.begin(0.5, 0.5); big.end();
  assert.ok(big.coverage() > small.coverage() * 3,
    `大笔刷应该覆盖明显更多: ${small.coverage().toFixed(4)} vs ${big.coverage().toFixed(4)}`);
});

/* ================================================================
   渐变 / 径向蒙版
   ----------------------------------------------------------------
   桩件已经补了 createLinearGradient / translate / scale，
   所以这里能验**几何**：渐变沿轴衰减、径向沿椭圆半径衰减。
   ================================================================ */

/** 取归一化坐标处的 R 通道（0~255）。
 *  归一化 → 设备的映射跟 mask.js 一致：x = nx*W，y = (1-ny)*H（Y 翻转） */
function at(m, nx, ny) {
  const W = m.canvas.width, H = m.canvas.height;
  const x = Math.min(W - 1, Math.max(0, Math.round(nx * W)));
  const y = Math.min(H - 1, Math.max(0, Math.round((1 - ny) * H)));
  return m.toTextureData().data[(y * W + x) * 4];
}

t('渐变：起点侧实、终点侧空', () => {
  const m = new Mask();
  m.resize(400, 400);
  m.begin(0.2, 0.5, 'gradient');
  m.extend(0.8, 0.5);
  m.end();
  assert.ok(at(m, 0.1, 0.5) > 200, `起点那一侧应该被选中，实际 ${at(m, 0.1, 0.5)}`);
  assert.ok(at(m, 0.9, 0.5) < 40, `终点那一侧应该是空的，实际 ${at(m, 0.9, 0.5)}`);
});

t('渐变：轴中点在半透明', () => {
  const m = new Mask();
  m.resize(400, 400);
  m.begin(0.2, 0.5, 'gradient');
  m.extend(0.8, 0.5);
  m.end();
  const mid = at(m, 0.5, 0.5);
  assert.ok(mid > 80 && mid < 180, `轴中点应该在半透明，实际 ${mid}`);
});

t('渐变：extend 替换终点而不是追加', () => {
  const m = new Mask();
  m.resize(400, 400);
  m.begin(0.2, 0.5, 'gradient');
  m.extend(0.4, 0.5);
  m.extend(0.6, 0.5);
  m.extend(0.8, 0.5);
  assert.equal(m._cur.points.length, 2);
  assert.deepEqual(m._cur.points[1], [0.8, 0.5]);
  m.end();
  assert.equal(m.strokes.length, 1);
});

t('径向：中心实、外半径之外空', () => {
  const m = new Mask();
  m.resize(400, 400);
  m.begin(0.5, 0.5, 'radial');
  m.extend(0.7, 0.5);          // 半径 = 0.2（归一化）
  m.end();
  assert.ok(at(m, 0.5, 0.5) > 200, `中心应该被选中，实际 ${at(m, 0.5, 0.5)}`);
  assert.ok(at(m, 0.75, 0.5) < 40, `外半径之外应该是空的，实际 ${at(m, 0.75, 0.5)}`);
});

t('径向：纯横向拖动也能画出可见椭圆（回归：塌成一条线）', () => {
  const m = new Mask();
  m.resize(400, 400);
  m.begin(0.5, 0.5, 'radial');
  m.extend(0.8, 0.5);          // 纵向分量恰好是 0
  m.end();
  assert.ok(m.strokes[0].points[1][1] >= 0.03,
    `纵向半径应该有一个最小值，实际 ${m.strokes[0].points[1][1]}`);
  // 中心列、离中心 6 像素的地方还得看得见
  assert.ok(at(m, 0.5, 0.5 + 6 / 400) > 100, '纵向不该塌成一条线');
});

t('渐变/径向只点不拖：不产生空笔画', () => {
  for (const kind of ['gradient', 'radial']) {
    const m = new Mask();
    m.resize(400, 400);
    m.begin(0.5, 0.5, kind);
    assert.equal(m.end(), false, `${kind} 没拖动就不该算一笔`);
    assert.equal(m.strokes.length, 0, `${kind} 空笔画不该进历史`);
    assert.equal(m.isEmpty, true, `${kind} 空笔画不该算有内容`);
  }
  const m = new Mask();
  m.resize(400, 400);
  m.begin(0.5, 0.5);           // 画笔：点按仍然是一笔
  assert.equal(m.end(), true, '画笔点按应该仍然是一笔');
  assert.equal(m.strokes.length, 1);
});

t('渐变：手抖级别的拖动不算一笔（回归：点一下就选中半张图）', () => {
  // 渐变之前没有死区：拖 1 像素也生成一次整画布填充。而 canvas 的线性
  // 渐变在端点之外是**夹逼**的（投影 t<0 全取 stop0，t>1 全取 stop1），
  // _paintGradient 的 fillRect 又铺满整张画布 —— 所以哪怕只拖 1 像素，
  // "起点侧"就是整整半个画面全被选中。十笔叠起来覆盖率冲到 90%+，
  // 表现是"点一下整张图全变红"，而且不报任何错。
  const m = new Mask();
  m.resize(400, 400);
  m.begin(0.5, 0.5, 'gradient');
  assert.equal(m.extend(0.505, 0.5), false, '死区内的拖动应该被拒');
  assert.equal(m.end(), false, '没拖出死区就不该算一笔');
  assert.equal(m.strokes.length, 0, '死区拖动不该进历史');
  assert.equal(m.isEmpty, true, '死区拖动不该算有内容');

  // 死区之外仍然正常画出半平面，不能把这个功能掐掉
  const m2 = new Mask();
  m2.resize(400, 400);
  m2.begin(0.5, 0.5, 'gradient');
  assert.equal(m2.extend(0.58, 0.5), true, '超过死区应该正常更新终点');
  assert.equal(m2.end(), true);
  assert.equal(m2.strokes.length, 1);
  assert.ok(m2.coverage() > 0.3, `拖出死区应该真选到一大片，实际 ${m2.coverage()}`);
});

t('径向可以擦除（destination-out 路径）', () => {
  const m = new Mask();
  m.resize(400, 400);
  m.begin(0.5, 0.5, 'radial');
  m.extend(0.75, 0.5);
  m.end();
  const before = at(m, 0.5, 0.5);
  assert.ok(before > 200, `前置：先画出一个选区，实际 ${before}`);
  m.mode = 'erase';
  m.begin(0.5, 0.5, 'radial');
  m.extend(0.75, 0.5);
  m.end();
  const after = at(m, 0.5, 0.5);
  assert.ok(after < before * 0.2,
    `同位置径向擦除应该把中心消掉: ${before} → ${after}`);
});

t('拖拽中多次 extend 不累加（回归：lighter 叠加把平滑过渡刷成硬边）', () => {
  // 上一笔已经渲染过一次（dirty=false）——这正是会让脏画布留下来的状态
  const m = new Mask();
  m.resize(400, 400);
  m.begin(0.2, 0.5, 'radial');
  m.extend(0.3, 0.5);
  m.end();
  m.coverage();

  m.begin(0.6, 0.5, 'radial');
  m.extend(0.66, 0.5);
  m.extend(0.7, 0.5);   // 同一笔内再拖一次
  m.end();

  // 参照：同样两笔，但按正确方式只渲染一次
  const ref = new Mask();
  ref.resize(400, 400);
  ref.begin(0.2, 0.5, 'radial'); ref.extend(0.3, 0.5); ref.end();
  ref.begin(0.6, 0.5, 'radial'); ref.extend(0.7, 0.5); ref.end();
  ref.render();

  const got = at(m, 0.65, 0.5);
  const want = at(ref, 0.65, 0.5);
  assert.ok(Math.abs(got - want) <= 4,
    `拖两下后中点应该是 ${want}，实际 ${got}`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
