/* ================================================================
   Service Worker —— 只缓存「静态外壳」，绝不缓存 API 与照片
   ================================================================
   为什么照片和 API 一律不缓存：
     · 照片是私密的，缓存到共享/持久存储会带来串号与登出后残留的风险
     · API 响应带登录态，缓存会显示过期内容
   外壳（HTML/CSS/JS/图标）不含任何隐私数据，可安全缓存。
   ================================================================ */

// 版本号改了才会重新拉取整个 shell。
// 加文件进来（比如 mask.js）也必须升版本，否则老客户端永远拿不到它 ——
// 表现是「本地测好的功能，线上用起来没反应」。
//
// ⚠️ 这条规则很容易漏：裁剪/旋转那两轮改了 studio.js/css/html
// 但**忘了升这里**（4335d06、82f2597），线上会一直在跑旧外壳。
// 所以「改了 ASSETS 里任何一个文件就得升」应当当成提交前的固定检查项
// （studio.* 和 mask.js 都算）
// 现在 test/sw-version.test.mjs 会守住它。
const SHELL = 'shell-v34';
const ASSETS = [
  '/',
  '/index.html',
  '/album.html',
  '/styles.css',
  '/album.css',
  // 全局导航。⚠️ 每个页面都引它，漏一个的症状是
  // 「在线正常、离线打开没有导航条」—— SW 只是没缓存，在线时浏览器
  // 自己去网络拿得到，所以很难发现（upload.js 就这么漏过一次）。
  '/nav.css',
  '/nav.js',
  '/common.js',
  '/app.js',
  '/album.js',
  '/autolayout.js',
  '/orient.js',
  '/reader.js',
  '/share.html',
  '/share.js',
  '/studio.html',
  '/studio.css',
  '/studio.js',
  '/mask.js',
  // ⚠️ upload.js 一直漏在这里（index.html 引用了它）。
  // 症状很隐蔽：**在线时完全正常**（SW 只是没缓存，
  // 浏览器自己会去网络拿），只有**装了 SW 之后离线打开**才暴露 ——
  // 页面能开、相册能看，但上传按钮点了没反应。
  // 是 test/sw-version.test.mjs 的"ASSETS 要覆盖所有 js/css"抓出来的。
  '/upload.js',
  '/icon.svg',
  // 分享卡片的兜底封面。⚠️ 它同时是**其他站点**（微信爬虫）
  // 要抓的资源 —— 放进 shell 缓存只是让它离线也能显示，
  // 爬虫那边走的是网络，不受影响。
  '/og-cover.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => c.addAll(ASSETS).catch(() => {}))   // 个别失败不影响安装
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 跨域（API、图片）一律直连，不拦截、不缓存
  if (url.origin !== location.origin) return;

  const path = url.pathname;

  /* ---------- 图标 / manifest：缓存优先（几乎不变）---------- */
  if (/\.(svg|png|webmanifest)$/.test(path)) {
    e.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(request, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  /* ---------- 页面 / JS / CSS：网络优先 ----------
     为什么不用缓存优先：那样改了前端文件浏览器会一直吃旧缓存，
     除非每次改都手动升 SHELL 版本号 —— 太容易漏。
     网络优先在离线时仍会回退到缓存，离线可用性不受影响。 */
  if (request.mode === 'navigate' || /\.(html|js|css)$/.test(path) || path === '/') {
    e.respondWith(
      fetch(request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(request, copy)).catch(() => {});
        }
        return res;
      }).catch(() =>
        caches.match(request).then(hit => hit || offlinePage())
      )
    );
  }
});

/** 离线且没缓存时的兜底页 */
function offlinePage() {
  return new Response(
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font:15px/1.7 -apple-system,sans-serif;padding:15vh 24px;text-align:center;' +
    'color:#2b2320;background:#faf7f4">' +
    '<h2 style="font-size:17px;font-weight:600">当前无网络</h2>' +
    '<p style="color:#7d726a;font-size:13.5px;margin-top:8px">连上网络后再打开就能看到照片</p></body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
