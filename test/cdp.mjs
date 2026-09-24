/* ================================================================
   最小 CDP 驱动（Chrome DevTools Protocol）
   ----------------------------------------------------------------
   为什么自己写一个：项目里原来用的是 /tmp/dsh-browser.mjs，
   那是 macOS 上的临时文件，换电脑就没了。浏览器测试不该依赖
   一个不在仓库里的东西 —— 所以这里补进仓库。

   依赖为零：WebSocket 客户端也是手写的（只用 node 内置的
   http / crypto）。理由是不想为几个测试往仓库里塞一个 ws 依赖，
   而 CDP 只需要「文本帧 + 客户端掩码」这一小块协议。

   ⚠️ Chrome 从 v136 起**拒绝在默认 profile 上开远程调试端口**，
   所以必须给一个独立的 user-data-dir，否则调试端口起不来
   （现象是 /json/version 一直连不上，看起来像启动失败）。
   ================================================================ */
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/* ---------------- 找 Chrome ---------------- */
export function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* 下一个 */ } }
  throw new Error('找不到 Chrome。设 CHROME_PATH 环境变量指过去。');
}

/* ---------------- 手写 WebSocket 客户端 ---------------- */
/* 只实现我们需要的：连接、发/收文本帧、收 ping 回 pong。
   发送要支持分片 —— CDP 的 Runtime.evaluate 带一大段代码时会超过单帧上限。 */
class WS {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.handlers = [];
    this.closed = false;
    sock.on('data', d => this._onData(d));
    sock.on('close', () => { this.closed = true; });
    sock.on('error', () => { this.closed = true; });
  }

  static connect(wsUrl) {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + (u.search || ''),
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13'
        }
      });
      req.on('upgrade', (res, socket) => resolve(new WS(socket)));
      req.on('response', res => reject(new Error('WebSocket 握手被拒: HTTP ' + res.statusCode)));
      req.on('error', reject);
      req.end();
    });
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const op = b[0] & 0x0f;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2)); off = 10;
      }
      if (b.length < off + len) return;
      const payload = b.slice(off, off + len);
      this.buf = b.slice(off + len);

      if (op === 0x8) { this.closed = true; try { this.sock.end(); } catch { /* 已关 */ } return; }
      if (op === 0x9) { this._frame(0xA, payload); continue; }   // ping -> pong
      if (op === 0x1 || op === 0x0) this._deliver(payload);
    }
  }

  _deliver(text) {
    const s = text.toString('utf8');
    for (const h of this.handlers.slice()) h(s);
  }

  onMessage(fn) { this.handlers.push(fn); }

  _frame(op, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(6);
      header[1] = 0x80 | len;
      mask.copy(header, 2);
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      mask.copy(header, 10);
    }
    header[0] = 0x80 | op;
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([header, masked]));
  }

  send(str) {
    const b = Buffer.from(str, 'utf8');
    const CHUNK = 60000;
    if (b.length <= CHUNK) { this._frame(0x1, b); return; }
    for (let i = 0; i < b.length; i += CHUNK) {
      const part = b.slice(i, i + CHUNK);
      const last = i + CHUNK >= b.length;
      this._frame(last ? 0x80 : 0x0, part);
    }
  }

  close() {
    try { this._frame(0x8, Buffer.alloc(0)); } catch { /* 已关 */ }
    try { this.sock.end(); } catch { /* 已关 */ }
  }
}

/* ---------------- HTTP 小工具 ---------------- */
export function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error('非 JSON 响应: ' + d.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

/* ---------------- 启动 Chrome 并等调试端口 ---------------- */
export async function launch(opts = {}) {
  const chrome = findChrome();
  let port = opts.port || 9333;
  while (!(await portFree(port))) port++;

  // ⚠️ Chrome 136+ 拒绝在默认 profile 上开调试端口，必须独立 user-data-dir
  const userDir = path.join(os.tmpdir(), 'cdp-profile-' + process.pid + '-' + port);
  fs.mkdirSync(userDir, { recursive: true });

  const args = [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--window-size=1200,800',
    // SwiftShader：无头环境没有真 GPU，用软件渲染跑 WebGL。
    // 不加这几个的话 getContext('webgl') 返回 null
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    'about:blank'
  ];

  // stdio: 'ignore' —— Chrome 的输出管道在受限环境下会 EPERM，
  // 而且我们也不需要它的日志（真出错时调试端口会超时，那时再手查）
  const proc = spawn(chrome, args, { stdio: 'ignore' });

  const deadline = Date.now() + 30000;
  for (;;) {
    if (Date.now() > deadline) {
      try { proc.kill(); } catch { /* 已退 */ }
      throw new Error('Chrome 调试端口 30 秒内没起来（port ' + port + '）');
    }
    try {
      const v = await getJson(`http://127.0.0.1:${port}/json/version`);
      if (v && v.webSocketDebuggerUrl) return { proc, port, userDir, version: v };
    } catch { /* 还没起来，继续等 */ }
    await sleep(300);
  }
}

export function shutdown(chrome) {
  if (!chrome) return;
  try { chrome.proc.kill(); } catch { /* 已退 */ }
  try { fs.rmSync(chrome.userDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

/* ---------------- 打开页面并求值 ---------------- */
/** Chrome 的 /json/new 在不同版本上分别是 GET / PUT，两个都试 */
async function newTarget(port, url) {
  const tryOne = method => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port,
      path: '/json/new?' + encodeURIComponent(url), method
    }, res => {
      let d = ''; res.on('data', c => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error('建标签页失败: ' + d.slice(0, 120))); }
      });
    });
    req.on('error', reject); req.end();
  });
  try { return await tryOne('PUT'); }
  catch { return await tryOne('GET'); }
}

function closeTarget(port, id) {
  const req = http.request({
    hostname: '127.0.0.1', port, path: '/json/close/' + id, method: 'PUT'
  }, res => res.resume());
  req.on('error', () => {}); req.end();
}

/**
 * 打开 url，求值一个**表达式**（不是语句块）。
 * 语句块会被 Runtime.evaluate 静默当成 undefined —— 包装成
 * `(async () => { ... })()` 是调用方的责任。
 *
 * ⚠️ 这里有个真实的坑：站点注册了 Service Worker，而 sw.js 里
 * `skipWaiting()` + `clients.claim()` 会让**首次访问的页面重新加载一次**。
 * 表现是 Runtime.evaluate 报 "Execution context was destroyed"，
 * 而且只在前面几个用例上出现（后面的页面已经是 SW 控制的了）——
 * 看起来像"前几个测试是坏的"，其实是被导航打断了。
 *
 * 所以：① 先等页面完全稳定，② 求值遇到 context 被销毁就重试。
 */
export async function evaluate(port, url, expression, opts = {}) {
  const attempts = opts.attempts || 3;
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    try {
      return await evaluateOnce(port, url, expression, opts);
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message || e);
      // 只重试"页面被换掉了"这类瞬时错误，真的异常要如实报出来
      const transient = /Execution context was destroyed|Cannot find context|Target closed|Inspected target navigated/.test(msg);
      if (!transient) throw e;
      await sleep(700);
    }
  }
  throw lastErr;
}

async function evaluateOnce(port, url, expression, opts = {}) {
  const target = await newTarget(port, url);
  const ws = await WS.connect(target.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  ws.onMessage(s => {
    let msg; try { msg = JSON.parse(s); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });

  const call = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    const t = setTimeout(() => {
      pending.delete(myId);
      reject(new Error('CDP 超时: ' + method));
    }, opts.timeout || 60000);
    pending.set(myId, m => {
      clearTimeout(t);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    });
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });

  try {
    await call('Runtime.enable');
    await call('Page.enable');

    // 等 document 就绪。新建的标签页在 url 加载完之前 evaluate 会拿到
    // 一个空上下文，那时 window.Studio 当然不存在
    for (let n = 0; n < 100; n++) {
      try {
        const st = await call('Runtime.evaluate', {
          expression: 'document.readyState', returnByValue: true
        });
        if (st && st.result && st.result.value === 'complete') break;
      } catch { /* 上下文还没建好，继续等 */ }
      await sleep(100);
    }

    if (opts.wait) await sleep(opts.wait);
    // Service Worker 首次 claim 会导致一次重载，给它一点时间安定下来
    await sleep(opts.settle || 900);

    const r = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });

    if (r.exceptionDetails) {
      const ex = r.exceptionDetails;
      throw new Error('页面异常: '
        + ((ex.exception && ex.exception.description) || ex.text));
    }
    return r.result && r.result.value;
  } finally {
    ws.close();
    closeTarget(port, target.id);
  }
}
