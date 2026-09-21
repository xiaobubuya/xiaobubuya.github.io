/**
 * upload.js 的纯逻辑测试
 * 运行：node test/upload.test.mjs
 *
 * 重点测 EXIF 拍摄时间解析 —— 这是上传链路里最容易出错、
 * 且出错后最难发现的一环（日期错了，照片就会跑到错误的那一天）。
 */

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
};

/* ---------------- 最小 DOM 桩，让 upload.js 能被加载 ---------------- */
const stubEl = () => ({
  hidden: false, value: '', textContent: '', innerHTML: '',
  style: {}, dataset: {}, classList: { toggle(){}, add(){}, remove(){} },
  addEventListener(){}, appendChild(){}, querySelector(){ return null; },
  querySelectorAll(){ return []; }, remove(){}, click(){}
});

globalThis.window = globalThis;
globalThis.document = {
  getElementById: () => stubEl(),
  createElement: () => stubEl()
};

await import('../upload.js');
const U = globalThis.AlbumUpload._internals;

/* ================================================================
   构造一个带 EXIF 的最小 JPEG
   ================================================================ */
function buildJpegWithExif(dateStr, { bigEndian = false, tagInIfd0 = false } = {}) {
  const ascii = s => { const b = new Uint8Array(s.length + 1); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };

  const dtOrig = ascii(dateStr);          // 20 字节含结尾 NUL
  while (dtOrig.length % 2) { /* 保持偶数对齐 */ break; }

  // ---- TIFF 结构 ----
  const IFD0_OFF = 8;
  const IFD0_ENTRIES = tagInIfd0 ? 1 : 2;
  const IFD0_SIZE = 2 + IFD0_ENTRIES * 12 + 4;
  const EXIF_IFD_OFF = IFD0_OFF + IFD0_SIZE;
  const EXIF_SIZE = 2 + 1 * 12 + 4;
  const DT_OFF = EXIF_IFD_OFF + EXIF_SIZE;

  const total = DT_OFF + dtOrig.length;
  const t = new Uint8Array(total);
  const dv = new DataView(t.buffer);
  const le = !bigEndian;
  const w16 = (o, v) => dv.setUint16(o, v, le);
  const w32 = (o, v) => dv.setUint32(o, v, le);

  // TIFF header
  if (bigEndian) { t[0] = 0x4D; t[1] = 0x4D; } else { t[0] = 0x49; t[1] = 0x49; }
  w16(2, 0x002A);
  w32(4, IFD0_OFF);

  // IFD0
  let o = IFD0_OFF;
  w16(o, IFD0_ENTRIES); o += 2;
  if (!tagInIfd0) {
    // ExifIFD 指针 tag 0x8769
    w16(o, 0x8769); w16(o + 2, 4); w32(o + 4, 1); w32(o + 8, EXIF_IFD_OFF); o += 12;
  }
  // DateTime (0x0132) —— 解析失败时的兜底
  w16(o, 0x0132); w16(o + 2, 2); w32(o + 4, dtOrig.length); w32(o + 8, DT_OFF); o += 12;
  w32(o, 0);                                   // 无下一个 IFD

  if (!tagInIfd0) {
    // ExifIFD
    o = EXIF_IFD_OFF;
    w16(o, 1); o += 2;
    // DateTimeOriginal 0x9003
    w16(o, 0x9003); w16(o + 2, 2); w32(o + 4, dtOrig.length); w32(o + 8, DT_OFF); o += 12;
    w32(o, 0);
  }

  t.set(dtOrig, DT_OFF);

  // ---- 包进 JPEG APP1 ----
  const payload = new Uint8Array(6 + t.length);
  payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);   // "Exif\0\0"
  payload.set(t, 6);

  const segLen = payload.length + 2;
  const app1 = new Uint8Array(4 + payload.length);
  app1[0] = 0xFF; app1[1] = 0xE1;
  app1[2] = (segLen >> 8) & 0xFF; app1[3] = segLen & 0xFF;
  app1.set(payload, 4);

  const sos = new Uint8Array([0xFF, 0xDA, 0x00, 0x02]);   // SOS，解析到此为止
  const out = new Uint8Array(2 + app1.length + sos.length);
  out[0] = 0xFF; out[1] = 0xD8;                            // SOI
  out.set(app1, 2);
  out.set(sos, 2 + app1.length);
  return out;
}

const fakeFile = (bytes, name = 'photo.jpg', type = 'image/jpeg') => ({
  name, type, size: bytes.length, lastModified: Date.now(),
  slice: (a, b) => ({ arrayBuffer: async () => bytes.slice(a, b ?? bytes.length).buffer })
});

/* ================================================================
   1. 纯函数
   ================================================================ */
console.log('\n=== 1. EXIF 时间格式转换 ===');
{
  ok(U.exifToIso('2025:09:18 10:23:00') === '2025-09-18T10:23:00+08:00',
     '标准格式 → ISO（补 +08:00）', U.exifToIso('2025:09:18 10:23:00'));
  ok(U.exifToIso('2025:09:18T10:23:00') === '2025-09-18T10:23:00+08:00',
     '带 T 分隔符也认');
  ok(U.exifToIso('0000:00:00 00:00:00') === null, '全零无效值 → null');
  ok(U.exifToIso('1800:01:01 00:00:00') === null, '年份过于久远 → null');
  ok(U.exifToIso('乱七八糟') === null, '非日期字符串 → null');
  ok(U.exifToIso('') === null, '空串 → null');
}

console.log('\n=== 2. 内容寻址 key ===');
{
  const k = await U.sha256Hex16(new TextEncoder().encode('hello').buffer);
  ok(/^[a-f0-9]{16}$/.test(k), `sha256 取前 16 位十六进制（${k}）`);
  const k2 = await U.sha256Hex16(new TextEncoder().encode('hello').buffer);
  ok(k === k2, '同样内容 → 同样 key（可去重）');
  const k3 = await U.sha256Hex16(new TextEncoder().encode('hello!').buffer);
  ok(k !== k3, '不同内容 → 不同 key');
}

/* ================================================================
   3. 真实 EXIF 解析
   ================================================================ */
console.log('\n=== 3. EXIF 解析（小端）===');
{
  const jpg = buildJpegWithExif('2025:09:18 10:23:00');
  const got = await U.readExifDate(fakeFile(jpg));
  ok(got === '2025-09-18T10:23:00+08:00', `解析出拍摄时间（${got}）`);

  // 关键：跨午夜的照片必须归到正确的那一天
  const jpg2 = buildJpegWithExif('2025:09:18 00:30:00');
  const got2 = await U.readExifDate(fakeFile(jpg2));
  ok(got2 === '2025-09-18T00:30:00+08:00', `凌晨 00:30 的时间正确（${got2}）`);
  ok(got2.slice(0, 10) === '2025-09-18', '归日仍是 09-18（不会被算到前一天）');
}

console.log('\n=== 4. 大端字节序 ===');
{
  const jpg = buildJpegWithExif('2024:03:05 18:07:42', { bigEndian: true });
  const got = await U.readExifDate(fakeFile(jpg));
  ok(got === '2024-03-05T18:07:42+08:00', `Motorola 序（MM）也能解析（${got}）`);
}

console.log('\n=== 5. 兜底路径 ===');
{
  // 没有 ExifIFD，只在 IFD0 里有 DateTime
  const jpg = buildJpegWithExif('2023:12:31 23:59:59', { tagInIfd0: true });
  const got = await U.readExifDate(fakeFile(jpg));
  ok(got === '2023-12-31T23:59:59+08:00', `回退到 IFD0 的 DateTime（${got}）`);
}

console.log('\n=== 6. 异常输入不应崩 ===');
{
  ok(await U.readExifDate(fakeFile(new Uint8Array([1, 2, 3]), 'x.jpg')) === null, '太短的数据 → null');
  ok(await U.readExifDate(fakeFile(new Uint8Array(0), 'x.jpg')) === null, '空文件 → null');
  ok(await U.readExifDate(fakeFile(new Uint8Array(64), 'x.jpg')) === null, '全零数据 → null');

  // 没有 EXIF 的合法 JPEG 头
  const plain = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]);
  ok(await U.readExifDate(fakeFile(plain)) === null, '无 EXIF 的 JPEG → null');

  // PNG 不走 EXIF 分支
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  ok(await U.readExifDate(fakeFile(png, 'a.png', 'image/png')) === null, 'PNG 直接跳过 → null');

  // 截断的 APP1（声明长度超出实际）
  const bad = buildJpegWithExif('2025:01:01 00:00:00').slice(0, 30);
  let threw = false;
  try { await U.readExifDate(fakeFile(bad)); } catch { threw = true; }
  ok(!threw, '截断的 EXIF 不抛异常');
}

/* ================================================================
   汇总
   ================================================================ */
console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(46) + '\n');
process.exit(fail ? 1 : 0);
