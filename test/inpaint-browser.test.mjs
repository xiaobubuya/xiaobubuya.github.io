/* ================================================================
   去物 —— 浏览器实测
   ----------------------------------------------------------------
   去物这条链路最长，跨的东西最多：

     画笔蒙版 → 算 bbox → 上传换公网 URL → IPC → 火山 → 下载 → 合成回画布

   任何一环错了都是「点了没反应」或者「改了不该改的地方」。
   所以这里把上传和 IPC 都换成假的（不花钱、不依赖网络），
   但**我们自己写的那部分逻辑是真的在跑**：蒙版统计、坐标换算、
   提示词组装、结果合成。

   最该守住的一条：AI 返回的是它重画过的整张图，
   但我们**只能接受选区那一块** —— 否则它会顺手把人脸也"美化"一遍。
   这个在浏览器测试里是能验的（读选区外像素有没有被改）。
   ================================================================ */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const HARNESS = '/tmp/dsh-browser.mjs';
const URL = process.env.STUDIO_URL || 'https://muyaya.world/studio.html';

let pass = 0, fail = 0;
const results = [];

function cdp(code) {
  const args = [HARNESS, 'eval', URL, code, '--w', '1200', '--h', '800'];
  const out = execFileSync('node', args, {
    encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024
  });
  // harness 打印的是 JSON.stringify(value, null, 2)，整体解析
  const s = out.indexOf('{') >= 0 && (out.indexOf('[') < 0 || out.indexOf('{') < out.indexOf('['))
    ? out.indexOf('{') : out.indexOf('[');
  if (s < 0) throw new Error('CDP 输出里没有 JSON:\n' + out.slice(-800));
  try { return JSON.parse(out.slice(s)); }
  catch {
    const last = out.trim().split('\n').pop();
    try { return JSON.parse(last); } catch {}
    throw new Error('CDP 输出无法解析:\n' + out.slice(-800));
  }
}

async function t(name, body, check) {
  const code = `(async () => { ${body} })()`;
  try {
    const r = await cdp(code);
    if (r === undefined || r === null) throw new Error('页面返回 undefined（多半抛异常了）');
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

/** 公共前置：造图 + 装假的 fetch 和 electron 桥 */
const SETUP = `
  const S = window.Studio;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function loadGray() {
    const c = document.createElement('canvas');
    c.width = 600; c.height = 400;
    const x = c.getContext('2d');
    x.fillStyle = '#808080'; x.fillRect(0, 0, 600, 400);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
    await S.openFile(new File([blob], 'test.jpg', { type: 'image/jpeg' }));
    await sleep(350);
  }
  function pixelAt(nx, ny) {
    const gl = S._canvas();
    const t = document.createElement('canvas');
    t.width = gl.width; t.height = gl.height;
    t.getContext('2d').drawImage(gl, 0, 0);
    const d = t.getContext('2d').getImageData(
      Math.round(nx * (gl.width - 1)), Math.round((1 - ny) * (gl.height - 1)), 1, 1).data;
    return [d[0], d[1], d[2]];
  }
  /** 装假的网络和 IPC。返回记录容器，用来断言我们发了什么 */
  function mockAI({ resultColor = '#c8c8c8', fail = null } = {}) {
    const log = { fetch: [], inpaint: null, deleted: [] };
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      log.fetch.push({ url: u, method: opts.method || 'GET',
                       ct: opts.headers && opts.headers['Content-Type'],
                       bytes: opts.body && opts.body.size });
      if (u.endsWith('/api/tmp') && (opts.method || 'GET') === 'POST') {
        return new Response(JSON.stringify({
          token: 'a'.repeat(32),
          publicUrl: 'https://api.muyaya.world/api/tmp/' + 'a'.repeat(32)
        }), { status: 200 });
      }
      if ((opts.method) === 'DELETE') { log.deleted.push(u); }
      if (fail === 'upload' && (opts.method) === 'PUT') {
        return new Response(JSON.stringify({ error: 'boom', message: '上传炸了' }), { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    window.albumStudio = {
      volcInpaint: async o => {
        log.inpaint = o;
        if (fail === 'inpaint') return { ok: false, error: '生成失败：额度用完了' };
        const m = document.createElement('canvas');
        m.width = 600; m.height = 400;
        const mc = m.getContext('2d');
        mc.fillStyle = resultColor; mc.fillRect(0, 0, 600, 400);
        return { ok: true, image: m.toDataURL('image/png'), totalMs: 17500, taskId: '999' };
      },
      onInpaintProgress: () => () => {}
    };
    return log;
  }
  /** 走 removeObject，并自动把弹层里的输入框填上 */
  async function runRemove(intentText) {
    setTimeout(() => {
      const inp = document.getElementById('stAskInput');
      if (inp) {
        inp.value = intentText;
        document.querySelector('[data-act=ok]').click();
      }
    }, 250);
    await S.removeObject();
    await sleep(800);
  }
`;

console.log('\n=== 去物：完整链路（真实逻辑 + 假网络）===\n');

await t('选区包围盒和覆盖率算得对', `
  ${SETUP}
  await loadGray();
  S.paintRect(0.3, 0.35, 0.7, 0.65);
  await sleep(200);
  const s = S.maskStats();
  return { bbox: s.bbox, coverage: s.coverage };
`, r => {
  // paintRect(0.3,0.35,0.7,0.65) + 笔刷半径 → bbox 稍大一点
  assert.ok(r.bbox.x0 > 0.24 && r.bbox.x0 < 0.31, `x0 不对: ${r.bbox.x0}`);
  assert.ok(r.bbox.x1 > 0.69 && r.bbox.x1 < 0.76, `x1 不对: ${r.bbox.x1}`);
  assert.ok(r.coverage > 0.05 && r.coverage < 0.35, `覆盖率不对: ${r.coverage}`);
});

await t('⭐ 真实鼠标涂画布上部 → bbox 报"上方"（Y 轴不能翻两次）', `
  ${SETUP}
  await loadGray();
  const gl = S._canvas();
  document.getElementById('stBrush').click();
  await sleep(150);
  const r = gl.getBoundingClientRect();

  // 在**画布上部**用真实鼠标涂一笔（屏幕 y 小 = 画面上方）
  const sy = r.top + r.height * 0.2;
  const ev = (type, cx) => gl.dispatchEvent(new PointerEvent(type, {
    clientX: cx, clientY: sy, bubbles: true, pointerId: 1,
    pointerType: 'mouse', isPrimary: true
  }));
  ev('pointerdown', r.left + r.width * 0.3);
  for (let i = 1; i <= 10; i++) ev('pointermove', r.left + r.width * (0.3 + 0.4 * i / 10));
  ev('pointerup', r.left + r.width * 0.7);
  await sleep(300);

  const b = S.maskStats().bbox;
  return { y0: b.y0, y1: b.y1 };
`, r => {
  // 画面上方 → bbox 的 y 应该大（y 大 = 上）。
  // 这里错了的话 AI 会去改相反的位置，而且看起来"就是不对劲"。
  assert.ok(r.y1 > 0.7, `涂在上方，y1 应该接近 1，实际 ${r.y1}`);
  assert.ok(r.y0 > 0.5, `涂在上方，y0 应该 > 0.5，实际 ${r.y0}`);
});

await t('⭐ 真实鼠标涂画布下部 → bbox 报"下方"', `
  ${SETUP}
  await loadGray();
  const gl = S._canvas();
  document.getElementById('stBrush').click();
  await sleep(150);
  const r = gl.getBoundingClientRect();
  const sy = r.top + r.height * 0.8;      // 画布下部
  const ev = (type, cx) => gl.dispatchEvent(new PointerEvent(type, {
    clientX: cx, clientY: sy, bubbles: true, pointerId: 1,
    pointerType: 'mouse', isPrimary: true
  }));
  ev('pointerdown', r.left + r.width * 0.3);
  for (let i = 1; i <= 10; i++) ev('pointermove', r.left + r.width * (0.3 + 0.4 * i / 10));
  ev('pointerup', r.left + r.width * 0.7);
  await sleep(300);
  const b = S.maskStats().bbox;
  return { y0: b.y0, y1: b.y1 };
`, r => {
  assert.ok(r.y0 < 0.3, `涂在下方，y0 应该接近 0，实际 ${r.y0}`);
  assert.ok(r.y1 < 0.5, `涂在下方，y1 应该 < 0.5，实际 ${r.y1}`);
});

await t('上传：先申请通行证再传 JPEG', `
  ${SETUP}
  await loadGray();
  const log = mockAI();
  const blob = await S.imageBlob();
  const up = await S.uploadForAI(blob);
  return { log, upUrl: up.url, blobSize: blob.size };
`, r => {
  assert.equal(r.log.fetch.length, 2, `应该发 2 个请求，实际 ${r.log.fetch.length}`);
  assert.ok(/\/api\/tmp$/.test(r.log.fetch[0].url), '第一个请求应该是申请通行证');
  assert.equal(r.log.fetch[0].method, 'POST');
  assert.ok(/\/api\/tmp\/[a-f0-9]{32}$/.test(r.log.fetch[1].url), '第二个请求应该带 token');
  assert.equal(r.log.fetch[1].method, 'PUT');
  assert.equal(r.log.fetch[1].ct, 'image/jpeg', '必须声明 image/jpeg（火山只吃 JPEG/PNG）');
  assert.ok(r.log.fetch[1].bytes > 1000, `应该真的传了字节，实际 ${r.log.fetch[1].bytes}`);
  assert.ok(/^https:\/\//.test(r.upUrl), '返回的必须是公网 URL');
});

await t('上传失败会清理通行证（不留垃圾）', `
  ${SETUP}
  await loadGray();
  const log = mockAI({ fail: 'upload' });
  const blob = await S.imageBlob();
  let err = null;
  try { await S.uploadForAI(blob); } catch (e) { err = e.message; }
  return { err, deleted: log.deleted };
`, r => {
  assert.ok(r.err, '上传失败应该抛错');
  assert.ok(r.deleted.length >= 1, '失败时应该把通行证删掉');
});

await t('完整流程：意图、bbox、URL 都传到位', `
  ${SETUP}
  await loadGray();
  const log = mockAI();
  S.paintRect(0.3, 0.35, 0.7, 0.65);
  await sleep(200);
  await runRemove('背景里的路人');
  return { inpaint: log.inpaint };
`, r => {
  assert.ok(r.inpaint, 'IPC 没被调用');
  assert.equal(r.inpaint.intent, '背景里的路人', '用户意图没传过去');
  assert.ok(r.inpaint.bbox && r.inpaint.bbox.x0 > 0.2, 'bbox 没传过去');
  assert.ok(r.inpaint.coverage > 0.05, 'coverage 没传过去');
  assert.ok(/^https:\/\/api\.muyaya\.world\/api\/tmp\//.test(r.inpaint.imageUrl),
    `应该传公网 URL，实际 ${r.inpaint.imageUrl}`);
});

await t('⭐ 只替换选区，选区外一点都不能动', `
  ${SETUP}
  await loadGray();
  mockAI({ resultColor: '#c8c8c8' });     // AI 返回整张 200 灰
  S.paintRect(0.3, 0.35, 0.7, 0.65);
  await sleep(200);
  const cornerBefore = pixelAt(0.05, 0.05);
  const midBefore = pixelAt(0.5, 0.5);
  await runRemove('背景里的路人');
  const midAfter = pixelAt(0.5, 0.5);
  const cornerAfter = pixelAt(0.05, 0.05);
  return { cornerBefore, cornerAfter, midBefore, midAfter };
`, r => {
  // 选区中心：原图 128 → AI 的 200
  assert.ok(r.midAfter[0] > 180, `选区中心应该被替换成 AI 的结果，实际 ${r.midAfter[0]}`);
  // 选区外：必须还是原来的 128
  const d = Math.abs(r.cornerAfter[0] - r.cornerBefore[0]);
  assert.ok(d < 6, `选区外被改动了！${r.cornerBefore[0]} → ${r.cornerAfter[0]}`);
});

await t('去物完成后蒙版自动清空', `
  ${SETUP}
  await loadGray();
  mockAI();
  S.paintRect(0.3, 0.35, 0.7, 0.65);
  await sleep(200);
  const before = S.mask.isEmpty;
  await runRemove('电线杆');
  return { before, after: S.mask.isEmpty, useMask: S.useMask, strokes: S.mask.strokes.length };
`, r => {
  assert.equal(r.before, false, '去物前应该有选区');
  assert.equal(r.after, true, '结果已经烤进图里，选区该清掉');
  assert.equal(r.useMask, false, '局部模式该关掉');
  assert.equal(r.strokes, 0);
});

await t('用完会主动删掉临时图', `
  ${SETUP}
  await loadGray();
  const log = mockAI();
  S.paintRect(0.3, 0.35, 0.7, 0.65);
  await sleep(200);
  await runRemove('水印');
  return { deleted: log.deleted };
`, r => {
  assert.ok(r.deleted.length >= 1, '应该主动 DELETE 临时图，而不是等它过期');
  assert.ok(/\/api\/tmp\/[a-f0-9]{32}$/.test(r.deleted[0]), `删除的 URL 不对: ${r.deleted[0]}`);
});

await t('生成失败时给提示，且不破坏原图', `
  ${SETUP}
  await loadGray();
  mockAI({ fail: 'inpaint' });
  S.paintRect(0.3, 0.35, 0.7, 0.65);
  await sleep(200);
  const before = pixelAt(0.5, 0.5);
  await runRemove('路人');
  const after = pixelAt(0.5, 0.5);
  const toast = document.getElementById('stToast');
  return { before, after, toast: toast.textContent, hidden: toast.hidden,
           deleted: true };
`, r => {
  assert.equal(r.after[0], r.before[0], '失败了就不该改动画面');
  assert.equal(r.hidden, false, '应该弹提示');
  assert.ok(/失败/.test(r.toast), `提示应该说清楚失败了: ${r.toast}`);
});

await t('用户取消弹层 → 什么都不做', `
  ${SETUP}
  await loadGray();
  mockAI();
  S.paintRect(0.3, 0.35, 0.7, 0.65);
  await sleep(200);
  setTimeout(() => {
    const btn = document.querySelector('[data-act=cancel]');
    if (btn) btn.click();
  }, 250);
  await S.removeObject();
  await sleep(400);
  return { hasDialog: !!document.querySelector('.st-ask'),
           stillHasMask: !S.mask.isEmpty };
`, r => {
  assert.equal(r.hasDialog, false, '弹层应该关掉');
  assert.equal(r.stillHasMask, true, '取消后选区应该还在，用户没说不要');
});

await t('没涂就点去物 → 提示先涂', `
  ${SETUP}
  await loadGray();
  mockAI();
  await S.removeObject();
  await sleep(300);
  const toast = document.getElementById('stToast');
  return { text: toast.textContent, hidden: toast.hidden, strokes: S.mask.strokes.length };
`, r => {
  assert.equal(r.hidden, false, '应该弹提示');
  assert.ok(/画笔|涂/.test(r.text), `应该提示先涂选区: ${r.text}`);
});

await t('上传前会缩到长边 2048 以内（省时间省流量）', `
  ${SETUP}
  // 造一张 4000×3000 的大图
  const c = document.createElement('canvas');
  c.width = 4000; c.height = 3000;
  c.getContext('2d').fillStyle = '#808080';
  c.getContext('2d').fillRect(0, 0, 4000, 3000);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
  await S.openFile(new File([blob], 'big.jpg', { type: 'image/jpeg' }));
  await sleep(600);
  const out = await S.imageBlob();
  const bmp = await createImageBitmap(out);
  return { origW: S.image.width, origH: S.image.height, upW: bmp.width, upH: bmp.height };
`, r => {
  assert.equal(r.origW, 4000, '原图应该是 4000 宽');
  assert.ok(Math.max(r.upW, r.upH) <= 2048, `上传尺寸应该 ≤2048，实际 ${r.upW}x${r.upH}`);
  assert.ok(r.upW > 1500, `也别缩太狠，实际 ${r.upW}`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
fs.writeFileSync('/tmp/inpaint-browser-results.json', JSON.stringify(results, null, 2));
process.exit(fail ? 1 : 0);
