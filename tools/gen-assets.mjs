/* ================================================================
   素材生成（调 Agnes 图像模型）
   ----------------------------------------------------------------
   ⚠️ 为什么是脚本而不是 DSH 的图像插件：

   DSH 的 dsh-image-generation 插件**没法接 Agnes**，三道硬障碍：

     ① 模型白名单写死：provider.js 里
        `OPENAI_IMAGES = new Set([...gpt-image-*])`，
        `agnes-image-*` 永远不在可选项里
     ② 保存时要过 `GET /v1/models/{model}` 且返回的 `id` 必须等于 model。
        实测 Agnes 返回 HTTP 200 但内容是
        `{"error":{"code":"model_not_found"}}` —— **没有 id 字段**，
        于是报 "The requested model was not returned by the provider."，存不上
     ③ 只有 bytedance / openai 两个 provider，没有"自定义"第三个

   所以这里绕过插件，直接调 Agnes 的 OpenAI 兼容接口。
   实测（2026-09-25）：
     POST /v1/images/generations  7 秒返回 1024×1024 PNG

   ⚠️⚠️ 两个必须记住的坑：

   1. **必须显式传 `response_format: 'b64_json'`。**
      Agnes 默认只回 `url`，而 `b64_json` 字段是**空字符串**。
      不传这个参数的话，拿到的 base64 长度是 0 ——
      而 DSH 插件恰恰只认 base64，这也是一道它接不上的原因。

   2. **密钥不写进这个文件。** 用环境变量 `AGNES_API_KEY`。
      （这个仓库是公开的，密钥进去就等于公开了。）

   用法：
     $env:AGNES_API_KEY = 'sk-...'
     node tools/gen-assets.mjs icons        # 生成 App 图标
     node tools/gen-assets.mjs og           # 生成分享页兜底图
     node tools/gen-assets.mjs stage        # 生成循环播放页视觉
     node tools/gen-assets.mjs portrait     # 生成验收用的人像
     node tools/gen-assets.mjs all
   ================================================================ */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, '..');          // xiaobubuya.github.io
const OUT_DIR = path.join(WEB_ROOT, 'assets', 'gen');

const BASE = process.env.AGNES_BASE || 'https://api.agnes-ai.cn/v1';
const MODEL = process.env.AGNES_MODEL || 'agnes-image-2.5-flash';
const KEY = process.env.AGNES_API_KEY || '';

/* ================================================================
   风格（所有素材共用，保证是一套）
   ================================================================ */
const STYLE = [
  'Warm minimal keepsake aesthetic for a private two-person wedding album.',
  'Palette: ivory #faf7f4, deep warm charcoal #2a2320, muted rose-gold #b98a6a, soft dusty rose #d8b4a6.',
  'Thin elegant line work, generous whitespace, no gradients, no clutter, no text, no letters, no watermark.'
].join(' ');

/* ================================================================
   任务定义
   ================================================================ */
const TASKS = {
  icons: {
    desc: 'App 图标',
    /* 一次生成，再本地缩成 512/192/180 —— 同一张图缩放出来的
       三档才是一致的；分别生成会三张都不一样（AI 不可复现）。 */
    ratio: '1:1',
    size: 1024,
    prompt: 'A minimalist app icon on a flat ivory background: two overlapping '
      + 'photo frames tilted slightly, with a small heart formed in the negative '
      + 'space where they meet. Perfectly centered, motif occupying about 58% of '
      + 'the frame, even generous margin on all four sides, clean bold silhouette '
      + 'that stays readable at 48x48. Flat vector, thin-to-medium charcoal strokes, '
      + 'a single muted rose-gold accent line.'
  },
  og: {
    desc: '分享页兜底图（微信预览）',
    ratio: '16:9',
    size: 1200,
    prompt: 'A serene wedding-keepsake cover image, wide 16:9 composition. A soft '
      + 'ivory paper texture background with a subtle warm vignette; centered, two '
      + 'delicately drawn overlapping photo frames resting at a slight angle, one '
      + 'holding a simple line-art heart. Lots of empty space around the center so '
      + 'text could later sit over it. Elegant, quiet, no people, no faces.'
  },
  stage: {
    desc: '循环播放页视觉',
    ratio: '16:9',
    size: 1920,
    prompt: 'A dark, cinematic backdrop for a full-screen wedding photo slideshow, '
      + 'wide 16:9. Very dark warm charcoal (#15110f) ground with an extremely '
      + 'subtle radial glow in soft rose-gold near the center, faint ivory grain '
      + 'and dust motes. Almost empty in the middle so photographs can be composed '
      + 'over it. No objects, no people, no text.'
  },
  portrait: {
    desc: '验收用的人像（美颜/抠人）',
    ratio: '3:4',
    size: 1536,
    prompt: 'A natural, unretouched editorial portrait of a young woman, three-quarter '
      + 'view, soft window light from the left, plain warm neutral studio backdrop, '
      + 'visible natural skin texture with a few freckles and fine flyaway hair at '
      + 'the edges. Shot on an 85mm lens, shallow depth of field. Photographic, not '
      + 'illustrated. This is a test subject for a portrait retouching pipeline, so '
      + 'realistic skin and hair detail matter more than glamour.'
  }
};

/* ================================================================
   调用
   ================================================================ */
async function generate(task, opts = {}) {
  if (!KEY) {
    throw new Error('没有 AGNES_API_KEY。先设环境变量：\n'
      + "  $env:AGNES_API_KEY = 'sk-...'");
  }

  const body = {
    model: MODEL,
    prompt: `${task.prompt}\n\nArt direction: ${STYLE}`,
    size: opts.size || task.size || 1024,
    n: 1,
    // ⚠️ 必须传。不传的话 Agnes 只回 url，b64_json 是空串（实测）
    response_format: 'b64_json'
  };
  // Agnes 接受 "1024x1024" 这种字符串；宽高都取方形/比例对应的值
  if (task.ratio === '16:9') body.size = `${body.size}x${Math.round(body.size * 9 / 16)}`;
  else if (task.ratio === '3:4') body.size = `${Math.round(body.size * 3 / 4)}x${body.size}`;
  else body.size = `${body.size}x${body.size}`;

  const t0 = Date.now();
  const res = await fetch(`${BASE}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);

  let j;
  try { j = JSON.parse(txt); }
  catch { throw new Error('返回的不是 JSON：' + txt.slice(0, 200)); }

  const d = j && j.data && j.data[0];
  if (!d) throw new Error('响应里没有 data[0]：' + txt.slice(0, 200));

  const b64 = d.b64_json;
  if (typeof b64 !== 'string' || b64.length < 100) {
    throw new Error(
      '拿不到 base64（长度 ' + (typeof b64 === 'string' ? b64.length : 'n/a') + '）。\n'
      + '     ⚠️ 多半是忘了传 response_format: "b64_json" —— '
      + 'Agnes 默认只回 url，b64_json 是空串。\n'
      + '     url = ' + (d.url || '(无)'));
  }

  const bytes = Buffer.from(b64, 'base64');
  return { bytes, ms: Date.now() - t0, prompt: body.prompt };
}

/* ================================================================
   纯 JS 的 PNG 缩放（不引依赖，也不需要 sharp）
   ----------------------------------------------------------------
   只做 box filter 缩小 —— 对线稿图标来说够了，而且没有依赖。
   ================================================================ */
function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8 位 PNG（实际 ' + bitDepth + '）');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('只支持 RGB/RGBA（colorType ' + colorType + '）');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= channels) ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
  }
  return { w, h, channels, px };
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function writePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;   // 8 位 RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** box filter 缩放 + 可选圆角（圆角外透明） */
function resize(img, outW, outH, radiusFrac = 0) {
  const { w, h, channels, px } = img;
  const out = Buffer.alloc(outW * outH * 4);
  const sx = w / outW, sy = h / outH;

  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(h, Math.ceil((y + 1) * sy));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(w, Math.ceil((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * channels;
          r += px[i]; g += px[i + 1]; b += px[i + 2];
          a += channels === 4 ? px[i + 3] : 255;
          n++;
        }
      }
      if (!n) n = 1;
      const o = (y * outW + x) * 4;
      let alpha = a / n;

      if (radiusFrac > 0) {
        /* 圆角遮罩：到圆心的距离超过内矩形就渐隐。
           用超采样（4×4）算覆盖率，边缘才不会有锯齿。 */
        const R = radiusFrac * Math.min(outW, outH);
        const cx = Math.min(Math.max(x + 0.5, R), outW - R);
        const cy = Math.min(Math.max(y + 0.5, R), outH - R);
        let cov = 0;
        for (let s = 0; s < 4; s++) {
          for (let t = 0; t < 4; t++) {
            const fx = x + (s + 0.5) / 4, fy = y + (t + 0.5) / 4;
            const dist = Math.hypot(fx - cx, fy - cy);
            if (dist <= R) cov++;
          }
        }
        alpha = alpha * (cov / 16);
      }

      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(alpha);
    }
  }
  return { w: outW, h: outH, channels: 4, px: out };
}

/* ================================================================
   各任务的落盘
   ================================================================ */
async function doIcons() {
  const t = TASKS.icons;
  console.log(`\n→ ${t.desc}`);
  const { bytes, ms } = await generate(t);
  console.log(`   生成完成 ${ms}ms  ${bytes.length} 字节`);

  const src = readPng(bytes);
  console.log(`   源图 ${src.w}×${src.h}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 三档图标：transparent 圆角（iOS/Android 会自己再加遮罩，圆角更耐看）
  for (const size of [512, 192, 180]) {
    const r = resize(src, size, size, 0.22);
    const file = path.join(WEB_ROOT, `icon-${size}.png`);
    fs.writeFileSync(file, writePng(r.w, r.h, r.px));
    console.log(`   ✓ icon-${size}.png  (圆角透明)`);
  }

  // 原图留档，方便以后重切
  fs.writeFileSync(path.join(OUT_DIR, 'icon-master.png'), bytes);
  console.log(`   ✓ assets/gen/icon-master.png  (1024 原图留档)`);
}

async function doOg() {
  const t = TASKS.og;
  console.log(`\n→ ${t.desc}`);
  const { bytes, ms } = await generate(t);
  console.log(`   生成完成 ${ms}ms  ${bytes.length} 字节`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(WEB_ROOT, 'og-cover.png');
  fs.writeFileSync(file, bytes);
  const src = readPng(bytes);
  console.log(`   ✓ og-cover.png  ${src.w}×${src.h}`);
}

async function doStage() {
  const t = TASKS.stage;
  console.log(`\n→ ${t.desc}`);
  const { bytes, ms } = await generate(t);
  console.log(`   生成完成 ${ms}ms  ${bytes.length} 字节`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, 'stage-bg.png');
  fs.writeFileSync(file, bytes);
  const src = readPng(bytes);
  console.log(`   ✓ assets/gen/stage-bg.png  ${src.w}×${src.h}`);
}

async function doPortrait() {
  const t = TASKS.portrait;
  console.log(`\n→ ${t.desc}`);
  const { bytes, ms } = await generate(t);
  console.log(`   生成完成 ${ms}ms  ${bytes.length} 字节`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, 'portrait-test.png');
  fs.writeFileSync(file, bytes);
  const src = readPng(bytes);
  console.log(`   ✓ assets/gen/portrait-test.png  ${src.w}×${src.h}`);
}

/* ================================================================
   入口
   ================================================================ */
const which = (process.argv[2] || 'all').toLowerCase();
const MAP = { icons: doIcons, og: doOg, stage: doStage, portrait: doPortrait };

console.log('素材生成（Agnes ' + MODEL + ' @ ' + BASE + '）');
if (!KEY) {
  console.error('\n✗ 没有 AGNES_API_KEY。用法：');
  console.error("  $env:AGNES_API_KEY = 'sk-...'");
  console.error('  node tools/gen-assets.mjs icons');
  process.exit(1);
}

const list = which === 'all' ? Object.keys(MAP) : [which];
for (const name of list) {
  if (!MAP[name]) {
    console.error(`\n✗ 不认识的任务「${name}」。可选：${Object.keys(MAP).join(' / ')} / all`);
    process.exit(1);
  }
  try {
    await MAP[name]();
  } catch (e) {
    console.error(`\n✗ ${name} 失败：${e.message}`);
    process.exitCode = 1;
  }
}
console.log('\n完成。');
