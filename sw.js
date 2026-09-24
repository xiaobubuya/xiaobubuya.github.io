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
const SHELL = 'shell-v7';
const ASSETS = [
  '/',
  '/index.html',
  '/album.html',
  '/styles.css',
  '/album.css',
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
  '/icon.svg',
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
