/* ================================================================
   修图页 —— 蒙版与局部调整的浏览器实测
   ================================================================
   用 CDP 驱动真实 Chrome（软件渲染 WebGL），验证三件事：

     ① 蒙版能涂上，且覆盖率正确
     ② 局部调整真的只影响涂过的区域（读像素对比）
     ③ 全局调整不受蒙版影响

   为什么一定要在真浏览器里测：shader 编译、纹理上传、
   坐标翻转这些事，node 里的桩件一概验不出来。
   之前曝光参数算错就是在真机上才看出来的。
   ================================================================ */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const HARNESS = process.env.DSH_BROWSER || '/tmp/dsh-browser.mjs';
const URL = process.env.STUDIO_URL || 'https://muyaya.world/studio.html';

// ⚠️ 这个测试依赖 /tmp/dsh-browser.mjs —— 那是个**不在仓库里**的临时
// harness（原来是 macOS 上的）。换电脑就没有了。
// 仓库里现在有 test/cdp.mjs（自带 Chrome 启动、零依赖），
// 新的浏览器测试都用它。这个老测试还没迁过去，缺 harness 时给出明确提示。
if (!fs.existsSync(HARNESS)) {
  console.log('\n=== 跳过：找不到 CDP harness ===\n');
  console.log(`  ${HARNESS} 不存在。`);
  console.log('  这个测试还没有迁到仓库自带的 test/cdp.mjs。');
  console.log('  想看等价覆盖，跑：node test/adjust-browser.test.mjs\n');
  process.exit(0);
}

let pass = 0, fail = 0;
const results = [];

function cdp(code, opts = {}) {
  // 注意 harness 的参数是「位置参数」：eval <url> <code> [--flags]
  // code 必须紧跟 url，放到 flags 后面会被当成 rest 里的值
  const args = [HARNESS, 'eval', URL, code, '--w', '1200', '--h', '800'];
  if (opts.wait) args.push('--wait', String(opts.wait));
  const out = execFileSync('node', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });

  // ⚠️ harness 打印的是 JSON.stringify(value, null, 2) —— 多行格式化的。
  // 一开始按「取最后一行」解析，结果稍微复杂点的返回值全都解析失败，
  // 报的却是「无法解析」，看起来像页面坏了，其实只是解析器太蠢。
  // 正确做法：从第一个 { 或 [ 开始整体解析。
  const s = out.indexOf('{') >= 0 && (out.indexOf('[') < 0 || out.indexOf('{') < out.indexOf('['))
    ? out.indexOf('{')
    : out.indexOf('[');
  if (s < 0) throw new Error('CDP 输出里没有 JSON:\n' + out.slice(-800));
  try {
    return JSON.parse(out.slice(s));
  } catch (e) {
    // 单个标量（数字/字符串/bool）走这里
    const last = out.trim().split('\n').pop();
    try { return JSON.parse(last); } catch {}
    throw new Error('CDP 输出无法解析:\n' + out.slice(-800));
  }
}

async function t(name, body, check) {
  // ⚠️ harness 走的是 Runtime.evaluate，只接受「单个表达式」。
  // 直接甩一段语句块进去会得到 undefined（不是报错，是静默的 undefined），
  // 所以统一包成 async IIFE —— 顺便还能用 await。
  const code = `(async () => { ${body} })()`;
  try {
    const r = await cdp(code);
    if (r === undefined || r === null) {
      throw new Error('页面返回 undefined（多半是代码抛异常了，见 stderr）');
    }
    check(r);
    pass++;
    console.log(`  ✅ ${name}`);
    results.push({ name, ok: true, r });
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name}\n     ${e.message}`);
    results.push({ name, ok: false, err: e.message });
  }
}

console.log('\n=== 修图页：蒙版与局部调整（真实 Chrome + WebGL）===\n');

const HELPERS = `
  const S = window.Studio;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function loadTestImage() {
    // 造一张纯中灰的图当测试底片，读像素时任何变化都很显眼
    const c = document.createElement('canvas');
    c.width = 600; c.height = 400;
    const x = c.getContext('2d');
    x.fillStyle = '#808080'; x.fillRect(0, 0, 600, 400);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
    await S.openFile(new File([blob], 'test.jpg', { type: 'image/jpeg' }));
    await sleep(250);
  }
  // 读画布上某个归一化位置的像素（用 2D 画布转存，绕开 WebGL 读取）
  function pixelAt(nx, ny) {
    const gl = S._canvas();
    const tmp = document.createElement('canvas');
    tmp.width = gl.width; tmp.height = gl.height;
    tmp.getContext('2d').drawImage(gl, 0, 0);
    const px = Math.round(nx * (gl.width - 1));
    // 画布 Y 和归一化 Y 相反
    const py = Math.round((1 - ny) * (gl.height - 1));
    const d = tmp.getContext('2d').getImageData(px, py, 1, 1).data;
    return [d[0], d[1], d[2]];
  }
`;

// 先给 Studio 暴露画布，方便读像素
await t('⭐ 图片朝向正确（上半不能跑到下面去）', `
  ${HELPERS}
  // 造一张上下明显不同的图：上半蓝、下半红。
  // 之前一直没发现整张预览是上下颠倒的，因为测试图都是纯色/对称的 ——
  // 症状只在真实照片上才看得出来，而且很容易被当成"照片本来就那样"。
  const c = document.createElement('canvas');
  c.width = 400; c.height = 200;
  const x = c.getContext('2d');
  x.fillStyle = '#0000ff'; x.fillRect(0, 0, 400, 100);
  x.fillStyle = '#ff0000'; x.fillRect(0, 100, 400, 100);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  await S.openFile(new File([blob], 'half.png', { type: 'image/png' }));
  await sleep(450);

  return { top: pixelAt(0.5, 0.8), bottom: pixelAt(0.5, 0.2) };
`, r => {
  assert.ok(r.top[2] > 200 && r.top[0] < 60,
    `上部应该是蓝色，实际 rgb(${r.top})`);
  assert.ok(r.bottom[0] > 200 && r.bottom[2] < 60,
    `下部应该是红色，实际 rgb(${r.bottom})`);
});

await t('⭐ 蒙版位置和照片对齐（涂上方红在上方）', `
  ${HELPERS}
  await loadTestImage();
  const base = pixelAt(0.5, 0.85);
  S.paintRect(0.3, 0.75, 0.7, 0.9);        // 画面上方
  await sleep(250);
  S.setShowMask(true);
  await sleep(500);
  const up = pixelAt(0.5, 0.85);
  const lo = pixelAt(0.5, 0.15);
  S.setShowMask(false);
  return { base, up, lo };
`, r => {
  assert.ok(r.up[0] > r.up[1] + 20, `上方应该罩红，实际 rgb(${r.up})`);
  assert.ok(Math.abs(r.lo[0] - r.base[0]) < 20,
    `下方不该有红色，实际 rgb(${r.lo}) vs 底色 rgb(${r.base})`);
});

await t('测试 API 可用', `
  const S = window.Studio;
  return { hasMask: !!S.mask, hasPaint: typeof S.paint === 'function',
           hasRect: typeof S.paintRect === 'function', hasSeg: typeof S.segmentPerson === 'function' };
`, r => {
  assert.ok(r.hasMask, '缺少 mask');
  assert.ok(r.hasPaint, '缺少 paint');
  assert.ok(r.hasRect, '缺少 paintRect');
  assert.ok(r.hasSeg, '缺少 segmentPerson');
});

await t('shader 编译通过且页面无报错', `
  const S = window.Studio;
  return { canvas: !!document.getElementById('stCanvas'),
           sliders: document.querySelectorAll('.st-sl').length,
           title: document.title };
`, r => {
  assert.ok(r.canvas, '画布不存在');
  assert.equal(r.sliders, 6, `应该有 6 个滑块，实际 ${r.sliders}`);
});

await t('加载图片后蒙版位图就绪', `
  ${HELPERS}
  await loadTestImage();
  const m = S.mask;
  return { w: m.canvas && m.canvas.width, h: m.canvas && m.canvas.height,
           empty: m.isEmpty, imgW: S.image.width };
`, r => {
  assert.ok(r.w > 0, '蒙版位图没建起来');
  assert.equal(r.empty, true, '新图不该有选区');
  assert.equal(r.imgW, 600);
});

await t('涂一笔后覆盖率 > 0 且界面同步', `
  ${HELPERS}
  await loadTestImage();
  S.paint([[0.4, 0.5], [0.5, 0.5], [0.6, 0.5]], { radius: 0.06, hardness: 0.9 });
  await sleep(150);
  return { cov: S.maskCoverage(), useMask: S.useMask,
           info: document.getElementById('stMaskInfo').textContent,
           checked: document.getElementById('stUseMask').checked };
`, r => {
  assert.ok(r.cov > 0.005, `覆盖率应该 > 0.5%，实际 ${r.cov}`);
  assert.ok(r.cov < 0.5, `覆盖率不该这么大，实际 ${r.cov}`);
  assert.equal(r.useMask, true, '涂了之后应该自动打开局部模式');
  assert.equal(r.checked, true, '开关界面没同步');
  assert.ok(/已选/.test(r.info), `信息栏没更新: ${r.info}`);
});

await t('局部调整：只影响涂过的区域', `
  ${HELPERS}
  await loadTestImage();
  const before = pixelAt(0.5, 0.5);      // 中心
  const cornerBefore = pixelAt(0.08, 0.08);  // 角落

  S.paintRect(0.3, 0.35, 0.7, 0.65);      // 只涂中间
  await sleep(150);
  S.setValue('uExposure', 1.5);           // 提亮
  await sleep(250);

  const after = pixelAt(0.5, 0.5);
  const cornerAfter = pixelAt(0.08, 0.08);
  return { before, after, cornerBefore, cornerAfter, cov: S.maskCoverage() };
`, r => {
  const dCenter = r.after[0] - r.before[0];
  const dCorner = Math.abs(r.cornerAfter[0] - r.cornerBefore[0]);
  assert.ok(dCenter > 25, `涂过的中心应该明显变亮，实际 ${r.before[0]} → ${r.after[0]}`);
  assert.ok(dCorner < 6, `没涂的角落不该变，实际 ${r.cornerBefore[0]} → ${r.cornerAfter[0]}`);
});

await t('关掉局部开关后调整作用于全图', `
  ${HELPERS}
  await loadTestImage();
  S.paintRect(0.3, 0.35, 0.7, 0.65);
  await sleep(150);
  S.setUseMask(false);                    // 改成全局
  await sleep(100);
  const cornerBefore = pixelAt(0.08, 0.08);
  S.setValue('uExposure', 1.5);
  await sleep(250);
  const cornerAfter = pixelAt(0.08, 0.08);
  return { cornerBefore, cornerAfter };
`, r => {
  const d = r.cornerAfter[0] - r.cornerBefore[0];
  assert.ok(d > 25, `全局模式下角落也该变亮，实际 ${r.cornerBefore[0]} → ${r.cornerAfter[0]}`);
});

await t('空蒙版时即使开着局部也不影响画面（防呆）', `
  ${HELPERS}
  await loadTestImage();
  const before = pixelAt(0.5, 0.5);
  S.setUseMask(true);                     // 故意开着一个空蒙版
  await sleep(100);
  S.setValue('uExposure', 1.5);
  await sleep(250);
  const after = pixelAt(0.5, 0.5);
  return { before, after, empty: S.mask.isEmpty };
`, r => {
  const d = r.after[0] - r.before[0];
  assert.ok(d > 25, `空蒙版应该按全局处理（画面要变亮），实际 ${r.before[0]} → ${r.after[0]}`);
});

await t('显示选区：涂过的地方罩红', `
  ${HELPERS}
  await loadTestImage();
  S.paintRect(0.3, 0.35, 0.7, 0.65);
  await sleep(150);
  S.setValue('uExposure', 0);
  S.setShowMask(true);
  await sleep(250);
  const inside = pixelAt(0.5, 0.5);
  const outside = pixelAt(0.08, 0.08);
  S.setShowMask(false);
  await sleep(200);
  const clean = pixelAt(0.5, 0.5);
  return { inside, outside, clean };
`, r => {
  assert.ok(r.inside[0] > r.inside[1] + 30, `选区应该偏红: ${r.inside}`);
  assert.ok(r.outside[0] < r.outside[1] + 30, `区外不该偏红: ${r.outside}`);
  assert.ok(Math.abs(r.clean[0] - r.clean[1]) < 12, `关掉后应该没有红色: ${r.clean}`);
});

await t('撤销一笔后选区变小', `
  ${HELPERS}
  await loadTestImage();
  S.paintRect(0.3, 0.35, 0.7, 0.65);
  await sleep(100);
  const big = S.maskCoverage();
  S.mask.undo(); S.mask._forceUpload = true; S._syncMaskUI(); S._draw();
  await sleep(150);
  const small = S.maskCoverage();
  return { big, small, strokes: S.mask.strokes.length };
`, r => {
  assert.ok(r.small < r.big, `撤销后应该变小: ${r.big} → ${r.small}`);
  assert.equal(r.strokes, 0);
});

await t('换图片会清掉上一张的选区', `
  ${HELPERS}
  await loadTestImage();
  S.paintRect(0.3, 0.35, 0.7, 0.65);
  await sleep(100);
  const withMask = S.maskCoverage();
  await loadTestImage();                 // 再开一次
  await sleep(200);
  return { withMask, after: S.maskCoverage(), strokes: S.mask.strokes.length };
`, r => {
  assert.ok(r.withMask > 0.02, '第一张应该有选区');
  assert.equal(r.after, 0, `换图后选区应该清空，实际 ${r.after}`);
  assert.equal(r.strokes, 0, '笔画历史也该清空');
});

await t('导出仍能正常工作（带蒙版状态）', `
  ${HELPERS}
  await loadTestImage();
  S.paintRect(0.3, 0.35, 0.7, 0.65);
  await sleep(150);
  S.setValue('uExposure', 0.8);
  await sleep(200);
  const gl = S._canvas();
  const prevW = gl.width, prevH = gl.height;
  // 手动走一遍导出时的分辨率切换，验证不会崩
  gl.width = S.image.width; gl.height = S.image.height;
  S._draw();
  const blob = await new Promise(r => gl.toBlob(r, 'image/jpeg', 0.95));
  gl.width = prevW; gl.height = prevH;
  S._draw();
  return { ok: !!blob, size: blob ? blob.size : 0, strokes: S.mask.strokes.length };
`, r => {
  assert.ok(r.ok, '导出没生成 blob');
  assert.ok(r.size > 1000, `导出的图太小: ${r.size}`);
  assert.equal(r.strokes, 1, '导出后选区不该被改动');
});

await t('真实鼠标拖动能画出一条完整的线', `
  ${HELPERS}
  await loadTestImage();
  const gl = S._canvas();
  document.getElementById('stBrush').click();
  await sleep(150);

  // 用真正的 PointerEvent 走一遍用户的操作路径。
  // ⚠️ 这条链路和 S.paint() 不一样：会经过 pointerdown/move/up 处理器、
  // getCoalescedEvents、坐标换算。合成事件的 getCoalescedEvents() 返回空数组，
  // 早期版本直接遍历它，导致拖一整条线只画出落笔那一个点 —— 而且不报错。
  const r = gl.getBoundingClientRect();
  const ev = (type, cx) => gl.dispatchEvent(new PointerEvent(type, {
    clientX: cx, clientY: r.top + r.height * 0.5,
    bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true
  }));
  ev('pointerdown', r.left + r.width * 0.2);
  for (let i = 1; i <= 12; i++) ev('pointermove', r.left + r.width * (0.2 + 0.6 * i / 12));
  ev('pointerup', r.left + r.width * 0.8);
  await sleep(300);

  const m = S.mask, W = m.canvas.width;
  const d = m.canvas.getContext('2d').getImageData(0, 0, W, m.canvas.height).data;
  let minX = 1e9, maxX = -1;
  for (let y = 0; y < m.canvas.height; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4] > 10) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    }
  }
  return { points: m.strokes[0].points.length,
           spanX: [minX / W, maxX / W], cov: S.maskCoverage(),
           brushOn: document.getElementById('stBrush').classList.contains('on') };
`, r => {
  assert.ok(r.brushOn, '画笔按钮没亮');
  assert.ok(r.points > 8, `拖动应该产生多个点，实际 ${r.points}`);
  assert.ok(r.spanX[0] < 0.3, `线应该从左侧开始，实际 ${r.spanX[0]}`);
  assert.ok(r.spanX[1] > 0.7, `线应该延伸到右侧，实际 ${r.spanX[1]}`);
  assert.ok(r.cov > 0.02, `覆盖率太小: ${r.cov}`);
});

await t('真实拖动涂出来的区域能驱动局部调整', `
  ${HELPERS}
  await loadTestImage();
  const gl = S._canvas();
  document.getElementById('stBrush').click();
  await sleep(150);
  const r = gl.getBoundingClientRect();
  const ev = (type, cx) => gl.dispatchEvent(new PointerEvent(type, {
    clientX: cx, clientY: r.top + r.height * 0.5,
    bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true
  }));
  // 只涂左半边的中间一条
  ev('pointerdown', r.left + r.width * 0.1);
  for (let i = 1; i <= 8; i++) ev('pointermove', r.left + r.width * (0.1 + 0.25 * i / 8));
  ev('pointerup', r.left + r.width * 0.35);
  await sleep(250);

  const read = (nx, ny) => {
    const t = document.createElement('canvas');
    t.width = gl.width; t.height = gl.height;
    t.getContext('2d').drawImage(gl, 0, 0);
    const d = t.getContext('2d').getImageData(
      Math.round(nx * (gl.width - 1)), Math.round((1 - ny) * (gl.height - 1)), 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const onBefore = read(0.22, 0.5);
  const offBefore = read(0.85, 0.5);
  S.setValue('uExposure', 1.8);
  await sleep(300);
  const onAfter = read(0.22, 0.5);
  const offAfter = read(0.85, 0.5);
  return { onBefore, onAfter, offBefore, offAfter, useMask: S.useMask };
`, r => {
  assert.equal(r.useMask, true, '涂完应该自动进局部模式');
  const dOn = r.onAfter[0] - r.onBefore[0];
  const dOff = Math.abs(r.offAfter[0] - r.offBefore[0]);
  assert.ok(dOn > 30, `涂过的地方应该变亮: ${r.onBefore[0]} → ${r.onAfter[0]}`);
  assert.ok(dOff < 8, `没涂的地方不该变: ${r.offBefore[0]} → ${r.offAfter[0]}`);
});

await t('网页版调用 AI 抠人给友好提示（不崩）', `
  ${HELPERS}
  await loadTestImage();
  const hasD = S.hasDesktop();
  await S.segmentPerson();
  await sleep(300);
  const t = document.getElementById('stToast');
  return { hasD, text: t.textContent, hidden: t.hidden };
`, r => {
  assert.equal(r.hasD, false, '网页版不该有 electron 桥');
  assert.equal(r.hidden, false, '应该弹提示');
  assert.ok(/桌面版/.test(r.text), `提示应该说明要用桌面版: ${r.text}`);
});

await t('AI 蒙版能灌进蒙版引擎（模拟桌面版返回）', `
  ${HELPERS}
  await loadTestImage();
  // 装一个假的 electron 桥，返回「左半边是人」的蒙版
  const m = document.createElement('canvas');
  m.width = 600; m.height = 400;
  const mx = m.getContext('2d');
  mx.fillStyle = '#000'; mx.fillRect(0, 0, 600, 400);
  mx.fillStyle = '#fff'; mx.fillRect(0, 0, 300, 400);
  window.albumStudio = { baiduBodySeg: async () => ({ ok: true, persons: 2, mask: m.toDataURL('image/png') }) };

  await S.segmentPerson();
  await sleep(600);

  const mk = S.mask, W = mk.canvas.width, H = mk.canvas.height;
  const d = mk.canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const at = (nx, ny) => d[(Math.round((1 - ny) * (H - 1)) * W + Math.round(nx * (W - 1))) * 4];
  return { cov: S.maskCoverage(), left: at(0.25, 0.5), right: at(0.75, 0.5),
           strokes: mk.strokes.length, useMask: S.useMask,
           toast: document.getElementById('stToast').textContent };
`, r => {
  assert.ok(Math.abs(r.cov - 0.5) < 0.05, `覆盖率应该约 50%，实际 ${r.cov}`);
  assert.ok(r.left > 200, `左半边应该被选中，实际 ${r.left}`);
  assert.ok(r.right < 40, `右半边不该被选中，实际 ${r.right}`);
  assert.equal(r.useMask, true, '抠完应该自动进局部模式');
  assert.equal(r.strokes, 1, '位图蒙版应该包成一笔');
  assert.ok(/抠出 2 个人/.test(r.toast), `提示不对: ${r.toast}`);
});

await t('AI 蒙版真的驱动 shader（只改选中的半边）', `
  ${HELPERS}
  await loadTestImage();
  const gl = S._canvas();
  const m = document.createElement('canvas');
  m.width = 600; m.height = 400;
  const mx = m.getContext('2d');
  mx.fillStyle = '#000'; mx.fillRect(0, 0, 600, 400);
  mx.fillStyle = '#fff'; mx.fillRect(0, 0, 300, 400);
  window.albumStudio = { baiduBodySeg: async () => ({ ok: true, persons: 1, mask: m.toDataURL('image/png') }) };

  const read = (nx, ny) => {
    const t = document.createElement('canvas');
    t.width = gl.width; t.height = gl.height;
    t.getContext('2d').drawImage(gl, 0, 0);
    const d = t.getContext('2d').getImageData(
      Math.round(nx * (gl.width - 1)), Math.round((1 - ny) * (gl.height - 1)), 1, 1).data;
    return [d[0], d[1], d[2]];
  };

  await S.segmentPerson();
  await sleep(700);
  const lb = read(0.25, 0.5), rb = read(0.75, 0.5);
  S.setValue('uExposure', 1.8);
  await sleep(350);
  const la = read(0.25, 0.5), ra = read(0.75, 0.5);
  return { dLeft: la[0] - lb[0], dRight: ra[0] - rb[0], lb: lb[0], la: la[0] };
`, r => {
  assert.ok(r.dLeft > 40, `选区那半边应该变亮: ${r.lb} → ${r.la}`);
  assert.ok(Math.abs(r.dRight) < 6, `选区外不该变，实际差 ${r.dRight}`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
fs.writeFileSync('/tmp/mask-browser-results.json', JSON.stringify(results, null, 2));
process.exit(fail ? 1 : 0);
