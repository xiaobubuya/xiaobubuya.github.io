/* ================================================================
   相册页 —— 列表 / 自由排版编辑器 / 翻页阅读器
   ================================================================
   排版数据用归一化坐标（0~1），与屏幕尺寸无关，
   所以编辑器所见 = 阅读器所得，手机与桌面也一致。

   交互全部在「像素空间」里算再换算回归一化 ——
   归一化坐标不是等比的，直接在里面算旋转会导致角度失真。
   ================================================================ */
(function () {
  'use strict';

  const A = window.ALBUM;
  const el = A.el;

  /* ---------------- 状态 ---------------- */
  const S = {
    view: 'list',
    albums: [],
    album: null,          // { id, title, pageCount, coverKey }
    pages: [],            // [{ index, layout:{canvas,items}, version }]
    cur: 0,
    sel: null,            // 选中元素的 id
    undo: [], redo: [],
    dirty: false,
    saveTimer: null,
    saving: false,
    conflict: null,
    drag: null,
    touch: null,
    photos: [], photosLoaded: false,
    picking: false
  };

  const RATIOS = [1.5, 1.3333, 1, 0.75, 0.6667];
  const GAP_PX = 8, SNAP_PX = 8, MIN_ITEM_PX = 36;

  /* 画布缩放档位。竖屏手机上 3:2 横版画布只能占屏幕一小条，
     元素显得很小、不好点，放大后编辑会舒服很多。 */
  const ZOOMS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  let zoomIdx = 0;
  const zoomFactor = () => ZOOMS[zoomIdx];

  const page = () => S.pages[S.cur];
  const curLayout = () => page() && page().layout;
  const curRatio = () => (curLayout() && curLayout().canvas.ratio) || 1.5;

  const ratioLabel = r => {
    const map = { '1.5': '3:2', '1.3333': '4:3', '1': '1:1', '0.75': '3:4', '0.6667': '2:3' };
    return map[String(r)] || Number(r).toFixed(2);
  };

  /**
   * 元素 id。
   * ⚠️ 必须跨会话唯一 —— 早期版本用的是会话内自增计数器，
   * 刷新页面后计数归零，再添加元素就会和上一轮的 id 撞上，
   * 表现为「一次选中两个元素」，而且改的其实是第一个。
   * 现在用随机串，撞车概率可以忽略。
   */
  function newId() {
    const r = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    return 'it_' + r.slice(0, 11);
  }

  /**
   * 修复历史数据里重复的元素 id。
   * 发现重复就重新分配，保证同一页内唯一。
   * @returns {number} 修好的个数
   */
  function repairItemIds(pages) {
    let fixed = 0;
    for (const p of pages) {
      const seen = new Set();
      for (const it of (p.layout && p.layout.items) || []) {
        if (!it.id || seen.has(it.id)) {
          it.id = newId();
          fixed++;
        }
        seen.add(it.id);
      }
    }
    return fixed;
  }

  /* ================================================================
     视图切换
     ================================================================ */
  function show(view) {
    S.view = view;
    el('listView').hidden = view !== 'list';
    el('editView').hidden = view !== 'edit';
    el('readView').hidden = view !== 'read';
    document.body.style.overflow = view === 'edit' ? 'hidden' : '';
    if (view === 'edit') {
      requestAnimationFrame(() => { fitCanvas(); relayoutTray(); });
    }
  }

  /* ================================================================
     相册列表
     ================================================================ */
  async function loadAlbums() {
    try {
      const d = await (await A.api('/api/albums')).json();
      S.albums = d.albums || [];
    } catch {
      S.albums = [];
      A.toast('加载相册失败');
    }
    renderAlbums();
  }

  function renderAlbums() {
    const grid = el('albumGrid');
    grid.innerHTML = '';
    el('listEmpty').hidden = S.albums.length > 0;
    el('listMeta').textContent = S.albums.length
      ? `${S.albums.length} 本相册`
      : '还没有相册';

    for (const al of S.albums) {
      const card = document.createElement('div');
      card.className = 'album-card';

      const cover = document.createElement('div');
      cover.className = 'album-cover' + (al.coverKey ? '' : ' empty');
      if (al.coverKey) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = A.thumbUrl(al.coverKey);
        cover.appendChild(img);
      }

      const meta = document.createElement('div');
      meta.className = 'album-meta';
      meta.innerHTML =
        `<div class="album-name">${A.esc(al.title)}</div>` +
        `<div class="album-sub">${al.pageCount} 页</div>`;

      card.append(cover, meta);
      card.addEventListener('click', () => openAlbum(al.id));
      grid.appendChild(card);
    }
  }

  /* ================================================================
     打开相册
     ================================================================ */
  async function openAlbum(id) {
    try {
      const res = await A.api('/api/albums/' + id + '/pages');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      S.album = d.album;
      S.pages = d.pages || [];
      if (!S.pages.length) {
        S.pages = [{ index: 0, version: 1, layout: { canvas: { ratio: 1.5, bg: '#fff' }, items: [] } }];
      }
      S.cur = 0;
      S.sel = null;
      S.undo = []; S.redo = [];

      // 修掉历史数据里重复的元素 id（早期版本的计数器会撞车）
      const fixed = repairItemIds(S.pages);
      if (fixed) {
        A.toast(`修复了 ${fixed} 个重复的元素编号`);
        scheduleSave();
      }

      el('albumTitle').value = S.album.title;
      show('edit');
      renderEditor();
      setSaveState('', '');
    } catch (e) {
      A.toast('打开失败：' + e.message);
    }
  }

  /* ================================================================
     画布尺寸与缩放
     ================================================================ */
  let baseW = 0, baseH = 0;   // 适应屏幕时的尺寸（缩放前的基准）

  function fitCanvas() {
    const stage = el('stage');
    const c = el('canvas');
    if (!stage || !c) return;
    const pad = 24;
    const aw = Math.max(60, stage.clientWidth - pad);
    const ah = Math.max(40, stage.clientHeight - pad);

    let w = aw, h = w / curRatio();
    if (h > ah) { h = ah; w = h * curRatio(); }
    baseW = w; baseH = h;

    const z = zoomFactor();
    c.style.width = (w * z) + 'px';
    c.style.height = (h * z) + 'px';
    updateZoomLabel();
  }

  function updateZoomLabel() {
    el('btnZoom').textContent = Math.round(zoomFactor() * 100) + '%';
    el('btnZoomOut').disabled = zoomIdx === 0;
    el('btnZoomIn').disabled = zoomIdx === ZOOMS.length - 1;
  }

  /** 切档位；keepCenter=true 时尽量把可视中心留在原处 */
  function setZoom(i, keepCenter) {
    const stage = el('stage');
    const oldZ = zoomFactor();
    const cx = baseW ? (stage.scrollLeft + stage.clientWidth / 2) / (baseW * oldZ) : 0.5;
    const cy = baseH ? (stage.scrollTop + stage.clientHeight / 2) / (baseH * oldZ) : 0.5;

    zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, i));
    fitCanvas();

    if (keepCenter && baseW && baseH) {
      const z = zoomFactor();
      stage.scrollLeft = cx * baseW * z - stage.clientWidth / 2;
      stage.scrollTop = cy * baseH * z - stage.clientHeight / 2;
    }
  }

  el('btnZoomIn').addEventListener('click', () => setZoom(zoomIdx + 1, true));
  el('btnZoomOut').addEventListener('click', () => setZoom(zoomIdx - 1, true));
  el('btnZoom').addEventListener('click', () => setZoom(0, false));

  const CW = () => el('canvas').clientWidth;
  const CH = () => el('canvas').clientHeight;

  /* ================================================================
     编辑器渲染
     ================================================================ */
  function renderEditor() {
    const p = page();
    if (!p) return;

    el('btnPage').textContent = `${S.cur + 1}/${S.pages.length}`;
    el('btnRatio').textContent = ratioLabel(p.layout.canvas.ratio);
    el('btnUndo').disabled = S.undo.length === 0;
    el('btnRedo').disabled = S.redo.length === 0;
    el('btnDelPage').disabled = S.pages.length <= 1;
    const hasSel = !!S.sel;
    for (const id of ['btnFront','btnUp','btnDown','btnBack2','btnDelItem','btnSetCover']) {
      el(id).disabled = !hasSel;
    }
    el('btnNextItem').disabled = p.layout.items.length === 0;
    // 选中的这张是不是当前生效的封面
    const selItem = hasSel ? p.layout.items.find(x => x.id === S.sel) : null;
    const isCover = !!(selItem && S.album.coverKey === selItem.photo);
    const btnCover = el('btnSetCover');
    btnCover.textContent = isCover ? '★' : '☆';
    btnCover.style.color = isCover ? 'var(--accent)' : '';
    btnCover.title = isCover
      ? (S.album.coverAuto ? '当前封面（自动取第一页第一张）' : '已手动设为封面，再点一次恢复自动')
      : '设为封面';

    const layer = el('itemLayer');
    layer.innerHTML = '';

    // 按 z 排序渲染（数组顺序即层级，索引越大越靠上）
    const items = p.layout.items;
    items.forEach((it, i) => {
      const div = document.createElement('div');
      div.className = 'item' + (S.sel === it.id ? ' sel' : '');
      div.dataset.id = it.id;
      div.style.cssText =
        `left:${it.x * 100}%;top:${it.y * 100}%;` +
        `width:${it.w * 100}%;height:${it.h * 100}%;` +
        `transform:rotate(${it.rot}deg);z-index:${i + 1}`;

      const wrap = document.createElement('div');
      wrap.className = 'img';
      const img = document.createElement('img');
      img.src = A.previewUrl(it.photo);   // 编辑时用高清档，排得准
      img.alt = '';
      img.draggable = false;
      wrap.appendChild(img);
      div.appendChild(wrap);

      if (it.caption) {
        const cap = document.createElement('div');
        cap.className = 'cap';
        cap.textContent = it.caption;
        div.appendChild(cap);
      }

      if (S.sel === it.id) {
        for (const h of ['rot', 'nw', 'ne', 'sw', 'se']) {
          const hd = document.createElement('div');
          hd.className = 'handle ' + h;
          hd.dataset.h = h;
          div.appendChild(hd);
        }
      }

      layer.appendChild(div);
    });

    renderTray();
    fitCanvas();
  }

  /* ================================================================
     交互：移动 / 缩放 / 旋转（像素空间 + 吸附）
     ================================================================ */
  const toPx = (it, W, H) => ({ x: it.x * W, y: it.y * H, w: it.w * W, h: it.h * H });
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function snapAxis(nx, size, total, others, vertical) {
    // 阈值换算成画布坐标：希望「屏幕上 8px 内吸附」，
    // 放大后画布坐标被拉大，阈值要相应缩小，否则吸附会变得过黏
    const tol = SNAP_PX / zoomFactor();

    const lines = [0, total / 2, total];
    for (const o of others) {
      if (vertical) lines.push(o.x, o.x + o.w / 2, o.x + o.w);
      else lines.push(o.y, o.y + o.h / 2, o.y + o.h);
    }
    let best = null;
    for (const anchor of [nx, nx + size / 2, nx + size]) {
      for (const L of lines) {
        const d = L - anchor;
        if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) {
          best = { d, line: L };
        }
      }
    }
    return best;
  }

  /** 放大后把选中的元素滚进视野 —— 从托盘或 ⇄ 选中时用 */
  function revealSelected() {
    if (zoomFactor() <= 1) return;
    const node = el('itemLayer').querySelector('.item.sel');
    if (!node) return;
    try {
      node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    } catch { /* 老浏览器忽略 */ }
  }

  function showGuides(vx, hy) {
    const g = el('guides');
    const gv = g.querySelector('.v'), gh = g.querySelector('.h');
    gv.style.display = vx == null ? 'none' : 'block';
    gh.style.display = hy == null ? 'none' : 'block';
    if (vx != null) gv.style.left = vx + 'px';
    if (hy != null) gh.style.top = hy + 'px';
  }

  el('canvas').addEventListener('pointerdown', e => {
    const handleEl = e.target.closest('.handle');
    const itemEl = e.target.closest('.item');
    const items = curLayout().items;

    if (handleEl && itemEl) {
      const it = items.find(x => x.id === itemEl.dataset.id);
      if (!it) return;
      e.preventDefault();

      const W = CW(), H = CH();
      const px = toPx(it, W, H);
      const rect = el('canvas').getBoundingClientRect();
      // 撤销快照先攒着，等真的改动了再入栈（避免点一下没拖也压栈）
      const snap = snapshot();

      if (handleEl.dataset.h === 'rot') {
        const cx = px.x + px.w / 2, cy = px.y + px.h / 2;
        const a0 = Math.atan2(e.clientY - rect.top - cy, e.clientX - rect.left - cx) * 180 / Math.PI;
        S.drag = { mode: 'rot', it, px, cx, cy, offset: it.rot - a0, snap, moved: false };
      } else {
        const sx = handleEl.dataset.h.includes('e') ? 1 : -1;
        const sy = handleEl.dataset.h.includes('s') ? 1 : -1;
        S.drag = { mode: 'resize', it, px, sx, sy, W, H, snap, moved: false,
                   startX: e.clientX, startY: e.clientY };
      }
      bindDrag();
      return;
    }

    if (itemEl) {
      const it = items.find(x => x.id === itemEl.dataset.id);
      if (!it) return;
      e.preventDefault();
      if (S.sel !== it.id) { S.sel = it.id; renderEditor(); }

      const W = CW(), H = CH();
      S.drag = { mode: 'move', it, px: toPx(it, W, H), W, H,
                 startX: e.clientX, startY: e.clientY, moved: false, snap: snapshot() };
      bindDrag();
      return;
    }

    if (S.sel) { S.sel = null; renderEditor(); }
  });

  function bindDrag() {
    document.addEventListener('pointermove', onDrag);
    document.addEventListener('pointerup', endDrag, { once: true });
    document.addEventListener('pointercancel', endDrag, { once: true });
  }

  function onDrag(e) {
    const d = S.drag;
    if (!d) return;
    e.preventDefault();
    const node = el('itemLayer').querySelector(`[data-id="${d.it.id}"]`);
    if (!node) return;

    const { it, px, W, H } = d;

    /* ---- 移动 ---- */
    if (d.mode === 'move') {
      // 用位移量驱动而非绝对位置 —— 手指不会挡住目标
      let nx = px.x + (e.clientX - d.startX);
      let ny = px.y + (e.clientY - d.startY);
      d.moved = true;

      const others = curLayout().items.filter(o => o.id !== it.id).map(o => toPx(o, W, H));
      const sx = snapAxis(nx, px.w, W, others, true);
      const sy = snapAxis(ny, px.h, H, others, false);
      if (sx) nx += sx.d;
      if (sy) ny += sy.d;
      showGuides(sx ? sx.line : null, sy ? sy.line : null);

      nx = clamp(nx, 0, Math.max(0, W - px.w));
      ny = clamp(ny, 0, Math.max(0, H - px.h));

      it.x = nx / W; it.y = ny / H;
      node.style.left = (it.x * 100) + '%';
      node.style.top = (it.y * 100) + '%';
      return;
    }

    /* ---- 缩放（对角锚定，旋转下依然正确）---- */
    if (d.mode === 'resize') {
      d.moved = true;
      const rad = it.rot * Math.PI / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
      const ldx = dx * cos + dy * sin;      // 投影到元素自身坐标轴
      const ldy = -dx * sin + dy * cos;

      const nw = Math.max(MIN_ITEM_PX, px.w + d.sx * ldx);
      const nh = Math.max(MIN_ITEM_PX, px.h + d.sy * ldy);

      const cx0 = px.x + px.w / 2, cy0 = px.y + px.h / 2;
      const fx = -d.sx * px.w / 2, fy = -d.sy * px.h / 2;
      const fsx = cx0 + fx * cos - fy * sin;
      const fsy = cy0 + fx * sin + fy * cos;

      const nfx = -d.sx * nw / 2, nfy = -d.sy * nh / 2;
      const ncx = fsx - (nfx * cos - nfy * sin);
      const ncy = fsy - (nfx * sin + nfy * cos);

      let nx = ncx - nw / 2, ny = ncy - nh / 2;
      nx = clamp(nx, 0, Math.max(0, W - nw));
      ny = clamp(ny, 0, Math.max(0, H - nh));

      it.x = nx / W; it.y = ny / H; it.w = nw / W; it.h = nh / H;
      node.style.left = (it.x * 100) + '%';
      node.style.top = (it.y * 100) + '%';
      node.style.width = (it.w * 100) + '%';
      node.style.height = (it.h * 100) + '%';
      return;
    }

    /* ---- 旋转（0/±90 自动回正）---- */
    if (d.mode === 'rot') {
      d.moved = true;
      const rect = el('canvas').getBoundingClientRect();
      const a = Math.atan2(e.clientY - rect.top - d.cy, e.clientX - rect.left - d.cx) * 180 / Math.PI;
      let rot = a + d.offset;
      const snapped = Math.round(rot / 90) * 90;
      if (Math.abs(rot - snapped) <= 5) rot = snapped;
      rot = ((rot + 180) % 360 + 360) % 360 - 180;
      it.rot = Math.round(rot * 10) / 10;
      node.style.transform = `rotate(${it.rot}deg)`;
    }
  }

  function endDrag() {
    document.removeEventListener('pointermove', onDrag);
    showGuides(null, null);
    const d = S.drag;
    S.drag = null;
    if (!d) return;
    if (!d.moved) return;            // 只是点选，没改动 —— 不入撤销栈
    if (d.snap) {
      S.undo.push(d.snap);
      if (S.undo.length > 30) S.undo.shift();
      S.redo.length = 0;
    }
    renderEditor();
    scheduleSave();
  }

  /* ================================================================
     撤销 / 重做
     ================================================================ */
  function snapshot() {
    return JSON.stringify({ pages: S.pages, cur: S.cur });
  }
  function pushUndo() {
    S.undo.push(snapshot());
    if (S.undo.length > 30) S.undo.shift();
    S.redo.length = 0;
  }
  function undo() {
    if (!S.undo.length) return;
    S.redo.push(snapshot());
    const st = JSON.parse(S.undo.pop());
    S.pages = st.pages; S.cur = st.cur; S.sel = null;
    renderEditor(); scheduleSave();
  }
  function redo() {
    if (!S.redo.length) return;
    S.undo.push(snapshot());
    const st = JSON.parse(S.redo.pop());
    S.pages = st.pages; S.cur = st.cur; S.sel = null;
    renderEditor(); scheduleSave();
  }

  /** 对当前页做一次可撤销的修改 */
  function withSel(fn) {
    const items = curLayout().items;
    const i = items.findIndex(x => x.id === S.sel);
    if (i < 0) return;
    pushUndo();
    fn(items, i);
    renderEditor();
    scheduleSave();
  }

  /* ================================================================
     自动保存 + 乐观并发
     ================================================================ */
  function setSaveState(cls, text) {
    const s = el('saveState');
    s.className = 'save-state ' + (cls || '');
    s.textContent = text || '';
  }

  function scheduleSave() {
    S.dirty = true;
    // 有未解决的冲突时不再自动保存 —— 否则每次编辑都会再撞一次 409、反复弹窗
    if (S.conflict) { setSaveState('err', '有冲突未解决'); return; }
    setSaveState('busy', '保存中…');
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(doSave, 900);
  }

  async function doSave(forceVersion) {
    if (S.saving) return;
    const p = page();
    if (!p || !S.dirty && forceVersion === undefined) return;

    S.saving = true;
    const baseVersion = forceVersion !== undefined ? forceVersion : p.version;

    try {
      const res = await A.api(`/api/albums/${S.album.id}/pages/${S.cur}`, {
        method: 'PUT',
        body: JSON.stringify({ baseVersion, layout: p.layout })
      });

      if (res.status === 409) {
        const d = await res.json();
        S.conflict = d.server;
        showConflict();
        setSaveState('err', '有冲突');
        return;
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setSaveState('err', d.error === 'base_version_required' ? '参数错误' : '保存失败');
        return;
      }

      const d = await res.json();
      p.version = d.page.version;
      S.dirty = false;
      setSaveState('ok', '已保存');
    } catch (e) {
      setSaveState('err', '网络错误');
    } finally {
      S.saving = false;
    }
  }

  function showConflict() {
    const s = S.conflict;
    el('conflictNote').textContent =
      `对方在 ${s ? s.updatedAt : '刚才'}（${s && s.updatedBy || '另一人'}）改过这一页，` +
      `内容是 ${s ? (s.layout.items || []).length : '?'} 个元素。你打算怎么办？`;
    el('conflict').hidden = false;
    clearTimeout(S.saveTimer);
  }

  el('btnOverwrite').addEventListener('click', async () => {
    el('conflict').hidden = true;
    const server = S.conflict;
    S.conflict = null;
    S.dirty = true;
    await doSave(server ? server.version : undefined);
  });

  el('btnUseServer').addEventListener('click', () => {
    el('conflict').hidden = true;
    const server = S.conflict;
    S.conflict = null;
    if (server) {
      pushUndo();
      S.pages[S.cur].layout = server.layout;
      S.pages[S.cur].version = server.version;
      S.sel = null;
      renderEditor();
    }
    S.dirty = false;
    setSaveState('ok', '已加载对方版本');
  });

  el('btnConflictLater').addEventListener('click', () => {
    el('conflict').hidden = true;
    setSaveState('err', '有冲突未解决');
  });

  /* ================================================================
     工具栏
     ================================================================ */
  el('btnBack').addEventListener('click', async () => {
    if (S.dirty) { await doSave(); }
    await loadAlbums();
    show('list');
  });

  /* ================================================================
     工具面板开合
     ----------------------------------------------------------------
     顶栏只放返回/标题/保存状态，工具收进可下拉的面板里，
     免得在手机上横向滚动。面板占垂直空间，开合后要重新适配画布。
     ================================================================ */
  const TOOLS_KEY = 'album_tools_open';

  function setToolsOpen(open) {
    el('toolPanel').hidden = !open;
    const btn = el('btnToggleTools');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? '▴' : '▾';
    btn.title = open ? '收起工具' : '展开工具';
    try { localStorage.setItem(TOOLS_KEY, open ? '1' : '0'); } catch { /* 隐私模式 */ }
    requestAnimationFrame(() => fitCanvas());
  }

  el('btnToggleTools').addEventListener('click', () => {
    setToolsOpen(el('toolPanel').hidden);
  });

  el('btnUndo').addEventListener('click', undo);
  el('btnRedo').addEventListener('click', redo);

  el('albumTitle').addEventListener('change', async () => {
    const title = el('albumTitle').value.trim();
    if (!title || title === S.album.title) return;
    const res = await A.api('/api/albums/' + S.album.id, {
      method: 'PATCH', body: JSON.stringify({ title })
    });
    if (res.ok) { S.album.title = title; A.toast('已改名'); await loadAlbums(); }
    else A.toast('改名失败');
  });

  el('btnPrevPage').addEventListener('click', () => goPage(S.cur - 1));
  el('btnNextPage').addEventListener('click', () => goPage(S.cur + 1));

  async function goPage(i) {
    if (i < 0 || i >= S.pages.length) return;
    if (S.dirty) await doSave();
    S.cur = i; S.sel = null;
    renderEditor();
  }

  el('btnAddPage').addEventListener('click', async () => {
    if (S.dirty) await doSave();
    const res = await A.api(`/api/albums/${S.album.id}/pages`, { method: 'POST' });
    if (!res.ok) { A.toast('加页失败'); return; }
    const d = await res.json();
    // 重拉，保证页码与版本都是服务端的真值
    const fresh = await (await A.api(`/api/albums/${S.album.id}/pages`)).json();
    S.pages = fresh.pages;
    S.album = fresh.album;
    S.cur = d.index;
    S.sel = null;
    renderEditor();
  });

  el('btnDelPage').addEventListener('click', async () => {
    if (S.pages.length <= 1) return;
    if (!confirm(`删除第 ${S.cur + 1} 页？`)) return;
    if (S.dirty) await doSave();
    const res = await A.api(`/api/albums/${S.album.id}/pages/${S.cur}`, { method: 'DELETE' });
    if (!res.ok) { A.toast('删页失败'); return; }
    const fresh = await (await A.api(`/api/albums/${S.album.id}/pages`)).json();
    S.pages = fresh.pages;
    S.album = fresh.album;
    S.cur = Math.min(S.cur, S.pages.length - 1);
    S.sel = null;
    renderEditor();
  });

  el('btnRatio').addEventListener('click', () => {
    pushUndo();
    const layout = curLayout();
    const i = RATIOS.findIndex(r => Math.abs(r - layout.canvas.ratio) < 0.01);
    layout.canvas.ratio = RATIOS[(i + 1) % RATIOS.length];
    renderEditor();
    scheduleSave();
  });

  el('btnFront').addEventListener('click', () => withSel((a, i) => a.push(a.splice(i, 1)[0])));
  el('btnUp').addEventListener('click', () => withSel((a, i) => { if (i < a.length - 1) [a[i], a[i + 1]] = [a[i + 1], a[i]]; }));
  el('btnDown').addEventListener('click', () => withSel((a, i) => { if (i > 0) [a[i], a[i - 1]] = [a[i - 1], a[i]]; }));
  el('btnBack2').addEventListener('click', () => withSel((a, i) => a.unshift(a.splice(i, 1)[0])));
  el('btnDelItem').addEventListener('click', () => withSel((a, i) => { a.splice(i, 1); S.sel = null; }));

  /* ---- 设为封面 ---- */
  // 后端默认会取「第一页第一个元素」当封面，所以这个按钮是可选的覆盖。
  // 再点一次清掉显式封面，回到自动。
  el('btnSetCover').addEventListener('click', async () => {
    const it = curLayout().items.find(x => x.id === S.sel);
    if (!it) return;

    const isCover = S.album.coverKey === it.photo;
    const explicit = isCover && !S.album.coverAuto;
    const res = await A.api('/api/albums/' + S.album.id, {
      method: 'PATCH',
      body: JSON.stringify({ coverKey: explicit ? null : it.photo })
    });
    if (!res.ok) { A.toast('设置封面失败'); return; }

    if (explicit) {
      // 取消显式封面 → 回到「自动取第一页第一张」，重新拉一次拿准确值
      S.album.coverKey = null;
      S.album.coverAuto = true;
      const d = await (await A.api('/api/albums/' + S.album.id + '/pages')).json();
      S.album = d.album;
    } else {
      S.album.coverKey = it.photo;
      S.album.coverAuto = false;
    }
    renderEditor();
    A.toast(explicit ? '已恢复自动封面' : '已设为封面');
  });

  el('tipClose').addEventListener('click', () => el('rotateTip').classList.remove('show'));

  document.addEventListener('keydown', e => {
    if (S.view !== 'edit') return;
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { e.preventDefault(); el('btnDelItem').click(); }
  });

  /* ================================================================
     选照片
     ================================================================ */
  async function ensurePhotos() {
    if (S.photosLoaded) return;
    let cursor = null;
    for (let i = 0; i < 40; i++) {
      const q = new URLSearchParams({ limit: '200' });
      if (cursor) q.set('cursor', cursor);
      const d = await (await A.api('/api/photos?' + q)).json();
      S.photos.push(...(d.photos || []));
      cursor = d.nextCursor;
      if (!cursor) break;
    }
    S.photosLoaded = true;
  }

  el('btnAddPhoto').addEventListener('click', async () => {
    S.picking = true;
    el('pickerTitle').textContent = '选择照片加到本页';
    el('picker').hidden = false;
    el('pickerLoading').hidden = false;
    el('pickerGrid').innerHTML = '';
    await ensurePhotos();
    el('pickerLoading').hidden = true;
    renderPicker();
  });

  function renderPicker() {
    const used = new Set(curLayout().items.map(i => i.photo));
    const grid = el('pickerGrid');
    grid.innerHTML = '';

    if (!S.photos.length) {
      grid.innerHTML = '<div class="dim" style="grid-column:1/-1;padding:30px;text-align:center;font-size:13px">还没有照片，先去时间线传几张</div>';
      return;
    }

    for (const p of S.photos) {
      const cell = document.createElement('div');
      cell.className = 'picker-cell' + (used.has(p.k) ? ' used' : '');
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = A.thumbUrl(p.k);
      cell.appendChild(img);
      cell.addEventListener('click', () => addPhoto(p));
      grid.appendChild(cell);
    }
  }

  function addPhoto(p) {
    const W = CW(), H = CH();
    // 默认放中间偏上，宽占 40%，按原图比例给高度
    const w = 0.40;
    const h = (w * W) * (p.h / p.w) / H;
    const items = curLayout().items;

    if (items.length >= 40) { A.toast('这一页最多 40 个元素'); return; }

    pushUndo();
    items.push({
      id: newId(), photo: p.k,
      x: clamp((1 - w) / 2, 0, 1 - w),
      y: clamp((1 - h) / 2, 0, Math.max(0, 1 - h)),
      w, h, rot: 0, z: items.length,
      fit: 'cover', radius: 0, caption: ''
    });
    S.sel = items[items.length - 1].id;
    el('picker').hidden = true;
    renderEditor();
    scheduleSave();
  }

  document.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) el('picker').hidden = true;
  });

  function renderTray() {
    const box = el('trayScroll');
    box.innerHTML = '';

    // 本页元素按「视觉层级从高到低」列在托盘里（与画布上叠放顺序一致），
    // 带序号、当前选中的高亮、并自动滚到可见 ——
    // 画布上的小元素或旋转过的元素不好精确点中时，从这里选最稳。
    const items = curLayout().items;
    if (!items.length) {
      box.innerHTML = '<span class="tray-hint">点左侧「加照片」开始排版</span>';
      return;
    }

    items.slice().reverse().forEach((it, revIdx) => {
      const order = items.length - revIdx;          // 显示用的层号（从高到低）

      const d = document.createElement('div');
      d.className = 'tray-thumb' + (S.sel === it.id ? ' on' : '');
      d.dataset.id = it.id;
      d.title = `第 ${order} 层`;

      const img = document.createElement('img');
      img.src = A.thumbUrl(it.photo);
      img.alt = '';
      img.draggable = false;

      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = order;

      d.append(img, idx);
      d.addEventListener('click', () => {
        S.sel = (S.sel === it.id) ? null : it.id;
        renderEditor();
        revealSelected();
      });
      box.appendChild(d);

      if (S.sel === it.id) {
        requestAnimationFrame(() => {
          d.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
      }
    });
  }

  /* 依次切换选中 —— 完全不依赖在画布上点中 */
  el('btnNextItem').addEventListener('click', () => {
    const items = curLayout().items;
    if (!items.length) return;
    const i = items.findIndex(x => x.id === S.sel);
    S.sel = items[(i + 1) % items.length].id;
    renderEditor();
    revealSelected();
  });
  function relayoutTray() { /* 占位，托盘是弹性布局，无需重算 */ }

  /* ================================================================
     阅读器（横滑翻页）
     ================================================================ */
  el('btnRead').addEventListener('click', async () => {
    if (S.dirty) await doSave();
    renderReader();
    show('read');
    el('readTitle').textContent = S.album.title;
    setTimeout(() => { el('readHint').style.opacity = '0'; }, 2600);
  });

  function renderReader() {
    const box = el('readSlides');
    box.innerHTML = '';

    const availW = window.innerWidth - 32;
    const availH = window.innerHeight - 120;

    S.pages.forEach((p, idx) => {
      const slide = document.createElement('div');
      slide.className = 'read-slide';

      const ratio = (p.layout.canvas && p.layout.canvas.ratio) || 1.5;
      let w = availW, h = w / ratio;
      if (h > availH) { h = availH; w = h * ratio; }

      const paper = document.createElement('div');
      paper.className = 'read-paper';
      paper.style.width = w + 'px';
      paper.style.height = h + 'px';
      paper.style.background = (p.layout.canvas && p.layout.canvas.bg) || '#fff';

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
        img.src = A.previewUrl(it.photo);
        img.alt = '';
        img.loading = idx === S.cur ? 'eager' : 'lazy';
        if (it.fit === 'contain') img.style.objectFit = 'contain';
        wrap.appendChild(img);
        d.appendChild(wrap);
        if (it.caption) {
          const cap = document.createElement('div');
          cap.className = 'cap';
          cap.textContent = it.caption;
          d.appendChild(cap);
        }
        paper.appendChild(d);
      });

      slide.appendChild(paper);
      box.appendChild(slide);
    });

    updateReadPos();
    requestAnimationFrame(() => { box.scrollLeft = S.cur * box.clientWidth; });
  }

  function updateReadPos() {
    const box = el('readSlides');
    const i = Math.round(box.scrollLeft / Math.max(1, box.clientWidth));
    el('readPos').textContent = `${Math.min(i + 1, S.pages.length)} / ${S.pages.length}`;
    S.cur = Math.min(i, S.pages.length - 1);
  }

  el('readSlides').addEventListener('scroll', () => requestAnimationFrame(updateReadPos), { passive: true });

  el('readExit').addEventListener('click', () => {
    show('edit');
    renderEditor();
  });

  /* ================================================================
     新建相册
     ================================================================ */
  let newRatio = 1.5;

  el('btnNewAlbum').addEventListener('click', () => {
    el('newTitle').value = '';
    el('newSheet').hidden = false;
    setTimeout(() => el('newTitle').focus(), 120);
  });

  el('newRatio').addEventListener('click', e => {
    const b = e.target.closest('button[data-r]');
    if (!b) return;
    newRatio = parseFloat(b.dataset.r);
    [...el('newRatio').children].forEach(x => x.classList.toggle('on', x === b));
  });

  el('btnCreate').addEventListener('click', async () => {
    const title = el('newTitle').value.trim();
    if (!title) { A.toast('请填相册名'); return; }
    const res = await A.api('/api/albums', {
      method: 'POST', body: JSON.stringify({ title, ratio: newRatio })
    });
    if (!res.ok) { A.toast('创建失败'); return; }
    const d = await res.json();
    el('newSheet').hidden = true;
    await loadAlbums();
    openAlbum(d.album.id);
  });

  document.addEventListener('click', e => {
    if (e.target.closest('#newSheet [data-close]')) el('newSheet').hidden = true;
  });

  /* ================================================================
     横竖屏提示
     ================================================================ */
  function checkOrientation() {
    if (S.view !== 'edit') return;
    const portrait = window.innerHeight > window.innerWidth;
    const small = Math.min(window.innerWidth, window.innerHeight) < 820;
    el('rotateTip').classList.toggle('show', portrait && small);
  }

  window.addEventListener('resize', A.debounce(() => { fitCanvas(); checkOrientation(); }, 120));
  window.addEventListener('orientationchange', () => setTimeout(() => {
    fitCanvas(); checkOrientation();
  }, 180));

  /* 离开前把没保存的存掉 */
  window.addEventListener('beforeunload', e => {
    if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ================================================================
     启动
     ================================================================ */
  (async function boot() {
    const user = await A.requireAuth();
    if (!user) return;
    el('boot').hidden = true;

    // 恢复工具面板开合状态。首次默认展开 —— 否则新用户根本不知道有哪些工具
    let toolsOpen = true;
    try { toolsOpen = localStorage.getItem(TOOLS_KEY) !== '0'; } catch { /* 隐私模式 */ }
    setToolsOpen(toolsOpen);

    // 带 ?id=xxx 直接进编辑器
    const id = new URLSearchParams(location.search).get('id');
    if (id) await openAlbum(id);
    else { await loadAlbums(); show('list'); }
  })();
})();
