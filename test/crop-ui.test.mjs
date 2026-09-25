/* ================================================================
   裁剪/旋转面板的 UI 状态同步
   ----------------------------------------------------------------
   守的是一个**实测抓到的** bug：

     进裁剪 → 拖旋转到 30° → 按「⟲ 90°」快转
     （内部会旋转**并重新进入裁剪**，crop.rot 归零）
     → **滑杆和度数标签仍停在 30°**

   症状：显示 30° 而实际 0°。用户会以为旋转丢了，或者以为已经转了。

   根因：`#stCropRot`（滑杆）和 `#stCropRotVal`（标签）是两个独立元素，
   没有 <output> 绑定关系 —— **只有显式同步才会一致**。
   凡是能改 crop.rot 的地方都得同步一次（enterCrop / setCropRotation /
   rotateQuarter 之后）。

   ⚠️ 这类"两个控件描述同一状态、但只有一个被更新"的 bug，
   静态测试和像素测试都抓不到，只能靠"读 DOM 的实际值再和状态比对"。
   ================================================================ */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, shutdown } from './cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CROPUI_PORT || 8877);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json'
};
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
});

let ACTUAL = PORT;
for (let p = PORT; p < PORT + 10; p++) {
  try {
    await new Promise((ok, no) => {
      const onErr = e => { server.removeListener('listening', onOk); no(e); };
      const onOk = () => { server.removeListener('error', onErr); ok(); };
      server.once('error', onErr); server.once('listening', onOk);
      server.listen(p, '127.0.0.1');
    });
    ACTUAL = p; break;
  } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
}

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== 裁剪面板 UI 状态同步 ===\n');

const chrome = await launch();
let steps;
try {
  const page = await openPage(chrome.port, `http://127.0.0.1:${ACTUAL}/studio.html?v=${Date.now()}`);
  await page.eval(`(async () => {
    const dl = Date.now() + 20000;
    while (Date.now() < dl) {
      if (window.Studio && window.Studio.enterCrop
          && document.getElementById('stSliders').children.length) return true;
      await new Promise(r => setTimeout(r, 60));
    }
    throw new Error('修图页 20 秒没就绪');
  })()`);

  steps = await page.eval(`(async () => {
    const S = window.Studio;
    const snap = tag => {
      const sl = document.getElementById('stCropRot');
      const lb = document.getElementById('stCropRotVal');
      const raw = lb ? String(lb.textContent) : '';
      return {
        tag,
        slider: sl ? Number(sl.value) : null,
        // ⚠️ 转成数字再比 —— 一开始留成字符串，断言里
        // 字符串 '30' 和数字 30 不相等，报出"标签应该是 30，实际 30"，
        // 看着像逻辑错，其实是类型没转。
        label: lb ? Number(String(lb.textContent).replace('°', '')) : null,
        labelRaw: lb ? String(lb.textContent) : null,
        state: S.crop ? S.crop.rot : null
      };
    };
    const out = [];

    const c = document.createElement('canvas');
    c.width = 600; c.height = 400;
    c.getContext('2d').fillRect(0, 0, 600, 400);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    await S.openFile(new File([blob], 'x.png', { type: 'image/png' }));
    S.resetAll();

    S.enterCrop();
    await new Promise(r => setTimeout(r, 150));
    out.push(snap('刚进裁剪'));

    const sl = document.getElementById('stCropRot');
    sl.value = '30';
    sl.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    out.push(snap('拖到 30°'));

    // 90° 快转：内部会旋转并重新进入裁剪。
    // ⚠️ 它**故意保留**细调角度（keepRot = crop.rot）——
    //    用户先调 30° 拉直、再转 90°，不应该把拉直丢掉。
    await S.rotateQuarter(1);
    await new Promise(r => setTimeout(r, 400));
    out.push(snap('转 90° 之后'));

    // 取消 → 重进
    S.exitCrop(false);
    S.enterCrop();
    await new Promise(r => setTimeout(r, 200));
    out.push(snap('取消后重进'));

    /* 超出滑杆量程（±45）的角度：滑杆会被浏览器夹到边界，
       如果不同步钳制，就会出现"标签 60° 而滑杆 45°"这种不一致。
       走公开入口 setCropRotation（内部会钳制）。 */
    S.setCropRotation(80);
    await new Promise(r => setTimeout(r, 200));
    out.push(snap('设成 80°（超量程）'));
    S.setCropRotation(-80);
    await new Promise(r => setTimeout(r, 200));
    out.push(snap('设成 -80°（超量程）'));

    return out;
  })()`);
  await page.close().catch(() => {});
} finally {
  shutdown(chrome);
  server.close();
}

console.log('');
for (const s of steps) {
  console.log(`  ${String(s.tag).padEnd(14)} 滑杆=${String(s.slider).padStart(4)}  `
    + `标签=${String(s.labelRaw).padStart(5)}  crop.rot=${s.state}`);
}
console.log('');

t('⭐ 滑杆、标签、实际角度三者始终一致', () => {
  const bad = [];
  for (const s of steps) {
    if (s.slider !== s.label || s.slider !== s.state) {
      bad.push(`「${s.tag}」滑杆=${s.slider} 标签=${s.label} 实际=${s.state}`);
    }
  }
  assert.equal(bad.length, 0,
    `这三者不一致（显示的角度和实际用的角度不是一回事）：\n       `
    + bad.join('\n       ')
    + '\n     ⚠️ #stCropRot 和 #stCropRotVal 是两个独立元素，'
    + '没有 <output> 绑定 —— 每次改 crop.rot 都要显式同步。');
});

t('⭐ 重新进入裁剪时旋转角度归零（滑杆不能停在上次的值）', () => {
  const enter = steps.find(s => s.tag === '取消后重进');
  assert.ok(enter, '没拿到"取消后重进"的快照');
  assert.equal(enter.state, 0, `重进后 crop.rot 应该是 0，实际 ${enter.state}`);
  assert.equal(enter.slider, 0,
    `重进后滑杆应该是 0，实际 ${enter.slider} —— `
    + '显示 30° 而实际 0°，用户会以为旋转丢了');
  assert.equal(enter.label, 0, `重进后标签应该是 0，实际 ${enter.label}`);
});

t('⭐ 90° 快转后保留细调角度（不能把拉直丢掉）', () => {
  const after = steps.find(s => s.tag === '转 90° 之后');
  assert.ok(after, '没拿到"转 90° 之后"的快照');
  /* ⚠️ 这条断言我一开始写反了：以为快转后应该归零，报
     "crop.rot 应该是 0，实际 30"。其实 rotateQuarter 是
     `keepRot = crop.rot` —— **故意保留**的：
     先调 30° 拉直、再转 90°，把拉直丢掉才是 bug。
     真正要守的是"滑杆/标签/状态三者一致"（见第一条）。 */
  assert.equal(after.state, 30,
    `快转后应该保留细调角度 30°，实际 ${after.state}`);
  assert.equal(after.slider, 30, `滑杆应该跟着是 30，实际 ${after.slider}`);
  assert.equal(after.label, 30, `标签应该跟着是 30，实际 ${after.label}`);
});

t('⭐ 超出滑杆量程的角度要被钳制（否则滑杆和标签会不一致）', () => {
  /* 滑杆量程只有 ±45。给 input.value 赋超出 min/max 的值时，
     **浏览器会把它夹到边界** —— 于是"标签 80° 而滑杆 45°"。
     所以 syncCropRotUI 里必须自己先钳一次，并使 crop.rot 也落在量程内。 */
  for (const tag of ['设成 80°（超量程）', '设成 -80°（超量程）']) {
    const s = steps.find(v => v.tag === tag);
    assert.ok(s, `没拿到"${tag}"的快照`);
    assert.equal(s.slider, s.label,
      `「${tag}」滑杆 ${s.slider} 和标签 ${s.label} 不一致 —— `
      + '角度超出 ±45 时滑杆被浏览器夹住了，而标签显示的是原值');
    assert.equal(s.slider, s.state,
      `「${tag}」滑杆 ${s.slider} 和实际角度 ${s.state} 不一致`);
    assert.ok(Math.abs(s.state) <= 45,
      `「${tag}」实际角度 ${s.state} 超出了滑杆量程 ±45`);
  }
});

t('拖到 30° 时三者都是 30（同步是双向的，不是只会清零）', () => {
  const s = steps.find(v => v.tag === '拖到 30°');
  assert.ok(s, '没拿到"拖到 30°"的快照');
  assert.equal(s.slider, 30, `滑杆应该是 30，实际 ${s.slider}`);
  assert.equal(s.label, 30, `标签应该是 30，实际 ${s.label}`);
  assert.equal(s.state, 30, `crop.rot 应该是 30，实际 ${s.state}`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
