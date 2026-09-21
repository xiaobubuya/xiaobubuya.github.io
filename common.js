/* ================================================================
   共享基础模块
   ================================================================
   供 index.html（时间线）与 album.html（相册）共用。
   暴露到 window.ALBUM，普通脚本直接引用，不依赖加载顺序。
   ================================================================ */
window.ALBUM = (function () {
  'use strict';

  const PROD_API = 'https://api.muyaya.world';
  const IS_LOCAL = ['localhost', '127.0.0.1', ''].includes(location.hostname);
  // 本地开发时 API 必须与页面同 host（仅端口不同）——
  // localhost 与 127.0.0.1 属于不同 host，会被浏览器当作跨站，Cookie 不发送。
  const LOCAL_API = `http://${location.hostname || '127.0.0.1'}:8787`;
  const API = IS_LOCAL ? LOCAL_API : PROD_API;

  const el = id => document.getElementById(id);

  /** JSON 请求，统一带 Cookie */
  function api(path, opts = {}) {
    return fetch(API + path, {
      credentials: 'include',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      ...opts
    });
  }

  /* ---------------- 登录态 ---------------- */
  let cachedUser = null;

  async function checkAuth() {
    try {
      const res = await api('/api/me');
      if (!res.ok) return null;
      cachedUser = (await res.json()).user;
      return cachedUser;
    } catch {
      return null;
    }
  }

  /** 未登录则跳回首页（首页有登录表单）。返回用户名或 null。 */
  async function requireAuth() {
    const u = await checkAuth();
    if (!u) {
      location.replace('/?next=' + encodeURIComponent(location.pathname + location.search));
      return null;
    }
    return u;
  }

  async function logout() {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* 忽略 */ }
    location.href = '/';
  }

  /* ---------------- UI 小工具 ---------------- */
  let toastTimer = null;
  function toast(msg, ms = 2400) {
    const t = el('toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  /* ---------------- 时间 ---------------- */
  const CN_OFFSET = 8 * 3600 * 1000;

  const beijingToday = () =>
    new Date(Date.now() + CN_OFFSET).toISOString().slice(0, 10);

  /** 2025-09-18 → 「2025年9月18日 · 星期四」；近两天用「今天 / 昨天」 */
  function dayLabel(day) {
    const [y, m, d] = String(day).split('-').map(Number);
    if (!y || !m || !d) return String(day);
    const dt = new Date(Date.UTC(y, m - 1, d, 4));   // UTC 正午代表这天
    const wd = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][dt.getUTCDay()];

    const today = beijingToday();
    const yest = new Date(Date.now() + CN_OFFSET - 86400000).toISOString().slice(0, 10);
    if (day === today) return `今天 · ${wd}`;
    if (day === yest) return `昨天 · ${wd}`;

    const sameYear = today.slice(0, 4) === String(y);
    return sameYear ? `${m}月${d}日 · ${wd}` : `${y}年${m}月${d}日 · ${wd}`;
  }

  /** 显式按北京时间渲染时刻，避免设备时区不同导致显示不一致 */
  function timeLabel(iso) {
    try {
      return new Date(iso).toLocaleTimeString('zh-CN', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai'
      });
    } catch { return ''; }
  }

  const thumbUrl = k => `${API}/api/img/thumb/${k}`;
  const previewUrl = k => `${API}/api/img/preview/${k}`;

  return {
    API, IS_LOCAL,
    el, api, checkAuth, requireAuth, logout, toast, esc, debounce,
    dayLabel, timeLabel, beijingToday, thumbUrl, previewUrl
  };
})();
