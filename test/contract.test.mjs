/* ================================================================
   跨仓库契约检查
   ----------------------------------------------------------------
   这个测试不跑浏览器、不跑 Electron —— 它只比对**两边代码里的约定**。

   存在的理由是一个真实的 bug：preload 暴露的是 window.AlbumStudio
   （大写 A），而页面里读的是 window.albumStudio（小写 a）。
   JS 里这是两个完全不同的变量，所以：

     · 页面上 AI 抠人 / 去物 永远静默失败（hasDesktop() 返回 false）
     · 冒烟测试却是通过的 —— 因为它直接用大写名调 IPC，绕过了页面
     · 单元测试也全过 —— 因为它用假的 window.albumStudio 桩件

   也就是说：三层测试全绿，功能却完全不工作。

   这类「两边约定不一致」的问题，靠运行时测试很难发现，
   静态比对反而最有效。所以单独写一个。
   ================================================================ */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, '..');
const STUDIO = path.join(PAGE, '..', 'album-studio');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

const read = p => fs.readFileSync(p, 'utf8');

console.log('\n=== 跨仓库契约（页面 ↔ 桌面 App）===\n');

const preloadSrc = read(path.join(STUDIO, 'electron', 'preload.js'));
const studioSrc = read(path.join(PAGE, 'studio.js'));

t('preload 暴露的全局名和页面读的一致', () => {
  const m = preloadSrc.match(/exposeInMainWorld\(\s*'([^']+)'/);
  assert.ok(m, 'preload 里没找到 exposeInMainWorld');
  const exposed = m[1];

  // 页面里所有 window.XxxStudio 形式的引用（排除页面自己的 window.Studio）
  const used = new Set(
    (studioSrc.match(/window\.[A-Za-z_$][\w$]*Studio\b/g) || [])
      .map(s => s.replace('window.', ''))
      .filter(n => n !== 'Studio')
  );

  assert.ok(used.size > 0, '页面里没有引用桌面 App 的全局对象？');
  for (const name of used) {
    assert.equal(name, exposed,
      `页面用 window.${name}，但 preload 暴露的是 window.${exposed}。`
      + ' 大小写不一致时 JS 会当成两个变量，功能会静默失效。');
  }
});

t('页面用到的每个 desktop 方法，preload 都暴露了', () => {
  const exposed = new Set(
    (preloadSrc.match(/^\s{2}([a-zA-Z_$][\w$]*)\s*[:(]/gm) || [])
      .map(s => s.trim().replace(/[:(]$/, ''))
  );
  // 页面里调用的：window.AlbumStudio.xxx(
  const called = new Set(
    (studioSrc.match(/window\.AlbumStudio\.([a-zA-Z_$][\w$]*)/g) || [])
      .map(s => s.split('.').pop())
  );

  assert.ok(called.size > 0, '页面没有调用任何桌面能力？');
  const missing = [...called].filter(c => !exposed.has(c));
  assert.equal(missing.length, 0,
    `页面调用了 preload 没暴露的方法：${missing.join(', ')}`);
});

t('IPC 通道两边对得上', () => {
  // preload 里 invoke 的通道名 ←→ main.js 里 handle 的通道名
  const invoked = new Set(
    (preloadSrc.match(/ipcRenderer\.invoke\(\s*'([^']+)'/g) || [])
      .map(s => s.match(/'([^']+)'/)[1])
  );
  const handled = new Set(
    (read(path.join(STUDIO, 'electron', 'main.js'))
      .match(/ipcMain\.handle\(\s*'([^']+)'/g) || [])
      .map(s => s.match(/'([^']+)'/)[1])
  );

  assert.ok(invoked.size > 0, 'preload 没有 invoke 任何通道？');
  const unhandled = [...invoked].filter(c => !handled.has(c));
  assert.equal(unhandled.length, 0,
    `preload 调了但 main 没注册的通道：${unhandled.join(', ')}`);

  // 反向：main 注册了但没人调（不算错，只是提示）
  const unused = [...handled].filter(c => !invoked.has(c));
  if (unused.length) console.log(`     （提示：main 注册但 preload 没用的通道：${unused.join(', ')}）`);
});

t('AI 厂商的 provider 名和密钥白名单一致', () => {
  const vaultApi = read(path.join(PAGE, '..', 'album-api', 'src', 'vault-api.js'));
  const m = vaultApi.match(/const PROVIDERS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, '没找到 PROVIDERS 白名单');
  const allowed = new Set(
    (m[1].match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, ''))
  );

  // 页面里 getKeys('xxx') 用到的名字必须在白名单里
  const used = new Set(
    (studioSrc.match(/getKeys\(\s*'([^']+)'/g) || []).map(s => s.match(/'([^']+)'/)[1])
  );
  for (const u of used) {
    assert.ok(allowed.has(u),
      `页面取密钥用的是 '${u}'，但服务端白名单里没有它（${[...allowed].join(', ')}）`);
  }
});

t('缓存时长两边一致（都是 10 分钟）', () => {
  const client = read(path.join(STUDIO, 'electron', 'vault-client.js'));
  const page = studioSrc;

  const mClient = client.match(/const TTL_MS = (\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
  const mPage = page.match(/const VAULT_TTL = (\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
  assert.ok(mClient, 'vault-client.js 里没找到 TTL_MS');
  assert.ok(mPage, 'studio.js 里没找到 VAULT_TTL');

  const a = mClient.slice(1).reduce((x, y) => x * Number(y), 1);
  const b = mPage.slice(1).reduce((x, y) => x * Number(y), 1);
  assert.equal(a, b, `主进程缓存 ${a}ms，页面缓存 ${b}ms —— 不一致会让"改了密钥"表现得很奇怪`);
  assert.equal(a, 600000, `缓存应该是 10 分钟，实际 ${a / 60000} 分钟`);

  // 服务端也要是 10 分钟
  const vaultApi = read(path.join(PAGE, '..', 'album-api', 'src', 'vault-api.js'));
  const mSrv = vaultApi.match(/const CACHE_TTL = (\d+)/);
  assert.ok(mSrv, 'vault-api.js 里没找到 CACHE_TTL');
  assert.equal(Number(mSrv[1]) * 1000, a,
    `服务端缓存 ${mSrv[1]}s 和客户端 ${a / 1000}s 不一致`);
});

t('页面里没有引用不存在的桌面方法', () => {
  // hasDesktop 的探测条件必须是 preload 真的暴露了的东西
  const m = studioSrc.match(/function hasDesktop\(\)\s*\{([\s\S]*?)\}/);
  assert.ok(m, '没找到 hasDesktop');
  const body = m[1];
  const probe = (body.match(/window\.AlbumStudio\.([\w$]+)/) || [])[1];
  assert.ok(probe, 'hasDesktop 里没有探测任何方法');
  assert.ok(new RegExp(`\\b${probe}\\s*[:(]`).test(preloadSrc),
    `hasDesktop 探测的是 ${probe}，但 preload 没暴露它 —— 会导致桌面能力永远醒不过来`);
});

t('美颜的参数表只有一份（主进程定义，页面读接口）', () => {
  // 这是「接缝」性质的检查，和大小写那次同一个道理：
  // 参数表如果在 main 和页面里各存一份，加参数时漏改一边，
  // 症状是「滑块拖了但没效果」—— 静默失效，最难查。
  const mainSrc = read(path.join(STUDIO, 'electron', 'main.js'));
  assert.ok(mainSrc.includes("require('./ai-megvii.js')"),
    'main.js 没有引入 ai-megvii.js');
  assert.ok(/ipcMain\.handle\(\s*'ai:beautifySchema'/.test(mainSrc),
    'main.js 没有注册 ai:beautifySchema —— 页面就拿不到参数表');

  // 页面必须通过接口读，不能自己写死一份参数名
  assert.ok(/window\.AlbumStudio\.megviiSchema\(/.test(studioSrc),
    '页面没有调用 megviiSchema()，那参数表从哪来？');
  const hardcoded = /\bsmoothing\s*:\s*\d+[^0-9]/.test(studioSrc);
  assert.ok(!hardcoded,
    '页面里出现了写死的美颜参数名（如 smoothing: 45）—— '
    + '参数表必须从 megviiSchema() 读，否则两边会漂移');
});

t('美颜的 data: 前缀只补一次', () => {
  // 旷视回的 result 是裸 base64。补前缀这件事只能在 IPC 那层做一次。
  // 补两次（主进程 + 页面各一次）会变成
  // "data:image/jpeg;base64,data:image/jpeg;base64,..." —— 图片加载不出来，
  // 而且不报错，只是一直不触发 onload，表现成「点了没反应」。
  const mainSrc = read(path.join(STUDIO, 'electron', 'main.js'));
  assert.ok(/data:image\/jpeg;base64,'\s*\+\s*r\.imageB64/.test(mainSrc),
    'main.js 的 ai:beautify 应该补上 data:image/jpeg;base64, 前缀');

  // 页面拿到的是已经带前缀的 image，不该再拼一次
  const rePrefix = /'data:image\/jpeg;base64,'\s*\+\s*[\w.]*beauty[\w.]*/i;
  assert.ok(!rePrefix.test(studioSrc),
    '页面里又给美颜结果补了一次前缀 —— 会拼成双重前缀，图加载不出来');
});

t('美颜的 provider 名在主进程和页面之间一致', () => {
  const mainSrc = read(path.join(STUDIO, 'electron', 'main.js'));
  // 主进程从保险箱取的是 'megvii'
  assert.ok(/vault\.get\(\s*'megvii'\s*\)/.test(mainSrc),
    "main.js 没有用 vault.get('megvii') 取旷视密钥");
  // 页面侧也要用同一个名字（渲染进程负责 prime 给主进程）
  assert.ok(/getKeys\(\s*'megvii'\s*\)/.test(studioSrc),
    "studio.js 没有用 getKeys('megvii') —— 名字不一致的话主进程拿不到密钥");
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
