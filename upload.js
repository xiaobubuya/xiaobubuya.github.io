/* ================================================================
   上传 —— 浏览器端派生缩略图 + 直传 Worker
   ================================================================
   流程（每张）：
     读文件 → sha256 内容寻址 key
            → createImageBitmap 解码（自动按 EXIF 方向旋转）
            → OffscreenCanvas 生成 thumb(400) / preview(1600) WebP
            → PUT /api/blob/{size}/{key}  上传两个档位
            → POST /api/photos            登记元数据（幂等 upsert）
            → 完成

   为什么在浏览器端派生：Worker 不做图片处理，省算力也省钱；
   手机上解码一张 12MP 照片并缩放通常几百毫秒，完全可接受。

   通过 AlbumUpload.install({...}) 注入 API 地址等依赖，
   避免依赖脚本加载顺序。
   ================================================================ */

(function () {
  'use strict';

  const THUMB_EDGE = 400;
  const PREVIEW_EDGE = 1600;
  const THUMB_Q = 0.75;
  const PREVIEW_Q = 0.80;
  const CONCURRENCY = 3;

  let ctx = null;          // { API, toast, onDone, knownKeys }
  let queue = [];          // { file, state, msg, id }
  let running = 0;
  let el = {};

  /* ================================================================
     内容寻址 key
     ================================================================ */
  async function sha256Hex16(buf) {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);
  }

  /* ================================================================
     EXIF 拍摄时间
     ----------------------------------------------------------------
     EXIF 里存的是相机当地时间、不带时区。我们统一按北京时间理解，
     所以直接补 +08:00 —— 与后端 taken_day 的口径一致。
     解析失败返回 null，调用方回退到文件的 lastModified。
     ================================================================ */
  async function readExifDate(file) {
    const isJpeg = /jpe?g/i.test(file.type) || /\.jpe?g$/i.test(file.name);
    if (!isJpeg) return null;                 // HEIC 的 EXIF 结构不同，暂不解析

    let dv;
    try {
      // 只读头部，EXIF 一定在前面
      dv = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    } catch { return null; }

    if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return null;

    let off = 2;
    while (off + 4 <= dv.byteLength) {
      if (dv.getUint8(off) !== 0xFF) { off++; continue; }
      const marker = dv.getUint8(off + 1);

      if (marker === 0xDA || marker === 0xD9) break;      // 进入图像数据
      const size = dv.getUint16(off + 2);
      if (size < 2) break;

      if (marker === 0xE1 && off + 10 <= dv.byteLength) {
        const s = off + 4;
        // "Exif\0\0"
        if (dv.getUint32(s) === 0x45786966 && dv.getUint16(s + 4) === 0x0000) {
          const t = parseTiff(dv, s + 6);
          if (t) return t;
        }
      }
      off += 2 + size;
    }
    return null;
  }

  function parseTiff(dv, base) {
    if (base + 8 > dv.byteLength) return null;

    const le = dv.getUint16(base) === 0x4949;             // "II" = 小端
    const u16 = o => dv.getUint16(o, le);
    const u32 = o => dv.getUint32(o, le);

    if (u16(base + 2) !== 0x002A) return null;

    const ifd0 = base + u32(base + 4);
    if (ifd0 + 2 > dv.byteLength) return null;

    // IFD0 → ExifIFD 指针（tag 0x8769）
    const exifOff = readTagValue(dv, ifd0, 0x8769, le, u32);
    let s = null;

    if (exifOff) {
      s = readAsciiTag(dv, base + exifOff, 0x9003, le, u32, base);   // DateTimeOriginal
      if (!s) s = readAsciiTag(dv, base + exifOff, 0x9004, le, u32, base); // DateTimeDigitized
    }
    if (!s) s = readAsciiTag(dv, ifd0, 0x0132, le, u32, base);       // DateTime（IFD0）

    return s ? exifToIso(s) : null;
  }

  /** 遍历某个 IFD，返回指定 tag 的第一个 LONG 值 */
  function readTagValue(dv, ifd, tag, le, u32) {
    if (ifd + 2 > dv.byteLength) return 0;
    const n = dv.getUint16(ifd, le);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > dv.byteLength) return 0;
      if (dv.getUint16(e, le) === tag) return u32(e + 8);
    }
    return 0;
  }

  /** 取 ASCII tag（type 2），长度 ≤4 时内联在 entry 里，否则在偏移处 */
  function readAsciiTag(dv, ifd, tag, le, u32, base) {
    if (ifd + 2 > dv.byteLength) return null;
    const n = dv.getUint16(ifd, le);

    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > dv.byteLength) return null;
      if (dv.getUint16(e, le) !== tag) continue;
      if (dv.getUint16(e + 2, le) !== 2) return null;         // 必须是 ASCII

      const len = u32(e + 4);
      if (len < 10 || len > 64) return null;
      const at = len <= 4 ? e + 8 : base + u32(e + 8);
      if (at + len > dv.byteLength) return null;

      let str = '';
      for (let j = 0; j < len; j++) {
        const c = dv.getUint8(at + j);
        if (c === 0) break;
        str += String.fromCharCode(c);
      }
      return str.trim() || null;
    }
    return null;
  }

  /** "2025:09:18 10:23:00" → "2025-09-18T10:23:00+08:00" */
  function exifToIso(s) {
    const m = String(s).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const [, y, mo, d, h, mi, sec] = m;
    if (+y < 1990 || +y > 2100) return null;                  // 明显是无效值
    return `${y}-${mo}-${d}T${h}:${mi}:${sec}+08:00`;
  }

  /* ================================================================
     派生图
     ================================================================ */
  async function derive(bitmap, maxEdge, quality) {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, maxEdge / longEdge);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    // 优先 OffscreenCanvas（不阻塞主线程合成）
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(bitmap, 0, 0, w, h);
      try {
        const blob = await c.convertToBlob({ type: 'image/webp', quality });
        if (blob && blob.size) return blob;
      } catch { /* 落到下面的 <canvas> 分支 */ }
    }

    // 回退：普通 canvas
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise(res => c.toBlob(res, 'image/webp', quality));
    if (!blob) throw new Error('浏览器不支持 WebP 编码');
    return blob;
  }

  /* ================================================================
     单张处理
     ================================================================ */
  async function processOne(item) {
    const { file } = item;

    setState(item, 'hash', '计算中');
    const buf = await file.arrayBuffer();
    const key = await sha256Hex16(buf);

    // 已经在时间线里的，直接跳过（内容寻址，key 相同就是同一张）
    if (ctx.knownKeys && ctx.knownKeys.has(key)) {
      setState(item, 'skip', '已存在');
      return null;
    }

    setState(item, 'decode', '解码中');
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      throw new Error('此浏览器无法解码该格式（HEIC 请用手机上传或本地脚本）');
    }

    try {
      setState(item, 'derive', '生成缩略图');
      const thumb = await derive(bitmap, THUMB_EDGE, THUMB_Q);
      const preview = await derive(bitmap, PREVIEW_EDGE, PREVIEW_Q);
      const w = bitmap.width, h = bitmap.height;

      setState(item, 'upload', '上传中');
      await putBlob('thumb', key, thumb);
      await putBlob('preview', key, preview);

      setState(item, 'register', '登记中');
      const takenAt = (await readExifDate(file)) || new Date(file.lastModified).toISOString();

      const res = await fetch(ctx.API + '/api/photos', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ k: key, w, h, takenAt, bytes: file.size })
      });
      if (!res.ok) throw new Error('登记失败 HTTP ' + res.status);

      if (ctx.knownKeys) ctx.knownKeys.add(key);

      const day = String(takenAt).slice(0, 10);
      return { k: key, w, h, takenAt, takenDay: day, hasFull: false, pending: false };
    } finally {
      if (bitmap && bitmap.close) bitmap.close();
    }
  }

  async function putBlob(size, key, blob) {
    const res = await fetch(`${ctx.API}/api/blob/${size}/${key}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'image/webp' },
      body: blob
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(`${size} 上传失败 ${res.status}${d.error ? ' (' + d.error + ')' : ''}`);
    }
  }

  /* ================================================================
     队列
     ================================================================ */
  let seq = 0;
  let added = [];        // 本次成功登记的记录

  function setState(item, st, msg) {
    item.state = st;
    item.msg = msg || '';
    paintItem(item);
    paintSummary();
  }

  async function pump() {
    while (running < CONCURRENCY) {
      const next = queue.find(x => x.state === 'wait');
      if (!next) break;
      running++;
      run(next).finally(() => { running--; pump(); });
      // 循环继续，直到并发占满
    }
    if (!queue.some(x => x.state === 'wait' || x.state === 'run')) finish();
  }

  async function run(item) {
    item.state = 'run';
    try {
      const rec = await processOne(item);
      item.state = 'done';
      item.msg = rec ? '完成' : '已存在';
      if (rec) added.push(rec);
    } catch (err) {
      item.state = 'fail';
      item.msg = (err && err.message) || '失败';
    }
    paintItem(item);
    paintSummary();
  }

  let finished = false;
  function finish() {
    if (finished) return;
    if (queue.some(x => x.state === 'wait' || x.state === 'run')) return;
    finished = true;

    const okN = queue.filter(x => x.state === 'done' && x.msg === '完成').length;
    const skipN = queue.filter(x => x.state === 'done' && x.msg === '已存在').length;
    const failN = queue.filter(x => x.state === 'fail').length;

    const parts = [];
    if (okN) parts.push(`${okN} 张成功`);
    if (skipN) parts.push(`${skipN} 张已存在`);
    if (failN) parts.push(`${failN} 张失败`);
    ctx.toast(parts.join('，') || '没有可上传的照片', 3200);

    if (added.length && ctx.onDone) ctx.onDone(added.slice());
    added = [];
  }

  /* ================================================================
     UI
     ================================================================ */
  function paintSummary() {
    const total = queue.length;
    const done = queue.filter(x => x.state === 'done' || x.state === 'fail').length;
    const okN = queue.filter(x => x.state === 'done').length;

    el.fill.style.width = total ? `${Math.round(done / total * 100)}%` : '0';
    el.count.textContent = `${done} / ${total}`;

    const waiting = queue.some(x => x.state === 'wait' || x.state === 'run');
    el.title.textContent = waiting
      ? '正在上传…'
      : (okN === total ? '全部完成' : '部分失败，可单张重试');
  }

  function paintItem(item) {
    let row = el.list.querySelector(`[data-id="${item.id}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'up-item';
      row.dataset.id = item.id;
      row.innerHTML = '<span class="nm"></span><span class="st"></span>';
      el.list.appendChild(row);
    }
    row.querySelector('.nm').textContent = item.file.name;

    const st = row.querySelector('.st');
    st.textContent = item.state === 'run' || item.state === 'wait' ? (item.msg || '等待') : item.msg;

    row.classList.toggle('done', item.state === 'done');
    row.classList.toggle('fail', item.state === 'fail');

    // 失败项给一个重试按钮
    const old = row.querySelector('.retry');
    if (old) old.remove();
    if (item.state === 'fail') {
      const b = document.createElement('button');
      b.className = 'retry';
      b.textContent = '重试';
      b.onclick = () => {
        item.state = 'wait';
        item.msg = '等待';
        finished = false;
        paintItem(item);
        paintSummary();
        pump();
      };
      row.appendChild(b);
    }
  }

  function openPanel(files) {
    queue = files.map(f => ({ id: 'u' + (++seq), file: f, state: 'wait', msg: '等待' }));
    added = [];
    finished = false;
    el.list.innerHTML = '';
    el.panel.hidden = false;
    queue.forEach(paintItem);
    paintSummary();
    pump();
  }

  /* ================================================================
     对外接口
     ================================================================ */
  window.AlbumUpload = {
    /** 由 app.js 注入依赖 */
    install(deps) {
      ctx = deps;
      el = {
        panel: document.getElementById('uploadPanel'),
        title: document.getElementById('upTitle'),
        count: document.getElementById('upCount'),
        fill: document.getElementById('upFill'),
        list: document.getElementById('upList'),
        close: document.getElementById('upClose'),
        input: document.getElementById('fileInput')
      };

      el.close.addEventListener('click', () => { el.panel.hidden = true; });

      el.input.addEventListener('change', e => {
        const files = [...(e.target.files || [])].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
        el.input.value = '';                    // 允许重复选同一批
        if (!files.length) { ctx.toast('没有可用的图片'); return; }
        openPanel(files);
      });
    },

    /** 打开系统选图 */
    pick() {
      if (!ctx) return;
      el.input.click();
    },

    /** 纯函数，供单元测试使用（不经 UI，无副作用） */
    _internals: { readExifDate, exifToIso, parseTiff, sha256Hex16 }
  };
})();
