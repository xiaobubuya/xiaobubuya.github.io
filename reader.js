/* ================================================================
   书本式阅读器（编辑器与分享页共用）
   ================================================================
   自己生成 DOM，调用方只给一个容器和几个回调 ——
   这样相册编辑器和只读分享页用的是同一套代码，
   书脊、翻页动画、页码、单页/跨页这些视觉完全一致。

   翻页原理（向前翻为例）：
     底层：  左 = 旧左页      右 = 新右页   ← 翻的过程中逐渐露出来
     翻页层：正面 = 旧右页    背面 = 新左页
     绕书脊从 0° 转到 -180°，就盖到左边去了。
   向后翻是对称的。

   用法：
     const reader = BookReader.create(containerEl, {
       pages, title, imageUrl, startPage,
       onExit, onPageChange, toast
     });
   ================================================================ */
(function (root) {
  'use strict';

  const twoFrames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = ms => new Promise(r => setTimeout(r, ms));

  function create(container, o) {
    const opts = Object.assign({
      pages: [],
      title: '',
      imageUrl: () => '',
      startPage: 0,
      onExit: null,
      onPageChange: null,
      toast: () => {},
      autoSingle: true
    }, o || {});

    /* ---------------- 状态 ---------------- */
    const R = { spread: 0, single: false, flipping: false };
    // 用户手动切过单页/跨页就不再自动跟随屏幕比例
    let manualMode = false;

    const pages = () => opts.pages;
    const totalSpreads = () => Math.max(1, Math.ceil(pages().length / 2));
    const bookRatio = () => (pages()[0] && pages()[0].layout.canvas.ratio) || 1.5;
    const slideCount = () => (R.single ? pages().length : totalSpreads());
    const canPrev = () => R.spread > 0;
    const canNext = () => R.spread < slideCount() - 1;

    /* ---------------- DOM ---------------- */
    container.innerHTML = `
      <div class="read-stage">
        <div class="book">
          <div class="book-side left"></div>
          <div class="book-side right"></div>
          <div class="book-spine"></div>
          <div class="book-flip" hidden>
            <div class="face front"></div>
            <div class="face back"></div>
          </div>
        </div>
        <div class="read-hint"></div>
      </div>
      <div class="read-bar">
        ${opts.onExit ? '<button class="icon-btn light br-exit" title="退出">✕</button>' : ''}
        <span class="read-title"></span>
        <span class="read-pos"></span>
        <button class="icon-btn light br-rotate" title="横屏查看">⟳</button>
        <button class="icon-btn light br-mode" title="跨页 / 单页">▥</button>
      </div>`;

    const $ = sel => container.querySelector(sel);
    const stage = $('.read-stage');
    const book = $('.book');
    const sideL = $('.book-side.left');
    const sideR = $('.book-side.right');
    const flip = $('.book-flip');
    const flipFront = $('.book-flip .face.front');
    const flipBack = $('.book-flip .face.back');

    $('.read-title').textContent = opts.title;

    if (opts.onExit) $('.br-exit').addEventListener('click', () => opts.onExit());

    /* ---------------- 尺寸 ---------------- */
    function layoutBook() {
      const cols = R.single ? 1 : 2;
      const ratio = bookRatio();
      const availW = Math.max(120, stage.clientWidth - 34);
      const availH = Math.max(90, stage.clientHeight - 96);

      let w = availW;
      let h = w / (cols * ratio);
      if (h > availH) { h = availH; w = h * cols * ratio; }

      const sideW = Math.max(60, w / cols);
      book.style.width = (sideW * cols) + 'px';
      book.style.height = h + 'px';
      for (const s of [sideL, sideR]) {
        s.style.width = sideW + 'px';
        s.style.height = h + 'px';
      }
    }

    /* ---------------- 渲染单页 ---------------- */
    function renderSide(box, idx, align) {
      box.innerHTML = '';
      const p = pages()[idx];

      if (!p) {
        // 跨页的另一半没有内容 —— 留一张空白纸，像书的最后一页
        box.style.background = '#fdfcfa';
        return;
      }

      box.style.background = (p.layout.canvas && p.layout.canvas.bg) || '#ffffff';

      p.layout.items.forEach((it, i) => {
        const d = document.createElement('div');
        d.className = 'item';
        d.style.cssText =
          `left:${it.x * 100}%;top:${it.y * 100}%;` +
          `width:${it.w * 100}%;height:${it.h * 100}%;` +
          `transform:rotate(${it.rot}deg);z-index:${i + 1};cursor:default`;

        const wrap = document.createElement('div');
        wrap.className = 'img';
        const img = document.createElement('img');
        img.src = opts.imageUrl(it.photo);
        img.alt = '';
        img.draggable = false;
        if (it.fit === 'contain') img.style.objectFit = 'contain';
        wrap.appendChild(img);
        d.appendChild(wrap);

        if (it.caption) {
          const cap = document.createElement('div');
          cap.className = 'cap';
          cap.textContent = it.caption;
          d.appendChild(cap);
        }
        box.appendChild(d);
      });

      if (align) {
        const n = document.createElement('div');
        n.className = 'pgno ' + align;
        n.textContent = String(idx + 1);
        box.appendChild(n);
      }
    }

    /* ---------------- 渲染当前跨页 ---------------- */
    function updateBar() {
      const n = pages().length;
      $('.read-pos').textContent = R.single
        ? `${Math.min(R.spread + 1, n)} / ${n}`
        : (() => {
            const l = R.spread * 2 + 1;
            const rr = Math.min(l + 1, n);
            return l === rr ? `${l} / ${n}` : `${l}-${rr} / ${n}`;
          })();
      const mb = $('.br-mode');
      mb.textContent = R.single ? '▯' : '▥';
      mb.title = R.single ? '切到跨页（像翻书）' : '切到单页（窄屏更好看）';
    }

    function preloadAround() {
      const from = R.single ? R.spread : R.spread * 2;
      const idxs = R.single
        ? [R.spread - 1, R.spread + 1]
        : [from - 2, from - 1, from + 2, from + 3];
      for (const i of idxs) {
        const p = pages()[i];
        if (p) for (const it of p.layout.items) new Image().src = opts.imageUrl(it.photo);
      }
    }

    function render() {
      book.classList.toggle('single', R.single);
      layoutBook();

      if (R.single) {
        renderSide(sideR, R.spread, 'right');
      } else {
        const l = R.spread * 2;
        renderSide(sideL, l, 'left');
        renderSide(sideR, l + 1, 'right');
      }
      updateBar();
      preloadAround();
      if (opts.onPageChange) opts.onPageChange(R.single ? R.spread : R.spread * 2);
    }

    /* ---------------- 翻页 ---------------- */
    function beginFlip(dir) {
      if (dir === 1 && !canNext()) return false;
      if (dir === -1 && !canPrev()) return false;
      if (R.single) return true;

      const cur = R.spread;
      if (dir === 1) {
        const nxt = cur + 1;
        renderSide(sideL, cur * 2, 'left');
        renderSide(sideR, nxt * 2 + 1, 'right');
        renderSide(flipFront, cur * 2 + 1, 'right');
        renderSide(flipBack, nxt * 2, 'left');
        flip.className = 'book-flip fwd';
      } else {
        const prv = cur - 1;
        renderSide(sideL, prv * 2, 'left');
        renderSide(sideR, cur * 2 + 1, 'right');
        renderSide(flipFront, cur * 2, 'left');
        renderSide(flipBack, prv * 2 + 1, 'right');
        flip.className = 'book-flip bwd';
      }
      flip.hidden = false;
      flip.style.transition = 'none';
      flip.style.transform = 'rotateY(0deg)';
      return true;
    }

    function applyProgress(dir, p) {
      if (R.single) return;
      flip.style.transform = `rotateY(${(dir === 1 ? -180 : 180) * p}deg)`;
    }

    function animateFlip(dir, target) {
      if (R.single) return wait(150);
      flip.style.transition = '';
      void flip.offsetWidth;
      flip.style.transform = `rotateY(${(dir === 1 ? -180 : 180) * target}deg)`;
      return wait(target === 1 ? 620 : 360);
    }

    function finishFlip(dir, landed) {
      flip.hidden = true;
      flip.style.transition = 'none';
      flip.style.transform = '';
      void flip.offsetWidth;
      flip.style.transition = '';
      if (landed) R.spread += dir;
      render();
    }

    async function turnPage(dir) {
      if (R.flipping) return;
      if (dir === 1 && !canNext()) return;
      if (dir === -1 && !canPrev()) return;
      R.flipping = true;

      if (R.single) {
        sideR.style.transition = 'opacity .16s';
        sideR.style.opacity = '0';
        await wait(165);
        R.spread += dir;
        render();
        sideR.style.opacity = '1';
        await wait(165);
        sideR.style.transition = '';
      } else if (beginFlip(dir)) {
        await twoFrames();
        await animateFlip(dir, 1);
        finishFlip(dir, true);
      }
      R.flipping = false;
    }

    /* ---- 拖动翻页 ---- */
    let drag = null;

    stage.addEventListener('pointerdown', e => {
      if (R.flipping) return;
      if (e.button !== undefined && e.button !== 0) return;
      drag = { x0: e.clientX, y0: e.clientY, t0: performance.now(),
               id: e.pointerId, dir: 0, progress: 0, armed: false, moved: 0 };
    });

    stage.addEventListener('pointermove', e => {
      const d = drag;
      if (!d || e.pointerId !== d.id) return;

      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;
      d.moved = Math.abs(dx);

      if (!d.armed) {
        if (Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
        const dir = dx < 0 ? 1 : -1;
        if ((dir === 1 && !canNext()) || (dir === -1 && !canPrev())) return;
        if (!beginFlip(dir)) return;
        d.armed = true;
        d.dir = dir;
        stage.classList.add('dragging');
        try { stage.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      }

      const span = Math.max(160, stage.clientWidth * 0.70);
      d.progress = Math.min(1, Math.max(0, Math.abs(dx) / span));

      if (R.single) {
        book.style.transform = `translateX(${-dx * 0.22}px)`;
      } else {
        applyProgress(d.dir, d.progress);
        e.preventDefault();
      }
    });

    function endDrag(e) {
      const d = drag;
      drag = null;
      stage.classList.remove('dragging');
      if (!d || !d.armed) return;
      if (e && e.pointerId !== undefined && e.pointerId !== d.id) return;

      const dt = Math.max(1, performance.now() - d.t0);
      const speed = d.moved / dt;
      const land = d.progress >= 0.35 || speed > 0.5;

      R.flipping = true;
      (async () => {
        if (R.single) {
          sideR.style.transition = 'opacity .15s';
          sideR.style.opacity = '0';
          await wait(155);
          if (land) R.spread += d.dir;
          book.style.transform = '';
          render();
          sideR.style.opacity = '1';
          await wait(155);
          sideR.style.transition = '';
        } else {
          await animateFlip(d.dir, land ? 1 : 0);
          finishFlip(d.dir, land);
        }
        R.flipping = false;
      })();
    }

    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    /* ---- 键盘 ---- */
    function onKey(e) {
      if (container.hidden) return;
      if (e.key === 'Escape' && opts.onExit) { opts.onExit(); return; }
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); turnPage(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); turnPage(-1); }
    }
    document.addEventListener('keydown', onKey);

    /* ---- 单页 / 跨页 ---- */
    /** 竖屏（宽高比不够）用单页，否则跨页。手动切过就不再自动跟随 */
    function applyAutoMode() {
      if (manualMode) return false;
      const next = opts.autoSingle
        ? (window.innerWidth / window.innerHeight) < 1.15
        : false;
      const changed = next !== R.single;
      R.single = next;
      return changed;
    }

    $('.br-mode').addEventListener('click', () => {
      const page = R.single ? R.spread : R.spread * 2;
      manualMode = true;
      R.single = !R.single;
      R.spread = R.single
        ? Math.min(page, pages().length - 1)
        : Math.floor(page / 2);
      render();
      opts.toast(R.single ? '单页模式' : '跨页模式');
    });

    /* ---- 横屏 ---- */
    $('.br-rotate').addEventListener('click', async () => {
      const O = root.Orient;
      if (!O) { opts.toast('请把手机横过来'); return; }

      if (O.isLocked()) {
        await O.unlock();
        opts.toast('已恢复竖屏');
        // 交回自动判断
        manualMode = false;
        setTimeout(() => { applyAutoMode(); render(); }, 250);
        return;
      }

      try {
        const how = await O.lockLandscape();
        manualMode = false;          // 横屏后让跨页自动生效
        opts.toast(how === 'fullscreen' ? '已切横屏（全屏中）' : '已切横屏');
        setTimeout(() => { applyAutoMode(); render(); }, 350);
      } catch {
        // iOS Safari 没有这个能力，如实告诉用户，不要假装切了
        opts.toast('这个浏览器不能自动转屏，请把手机横过来', 3800);
      }
    });

    const onResize = () => {
      const wasSingle = R.single;
      const changed = applyAutoMode();
      if (changed) {
        // 方向变了导致单页↔跨页切换 —— 按当前页重新定位，别跳页
        const page = wasSingle ? R.spread : R.spread * 2;
        R.spread = R.single ? page : Math.floor(page / 2);
        R.spread = Math.max(0, Math.min(R.spread, slideCount() - 1));
        render();
      } else {
        layoutBook();
      }
    };
    window.addEventListener('resize', onResize);
    if (root.Orient) {
      root.Orient.onChange(() => {
        const b = $('.br-rotate');
        if (b) b.style.color = root.Orient.isLocked() ? '#5b9bd5' : '';
      });
    }

    /* ---- 与调用方的接口 ---- */
    function open(startPage) {
      const start = Math.max(0, startPage || 0);
      applyAutoMode();
      R.spread = R.single
        ? Math.min(start, Math.max(0, pages().length - 1))
        : Math.floor(start / 2);
      render();
      return R.single;
    }

    function destroy() {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      container.innerHTML = '';
    }

    return {
      open,
      render,
      turnPage,
      destroy,
      setPages(next) { opts.pages = next; render(); },
      isSingle: () => R.single,
      currentPage: () => (R.single ? R.spread : R.spread * 2)
    };
  }

  root.BookReader = { create };
})(typeof window !== 'undefined' ? window : globalThis);
