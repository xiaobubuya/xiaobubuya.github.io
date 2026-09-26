/* ================================================================
   我们的婚纱照 — 前端
   ================================================================
   与后端约定（见 album-api/README.md）：
     GET  /api/me                      → { user } | 401
     POST /api/login   {user,pass}     → 200 + 签名 Cookie
     POST /api/logout
     GET  /api/photos?cursor=&limit=   → { photos:[], nextCursor }
     GET  /api/photos/days             → { days:[{day,count}] }
     GET  /api/img/:size/:key          → 图片字节

   安全模型：照片字节全部经 Worker 鉴权后流出，前端只持有 Cookie。
   本文件不含任何密钥。
   ================================================================ */

/* ---------------- 配置 ---------------- */
const PROD_API = 'https://api.muyaya.world';

const IS_LOCAL = ['localhost', '127.0.0.1', ''].includes(location.hostname);
// 本地开发时 API 必须跟页面同 host（仅端口不同）——
// localhost 与 127.0.0.1 属于不同 host，会被浏览器当作跨站，Cookie 不发送。
const LOCAL_API = `http://${location.hostname || '127.0.0.1'}:8787`;
const API = IS_LOCAL ? LOCAL_API : PROD_API;

const PAGE_SIZE = 60;
const SLIDE_MS = 4000;

/* ---------------- DOM ---------------- */
const $ = id => document.getElementById(id);
const el = {
  login: $('login'), loginForm: $('loginForm'), userSeg: $('userSeg'),
  pass: $('pass'), loginBtn: $('loginBtn'), loginError: $('loginError'),

  app: $('app'), meta: $('meta'), timeline: $('timeline'),
  loading: $('loading'), empty: $('empty'), sentinel: $('sentinel'),
  btnMenu: $('btnMenu'), btnTop: $('btnTop'), btnUpload: $('btnUpload'),

  menu: $('menu'), btnSlideshow: $('btnSlideshow'), btnReload: $('btnReload'),
  btnLogout: $('btnLogout'), sheetFoot: $('sheetFoot'),

  viewer: $('viewer'), viewerStage: $('viewerStage'), viewerImg: $('viewerImg'),
  viewerSpinner: $('viewerSpinner'), viewerPos: $('viewerPos'),
  viewerTime: $('viewerTime'), viewerClose: $('viewerClose'),
  viewerEdit: $('viewerEdit'), viewerAdd: $('viewerAdd'),
  viewerPrev: $('viewerPrev'), viewerNext: $('viewerNext'),

  show: $('show'), showImg: $('showImg'), showBar: $('showBar'),
  showToggle: $('showToggle'), showPos: $('showPos'), showExit: $('showExit'),

  toast: $('toast')
};

/* ---------------- 状态 ---------------- */
const state = {
  user: null,
  photos: [],          // 已加载的照片（taken_at 倒序）
  cursor: null,
  loading: false,
  done: false,
  viewerIndex: -1,
  slideTimer: null,
  slideIndex: 0,
  paused: false
};

/** 已见过的照片 key —— 上传时用来跳过重复（内容寻址，key 相同即同一张） */
const knownKeys = new Set();

/* ================================================================
   工具
   ================================================================ */
function toast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.hidden = true; }, ms);
}

/** JSON 请求；统一带 Cookie */
async function api(path, opts = {}) {
  return fetch(API + path, {
    credentials: 'include',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts
  });
}

/** 北京时间的今天（YYYY-MM-DD）—— 与后端 taken_day 口径一致 */
function beijingToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 2025-09-18 → 「2025年9月18日 · 星期四」；近两天用「今天 / 昨天」 */
function dayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  // 用 UTC 正午代表这一天，规避宿主时区影响
  const dt = new Date(Date.UTC(y, m - 1, d, 4));
  const wd = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][dt.getUTCDay()];

  const today = beijingToday();
  const yest = new Date(Date.now() + 8 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  if (day === today) return `今天 · ${wd}`;
  if (day === yest) return `昨天 · ${wd}`;

  const sameYear = today.slice(0, 4) === String(y);
  return sameYear ? `${m}月${d}日 · ${wd}` : `${y}年${m}月${d}日 · ${wd}`;
}

/** 本地时刻（北京时间）—— 显式指定时区，避免设备时区不同导致显示不一致 */
function timeLabel(iso) {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai'
    });
  } catch { return ''; }
}

const thumbUrl = k => `${API}/api/img/thumb/${k}`;
const previewUrl = k => `${API}/api/img/preview/${k}`;

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ================================================================
   认证
   ================================================================ */
let pickedUser = 'yuge';

el.userSeg.addEventListener('click', e => {
  const b = e.target.closest('button[data-user]');
  if (!b) return;
  pickedUser = b.dataset.user;
  [...el.userSeg.children].forEach(x => x.classList.toggle('on', x === b));
});

el.loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  const pass = el.pass.value;
  if (!pass) return;

  el.loginBtn.disabled = true;
  el.loginError.textContent = '';

  try {
    const res = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ user: pickedUser, pass })
    });
    if (res.ok) {
      const d = await res.json();
      state.user = d.user;
      el.pass.value = '';
      await enterApp();
      return;
    }
    el.loginError.textContent = res.status === 429
      ? '尝试太频繁，请 15 分钟后再试'
      : '口令不正确';
  } catch {
    el.loginError.textContent = '连不上服务器，检查网络';
  } finally {
    el.loginBtn.disabled = false;
  }
});

async function checkAuth() {
  try {
    const res = await api('/api/me');
    if (!res.ok) return false;
    state.user = (await res.json()).user;
    return true;
  } catch {
    return false;
  }
}

async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* 忽略 */ }
  location.reload();
}

/* ================================================================
   启动
   ================================================================ */
async function boot() {
  if (await checkAuth()) {
    await enterApp();
  } else {
    el.login.hidden = false;
    el.pass.focus();
  }
}

async function enterApp() {
  el.login.hidden = true;
  el.app.hidden = false;
  // 登录成功才把导航亮出来（登录页上它一直是 hidden 的，见 nav.js）
  if (window.AlbumNav) AlbumNav.show(true);
  el.sheetFoot.textContent = IS_LOCAL ? `开发模式 · ${API}` : `已登录：${state.user}`;

  await loadDays();
  await loadMore();

  const io = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) loadMore();
  }, { rootMargin: '600px' });
  io.observe(el.sentinel);

  addEventListener('scroll', () => { el.btnTop.hidden = scrollY < 900; }, { passive: true });
  addEventListener('resize', debounce(relayout, 120));

  // 恢复上次离开时的滚动位置（切 tab 回来不用从头翻）
  const saved = sessionStorage.getItem('album_scroll');
  if (saved && state.photos.length > 0) {
    setTimeout(() => scrollTo(0, parseInt(saved, 10)), 100);
  }

  // 离开页面时保存滚动位置
  addEventListener('beforeunload', () => {
    sessionStorage.setItem('album_scroll', String(scrollY));
  });
}

/* ================================================================
   时间线
   ================================================================ */
let dayCounts = {};

async function loadDays() {
  try {
    const res = await api('/api/photos/days');
    if (!res.ok) return;
    const d = await res.json();
    const days = d.days || [];
    dayCounts = Object.fromEntries(days.map(x => [x.day, x.count]));
    const total = days.reduce((s, x) => s + x.count, 0);
    el.meta.textContent = total
      ? `共 ${total} 张 · ${days.length} 天`
      : '还没有照片';
  } catch { /* 静默 */ }
}

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  el.loading.hidden = false;

  try {
    const q = new URLSearchParams({ limit: PAGE_SIZE });
    if (state.cursor) q.set('cursor', state.cursor);

    const res = await api('/api/photos?' + q);
    if (res.status === 401) { location.reload(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const d = await res.json();
    const list = d.photos || [];

    if (!list.length) {
      state.done = true;
    } else {
      state.photos.push(...list);
      state.cursor = d.nextCursor;
      if (!d.nextCursor) state.done = true;
      renderNew(list);
    }

    el.empty.hidden = state.photos.length > 0;
  } catch (err) {
    toast('加载失败：' + err.message);
  } finally {
    state.loading = false;
    el.loading.hidden = true;
  }
}

/* ---- 增量渲染：只在末尾追加，避免整表重排 ---- */
function renderNew(list) {
  const groups = [];
  for (const p of list) {
    const day = p.takenDay || (p.takenAt || '').slice(0, 10);
    let g = groups[groups.length - 1];
    if (!g || g.day !== day) { g = { day, items: [] }; groups.push(g); }
    g.items.push(p);
  }

  for (const g of groups) {
    let sec = el.timeline.querySelector(`.day[data-day="${g.day}"]`);

    if (!sec) {
      sec = document.createElement('section');
      sec.className = 'day';
      sec.dataset.day = g.day;

      const h = document.createElement('h2');
      h.className = 'day-title';
      const n = dayCounts[g.day];
      h.innerHTML = `${dayLabel(g.day)}${n ? `<span class="count">${n} 张</span>` : ''}`;

      const grid = document.createElement('div');
      grid.className = 'grid';

      sec.append(h, grid);
      el.timeline.appendChild(sec);
    }

    const grid = sec.querySelector('.grid');
    for (const p of g.items) {
      knownKeys.add(p.k);
      grid.appendChild(makeCell(p));
    }
  }

  relayout();
}

function makeCell(p) {
  const i = state.photos.indexOf(p);

  const c = document.createElement('div');
  c.className = 'cell';
  c.dataset.i = i;

  const ph = document.createElement('div');
  ph.className = 'ph';

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';
  img.src = thumbUrl(p.k);
  img.addEventListener('load', () => c.classList.add('ready'), { once: true });
  img.addEventListener('error', () => c.classList.add('ready'), { once: true });

  c.append(ph, img);

  if (p.pending) {
    const b = document.createElement('div');
    b.className = 'badge';
    b.textContent = '处理中';
    c.appendChild(b);
  }

  c.addEventListener('click', () => openViewer(i));
  return c;
}

/* ---- 行优先瀑布流：用已知宽高比预算高度，图片加载前就占好位，无 CLS ---- */
function relayout() {
  /* ⚠️ 日期标题是 sticky 的，它的 top 要避开**所有**固定在上方的条：
     页面自己的 .topbar + 全局导航的顶栏（`.nav-top`）。
     漏掉导航那一段的症状是：往上滚时日期标题滑到导航底下被压住。
     ⚠️ 导航在手机上是在底部的（`.nav-top` 不可见），
     这时它不该占位 —— 所以按实际可见高度加，而不是按 CSS 变量加。 */
  const topbarH = document.querySelector('.topbar').offsetHeight;
  const navEl = document.querySelector('.nav-top');
  const navH = (navEl && navEl.getBoundingClientRect().height) || 0;
  document.querySelectorAll('.day-title').forEach(t => { t.style.top = (topbarH + navH) + 'px'; });

  const gap = 8, row = 8;

  document.querySelectorAll('.grid').forEach(grid => {
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
    const colW = (grid.clientWidth - (cols - 1) * gap) / cols;

    grid.querySelectorAll('.cell').forEach(cell => {
      const p = state.photos[+cell.dataset.i];
      if (!p || !p.w || !p.h) return;
      const h = colW * (p.h / p.w);
      cell.style.gridRowEnd = `span ${Math.max(1, Math.round((h + gap) / (row + gap)))}`;
    });
  });
}

/* ================================================================
   大图
   ================================================================ */
let touchStart = null;

function openViewer(i) {
  if (i < 0 || i >= state.photos.length) return;
  state.viewerIndex = i;
  el.viewer.hidden = false;
  document.body.style.overflow = 'hidden';
  /* ⚠️ 沉浸态要藏掉底部 tab：大图查看器自己的操作栏就贴在屏幕底部，
     两者叠在一起会互相压住（导航在下、操作栏在上，点不到关闭）。
     约定在 nav.js 的 `immersive()` 里，页面不用知道怎么藏。 */
  if (window.AlbumNav) AlbumNav.immersive(true);
  showViewerImage();
}

function closeViewer() {
  el.viewer.hidden = true;
  el.viewerImg.removeAttribute('src');
  document.body.style.overflow = '';
  state.viewerIndex = -1;
  if (window.AlbumNav) AlbumNav.immersive(false);
}

function showViewerImage() {
  const i = state.viewerIndex;
  const p = state.photos[i];
  if (!p) return;

  el.viewerPos.textContent = `${i + 1} / ${state.photos.length}`;
  el.viewerTime.textContent = timeLabel(p.takenAt);
  el.viewerImg.style.transform = '';

  const thumb = thumbUrl(p.k);
  const big = previewUrl(p.k);

  // 先上缩略图（多半已缓存，瞬时），大图加载完再换 —— 避免白屏
  el.viewerImg.src = thumb;
  el.viewerSpinner.hidden = false;

  const pre = new Image();
  pre.onload = () => {
    if (state.viewerIndex !== i) return;   // 已经切走了
    el.viewerImg.src = big;
    el.viewerSpinner.hidden = true;
  };
  pre.onerror = () => { el.viewerSpinner.hidden = true; };
  pre.src = big;

  // 预加载相邻，滑动更跟手
  [i - 1, i + 1].forEach(j => {
    const q = state.photos[j];
    if (q) new Image().src = previewUrl(q.k);
  });
}

function step(delta) {
  const n = state.photos.length;
  if (!n) return;
  state.viewerIndex = (state.viewerIndex + delta + n) % n;
  showViewerImage();
}

el.viewerClose.addEventListener('click', closeViewer);
el.viewerPrev.addEventListener('click', () => step(-1));
el.viewerNext.addEventListener('click', () => step(1));

/* 「修这张」：带 ?photo=<key> 跳到修图页 */
el.viewerEdit.addEventListener('click', () => {
  const p = state.photos[state.viewerIndex];
  if (!p) return;
  location.href = 'studio.html?photo=' + p.k;
});

/* 「加入相册」：打开选择相册的面板 */
el.viewerAdd.addEventListener('click', () => {
  const p = state.photos[state.viewerIndex];
  if (!p) return;
  openAddToAlbum(p.k);
});

/* ================================================================
   加入相册 —— 从大图查看器把照片加到指定相册的第一页
   ================================================================ */
async function openAddToAlbum(photoKey) {
  // 拉相册列表
  let albums = [];
  try {
    const d = await (await api('/api/albums')).json();
    albums = d.albums || [];
  } catch {
    toast('加载相册失败');
    return;
  }
  if (!albums.length) {
    toast('还没有相册，先去相册页创建一个');
    return;
  }

  // 造一个简单弹窗
  const sheet = document.createElement('div');
  // on-top：这是从大图查看器（z-index 90）里弹出来的，必须盖过它，见 nav.css
  sheet.className = 'nav-sheet on-top';
  sheet.id = 'addToAlbumSheet';
  const mask = document.createElement('div');
  mask.className = 'nav-sheet-mask';
  mask.addEventListener('click', () => sheet.remove());
  sheet.appendChild(mask);

  const body = document.createElement('div');
  body.className = 'nav-sheet-body';
  body.appendChild(Object.assign(document.createElement('div'), {
    className: 'nav-sheet-title', textContent: '加入相册'
  }));

  for (const al of albums) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nav-sheet-item';
    b.textContent = al.title + (al.pageCount ? ' · ' + al.pageCount + ' 页' : ' · 空');
    b.addEventListener('click', async () => {
      sheet.remove();
      await addPhotoToAlbum(al.id, photoKey);
    });
    body.appendChild(b);
  }

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'nav-sheet-item';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => sheet.remove());
  body.appendChild(cancel);

  sheet.appendChild(body);
  document.body.appendChild(sheet);
}

/* 「加入相册」撞乐观并发的重试上限（含第一次，共 3 次）。
   放成常量而不是裸数字：这个值要和下面对失败提示的措辞对上。 */
const ADD_TO_ALBUM_MAX_TRIES = 3;

async function addPhotoToAlbum(albumId, photoKey) {
  // baseVersion 校验是后端乐观并发（PUT /pages/:index 用 version 对账）。
  // 两人同时改同一页时可能撞车（409 conflict）：此时不能直接保存失败，
  // 要重拉最新的排版，把元素按当前坐标重放进去再存。
  for (let attempt = 0; attempt < ADD_TO_ALBUM_MAX_TRIES; attempt++) {
    try {
      // 拉第一页的排版
      const res = await api('/api/albums/' + albumId + '/pages');
      const d = await res.json();
      const page = d.pages && d.pages[0];
      if (!page) { toast('相册没有页面'); return; }

      const layout = page.layout;
      const items = layout.items || [];
      if (items.length >= 40) { toast('这一页最多 40 个元素'); return; }

      // 默认放中间，宽占 40%，按原图比例给高度
      const p = state.photos.find(x => x.k === photoKey);
      const w = 0.40;
      const h = p ? (w * (p.h / p.w)) : 0.3;

      const newItem = {
        id: 'it_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4),
        photo: photoKey,
        x: (1 - w) / 2,
        y: (1 - h) / 2,
        w, h, rot: 0, z: items.length,
        fit: 'cover', radius: 0, caption: ''
      };
      // 拷贝一份再 push，避免直接改到从服务端拿到的对象上出错时留脏数据
      const nextItems = items.concat([newItem]);

      // 保存
      const saveRes = await api('/api/albums/' + albumId + '/pages/0', {
        method: 'PUT',
        body: JSON.stringify({ baseVersion: page.version, layout: { ...layout, items: nextItems } })
      });
      if (saveRes.ok) { toast('已加入相册'); return; }

      const err = await saveRes.json().catch(() => ({}));
      // conflict：重拉最新排版再重放。加新元素不产生交错，直接重来即可。
      // ⚠️ attempt 从 0 起，所以"还有下次"是 attempt < MAX-1。
      if (err.error === 'conflict' && attempt < ADD_TO_ALBUM_MAX_TRIES - 1) continue;

      // 重试次数用尽仍然冲突时要说清楚**这张照片没加进去**，
      // 否则用户只看到一句 conflict，会以为加成功了（或者以为丢的是相册数据）。
      toast(err.error === 'conflict'
        ? `保存冲突，已重试 ${ADD_TO_ALBUM_MAX_TRIES} 次仍未成功，这张照片没有加入相册，请重试`
        : '保存失败：' + (err.error || '未知错误'), 3600);
      return;
    } catch (e) {
      toast('加入相册失败：' + (e && e.message ? e.message : e));
      return;
    }
  }
}

addEventListener('keydown', e => {
  if (el.viewer.hidden) return;
  if (e.key === 'Escape') closeViewer();
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});

// 触摸：左右滑切换，下滑关闭
el.viewerStage.addEventListener('touchstart', e => {
  const t = e.changedTouches[0];
  touchStart = { x: t.clientX, y: t.clientY, t: Date.now() };
}, { passive: true });

el.viewerStage.addEventListener('touchend', e => {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  const dt = Date.now() - touchStart.t;
  touchStart = null;
  if (dt > 800) return;

  if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
    step(dx < 0 ? 1 : -1);
  } else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) {
    closeViewer();
  }
}, { passive: true });

/* ================================================================
   幻灯片
   ================================================================ */
el.btnSlideshow.addEventListener('click', () => {
  closeMenu();
  if (!state.photos.length) { toast('还没有照片'); return; }
  state.slideIndex = Math.max(0, state.viewerIndex);
  el.viewer.hidden = true;
  el.show.hidden = false;
  state.paused = false;
  el.showToggle.textContent = '❚❚';
  showSlide();
  scheduleSlide();
  document.body.style.overflow = 'hidden';
  // 幻灯片也是沉浸态：藏掉底部 tab（它自己的控制条在同一个位置）
  if (window.AlbumNav) AlbumNav.immersive(true);
});

function showSlide() {
  const p = state.photos[state.slideIndex];
  if (!p) return;
  el.showImg.src = previewUrl(p.k);
  el.showPos.textContent = `${state.slideIndex + 1} / ${state.photos.length}`;
  el.showImg.style.animation = 'none';
  void el.showImg.offsetWidth;
  el.showImg.style.animation = '';
}

function scheduleSlide() {
  clearTimeout(state.slideTimer);
  if (state.paused) return;
  state.slideTimer = setTimeout(() => {
    state.slideIndex = (state.slideIndex + 1) % state.photos.length;
    // 播到接近末尾时补拉下一页
    if (state.slideIndex > state.photos.length - 5 && !state.done) loadMore();
    showSlide();
    scheduleSlide();
  }, SLIDE_MS);
}

el.showToggle.addEventListener('click', () => {
  state.paused = !state.paused;
  el.showToggle.textContent = state.paused ? '▶' : '❚❚';
  scheduleSlide();
});

function exitShow() {
  clearTimeout(state.slideTimer);
  el.show.hidden = true;
  el.showImg.removeAttribute('src');
  document.body.style.overflow = '';
  if (window.AlbumNav) AlbumNav.immersive(false);
}

el.showExit.addEventListener('click', exitShow);

el.show.addEventListener('click', e => {
  if (e.target.closest('.show-bar')) return;
  el.showBar.classList.toggle('hide');
});

// 切到后台暂停（省流量，也避免回来时突然跳）
document.addEventListener('visibilitychange', () => {
  if (el.show.hidden) return;
  state.paused = document.hidden;
  el.showToggle.textContent = state.paused ? '▶' : '❚❚';
  scheduleSlide();
});

/* ================================================================
   全局导航（nav.js）的动作
   ----------------------------------------------------------------
   ⚠️ 导航只负责"我在哪、能去哪"，具体动作归页面 ——
   所以这里是页面**接收** nav:action 事件，而不是让 nav.js 知道上传怎么走。
   这样以后把"上传"挪到别的位置（甚至手机底部），这里一行都不用改。
   ================================================================ */
window.addEventListener('nav:action', e => {
  const a = e.detail && e.detail.action;
  if (a === 'upload') {
    // ⚠️ upload.js 还没装好时点了不该报错，只提示
    if (window.AlbumUpload && AlbumUpload.pick) AlbumUpload.pick();
    else toast('上传还没准备好，稍等一下');
  } else if (a === 'slideshow') {
    el.btnSlideshow.click();          // 复用既有逻辑，别抄一遍
  } else if (a === 'reload') {
    location.reload();
  } else if (a === 'logout') {
    logout();
  }
});

/* ================================================================
   菜单
   ================================================================ */
function closeMenu() { el.menu.hidden = true; }
el.btnMenu.addEventListener('click', () => { el.menu.hidden = false; });
el.menu.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeMenu(); });
el.btnReload.addEventListener('click', () => location.reload());
el.btnLogout.addEventListener('click', logout);
el.btnTop.addEventListener('click', () => scrollTo({ top: 0, behavior: 'smooth' }));

/* ================================================================
   上传
   ================================================================ */
if (window.AlbumUpload) {
  AlbumUpload.install({
    API,
    toast,
    knownKeys,

    // 新照片可能插在时间线的任何位置（EXIF 日期可能很旧），
    // 增量插入要处理分组边界，直接重载最稳。
    onDone: async () => {
      state.photos = [];
      state.cursor = null;
      state.done = false;
      state.viewerIndex = -1;
      el.timeline.innerHTML = '';
      await loadDays();
      await loadMore();
      scrollTo({ top: 0 });
    }
  });

  el.btnUpload.addEventListener('click', () => AlbumUpload.pick());
}

/* ================================================================
   启动
   ================================================================ */
boot();

/* PWA：只在 https 下注册（本地 http 调试不注册，避免缓存干扰） */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 忽略 */ });
  });
}
