/* ================================================================
   分享页（只读）
   ================================================================
   拿 URL 里的 token 去换相册内容，然后用和编辑器同一套 reader.js 渲染。
   没有登录、没有编辑、没有相册列表 —— 拿到链接的人只能看这一本。

   图片走 /api/share/<token>/img/...，服务端会确认
   这张照片确实属于这个相册（见 album-api/src/share.js）。
   ================================================================ */
(function () {
  'use strict';

  const PROD_API = 'https://api.muyaya.world';
  const IS_LOCAL = ['localhost', '127.0.0.1', ''].includes(location.hostname);
  const API = IS_LOCAL ? `http://${location.hostname || '127.0.0.1'}:8787` : PROD_API;

  const TOKEN_RE = /^[a-f0-9]{32}$/;
  const token = new URLSearchParams(location.search).get('t') || '';
  const $ = id => document.getElementById(id);

  const imgUrl = key => `${API}/api/share/${token}/img/preview/${key}`;

  (async function boot() {
    if (!TOKEN_RE.test(token)) return fail('链接无效', '这个分享链接的格式不对，可能复制时少了一段。');

    let data;
    try {
      const res = await fetch(`${API}/api/share/${token}`, { credentials: 'omit' });
      if (res.status === 404) {
        return fail('链接已失效', '这本相册的分享可能已经被撤销了。');
      }
      if (!res.ok) {
        return fail('暂时打不开', `服务器返回了 ${res.status}，稍后再试试。`);
      }
      data = await res.json();
    } catch {
      return fail('网络不通', '没能连上服务器，检查一下网络再试。');
    }

    render(data);
  })();

  function render(data) {
    const pages = data.pages || [];
    if (!pages.length) return fail('相册是空的', '这本相册还没有内容。');

    document.title = `${data.album.title} · 相册`;
    $('boot').hidden = true;

    const view = $('shareView');
    view.hidden = false;

    window.BookReader.create(view, {
      pages,
      title: data.album.title,
      imageUrl: imgUrl,
      // 分享页没有「退出到编辑器」这回事，不传 onExit 即不显示退出按钮
      toast: () => {}
    }).open(0);

    // 首次提示：告诉来访者怎么翻页
    const hint = view.querySelector('.read-hint');
    if (hint) {
      hint.textContent = '左右滑动翻页';
      hint.style.opacity = '1';
      setTimeout(() => { hint.style.opacity = '0'; }, 3200);
    }
  }

  function fail(title, msg) {
    $('boot').hidden = true;
    $('shareError').hidden = false;
    $('errTitle').textContent = title;
    $('errMsg').textContent = msg;
    document.title = title;
  }
})();
