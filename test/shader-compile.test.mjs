/* ================================================================
   在真实 WebGL 里编译 studio.js 的 VERT / FRAG
   ----------------------------------------------------------------
   为什么要这个测试：静态检查（shader-guard 的反引号护栏、
   adjustments 的运算符护栏）只能**近似**地拦住「用了一个
   GLSL ES 3.00 才有的运算符」这类错误 —— 编译器才是最权威的答案。

   实测踩过（代价是整个修图页白了一轮）：分节开关一开始写成
   `uniform int uSecMask` + `uSecMask & 1`。`&` 位运算在 GLSL ES 1.00
   （WebGL1）里根本不存在，是 ES 3.00 才有的。shader 编译失败，
   页面显示「打不开修图功能」。

   同样的坑还有：`%` 取余、mod(int,int)、rem(int,int)。
   ES 1.00 里 int 能用的只有 + - * / 和比较 —— 所以读位用
   两个整数除法相减（SEC 宏）。

   这个测试比静态护栏贵（要起 Chrome），但它是唯一能给出
   getShaderInfoLog 的东西，所以单独留一个文件。

   实现细节：把抠出来的 shader 由本测试的静态服务当 /shaders.js
   供出去，页面里只需要读 window.__SHADERS —— 省掉把大段字符串
   往 CDP 的 Runtime.evaluate 里插值的转义地狱。
   ================================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, shutdown } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.STUDIO_PORT || 8903);
const BUILD_TAG = String(Date.now());   // 破 Chrome 对 127.0.0.1 的 GET 缓存
const URL = `http://127.0.0.1:${PORT}/studio.html?v=${BUILD_TAG}`;

const grab = name => {
  const src = fs.readFileSync(path.join(ROOT, 'studio.js'), 'utf8');
  const m = src.match(new RegExp('const ' + name + '\\s*=\\s*`([\\s\\S]*?)`;'));
  if (!m) throw new Error('studio.js 里没找到 ' + name);
  return m[1];
};
const SHADERS = { VERT: grab('VERT'), FRAG: grab('FRAG') };

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/shaders.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end('window.__SHADERS = ' + JSON.stringify(SHADERS) + ';');
    return;
  }
  const f = path.join(ROOT, u === '/' ? 'studio.html' : u);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(PORT, r));

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log('\n=== shader 真编译（WebGL 里跑 getShaderInfoLog）===\n');

const chrome = await launch();
let page;
try {
  page = await openPage(chrome.port, URL);

  await t('页面加载后没有显示「打不开修图功能」', async () => {
    const r = await page.eval(`(async () => {
      for (let i = 0; i < 100 && !window.Studio; i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      const drop = document.getElementById('stDrop');
      return {
        hasStudio: !!window.Studio,
        msg: drop ? drop.textContent : null,
        detail: drop && drop.querySelector('p') ? drop.querySelector('p').textContent : null
      };
    })()`);
    if (!r.hasStudio) throw new Error('window.Studio 没挂上去（studio.js 可能一开始就抛异常）');
    if (/打不开修图功能/.test(r.msg || '')) {
      throw new Error('boot() 抛异常了：' + (r.detail || '（没拿到错误文本）'));
    }
  });

  for (const [key, label] of [['VERT', '顶点着色器 VERT'], ['FRAG', '片段着色器 FRAG']]) {
    await t(label + ' 编译通过', async () => {
      const isFrag = key === 'FRAG';
      const r = await page.eval(`(async () => {
        if (!window.__SHADERS) {
          await new Promise(ok => {
            const s = document.createElement('script');
            s.src = '/shaders.js'; s.onload = ok;
            document.head.appendChild(s);
          });
        }
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        if (!gl) return { err: '拿不到 WebGL 上下文' };
        const ty = ${isFrag ? 'gl.FRAGMENT_SHADER' : 'gl.VERTEX_SHADER'};
        const src = ${isFrag ? "'precision mediump float;\\n' + " : ''}window.__SHADERS.${key};
        const sh = gl.createShader(ty);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        return { ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS), log: gl.getShaderInfoLog(sh) || '' };
      })()`);
      if (r.err) throw new Error(r.err);
      if (!r.ok) throw new Error('编译失败：\n' + r.log.trim());
    });
  }

  await t('VERT + FRAG 能链成 program（uniform 类型 / 入口签名对得上）', async () => {
    const r = await page.eval(`(async () => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return { err: '拿不到 WebGL 上下文' };
      const S = window.__SHADERS;
      const mk = (ty, src) => {
        const sh = gl.createShader(ty);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        return { sh, log: gl.getShaderInfoLog(sh) || '' };
      };
      const a = mk(gl.VERTEX_SHADER, S.VERT);
      const b = mk(gl.FRAGMENT_SHADER, 'precision mediump float;\\n' + S.FRAG);
      const p = gl.createProgram();
      gl.attachShader(p, a.sh); gl.attachShader(p, b.sh);
      gl.linkProgram(p);
      return {
        ok: gl.getProgramParameter(p, gl.LINK_STATUS),
        log: gl.getProgramInfoLog(p) || '',
        vlog: a.log, flog: b.log
      };
    })()`);
    if (r.err) throw new Error(r.err);
    if (!r.ok) {
      throw new Error('link 失败：' + (r.log.trim() || '（无日志）')
        + (r.vlog ? '\n（VERT）' + r.vlog.trim() : '')
        + (r.flog ? '\n（FRAG）' + r.flog.trim() : ''));
    }
  });
} finally {
  if (page) await page.close();
  shutdown(chrome);
  srv.close();
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
