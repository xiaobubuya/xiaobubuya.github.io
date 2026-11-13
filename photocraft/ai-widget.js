/**
 * AI Chat Widget — 悬浮聊天组件 (Plan B: Browser Execution)
 * 嵌入 Studio / PhotoCraft / LightCraft 编辑器页面
 *
 * Plan B 核心思想：AI 只负责解析指令生成调整参数，
 * 浏览器端直接通过 window.Studio.setValue() 执行，
 * 不需要上传图片到服务器，不需要 CLI 处理。
 *
 * Usage: <script src="/ai-widget.js"></script>
 */
(function() {
  'use strict';

  // 后端地址：Cloudflare 命名隧道，永久稳定。
  // 2026-10-26 之前这里是匿名 trycloudflare 地址，每次 cloudflared 重启就换域名，
  // 而代码里写死一个 —— 一旦那个进程重启，悬浮球就永远显示「已断开」。
  // 现在由服务器上的 cloudflared.service（muyaya-ai 隧道）提供：
  //   ai.muyaya.world → http://localhost:3000
  // HTTPS + WSS 都能用，绕开 GitHub Pages 的 mixed content 限制。
  // 站内优先：相册站点（nginx 的 /ai/）已经把本机 AI 服务代理出来了，
  // 同源、不需要域名解析 —— 备案期 ai.muyaya.world 的 DNS 是关的，走隧道必然「已断开」。
  // 独立部署（GitHub Pages 那种，同源没有 /ai/）探测失败时，自动退回隧道。
  const STATION_BASE = '/ai';
  const TUNNEL_URL = 'https://ai.muyaya.world';

  let API_BASE = TUNNEL_URL;
  let WS_URL = TUNNEL_URL.replace('https:', 'wss:') + '/ws?key=bubu';
  const API_KEY = 'bubu';

  /** 探一下站内代理在不在；有就用同源 /ai（含 ws），没有就用隧道。 */
  const baseReady = (function () {
    const override = (typeof window !== 'undefined' && window.MUYAYA_AI_BASE) || null;
    if (override) {
      API_BASE = override;
      WS_URL = override.replace(/^http/, 'ws') + '/ws?key=bubu';
      return Promise.resolve(API_BASE);
    }
    if (typeof fetch !== 'function' || !/^https?:$/.test(location.protocol)) return Promise.resolve(API_BASE);
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(function () { ctl.abort(); }, 900) : null;
    return fetch(STATION_BASE + '/api/health', { signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (timer) clearTimeout(timer);
        if (!r.ok) return API_BASE;
        API_BASE = STATION_BASE;
        WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + STATION_BASE + '/ws?key=bubu';
        return API_BASE;
      })
      .catch(function () { if (timer) clearTimeout(timer); return API_BASE; });
  })();

  // ── State ──
  let ws = null;
  let currentTaskId = null;
  let isProcessing = false;
  let currentTool = 'photocraft';
  let panelOpen = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let editorType = null; // 'studio' | 'photocraft' | 'lightcraft' | null
  let activeCommands = []; // Currently active adjustment commands
  const MAX_RECONNECT = 10;

  // ── Editor Integration ──
  function detectEditor() {
    if (window.Studio && window.Studio.setValue) {
      editorType = 'studio';
      currentTool = 'photocraft';
      return 'Studio 修图';
    }
    if (window.photocraft && window.photocraft.hasImage) {
      editorType = 'photocraft';
      currentTool = 'photocraft';
      return 'PhotoCraft';
    }
    // LightCraft 只挂了 { command }，没有 hasImage —— 以前这里是永远为假的判断，
    // 所以 LightCraft 页面永远"未检测到编辑器"。有 command 就当是它。
    if (window.lightcraft && typeof window.lightcraft.command === 'function') {
      editorType = 'lightcraft';
      currentTool = 'lightcraft';
      return 'LightCraft';
    }
    return null;
  }

  /**
   * Check if PhotoCraft AI Bridge is available (new API after Rust patch).
   * When available, window.execute_command() can drive the full PhotoCraft engine.
   */
  function hasPhotoCraftAIBridge() {
    return typeof window.execute_command === 'function' && typeof window.has_session === 'function';
  }


  /**
   * Execute commands in PhotoCraft via AI Bridge (preferred after Rust patch).
   */
  /** 上一次提交给 PhotoCraft 的结果（预设与滑块用它判断成败）。 */
  let lastPCApply = { applied: 0, rejected: [] };

  /**
   * Execute commands in PhotoCraft via AI Bridge (preferred after Rust patch).
   * opts.strict 是一组允许的 id：预设和滑块用的是写死的命令，写错要当场暴露，
   * 不能像旧映射表那样静默失败还提示"已应用"。
   */
  async function executePhotoCraftCommands(commands, opts) {
    if (!hasPhotoCraftAIBridge() || !window.has_session()) return false;
    const strict = opts && opts.strict ? opts.strict : null;

    // The bridge queues a command and waits for the eframe loop to drain it.
    // Its promise never settles (no waker), so fire it and force one repaint:
    // without the repaint an idle editor never runs the frame that applies it.
    function submit(commandId, params) {
      const pending = window.execute_command(commandId, JSON.stringify(params));
      if (pending && typeof pending.catch === 'function') {
        pending.catch(function(e) { console.warn('[AI Widget] bridge rejected:', e && e.message); });
      }
      if (typeof window.request_repaint === 'function') window.request_repaint();
    }

    let applied = 0;
    const rejected = [];
    for (const cmd of commands) {
      try {
        // Native PhotoCraft command from /api/parse: { id, params }.
        if (cmd && typeof cmd.id === 'string' && cmd.id) {
          if (strict && !strict.has(cmd.id)) { rejected.push(cmd.id); continue; }
          const params = cmd.params && typeof cmd.params === 'object' ? cmd.params : {};
          submit(cmd.id, params);
          applied++;
          photocraftUndo.__steps = (photocraftUndo.__steps || 0) + 1;   // 一步 = 一条命令（撤销时按这个数撤）
          continue;
        }
        // 旧 Studio 形状 {key, value}：后端早已只吐原生命令，这里不再猜映射，
        // 直接报出来（旧映射表指向的 adjust.* 引擎里一条都不存在）。
        if (cmd && cmd.key) {
          rejected.push('旧格式:' + cmd.key);
          continue;
        }
      } catch (e) {
        console.warn('[AI Widget] PhotoCraft command failed:', cmd && (cmd.id || cmd.key), ':', e.message);
        rejected.push(cmd && (cmd.id || cmd.key));
      }
    }
    lastPCApply = { applied: applied, rejected: rejected };
    return applied > 0;
  }

  /**
   * Execute adjustment commands in the editor.
   * Tries PhotoCraft AI Bridge first, then Studio (legacy), then Canvas 2D fallback.
   */
  /* ────────────────────────────────────────────────────────────────
   * LightCraft 执行器
   *
   * LightCraft 是另一套引擎：只有 `lightcraft.command(id, JSON字符串)`，
   * 而且"调什么"叫 develop 控件（`develop.controls` 里有 id/范围/当前值），
   * 一套控件改一次：`develop.set {"values":{"light.exposure":1.2}}`（绝对值）。
   *
   * AI 后端（/api/parse）不管 tool 传什么，吐的都是 **PhotoCraft 的命令 id**
   * （image.adjustments.* / filter.*），所以这里把这些指令翻译成 LightCraft 的控件值：
   *   - 参数按"相对调整"理解（用户说"亮一点"就是加一点，说两次就更亮）；
   *   - 先读当前值，加完按控件的 min/max 夹住，再一次性 develop.set。
   */

  // PhotoCraft 命令 id → LightCraft 控件的增量。函数返回 {控件id: 增量}。
  const PC_TO_LC = {
    // 亮度是 EV（LightCraft -5..5），PhotoCraft 亮度是 -150..150 的"档"：除以 100 再乘 1.5 手感接近
    'image.adjustments.brightnessContrast': (p) => ({
      'light.exposure': num(p.brightness) / 100 * 1.5,
      'light.contrast': num(p.contrast),
    }),
    'image.adjustments.exposure': (p) => ({
      'light.exposure': num(p.exposure) || num(p.value) / 100 * 5,
    }),
    'image.adjustments.vibrance': (p) => ({
      'color.vibrance': num(p.vibrance),
      'color.saturation': num(p.saturation),
    }),
    'image.adjustments.hueSaturation': (p) => ({
      'grading.global.hue': p.hue == null ? 0 : (num(p.hue) + 360) % 360,   // 色相是 0..360 的环
      'color.saturation': num(p.saturation),
      'grading.global.lum': num(p.lightness),
    }),
    // 黑白不再是"降饱和近似"：LightCraft 有自己的 treatment（color | bw），
    // 切过去以后 bwMix 的 8 个通道才生效 —— 这才是真黑白。
    'image.adjustments.desaturate': () => ({ __treatment: 'bw' }),
    'image.adjustments.blackWhite': (p) => {
      const out = { __treatment: 'bw' };
      // 通道混合：PhotoCraft 传 reds/yellows/... 是 -200..300，LightCraft 的 bw.* 是 -100..100
      const BW = { reds: 'bw.red', yellows: 'bw.yellow', greens: 'bw.green', cyans: 'bw.aqua',
                   blues: 'bw.blue', magentas: 'bw.magenta', oranges: 'bw.orange' };
      for (const k in BW) if (p[k] != null) out[BW[k]] = { abs: num(p[k]) };
      return out;
    },
    'image.adjustments.shadowsHighlights': (p) => ({
      'light.shadows': num(p.shadowAmount) * (p.shadows == null ? 1 : num(p.shadows) / 50),
      'light.highlights': -num(p.highlightAmount) * (p.highlights == null ? 1 : num(p.highlights) / 50),
    }),
    // 色彩平衡：[青-红, 洋红-绿, 黄-蓝] 三个通道。用红/蓝的差值推断"更暖还是更冷"，
    // 绿的多寡推断洋红/绿偏移 —— LightCraft 侧没有逐带调整，落到色温/色调最稳。
    'image.adjustments.colorBalance': (p) => {
      const band = (a) => (Array.isArray(a) ? a : [0, 0, 0]);
      const sums = [0, 1, 2].map(i =>
        (num(band(p.shadows)[i]) + num(band(p.midtones)[i]) + num(band(p.highlights)[i])) / 3);
      const [r, g, b] = sums;
      if (!r && !g && !b) return null;
      return { 'wb.temp': 600 * (r - b) / 100, 'wb.tint': 20 * g / 100 };
    },
    'image.adjustments.photoFilter': (p) => {
      const t = PHOTO_FILTER_EV[p.filter];
      if (!t) return null;
      return { 'wb.temp': t.temp, 'wb.tint': t.tint || 0, 'color.saturation': t.sat || 0 };
    },
    'filter.sharpen.unsharpMask': (p) => {
      const out = { 'detail.sharpenAmount': num(p.amount) || num(p.strength) };
      // 半径和阈值是"设成多少"，不是"再加多少"（AI 给的是绝对值）
      if (p.radius != null) out['detail.sharpenRadius'] = { abs: num(p.radius) };
      if (p.threshold != null) out['detail.sharpenMasking'] = { abs: num(p.threshold) };
      return out;
    },
    'filter.sharpen.smartSharpen': (p) => ({ 'detail.sharpenAmount': num(p.amount) || 60 }),
    'filter.sharpen.sharpen': (p) => ({ 'detail.sharpenAmount': num(p.amount) || 40 }),
    'filter.sharpen.sharpenMore': (p) => ({ 'detail.sharpenAmount': num(p.amount) || 70 }),
    'filter.sharpen.sharpenEdges': (p) => ({ 'detail.sharpenAmount': num(p.amount) || 50 }),
    'filter.noise.reduceNoise': (p) => ({
      'detail.nrLuminance': num(p.strength) || num(p.amount) || 40,
      'detail.nrColor': num(p.colorNoise) || 0,
    }),
    'filter.noise.median': (p) => ({ 'detail.nrLuminance': num(p.radius) * 8 }),
    'filter.noise.despeckle': (p) => ({ 'detail.nrLuminance': num(p.strength) || 30 }),
    'filter.gallery.grain': (p) => ({
      'grain.amount': num(p.amount) || num(p.intensity) || 30,
      'grain.size': num(p.size) || 0,
    }),
    'filter.gallery.filmGrain': (p) => ({ 'grain.amount': num(p.amount) || 25 }),
    'image.adjustments.invert': null,
    'image.crop': null,
  };

  // 常用暖/冷滤镜 → 色温/色调的偏移（LightCraft 色温是开尔文，6500 为中性）
  const PHOTO_FILTER_EV = {
    warming85: { temp: 900, tint: 6 },
    warming81: { temp: 500, tint: 3 },
    warmingLBA: { temp: 1100, tint: 10 },
    cooling80: { temp: -900, tint: -6 },
    coolingLBB: { temp: -1200, tint: -10 },
    sepia: { temp: 600, tint: 8, sat: -35 },
    deepRed: { temp: 800, tint: 18 },
    underWater: { temp: -1200, tint: -14 },
  };

  function num(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  const hasLightCraft = () => !!(window.lightcraft && typeof window.lightcraft.command === 'function');
  const lightcraftUndo = Object.create(null);   // 控件id → 改动前的值
  const photocraftUndo = Object.create(null);   // __steps：本次对话往 PhotoCraft 历史里写了几步
  let lightcraftUnsupported = [];               // 上次没能表达的指令 id

  /** 读当前 treatment（'color' | 'bw'） */
  async function lightcraftTreatment() {
    try {
      const g = JSON.parse(await window.lightcraft.command('develop.get', '{}'));
      return g && g.treatment ? String(g.treatment) : null;
    } catch (e) {
      return null;
    }
  }

  /** 撤销：LightCraft 的 develop.reset 清掉所有调整（含 treatment），实测像素级回原始；
   *  万一 reset 失败，退回"把动过的控件按记录值写回去"。 */
  /** 合成一次 Ctrl+Z（引擎认未受信任的 keydown，实测与真人按键同一条代码路径）。 */
  async function lightcraftSynthUndo() {
    const canvas = document.querySelector('canvas');
    if (canvas) {
      // 引擎只处理 canvas 有焦点时的按键；canvas 默认没有 tabindex，focus() 落不下去
      if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');
      try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
      try { canvas.focus(); } catch (e) {}
      await new Promise(r => setTimeout(r, 320));   // 焦点让出去、等引擎跑一帧再发键，否则第一下会被输入框吞掉
    }
    if (window.__AI_WIDGET_DEBUG) {
      console.log('[AI Widget][debug] 合成 Ctrl+Z，焦点=', document.activeElement && (document.activeElement.id || document.activeElement.tagName));
    }
    for (const t of [canvas, window, document].filter(Boolean)) {
      t.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'z', code: 'KeyZ', keyCode: 90, which: 90,
        ctrlKey: true, bubbles: true, cancelable: true,
      }));
    }
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /**
   * LightCraft 撤销：按本次对话写进去的步数按 Ctrl+Z（跟用户按键同一条路径）。
   * 只撤这几步，不动用户更早的手动调整。
   */
  async function undoLightCraft() {
    if (!hasLightCraft()) return false;
    const steps = Math.max(1, lightcraftUndo.__steps || 1);
    const readHist = async () => {
      try { return JSON.parse(await window.lightcraft.command('history.list', '{}')); } catch (e) { return null; }
    };
    const press = async () => {
      await lightcraftSynthUndo();
      await sleep(600);
      return readHist();
    };

    let h = await readHist();
    const before = h ? (h.history || []).length : null;
    if (h && before === 0 && (h.cursor === null || h.cursor === undefined)) {
      for (const k in lightcraftUndo) delete lightcraftUndo[k];
      return false;                        // 引擎本来就没记录
    }
    for (let i = 0; i < steps; i++) {
      const prevLen = h ? (h.history || []).length : null;
      h = await press();
      if (h && !(h.history || []).length && (h.cursor === null || h.cursor === undefined)) break;   // 已撤到空
      // 这一下没生效（或读不到历史）就再补一次，宁可多按一下也不误判成"撤不动"
      if (!h || (prevLen !== null && (h.history || []).length === prevLen)) h = await press();
    }
    const after = h ? (h.history || []).length : null;
    // 只有确认一步都没撤掉时才退回引擎 Reset（Reset 会连用户更早的调整一起清掉，属最后手段）
    if (before !== null && after !== null && before > 0 && after >= before) {
      console.warn('[AI Widget] Ctrl+Z 没撤动，退回 develop.reset');
      try { await window.lightcraft.command('develop.reset', '{}'); } catch (e) { return false; }
    }
    for (const k in lightcraftUndo) delete lightcraftUndo[k];
    return true;
  }

  /**
   * PhotoCraft 的撤销：调它自己的 edit.undo（跟用户 Ctrl+Z 是同一个动作），
   * 按本次对话写进去的步数撤，不多撤用户更早的手动调整。
   */
  /** 撤回本组件写进 PhotoCraft 的 n 步（不动用户更早的手动调整）。 */
  async function undoPhotoCraftSteps(n, gap) {
    if (!hasPhotoCraftAIBridge() || !n) return true;
    const wait = gap || 350;
    for (let i = 0; i < n; i++) {
      // 这个 bridge 的 promise 永不 settle（没有 waker），只能发出去再强制重绘一帧
      const pending = window.execute_command('edit.undo', '{}');
      if (pending && typeof pending.catch === 'function') {
        pending.catch(function (e) { console.warn('[AI Widget] edit.undo rejected:', e && e.message); });
      }
      if (typeof window.request_repaint === 'function') window.request_repaint();
      await sleep(wait);
    }
    return true;
  }

  /**
   * PhotoCraft 的撤销：调它自己的 edit.undo（跟用户 Ctrl+Z 是同一个动作），
   * 按本次对话写进去的步数撤，不多撤用户更早的手动调整。
   */
  async function undoPhotoCraft() {
    if (!hasPhotoCraftAIBridge()) return false;
    const steps = Math.max(1, photocraftUndo.__steps || 1);
    const ok = await undoPhotoCraftSteps(steps);
    if (ok) for (const k in photocraftUndo) delete photocraftUndo[k];
    return ok;
  }

  /** 读一遍 develop 控件（id → {value,min,max}），失败返回空表 */
  async function lightcraftControls() {
    const out = Object.create(null);
    try {
      const txt = await window.lightcraft.command('develop.controls', '{}');
      const arr = JSON.parse(txt);
      for (const c of arr) out[c.id] = { value: num(c.value), min: num(c.min), max: num(c.max) };
    } catch (e) {
      console.warn('[AI Widget] 读不到 LightCraft 控件:', e && e.message);
    }
    return out;
  }

  /** 有没有打开的照片（library.info 有 photos 且有渲染中的） */
  async function lightcraftHasImage() {
    try {
      const txt = await window.lightcraft.command('library.info', '{}');
      const info = JSON.parse(txt);
      return num(info.photos) > 0;
    } catch (e) {
      return false;
    }
  }

  async function executeLightCraftCommands(commands) {
    if (!hasLightCraft()) return false;
    const controls = await lightcraftControls();
    const controlCount = Object.keys(controls).length;
    if (!controlCount) {
      console.warn('[AI Widget] LightCraft 没读到控件表（先打开一张照片试试）');
      return false;
    }
    const delta = Object.create(null);
    const absolute = Object.create(null);
    lightcraftUnsupported = [];
    let wantTreatment = null;
    let mapped = 0;

    let wantReset = false;
    for (const cmd of commands) {
      if (!cmd || typeof cmd.id !== 'string') continue;

      // 后端对 LightCraft 已经直接吐 develop.* 指令（见 parse.ts 的 lightcraft 分支），
      // 这三条直接执行，不用再翻译。
      if (cmd.id === 'develop.adjust') {
        const v = (cmd.params && cmd.params.values) || {};
        let hit = 0;
        for (const k in v) { if (controls[k]) { delta[k] = (delta[k] || 0) + num(v[k]); hit++; } }
        if (hit) mapped++; else lightcraftUnsupported.push(cmd.id);
        continue;
      }
      if (cmd.id === 'develop.treatment') { wantTreatment = 'bw'; mapped++; continue; }
      if (cmd.id === 'develop.reset') { wantReset = true; mapped++; continue; }

      const fn = PC_TO_LC[cmd.id];
      if (!fn) {
        console.warn('[AI Widget] LightCraft 暂不支持这条命令:', cmd.id);
        lightcraftUnsupported.push(cmd.id);
        continue;
      }
      const part = fn(cmd.params || {});
      if (!part) continue;
      for (const k in part) {
        if (k === '__treatment') { wantTreatment = part[k]; continue; }
        if (!controls[k]) continue;
        const spec = part[k];
        if (spec && typeof spec === 'object') {
          if (typeof spec.abs === 'number') absolute[k] = spec.abs;
        } else {
          delta[k] = (delta[k] || 0) + num(spec);
        }
      }
      mapped++;
    }
    if (!mapped) return false;

    const values = Object.create(null);
    for (const k in delta) {
      const c = controls[k];
      let v = k in absolute ? absolute[k] : c.value + delta[k];
      if (k === 'grading.global.hue') v = ((v % 360) + 360) % 360;
      const lo = isFinite(c.min) ? c.min : -100, hi = isFinite(c.max) ? c.max : 100;
      values[k] = Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));
    }
    if (wantReset) {
      try {
        await window.lightcraft.command('develop.reset', '{}');
        for (const k in lightcraftUndo) delete lightcraftUndo[k];
        console.log('[AI Widget] LightCraft 已重置');
        return true;
      } catch (e) {
        console.warn('[AI Widget] develop.reset 失败:', e && e.message);
        return false;
      }
    }
    if (!Object.keys(values).length && !wantTreatment) return false;

    try {
      if (wantTreatment) {
        const cur = await lightcraftTreatment();
        if (cur && cur !== wantTreatment) {
          // develop.treatment 是开关不是赋值：先读 develop.get 再决定拨不拨
          if (!('__treatment' in lightcraftUndo)) lightcraftUndo.__treatment = cur;
          await window.lightcraft.command('develop.treatment', '{}');
        }
      }
      if (Object.keys(values).length) {
        const lcSteps = async () => {
          try { const h = JSON.parse(await window.lightcraft.command('history.list', '{}')); return (h.history || []).length; }
          catch (e) { return null; }
        };
        const h0 = await lcSteps();
        await window.lightcraft.command('develop.set', JSON.stringify({ values }));
        const h1 = await lcSteps();
        // 撤销时按真实历史增量按 Ctrl+Z（treatment 开关也可能各算一步，所以读差值而不是固定 +1）
        const added = (h0 === null || h1 === null) ? 1 : Math.max(1, h1 - h0);
        lightcraftUndo.__steps = (lightcraftUndo.__steps || 0) + added;
        // 记下改前的值（Ctrl+Z 撤不动时兜底，用不上也无害）
        for (const k in values) {
          if (!(k in lightcraftUndo)) lightcraftUndo[k] = controls[k] ? controls[k].value : 0;
        }
      }
      console.log('[AI Widget] LightCraft 已应用:', JSON.stringify(values), wantTreatment ? '| treatment=' + wantTreatment : '');
      return true;
    } catch (e) {
      console.warn('[AI Widget] LightCraft develop.set 失败:', e && e.message);
      return false;
    }
  }

  async function executeEditorCommands(commands) {
    // 0. LightCraft：走它自己的 develop.set
    if (editorType === 'lightcraft' && hasLightCraft()) {
      return await executeLightCraftCommands(commands);
    }

    // 1. Try PhotoCraft AI Bridge (new API)
    if (editorType === 'photocraft' && hasPhotoCraftAIBridge()) {
      return await executePhotoCraftCommands(commands);
    }

    // 2. Try Studio (legacy, will be removed)
    if (window.Studio && window.Studio.setValue) {
      return executeStudioCommands(commands);
    }

    // 3. Fallback: Canvas 2D
    return executeCanvasCommands(commands);
  }

  /**
   * Execute adjustment commands directly in the Studio editor.
   * This is the Plan B core: commands run in-browser, no server processing.
   */
  function executeStudioCommands(commands) {
    if (!window.Studio || !window.Studio.setValue) return false;

    let applied = 0;
    for (const cmd of commands) {
      if (!cmd.key || typeof cmd.value !== 'number') continue;
      try {
        window.Studio.setValue(cmd.key, cmd.value);
        applied++;
      } catch (e) {
        console.warn('[AI Widget] Failed to apply', cmd.key, ':', e.message);
      }
    }
    return applied > 0;
  }

  /**
   * 取当前工作区画布，缩到长边 maxEdge 后转 data URL。
   * 供 /api/parse 做视觉分析（定位类需求）；画布被跨域污染时返回 null。
   *
   * 2026-11-13：编码从 PNG 换成 JPEG，并按体积预算自动降档。
   * 原因：长边 1024 的照片 PNG 编出来通常 1.5~3MB，base64 后 2~4MB。
   * 这份 data URL 要走两段慢链路 —— 先上行传到本机后端（几 MB 上传几十秒），
   * 后端再把整份塞给视觉模型。改 JPEG 后同样内容约 150~300KB，两头都快一个数量级。
   * 照片没有透明需求，JPEG 对「看清主体 / 位置」完全够。
   *
   * 预算 700KB 是 base64 字符数（≈520KB 原始字节）：超了就把边长缩 25% 并降质量，
   * 最多试 4 档，保证全景 / 超宽截图这类极端图也不会退回几 MB。
   * 先铺白底：JPEG 不支持 alpha，透明区不铺底会变黑，视觉摘要会误判成暗部。
   *
   * @param {number} [maxEdge=1024] 返回值的 width/height 仍是文档原始尺寸（坐标映射要用）
   * @param {number} [quality=0.85] 起始 JPEG 质量
   */
  function grabWorkCanvas(maxEdge, quality) {
    maxEdge = maxEdge || 1024;
    const canvas = editorType === 'photocraft'
      ? document.getElementById('photocraft_canvas')
      : editorType === 'lightcraft'
        ? document.getElementById('lightcraft_canvas')
        : null;
    if (!canvas || !canvas.width || !canvas.height) return null;

    const docW = canvas.width;
    const docH = canvas.height;
    const BUDGET = 700 * 1024;
    let edge = Math.min(maxEdge, Math.max(docW, docH));
    let q = quality || 0.85;
    let dataUrl = '';

    for (let attempt = 0; attempt < 4; attempt++) {
      const scale = Math.min(1, edge / Math.max(docW, docH));
      const w = Math.max(1, Math.round(docW * scale));
      const h = Math.max(1, Math.round(docH * scale));
      try {
        const tmp = document.createElement('canvas');
        tmp.width = w;
        tmp.height = h;
        const ctx = tmp.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(canvas, 0, 0, w, h);
        dataUrl = tmp.toDataURL('image/jpeg', q);
      } catch (e) {
        console.warn('[AI Widget] 画布跨域污染，跳过视觉分析:', e.message);
        return null;
      }
      if (dataUrl.length <= BUDGET) break;
      edge = Math.round(edge * 0.75);
      q = Math.max(0.6, q - 0.1);
    }

    return {
      dataUrl,
      // 画布内在分辨率 = 文档尺寸（与 CSS 显示缩放无关）
      width: docW,
      height: docH,
    };
  }

  /**
   * Fallback: execute commands via Canvas 2D for PhotoCraft/LightCraft.
   * Limited but provides basic functionality when Studio is not available.
   */
  function executeCanvasCommands(commands) {
    const canvas = editorType === 'photocraft'
      ? document.getElementById('photocraft_canvas')
      : document.getElementById('lightcraft_canvas');

    if (!canvas) return false;

    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (e) {
      console.warn('[AI Widget] Canvas tainted, cannot process:', e.message);
      return false;
    }

    const data = imageData.data;
    let applied = 0;

    for (const cmd of commands) {
      if (!cmd.key || typeof cmd.value !== 'number') continue;

      const v = cmd.value;
      const key = cmd.key;

      if (key === 'uExposure') {
        // Adjust brightness
        const factor = Math.pow(2, v);
        for (let i = 0; i < data.length; i += 4) {
          data[i] = Math.min(255, Math.max(0, data[i] * factor));
          data[i + 1] = Math.min(255, Math.max(0, data[i + 1] * factor));
          data[i + 2] = Math.min(255, Math.max(0, data[i + 2] * factor));
        }
        applied++;
      } else if (key === 'uContrast') {
        const factor = (1 + v) * 255 / (255 - v * 255);
        for (let i = 0; i < data.length; i += 4) {
          for (let c = 0; c < 3; c++) {
            data[i + c] = Math.min(255, Math.max(0, (data[i + c] - 128) * factor + 128));
          }
        }
        applied++;
      } else if (key === 'uSaturation') {
        // v=0: normal, v=-1: grayscale, v=1: double saturation
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          data[i] = Math.min(255, Math.max(0, gray + (r - gray) * (1 + v)));
          data[i + 1] = Math.min(255, Math.max(0, gray + (g - gray) * (1 + v)));
          data[i + 2] = Math.min(255, Math.max(0, gray + (b - gray) * (1 + v)));
        }
        applied++;
      } else if (key === 'uTemp') {
        // Color temperature: positive=warm, negative=cool
        const w = Math.abs(v) * 50;
        if (v > 0) {
          for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.min(255, data[i] + w);           // R up
            data[i + 2] = Math.max(0, data[i + 2] - w * 0.5); // B down
          }
        } else {
          for (let i = 0; i < data.length; i += 4) {
            data[i + 2] = Math.min(255, data[i + 2] + w);     // B up
            data[i] = Math.max(0, data[i] - w * 0.5);           // R down
          }
        }
        applied++;
      } else if (key === 'uHighlights') {
        const factor = v > 0 ? (1 + v * 0.5) : (1 - v * 0.3);
        for (let i = 0; i < data.length; i += 4) {
          for (let c = 0; c < 3; c++) {
            if (data[i + c] > 150) {
              data[i + c] = Math.min(255, Math.max(0, data[i + c] * factor));
            }
          }
        }
        applied++;
      } else if (key === 'uShadows') {
        const factor = v > 0 ? (1 + v * 0.5) : (1 - v * 0.3);
        for (let i = 0; i < data.length; i += 4) {
          for (let c = 0; c < 3; c++) {
            if (data[i + c] < 100) {
              data[i + c] = Math.min(255, Math.max(0, data[i + c] * factor));
            }
          }
        }
        applied++;
      } else if (key === 'uTint') {
        const w = v * 40;
        for (let i = 0; i < data.length; i += 4) {
          // Positive=toward magenta (less green), negative=toward green
          data[i + 1] = Math.min(255, Math.max(0, data[i + 1] - w));
        }
        applied++;
      } else if (key === 'uVignette') {
        // Vignette effect
        const cx = canvas.width / 2, cy = canvas.height / 2;
        const maxDist = Math.sqrt(cx * cx + cy * cy);
        const strength = Math.abs(v) * 0.5;
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const idx = (y * canvas.width + x) * 4;
            const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
            const factor = v > 0
              ? 1 - strength * Math.pow(dist / maxDist, 2)
              : 1 + Math.abs(v) * strength * Math.pow(dist / maxDist, 2) * 0.3;
            data[idx] = Math.min(255, Math.max(0, data[idx] * factor));
            data[idx + 1] = Math.min(255, Math.max(0, data[idx + 1] * factor));
            data[idx + 2] = Math.min(255, Math.max(0, data[idx + 2] * factor));
          }
        }
        applied++;
      } else if (key === 'uGrain') {
        // Add film grain
        const amount = v * 30;
        for (let i = 0; i < data.length; i += 4) {
          const noise = (Math.random() - 0.5) * amount;
          data[i] = Math.min(255, Math.max(0, data[i] + noise));
          data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
          data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
        }
        applied++;
      }
    }

    if (applied > 0) {
      ctx.putImageData(imageData, 0, 0);
    }
    return applied > 0;
  }

  /**
   * Execute commands — routes to the appropriate execution method.
   * Tries PhotoCraft AI Bridge first, then Studio (legacy), then Canvas 2D fallback.
   */
  async function executeCommands(commands) {
    // 0. LightCraft：它有自己的 develop.set，别走 Canvas 降级（那是给 Studio 的）
    if (editorType === 'lightcraft' && hasLightCraft()) {
      return await executeLightCraftCommands(commands);
    }

    // 1. Try PhotoCraft AI Bridge (new API)
    if (editorType === 'photocraft' && hasPhotoCraftAIBridge()) {
      return await executePhotoCraftCommands(commands);
    }

    // 2. Try Studio (legacy, will be removed)
    if (editorType === 'studio') {
      return executeStudioCommands(commands);
    }

    // 3. Fallback: Canvas 2D
    if (editorType === 'photocraft' || editorType === 'lightcraft') {
      return executeCanvasCommands(commands);
    }
    return false;
  }

  // ── CSS ──
  const css = `
    /* 纸感配色：和木芽芽同一套（纸 #f7f3ea / 线 #ddd5c4 / 墨 #262320）。
       原来那抹亮蓝（#2d8cf0 / #3d7eff / #5a9bff）在纸面编辑器旁边太跳，全部下线。 */
    #ai-widget-btn{position:fixed;z-index:99999;background:#262320;color:#f7f3ea;width:56px;height:56px;border-radius:50%;border:none;cursor:grab;font-size:26px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(60,48,32,.22);transition:transform .2s,box-shadow .2s;touch-action:none;user-select:none}
    #ai-widget-btn:hover{transform:scale(1.1);box-shadow:0 6px 20px rgba(60,48,32,.3)}
    #ai-widget-btn.dragging{cursor:grabbing;transition:none;box-shadow:0 10px 26px rgba(60,48,32,.35)}
    #ai-widget-btn .badge{position:absolute;top:-2px;right:-2px;background:#a34a3a;color:#fff;font-size:10px;width:16px;height:16px;border-radius:50%;display:none;align-items:center;justify-content:center}
    #ai-widget-btn .badge.show{display:flex}

    #ai-widget-panel{position:fixed;z-index:99998;width:400px;max-height:560px;background:#f7f3ea;color:#262320;border:1px solid #ddd5c4;border-radius:12px;display:none;flex-direction:column;box-shadow:0 8px 32px rgba(60,48,32,.18);overflow:hidden}
    #ai-widget-panel.open{display:flex}

    #ai-widget-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#efe9dc;border-bottom:1px solid #ddd5c4;flex-shrink:0}
    #ai-widget-header .title{font-size:14px;font-weight:600;color:#262320;display:flex;align-items:center;gap:6px}
    #ai-widget-header .status{display:flex;align-items:center;gap:4px;font-size:11px;color:#6f6860}
    #ai-widget-header .dot{width:8px;height:8px;border-radius:50%;background:#8a8378}
    #ai-widget-header .dot.online{background:#5c7a52}
    #ai-widget-header .dot.offline{background:#a34a3a}
    #ai-widget-close{background:none;border:none;color:#6f6860;font-size:18px;cursor:pointer;padding:2px 6px;border-radius:4px}
    #ai-widget-close:hover{color:#262320;background:#e8e1d1}

    #ai-widget-messages{flex:1;overflow-y:auto;padding:12px;min-height:200px;max-height:350px}
    #ai-widget-messages .msg{max-width:85%;margin-bottom:10px;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.5;word-wrap:break-word}
    #ai-widget-messages .msg.user{margin-left:auto;background:#262320;color:#f7f3ea}
    #ai-widget-messages .msg.bot{background:#fcfaf5;color:#3b3733;border:1px solid #e6dfd0}
    #ai-widget-messages .msg.system{background:transparent;color:#8a8378;font-size:11px;text-align:center;max-width:100%}
    #ai-widget-messages .msg.error{background:#f4e6e2;color:#a34a3a}
    #ai-widget-messages .msg .cmd-list{margin-top:6px;font-size:11px;color:#6f6860;background:#f1ecdf;padding:6px 8px;border-radius:6px;max-height:80px;overflow-y:auto}
    #ai-widget-messages .msg .cmd-item{margin-bottom:2px}
    #ai-widget-messages .msg .cmd-item .key{color:#7a5f3a;font-weight:600}
    #ai-widget-messages .msg .cmd-item .val{color:#4f6f4a}

    #ai-widget-input{display:flex;gap:6px;padding:10px 14px;border-top:1px solid #ddd5c4;flex-shrink:0}
    #ai-widget-input input{flex:1;background:#fcfaf5;border:1px solid #ddd5c4;color:#262320;padding:8px 12px;border-radius:8px;font-size:13px;outline:none}
    #ai-widget-input input:focus{border-color:#262320}
    #ai-widget-input button{background:#262320;color:#f7f3ea;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500}
    #ai-widget-input button:disabled{opacity:.45;cursor:not-allowed}
    #ai-widget-hint{padding:0 14px 10px;font-size:11px;line-height:1.5;color:#8a8378}
    #ai-widget-hint kbd{font:inherit;padding:0 4px;border:1px solid #ddd5c4;border-radius:3px;background:#f1ecdf;color:#4a453e}
    #ai-widget-input .clear-btn{background:#efe9dc;color:#4a453e}
    #ai-widget-input .clear-btn:hover{background:#e8e1d1}

    /* ── 右侧抽屉（覆盖上面的浮动面板定位） ── */
    #ai-widget-panel{position:fixed;top:0;right:0;bottom:0;width:400px;max-height:none;
      background:#f7f3ea;border:none;border-left:1px solid #ddd5c4;border-radius:0;
      box-shadow:-10px 0 34px rgba(60,48,32,.16);transform:translateX(100%);
      transition:transform .2s ease;overflow:hidden}
    #ai-widget-panel.open{transform:none}
    @media (max-width:760px){#ai-widget-panel{width:min(400px,92vw)}}

    /* 收起状态的唤起手柄：一条纸色书签，不再是亮蓝渐变条 */
    #ai-widget-handle{position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:99999;
      width:34px;height:120px;border:none;border-left:1px solid #ddd5c4;border-top:1px solid #ddd5c4;
      border-bottom:1px solid #ddd5c4;border-radius:10px 0 0 10px;
      background:#f7f3ea;color:#4a453e;cursor:pointer;
      display:flex;align-items:center;justify-content:center;
      box-shadow:-3px 0 12px rgba(60,48,32,.12);padding:0;font-family:inherit}
    #ai-widget-handle:hover{width:40px;background:#efe9dc;color:#262320}
    #ai-widget-handle:focus-visible{outline:2px solid #8a8378;outline-offset:-3px}
    #ai-widget-handle span{writing-mode:vertical-rl;font-size:11px;letter-spacing:2px;user-select:none}

    /* 标签页 */
    .ai-tabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid #ddd5c4;flex-shrink:0}
    .ai-tabs button{background:none;border:none;color:#8a8378;font-size:12.5px;
      padding:7px 14px;border-radius:7px 7px 0 0;cursor:pointer;border-bottom:2px solid transparent}
    .ai-tabs button.on{color:#262320;background:#efe9dc;border-bottom-color:#262320}

    .ai-body{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}
    .ai-body[hidden]{display:none}

    /* 预设网格 */
    .ai-preset-wrap{flex:1;overflow-y:auto;padding:12px}
    .ai-preset-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}
    .ai-preset{border:1px solid #ddd5c4;border-radius:9px;overflow:hidden;cursor:pointer;
      background:#fcfaf5;transition:border-color .15s}
    .ai-preset:hover{border-color:#8a8378}
    .ai-preset.on{border-color:#262320;box-shadow:0 0 0 1px #262320 inset}
    .ai-preset .thumb{height:62px;background:linear-gradient(135deg,#e9e1cf,#d9d0bb);position:relative}
    .ai-preset .thumb::after{content:"";position:absolute;inset:0;
      background:linear-gradient(45deg,rgba(120,100,70,.16),transparent 60%)}
    .ai-preset .nm{padding:7px 9px;font-size:11.5px;color:#4a453e}
    .ai-preset.is-failed{border-color:#a34a3a;box-shadow:0 0 0 1px #a34a3a inset}
    .ai-preset .thumb.approx::before{content:"近似";position:absolute;right:4px;bottom:3px;
      font-size:9px;letter-spacing:.04em;color:#f7f3ea;background:rgba(38,35,32,.42);
      padding:1px 4px;border-radius:3px;z-index:1}
    .ai-cats{display:flex;gap:6px;padding:10px 12px 0;flex-shrink:0}
    .ai-cats button{flex:1;padding:6px 0;font-size:12px;font-family:inherit;cursor:pointer;
      border:1px solid #ddd5c4;border-radius:7px;background:#f7f3ea;color:#8a8378}
    .ai-cats button.on{background:#262320;border-color:#262320;color:#f7f3ea}

    /* 预设模块滑块 */
    .ai-modules{border-top:1px solid #ddd5c4;background:#f9f6ef;max-height:46%;overflow-y:auto;
      padding:10px 12px 12px;flex-shrink:0}
    .ai-modules[hidden]{display:none}
    .ai-modules.busy{opacity:.55}
    .ai-mod-head{display:flex;align-items:center;justify-content:space-between;
      font-size:11.5px;color:#4a453e;margin-bottom:8px}
    .ai-mod-head button{background:none;border:none;color:#8a8378;font-size:11px;cursor:pointer;
      font-family:inherit;padding:2px 4px}
    .ai-mod-head button:hover{color:#262320}
    .ai-mod{margin-bottom:9px}
    .ai-mod .row{display:flex;justify-content:space-between;font-size:11px;color:#8a8378;margin-bottom:3px}
    .ai-mod .row .val{color:#4a453e;font-variant-numeric:tabular-nums}
    .ai-mod.is-ai .name::after{content:" · AI";font-size:9.5px;color:#a39a8b}
    .ai-mod input[type=range]{width:100%;height:3px;accent-color:#4a453e}

    /* 基础调整折叠区 */
    .ai-basic{border-top:1px solid #ddd5c4;flex-shrink:0}
    .ai-basic>summary{padding:9px 12px;font-size:11.5px;color:#4a453e;cursor:pointer;
      list-style:none;user-select:none}
    .ai-basic>summary::before{content:"▸ ";color:#8a8378}
    .ai-basic[open]>summary::before{content:"▾ "}
    .ai-basic .ai-slider-wrap{max-height:260px}

    /* 姿势（实验） */
    .ai-tabs button .exp{font-size:8.5px;margin-left:3px;padding:1px 3px;border-radius:3px;
      background:#e4dccb;color:#7a7265;font-style:normal;vertical-align:super}
    .ai-pose-steps{display:flex;gap:6px;padding:9px 12px 0;font-size:11px;color:#a39a8b;flex-shrink:0}
    .ai-pose-steps span{flex:1;text-align:center;padding:4px 0;border-radius:6px;background:#f2ece0}
    .ai-pose-steps span.on{background:#262320;color:#f7f3ea}
    .ai-pose-pane{flex:1;display:flex;flex-direction:column;min-height:0;padding:10px 12px 12px;gap:9px;overflow-y:auto}
    .ai-pose-pane[hidden]{display:none}
    .ai-pose-photo{height:104px;border:1px solid #ddd5c4;border-radius:8px;background:#efe9dc center/contain no-repeat}
    .ai-pose-checks{list-style:none;margin:0;padding:0;font-size:11.5px;color:#4a453e;display:flex;flex-direction:column;gap:4px}
    .ai-pose-checks li.bad{color:#a34a3a}
    .ai-pose-row{display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:#8a8378}
    .ai-seg{display:flex;gap:4px}
    .ai-seg button{padding:4px 10px;font-size:11.5px;font-family:inherit;cursor:pointer;
      border:1px solid #ddd5c4;border-radius:6px;background:#f7f3ea;color:#8a8378}
    .ai-seg button.on{background:#262320;border-color:#262320;color:#f7f3ea}
    .ai-pose-next,.ai-pose-bar button,.ai-pose-actions button{padding:7px 12px;font-size:12px;font-family:inherit;
      border:1px solid #262320;border-radius:7px;background:#262320;color:#f7f3ea;cursor:pointer}
    .ai-pose-next:disabled,.ai-pose-bar button:disabled{opacity:.4;cursor:default}
    .ai-pose-filters{display:flex;gap:5px;flex-shrink:0}
    .ai-pose-filters select,.ai-pose-filters input{flex:1;min-width:0;font-size:11px;font-family:inherit;
      padding:4px 6px;border:1px solid #ddd5c4;border-radius:6px;background:#fcfaf5;color:#4a453e}
    .ai-pose-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;overflow-y:auto;flex:1;min-height:80px}
    .ai-pose-item{border:1px solid #ddd5c4;border-radius:7px;overflow:hidden;background:#fcfaf5;cursor:pointer;padding:0}
    .ai-pose-item img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;background:#efe9dc}
    .ai-pose-item span{display:block;font-size:10px;color:#8a8378;padding:2px 0}
    .ai-pose-item.on{border-color:#262320;box-shadow:0 0 0 1px #262320 inset}
    .ai-pose-empty{grid-column:1/-1;font-size:11px;color:#8a8378;text-align:center;padding:12px 0}
    .ai-pose-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:#8a8378}
    .ai-pose-progress{font-size:11.5px;color:#4a453e;display:flex;flex-direction:column;gap:6px}
    .ai-pose-progress .row{display:flex;justify-content:space-between;color:#8a8378}
    .ai-pose-progress .row.on{color:#262320}
    .ai-pose-progress .row.bad{color:#a34a3a}
    .ai-pose-progress button{margin-top:6px;padding:6px 10px;font-size:11.5px;font-family:inherit;
      border:1px solid #ddd5c4;border-radius:7px;background:#f7f3ea;color:#262320;cursor:pointer;align-self:flex-start}
    .ai-cmp{position:relative;border-radius:8px;overflow:hidden;border:1px solid #ddd5c4;background:#efe9dc}
    .ai-cmp img{display:block;width:100%}
    .ai-cmp-top{position:absolute;inset:0;overflow:hidden;clip-path:inset(0 50% 0 0)}
    .ai-cmp input{position:absolute;left:8px;right:8px;bottom:6px;width:calc(100% - 16px);accent-color:#262320}
    .ai-pose-actions{display:flex;gap:6px}
    .ai-pose-actions a{flex:1;text-align:center;padding:7px 10px;font-size:12px;border-radius:7px;
      background:#262320;color:#f7f3ea;text-decoration:none}
    .ai-pose-actions button{flex:1;background:#f7f3ea;color:#262320;border-color:#ddd5c4}
    .ai-pose-foot{display:flex;justify-content:flex-end}
    .ai-link{background:none;border:none;color:#8a8378;font-size:10.5px;cursor:pointer;font-family:inherit;padding:2px}
    .ai-cats button .adm{font-style:normal;font-size:8.5px;margin-left:3px;color:#a34a3a}

    /* 调整滑块 */
    .ai-slider-wrap{flex:1;overflow-y:auto;padding:14px 14px 18px;display:flex;flex-direction:column;gap:15px}
    .ai-slider .row{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
    .ai-slider .name{font-size:12px;color:#4a453e}
    .ai-slider .val{font-size:11.5px;color:#4a453e;font-variant-numeric:tabular-nums}
    .ai-slider input[type=range]{width:100%;-webkit-appearance:none;height:4px;border-radius:2px;
      background:#ddd5c4;outline:none;cursor:pointer}
    .ai-slider input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;
      border-radius:50%;background:#4a453e;border:2px solid #f7f3ea;box-shadow:0 1px 4px rgba(60,48,32,.28)}
    .ai-slider input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;
      background:#4a453e;border:2px solid #f7f3ea}
  `;

  // ── Inject CSS ──
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── Inject HTML ──
  // 无悬浮球：抽屉收起时用右侧竖条手柄唤起
  const handle = document.createElement('button');
  handle.id = 'ai-widget-handle';
  handle.title = '展开 AI 修图';
  handle.innerHTML = '<span>AI 修图</span>';
  document.body.appendChild(handle);

  const panel = document.createElement('div');
  panel.id = 'ai-widget-panel';
  panel.innerHTML = `
    <div id="ai-widget-header">
      <span class="title">✨ AI 修图</span>
      <span class="status"><span class="dot" id="ai-widget-dot"></span><span id="ai-widget-status-text">连接中</span></span>
      <button id="ai-widget-close" title="收起">⟩</button>
    </div>
    <div class="ai-tabs">
      <button data-tab="chat" class="on">对话</button>
      <button data-tab="preset">预设 · 调整</button>
      <button data-tab="pose">姿势<i class="exp">实验</i></button>
    </div>
    <div class="ai-body" data-body="chat">
      <div id="ai-widget-messages">
        <div class="msg system">直接描述你想要的效果，AI 会在编辑器中实时调整</div>
      </div>
      <div id="ai-widget-input">
        <input type="text" id="ai-msg-input" placeholder="描述修图需求..." disabled>
        <button id="ai-clear-btn" class="clear-btn" title="撤销本次调整" disabled>⟲</button>
        <button id="ai-send-btn" disabled>发送</button>
      </div>
      <div id="ai-widget-hint">💡 想回退：点 ⟲ 撤销本次调整，或直接按 <kbd>Ctrl</kbd>+<kbd>Z</kbd></div>
    </div>
    <div class="ai-body" data-body="preset" hidden>
      <div class="ai-cats" id="ai-cats">
        <button data-cat="portrait" class="on">人像</button>
        <button data-cat="landscape">风景</button>
      </div>
      <div class="ai-preset-wrap"><div class="ai-preset-grid" id="ai-preset-grid"></div></div>
      <div class="ai-modules" id="ai-modules" hidden></div>
      <details class="ai-basic" id="ai-basic">
        <summary>基础调整</summary>
        <div class="ai-slider-wrap" id="ai-slider-wrap"></div>
      </details>
    </div>

    <div class="ai-body" data-body="pose" hidden>
      <div class="ai-pose-steps">
        <span data-step="1" class="on">① 检查</span>
        <span data-step="2">② 选姿势</span>
        <span data-step="3">③ 生成</span>
      </div>

      <div class="ai-pose-pane" data-pane="1">
        <div class="ai-pose-photo" id="ai-pose-photo"></div>
        <ul class="ai-pose-checks" id="ai-pose-checks"><li>正在检查这张照片…</li></ul>
        <div class="ai-pose-row">
          <span>模式</span>
          <div class="ai-seg" id="ai-pose-mode">
            <button data-mode="full" class="on">全身</button>
            <button data-mode="half">半身</button>
          </div>
        </div>
        <button class="ai-pose-next" id="ai-pose-next" disabled>继续选姿势 →</button>
      </div>

      <div class="ai-pose-pane" data-pane="2" hidden>
        <div class="ai-cats" id="ai-pose-groups"></div>
        <div class="ai-pose-filters">
          <select id="ai-pose-cat"></select>
          <select id="ai-pose-angle"></select>
          <input id="ai-pose-search" placeholder="搜动作…">
        </div>
        <div class="ai-pose-grid" id="ai-pose-grid"></div>
        <div class="ai-pose-bar">
          <span id="ai-pose-picked">还没选姿势</span>
          <button id="ai-pose-gen" disabled>生成 →</button>
        </div>
      </div>

      <div class="ai-pose-pane" data-pane="3" hidden>
        <div class="ai-pose-progress" id="ai-pose-progress"></div>
        <div class="ai-pose-result" id="ai-pose-result" hidden>
          <div class="ai-cmp" id="ai-cmp">
            <img id="ai-cmp-a" alt="原图">
            <div class="ai-cmp-top" id="ai-cmp-top"><img id="ai-cmp-b" alt="结果"></div>
            <input type="range" id="ai-cmp-range" min="0" max="100" value="50">
          </div>
          <div class="ai-pose-actions">
            <a id="ai-pose-dl" download>下载图片</a>
            <button id="ai-pose-again">重新生成</button>
            <button id="ai-pose-back">换个姿势</button>
          </div>
        </div>
        <div class="ai-pose-foot">
          <button id="ai-pose-admin" class="ai-link">管理员口令</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // 抽屉固定右侧，无需定位（保留空函数供旧调用点）
  function placePanel() {}

  // ── DOM refs ──
  const dot = document.getElementById('ai-widget-dot');
  const statusText = document.getElementById('ai-widget-status-text');
  const messagesEl = document.getElementById('ai-widget-messages');
  const msgInput = document.getElementById('ai-msg-input');
  const sendBtn = document.getElementById('ai-send-btn');
  const clearBtn = document.getElementById('ai-clear-btn');

  // ── WebSocket ──
  async function connectWS() {
    if (ws && ws.readyState <= 1) return;
    await baseReady;   // 先定好走站内 /ai 还是走隧道，再连

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      setStatus('online', '已连接');
      reconnectAttempts = 0;
      msgInput.disabled = false;
      sendBtn.disabled = false;
      clearBtn.disabled = false;
      console.log('[AI Widget] WebSocket connected');
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleServerMsg(msg);
      } catch (err) {
        console.error('[AI Widget] Message parse error:', err);
      }
    };

    ws.onclose = () => {
      setStatus('offline', '已断开');
      scheduleReconnect();
    };

    ws.onerror = (e) => {
      console.error('[AI Widget] WebSocket error:', e);
    };
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT) return;
    reconnectAttempts++;
    const delay = Math.min(1000 * reconnectAttempts, 10000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWS();
    }, delay);
  }

  function setStatus(state, text) {
    dot.className = 'dot ' + state;
    statusText.textContent = text;
  }

  // ── Messages ──
  function addMsg(role, html) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.innerHTML = html;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatCommandsHtml(commands) {
    if (!commands || !commands.length) return '';
    let html = '<div class="cmd-list">';
    for (const cmd of commands) {
      if (cmd && typeof cmd.id === 'string' && cmd.id) {
        const params = cmd.params && typeof cmd.params === 'object' ? JSON.stringify(cmd.params) : '{}';
        html += '<div class="cmd-item"><span class="key">' + escapeHtml(cmd.id) + '</span> <span class="val">' + escapeHtml(params) + '</span></div>';
        continue;
      }
      if (cmd && typeof cmd.value === 'number') {
        html += '<div class="cmd-item"><span class="key">' + escapeHtml(cmd.key) + '</span> = <span class="val">' + cmd.value.toFixed(2) + '</span></div>';
      }
    }
    html += '</div>';
    return html;
  }

  function handleServerMsg(msg) {
    switch (msg.type) {
      case 'ack':
        addMsg('system', '📨 任务已提交');
        break;
      case 'thinking':
        addMsg('bot', '🤔 ' + msg.thought);
        break;
      case 'command':
        addMsg('bot', '🎯 ' + msg.explanation + formatCommandsHtml(msg.commands));
        break;
      case 'error':
        isProcessing = false;
        sendBtn.disabled = false;
        addMsg('error', '❌ ' + (msg.message || msg.code));
        break;
    }
  }

  // ── Send (Plan B: parse only, no upload) ──
  async function send() {
    if (isProcessing) return;
    const text = msgInput.value.trim();
    if (!text) return;

    msgInput.value = '';
    isProcessing = true;
    sendBtn.disabled = true;
    addMsg('user', text);

    try {
      // Plan B: call /api/parse, no image upload needed
      addMsg('system', '🤖 AI 正在分析指令...');

      // 带上当前画布：后端据此做视觉分析，定位类需求（选区/画笔/蒙版）才可用。
      const payload = { message: text, tool: currentTool };
      const shot = grabWorkCanvas();
      if (shot) {
        payload.imageBase64 = shot.dataUrl;
        payload.docSize = { w: shot.width, h: shot.height };
      }

      await baseReady;
      const res = await fetch(API_BASE + '/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (data.commands && data.commands.length > 0) {
        activeCommands = data.commands;
        addMsg('bot', '🎯 ' + (data.explanation || '已生成调整参数') + formatCommandsHtml(data.commands));

        // Execute commands in browser
        addMsg('system', '⚡ 正在应用到编辑器...');

        const success = await executeCommands(data.commands);
        if (success) {
          addMsg('system', '✅ 已应用到编辑器，可点 ⟲ 撤销，或按 Ctrl+Z');
          if (editorType === 'lightcraft' && lightcraftUnsupported.length) {
            addMsg('system', 'ℹ️ LightCraft 没有对应控件，这几条跳过了：' + lightcraftUnsupported.join('、'));
          }
        } else if (editorType === 'lightcraft' && lightcraftUnsupported.length) {
          addMsg('error', '⚠️ LightCraft 没有对应控件，这几条没执行：' + lightcraftUnsupported.join('、') +
            '（能用的有：曝光/对比/高光/阴影/饱和/自然饱和/色温/黑白/清晰度/去雾/锐化/降噪/颗粒/暗角）');
        } else {
          addMsg('error', '⚠️ 无法应用到当前编辑器，请截图保存参数');
        }
      } else {
        addMsg('error', '❌ ' + (data.explanation || '无法解析指令，请尝试更具体的描述'));
      }
    } catch (err) {
      addMsg('error', '❌ 请求失败: ' + err.message);
    } finally {
      isProcessing = false;
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener('click', send);
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // ── Reset button ──
  clearBtn.addEventListener('click', async () => {
    if (window.__AI_WIDGET_DEBUG) {
      console.log('[AI Widget][debug] 撤销点击：activeCommands=', activeCommands.length, 'editorType=', editorType);
    }
    if (!activeCommands.length) return;

    if (editorType === 'studio' && window.Studio.resetAll) {
      window.Studio.resetAll();
      addMsg('system', '⟲ 已重置所有调整');
    } else if (editorType === 'lightcraft' && hasLightCraft()) {
      const ok = await undoLightCraft();
      addMsg('system', ok ? '⟲ 已按步撤销本次调整（与 Ctrl+Z 相同）' : '⟲ 没有可撤销的调整');
    } else if (editorType === 'photocraft' && hasPhotoCraftAIBridge()) {
      const ok = await undoPhotoCraft();
      addMsg('system', ok ? '⟲ 已按步撤销本次调整（与 Ctrl+Z 相同）' : '⟲ 没有可撤销的调整');
    } else {
      // Restore original image if available
      addMsg('system', '⟲ 请手动重置编辑器');
    }
    activeCommands = [];
    presetState.id = null;
    presetState.steps = 0;
    markPreset(null);
  });

  // ── Panel toggle ──
  handle.addEventListener('click', async () => {
    panelOpen = true;
    panel.classList.add('open');
    handle.style.display = 'none';

    if (panelOpen) {
      placePanel();
      connectWS();

      // Detect editor
      const editorName = detectEditor();
      if (editorName) {
        // Check for PhotoCraft AI Bridge (new API)
        if (editorType === 'lightcraft') {
          const ok = await lightcraftHasImage();
          addMsg('system', ok
            ? '🔗 已连接 LightCraft（develop.set）'
            : '⚠️ LightCraft 里还没有打开的照片，先导一张进来再说话');
        } else if (editorType === 'photocraft' && hasPhotoCraftAIBridge()) {
          addMsg('system', '🔗 已连接 PhotoCraft AI Bridge（新 API）');
        } else if (editorType === 'photocraft') {
          addMsg('system', '🔗 已连接 PhotoCraft（Canvas 降级模式）');
        } else {
          addMsg('system', '🔗 已连接 ' + editorName + ' 编辑器');
        }

        // Enable input
        msgInput.disabled = false;
        sendBtn.disabled = false;
        clearBtn.disabled = false;

        // Show appropriate placeholder
        msgInput.placeholder = editorType === 'studio'
          ? '描述修图需求，如：调亮一点、加暖色调...'
          : '描述修图需求...';
      } else {
        addMsg('system', '⚠️ 未检测到编辑器，请先打开 PhotoCraft 或 LightCraft 页面');
      }

      msgInput.focus();
    }
  });

  document.getElementById('ai-widget-close').addEventListener('click', () => {
    panelOpen = false;
    panel.classList.remove('open');
    handle.style.display = '';
  });

  // ── Drag & drop ──
  panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.style.borderColor = '#262320'; });
  panel.addEventListener('dragleave', () => { panel.style.borderColor = '#ddd5c4'; });

  // ── 抽屉：预设（prompt + 模块滑块）与基础调整 ──
  // 预设 = 一段 prompt + 一组模块滑块。点预设 → /api/parse 解析成原生命令；
  // 本地能算的滑块直接走模板，需要定位人脸/编排的滑块松手后再解析一次。

  /** 一个人像/风景预设。sliders 里 local 的带 build(v) 模板，ai 的只描述。 */
  const PRESETS = [
    {
      id: 'portrait.airy-girl', name: '清透少女', category: 'portrait',
      prompt: '把这张人像修成清透少女感：肤色干净通透、保留一点毛孔，脸颊透出自然血色，'
        + '眼睛提亮有神，眼睛稍微大一点点、鼻子收一点点，整体高调低对比、偏暖白，不要把皮肤磨成塑料。',
      sliders: [
        { id: 'smooth', label: '磨皮', min: 0, max: 100, def: 35, kind: 'local',
          say: function (v) { return '磨皮 ' + v + '%（保留毛孔）'; },
          build: function (v) { return [{ id: 'filter.blur.surfaceBlur', params: { radius: round3(1 + v * 0.29), threshold: Math.round(8 + v * 0.4) } }]; } },
        { id: 'blush', label: '脸红润', min: -100, max: 100, def: 25, kind: 'local',
          say: function (v) { return v > 0 ? '脸颊加 ' + v + '% 血色' : '脸颊减 ' + (-v) + '% 血色'; },
          build: function (v) { return [
            { id: 'image.adjustments.selectiveColor', params: { colors: 'reds', magenta: round3(v * 0.3), black: round3(-v * 0.1) } },
            { id: 'image.adjustments.colorBalance', params: { highlights: [round3(v * 0.15), 0, round3(-v * 0.1)] } },
          ]; } },
        { id: 'eyes-size', label: '眼睛大小', min: -30, max: 30, def: 0, kind: 'ai' },
        { id: 'nose-size', label: '鼻子大小', min: -30, max: 30, def: 0, kind: 'ai' },
        { id: 'eyes-light', label: '眼神光', min: 0, max: 100, def: 30, kind: 'ai' },
        { id: 'bright', label: '高调', min: -100, max: 100, def: 20, kind: 'local',
          say: function (v) { return '整体提亮 ' + v + '%'; },
          build: function (v) { return [{ id: 'image.adjustments.exposure', params: { exposure: round3(v * 0.01) } }]; } },
        { id: 'contrast', label: '对比', min: -50, max: 100, def: -10, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.brightnessContrast', params: { contrast: Math.round(v) } }]; } },
      ],
    },
    {
      id: 'portrait.cream-skin', name: '奶油肌', category: 'portrait',
      prompt: '把皮肤修成奶油肌：细腻均匀、几乎看不到斑点，光从正面来、阴影很浅，'
        + '整体偏暖、低对比，像棚拍柔光，保留一点皮肤纹理。',
      sliders: [
        { id: 'smooth', label: '磨皮', min: 0, max: 100, def: 55, kind: 'local',
          say: function (v) { return '磨皮 ' + v + '%'; },
          build: function (v) { return [{ id: 'filter.blur.surfaceBlur', params: { radius: round3(1 + v * 0.35), threshold: Math.round(12 + v * 0.5) } }]; } },
        { id: 'spots', label: '斑点淡化', min: 0, max: 100, def: 40, kind: 'ai' },
        { id: 'warm', label: '暖度', min: -50, max: 50, def: 15, kind: 'local',
          say: function (v) { return v >= 0 ? '暖 ' + v : '冷 ' + (-v); },
          build: function (v) { return v >= 0
            ? [{ id: 'image.adjustments.photoFilter', params: { filter: 'warming85', density: round3(v * 0.6) } }]
            : [{ id: 'image.adjustments.photoFilter', params: { filter: 'cooling80', density: round3(-v * 0.6) } }]; } },
        { id: 'contrast', label: '对比', min: -50, max: 50, def: -15, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.brightnessContrast', params: { contrast: Math.round(v) } }]; } },
        { id: 'bright', label: '亮度', min: -50, max: 50, def: 10, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.exposure', params: { exposure: round3(v * 0.012) } }]; } },
      ],
    },
    {
      id: 'portrait.hk-film', name: '港风胶片', category: 'portrait',
      prompt: '修成 90 年代港风胶片：阴影偏青绿、肤色偏橙、整体低饱和但通透，加一点颗粒和暗角，对比稍高。',
      sliders: [
        { id: 'teal', label: '青绿阴影', min: -30, max: 30, def: 12, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.colorBalance', params: { shadows: [round3(-v * 0.5), round3(v * 0.5), round3(v * 0.8)] } }]; } },
        { id: 'skin', label: '肤色暖度', min: -30, max: 30, def: 15, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.selectiveColor', params: { colors: 'reds', magenta: round3(v * 0.4), yellow: round3(-v * 0.2) } }]; } },
        { id: 'sat', label: '饱和度', min: -60, max: 60, def: -15, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.vibrance', params: { saturation: Math.round(v) } }]; } },
        { id: 'grain', label: '颗粒', min: 0, max: 100, def: 25, kind: 'local',
          build: function (v) { return [{ id: 'filter.gallery.grain', params: { intensity: Math.round(v), contrast: 50 } }]; } },
        { id: 'contrast', label: '对比', min: -50, max: 50, def: 12, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.brightnessContrast', params: { contrast: Math.round(v) } }]; } },
      ],
    },
    {
      id: 'portrait.jp-cool', name: '日系清凉', category: 'portrait',
      prompt: '日系清凉感：高调、低饱和、阴影发青，天空更蓝，肤色白净不发黄。',
      sliders: [
        { id: 'bright', label: '高调', min: -100, max: 100, def: 25, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.exposure', params: { exposure: round3(v * 0.01) } }]; } },
        { id: 'sat', label: '饱和度', min: -60, max: 60, def: -12, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.vibrance', params: { saturation: Math.round(v) } }]; } },
        { id: 'cool', label: '冷调', min: -30, max: 30, def: 10, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.photoFilter', params: { filter: 'cooling80', density: round3(v * 0.8) } }]; } },
        { id: 'blue', label: '蓝', min: -30, max: 30, def: 8, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.colorBalance', params: { highlights: [0, 0, round3(v * 0.6)] } }]; } },
      ],
    },
    {
      id: 'portrait.bw', name: '黑白肖像', category: 'portrait',
      prompt: '面部黑白肖像：高反差，皮肤干净，眼睛和嘴唇提亮，背景压暗。',
      sliders: [
        { id: 'contrast', label: '反差', min: -50, max: 100, def: 30, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.brightnessContrast', params: { contrast: Math.round(v) } }]; } },
        { id: 'smooth', label: '磨皮', min: 0, max: 100, def: 30, kind: 'local',
          build: function (v) { return [{ id: 'filter.blur.surfaceBlur', params: { radius: round3(1 + v * 0.3), threshold: Math.round(10 + v * 0.4) } }]; } },
        { id: 'eyes', label: '眼睛提亮', min: 0, max: 100, def: 45, kind: 'ai' },
        { id: 'red', label: '红滤镜', min: -50, max: 50, def: 20, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.blackWhite', params: {
            reds: Math.round(40 + v * 2), yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 } }]; } },
      ],
    },
    {
      id: 'portrait.id-photo', name: '证件照', category: 'portrait',
      prompt: '证件照处理：正面均匀光、背景提白、去油光、肤色均匀，轻微磨皮，不要风格化。',
      sliders: [
        { id: 'bg', label: '背景提白', min: 0, max: 100, def: 60, kind: 'ai' },
        { id: 'smooth', label: '磨皮', min: 0, max: 100, def: 25, kind: 'local',
          build: function (v) { return [{ id: 'filter.blur.surfaceBlur', params: { radius: round3(1 + v * 0.25), threshold: Math.round(8 + v * 0.3) } }]; } },
        { id: 'shine', label: '油光压制', min: 0, max: 100, def: 35, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.selectiveColor', params: { colors: 'whites', yellow: round3(-v * 0.3), magenta: round3(-v * 0.2) } }]; } },
        { id: 'bright', label: '亮度', min: -30, max: 30, def: 0, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.exposure', params: { exposure: round3(v * 0.012) } }]; } },
      ],
    },
    {
      id: 'landscape.clear', name: '通透风光', category: 'landscape',
      prompt: '把这张风光修得通透：阴影提亮但别发灰，高光收回来，黑场压实，颜色饱和但自然，细节锐一点。',
      sliders: [
        { id: 'shadows', label: '阴影提亮', min: 0, max: 100, def: 35, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.shadowsHighlights', params: { shadowAmount: Math.round(v) } }]; } },
        { id: 'highlights', label: '高光回收', min: 0, max: 100, def: 30, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.shadowsHighlights', params: { highlightAmount: Math.round(v) } }]; } },
        { id: 'black', label: '黑场', min: 0, max: 40, def: 10, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.levels', params: { inBlack: Math.round(v) } }]; } },
        { id: 'clear', label: '通透', min: -100, max: 100, def: 18, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.vibrance', params: { vibrance: Math.round(v) } }]; } },
        { id: 'sharp', label: '锐度', min: 0, max: 100, def: 30, kind: 'local',
          build: function (v) { return [{ id: 'filter.sharpen.unsharpMask', params: { amount: Math.round(50 + v * 3), radius: 1, threshold: 0 } }]; } },
      ],
    },
    {
      id: 'landscape.golden', name: '日落金调', category: 'landscape',
      prompt: '修成日落金调：整体偏暖，高光带金橙，阴影压成偏冷的蓝紫，饱和稍高，对比中等。',
      sliders: [
        { id: 'warm', label: '暖度', min: 0, max: 100, def: 30, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.photoFilter', params: { filter: 'warming85', density: Math.round(v) } }]; } },
        { id: 'gold', label: '金光', min: 0, max: 100, def: 25, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.colorBalance', params: { highlights: [round3(v * 0.4), 0, round3(-v * 0.3)] } }]; } },
        { id: 'shadowBlue', label: '阴影蓝', min: -50, max: 50, def: 15, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.colorBalance', params: { shadows: [0, 0, round3(v * 0.5)] } }]; } },
        { id: 'sat', label: '饱和', min: -50, max: 50, def: 10, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.vibrance', params: { saturation: Math.round(v) } }]; } },
        { id: 'contrast', label: '对比', min: -50, max: 50, def: 8, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.brightnessContrast', params: { contrast: Math.round(v) } }]; } },
      ],
    },
    {
      id: 'landscape.alpine', name: '雪山冷调', category: 'landscape',
      prompt: '雪山冷调：整体偏冷偏蓝，雪面要白不能发灰，高光收住，对比拉开，细节锐利。',
      sliders: [
        { id: 'cool', label: '冷度', min: 0, max: 100, def: 25, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.photoFilter', params: { filter: 'cooling80', density: Math.round(v) } }]; } },
        { id: 'snow', label: '雪白', min: 0, max: 100, def: 20, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.levels', params: { inWhite: Math.round(255 - v * 0.4) } }]; } },
        { id: 'contrast', label: '对比', min: -50, max: 80, def: 20, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.brightnessContrast', params: { contrast: Math.round(v) } }]; } },
        { id: 'sharp', label: '锐度', min: 0, max: 100, def: 35, kind: 'local',
          build: function (v) { return [{ id: 'filter.sharpen.unsharpMask', params: { amount: Math.round(50 + v * 3), radius: 1, threshold: 0 } }]; } },
        { id: 'denoise', label: '降噪', min: 0, max: 10, def: 4, kind: 'local',
          build: function (v) { return [{ id: 'filter.noise.reduceNoise', params: { strength: round3(v), preserveDetails: 60 } }]; } },
      ],
    },
    {
      id: 'landscape.forest', name: '森林绿意', category: 'landscape',
      prompt: '森林绿意：绿色更浓更透，黄绿分开不脏，阴影提亮，整体通透。',
      sliders: [
        { id: 'greenSat', label: '绿色饱和', min: -100, max: 100, def: 20, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.hueSaturation', params: { greens: { saturation: Math.round(v) } } }]; } },
        { id: 'greenHue', label: '绿色色相', min: -30, max: 30, def: -6, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.hueSaturation', params: { greens: { hue: Math.round(v) } } }]; } },
        { id: 'shadows', label: '阴影提亮', min: 0, max: 100, def: 25, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.shadowsHighlights', params: { shadowAmount: Math.round(v) } }]; } },
        { id: 'clear', label: '通透', min: -100, max: 100, def: 15, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.vibrance', params: { vibrance: Math.round(v) } }]; } },
      ],
    },
    {
      id: 'landscape.coast', name: '海蓝清透', category: 'landscape',
      prompt: '海景清透：天空和海面偏青蓝，白云有层次，高光压住，整体明快。',
      sliders: [
        { id: 'sky', label: '天空青蓝', min: -50, max: 50, def: 18, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.colorBalance', params: { highlights: [0, 0, round3(v * 0.6)] } }]; } },
        { id: 'seaSat', label: '海面饱和', min: -50, max: 50, def: 12, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.vibrance', params: { saturation: Math.round(v) } }]; } },
        { id: 'highlights', label: '高光', min: 0, max: 100, def: 25, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.shadowsHighlights', params: { highlightAmount: Math.round(v) } }]; } },
        { id: 'bright', label: '亮度', min: -50, max: 50, def: 5, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.exposure', params: { exposure: round3(v * 0.012) } }]; } },
      ],
    },
    {
      id: 'landscape.mono', name: '黑白风光', category: 'landscape',
      prompt: '风光黑白：高反差，云层有层次，暗部不死黑，颗粒轻。',
      sliders: [
        { id: 'contrast', label: '反差', min: -50, max: 100, def: 30, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.brightnessContrast', params: { contrast: Math.round(v) } }]; } },
        { id: 'red', label: '红滤镜', min: -50, max: 50, def: 20, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.blackWhite', params: {
            reds: Math.round(40 + v * 2), yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 } }]; } },
        { id: 'grain', label: '颗粒', min: 0, max: 100, def: 20, kind: 'local',
          build: function (v) { return [{ id: 'filter.gallery.grain', params: { intensity: Math.round(v), contrast: 50 } }]; } },
        { id: 'black', label: '黑场', min: 0, max: 40, def: 8, kind: 'local',
          build: function (v) { return [{ id: 'image.adjustments.levels', params: { inBlack: Math.round(v) } }]; } },
      ],
    },
  ];

  // 基础调整：脱离预设，单独作用于当前图
  const BASIC_SLIDERS = [
    { id: 'exposure', label: '曝光', min: -2, max: 2, step: 0.05, build: function (v) {
      return [{ id: 'image.adjustments.exposure', params: { exposure: round3(v) } }];
    } },
    { id: 'brightness', label: '亮度', min: -150, max: 150, step: 1, build: function (v) {
      return [{ id: 'image.adjustments.brightnessContrast', params: { brightness: Math.round(v) } }];
    } },
    { id: 'contrast', label: '对比度', min: -50, max: 100, step: 1, build: function (v) {
      return [{ id: 'image.adjustments.brightnessContrast', params: { contrast: Math.round(v) } }];
    } },
    { id: 'saturation', label: '饱和度', min: -100, max: 100, step: 1, build: function (v) {
      return [{ id: 'image.adjustments.vibrance', params: { saturation: Math.round(v) } }];
    } },
    { id: 'warmth', label: '色温', min: -100, max: 100, step: 1, build: function (v) {
      return v >= 0
        ? [{ id: 'image.adjustments.photoFilter', params: { filter: 'warming85', density: round3(v) } }]
        : [{ id: 'image.adjustments.photoFilter', params: { filter: 'cooling80', density: round3(-v) } }];
    } },
  ];

  const CACHE_KEY = 'ai.preset.cache.v1';
  const CACHE_MAX = 40;

  const presetState = {
    id: null,
    category: 'portrait',
    values: {},
    base: [],        // AI 返回的命令（整段 prompt 的结果）
    steps: 0,        // 本组写入的撤销步数
    busy: false,
  };
  const sliderState = Object.create(null);   // 基础调整：滑块 id → 已写入步数
  let replaySeq = 0;                         // 重放序号：并发的滑块改动只让最后一发生效

  function round3(v) { return Math.round(v * 1000) / 1000; }

  function presetById(id) {
    for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  }

  function defaultValues(preset) {
    const out = {};
    preset.sliders.forEach(function (s) { out[s.id] = s.def; });
    return out;
  }

  /** 拼 prompt：预设正文 + 改动过/非 0 的滑块措辞 */
  function buildPrompt(preset, values) {
    const parts = [preset.prompt];
    preset.sliders.forEach(function (s) {
      const v = values[s.id];
      if (v === undefined || v === null) return;
      if (v === s.def) return;
      if (s.kind === 'ai' && !v) return;
      if (typeof s.say === 'function') parts.push(s.say(v));
      else if (v) parts.push(s.label + ' ' + v);
    });
    return parts.join('；') + '。';
  }

  /** 本地能算的命令：把所有 local 滑块按当前值展开 */
  function localCommands(preset, values) {
    let out = [];
    preset.sliders.forEach(function (s) {
      if (s.kind !== 'local' || typeof s.build !== 'function') return;
      const v = values[s.id];
      if (!v) return;                       // 0 = 不提交
      if (v === 0) return;
      out = out.concat(s.build(v));
    });
    return out;
  }

  function cacheKey(preset, values) {
    const ai = {};
    preset.sliders.forEach(function (s) { if (s.kind === 'ai') ai[s.id] = values[s.id]; });
    return preset.id + '|' + JSON.stringify(ai);
  }

  function readCache(key) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const map = raw ? JSON.parse(raw) : {};
      const hit = map[key];
      return Array.isArray(hit) ? hit : null;
    } catch (e) { return null; }
  }

  function writeCache(key, commands) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const map = raw ? JSON.parse(raw) : {};
      map[key] = commands;
      const keys = Object.keys(map);
      while (keys.length > CACHE_MAX) delete map[keys.shift()];
      localStorage.setItem(CACHE_KEY, JSON.stringify(map));
    } catch (e) { /* 隐私模式写不了就算了 */ }
  }

  /** 当前编辑器能不能接命令 */
  function canApply() {
    if (editorType === 'lightcraft') return hasLightCraft();
    if (editorType === 'photocraft') return hasPhotoCraftAIBridge() && !!(window.has_session && window.has_session());
    return false;
  }

  function applyHint() {
    return editorType === 'lightcraft' ? '先在 LightCraft 里打开一张照片' : '先在 PhotoCraft 里打开一张照片';
  }

  /** 把一句 prompt 交给后端解析成原生命令 */
  async function requestParse(message) {
    await baseReady;
    const payload = { message: message, tool: currentTool };
    const shot = grabWorkCanvas(1024);
    if (shot) {
      payload.imageBase64 = shot.dataUrl;
      payload.docSize = { w: shot.width, h: shot.height };
    }
    const res = await fetch(API_BASE + '/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return Array.isArray(data.commands) ? data.commands : [];
  }

  /** 撤回本组件上一组命令（按 presetState.steps） */
  async function undoPresetGroup() {
    const steps = presetState.steps || 0;
    presetState.steps = 0;
    if (!steps) return;
    if (editorType === 'lightcraft') {
      if (hasLightCraft()) {
        lightcraftUndo.__steps = steps;      // 让 LightCraft 按本次组内步数撤
        await undoLightCraft();
      }
    } else {
      await undoPhotoCraftSteps(steps, 80);  // 组内撤销要快，别拖着滑块
      photocraftUndo.__steps = Math.max(0, (photocraftUndo.__steps || 0) - steps);
    }
  }

  /** 提交一组命令，返回实际提交条数 */
  async function commitCommands(cmds) {
    if (!cmds || !cmds.length) return 0;
    if (editorType === 'lightcraft') {
      const before = lightcraftUndo.__steps || 0;
      const ok = await executeLightCraftCommands(cmds);
      if (!ok) return 0;
      return Math.max(1, (lightcraftUndo.__steps || 0) - before);
    }
    await executePhotoCraftCommands(cmds);
    return lastPCApply.applied;
  }

  function setBusy(on) {
    presetState.busy = !!on;
    const panel = document.getElementById('ai-modules');
    if (panel) panel.classList.toggle('busy', !!on);
  }

  /** 用「AI 基础命令 + 本地模板」重放当前预设 */
  async function replayPreset() {
    const preset = presetById(presetState.id);
    if (!preset) return;
    if (!canApply()) { addMsg('system', '⚠️ ' + applyHint()); return; }
    const seq = ++replaySeq;
    const idAtStart = presetState.id;
    await undoPresetGroup();
    if (seq !== replaySeq || presetState.id !== idAtStart) return;   // 期间又有改动/换预设，这一发作废
    const cmds = presetState.base.concat(localCommands(preset, presetState.values));
    presetState.steps = await commitCommands(cmds);
    if (!presetState.steps) addMsg('system', '⚠️ 「' + preset.name + '」没生效，引擎没接命令');
  }

  async function refreshFromAI(preset) {
    const prompt = buildPrompt(preset, presetState.values);
    const key = cacheKey(preset, presetState.values);
    const cached = readCache(key);
    if (cached) { presetState.base = cached; return; }

    const idAtStart = presetState.id;
    setBusy(true);
    try {
      const cmds = await requestParse(prompt);
      if (presetState.id !== idAtStart) return;   // 期间换了预设，丢掉这次结果
      presetState.base = cmds;
      writeCache(key, cmds);
    } catch (e) {
      console.warn('[AI Widget] 预设解析失败:', e && e.message);
      presetState.base = [];
      addMsg('system', '⚠️ AI 没返回命令，先用本地模板');
    } finally {
      setBusy(false);
    }
  }

  async function selectPreset(preset) {
    if (presetState.id === preset.id) { await cancelPreset(); return; }
    if (!canApply()) { addMsg('system', '⚠️ ' + applyHint()); return; }

    await undoPresetGroup();
    presetState.id = preset.id;
    presetState.values = defaultValues(preset);
    presetState.base = [];
    markPreset(preset.id);
    renderModules();
    addMsg('system', '🎨 正在生成「' + preset.name + '」…');
    await refreshFromAI(preset);
    if (presetState.id !== preset.id) return;
    await replayPreset();
    markPreset(preset.id, presetState.steps ? null : 'failed');
    if (presetState.steps) {
      addMsg('system', '🎨 已套用「' + preset.name + '」· 拖动下方滑块可再调');
    }
  }

  async function cancelPreset() {
    const preset = presetById(presetState.id);
    await undoPresetGroup();
    presetState.id = null;
    presetState.base = [];
    markPreset(null);
    renderModules();
    if (preset) addMsg('system', '↺ 已取消「' + preset.name + '」');
  }

  function markPreset(id, flag) {
    const grid = document.getElementById('ai-preset-grid');
    if (!grid) return;
    grid.querySelectorAll('.ai-preset').forEach(function (card) {
      const on = !!id && card.dataset.preset === id;
      card.classList.toggle('on', on);
      card.classList.toggle('is-failed', on && flag === 'failed');
    });
  }

  /** 当前画布缩略图（跨域污染时返回 null） */
  function canvasThumbURL() {
    try {
      const cv = document.getElementById(editorType === 'lightcraft' ? 'lightcraft_canvas'
        : editorType === 'photocraft' ? 'photocraft_canvas' : '')
        || document.querySelector('canvas');
      if (!cv || !cv.width || !cv.height) return null;
      const w = 160;
      const h = Math.max(1, Math.round(cv.height * w / cv.width));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(cv, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.7);
    } catch (e) { return null; }
  }

  function paintPresetThumbs() {
    const url = canvasThumbURL();
    if (!url) return;
    document.querySelectorAll('#ai-preset-grid .ai-preset .thumb').forEach(function (t) {
      t.style.backgroundImage = 'url(' + url + ')';
      t.style.backgroundSize = 'cover';
      t.style.backgroundPosition = 'center';
      t.classList.add('approx');
    });
  }

  function presetCard(preset) {
    const card = document.createElement('div');
    card.className = 'ai-preset';
    card.dataset.preset = preset.id;
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = preset.name;
    card.appendChild(thumb);
    card.appendChild(nm);
    card.addEventListener('click', function () { selectPreset(preset); });
    return card;
  }

  function renderPresetGrid() {
    const grid = document.getElementById('ai-preset-grid');
    if (!grid) return;
    grid.innerHTML = '';
    PRESETS.filter(function (p) { return p.category === presetState.category; })
      .forEach(function (p) { grid.appendChild(presetCard(p)); });
    paintPresetThumbs();
    if (presetState.id) markPreset(presetState.id);
  }

  /** 选中预设后，在卡片下方列出它的模块滑块 */
  function renderModules() {
    const panel = document.getElementById('ai-modules');
    if (!panel) return;
    panel.innerHTML = '';
    const preset = presetById(presetState.id);
    if (!preset) { panel.hidden = true; return; }
    panel.hidden = false;

    const head = document.createElement('div');
    head.className = 'ai-mod-head';
    head.innerHTML = '<span>' + escapeHtml(preset.name) + ' · 调整</span>'
      + '<button type="button" class="ai-mod-cancel">取消</button>';
    head.querySelector('.ai-mod-cancel').addEventListener('click', cancelPreset);
    panel.appendChild(head);

    preset.sliders.forEach(function (spec) {
      const row = document.createElement('div');
      row.className = 'ai-mod' + (spec.kind === 'ai' ? ' is-ai' : '');
      row.innerHTML = '<div class="row"><span class="name">' + spec.label
        + '</span><span class="val">' + fmtVal(spec, presetState.values[spec.id]) + '</span></div>'
        + '<input type="range" min="' + spec.min + '" max="' + spec.max + '" step="' + (spec.step || 1) + '" value="'
        + presetState.values[spec.id] + '">';
      const input = row.querySelector('input');
      const out = row.querySelector('.val');
      let timer = null;

      input.addEventListener('input', function () {
        const v = Number(input.value);
        presetState.values[spec.id] = v;
        out.textContent = fmtVal(spec, v);
      });

      input.addEventListener('change', function () {
        const v = Number(input.value);
        presetState.values[spec.id] = v;
        out.textContent = fmtVal(spec, v);
        if (timer) clearTimeout(timer);
        if (spec.kind === 'ai') {
          // 需要人脸定位/编排：松手后重新解析一次
          timer = setTimeout(async function () {
            if (!canApply()) { addMsg('system', '⚠️ ' + applyHint()); return; }
            addMsg('system', '🎨 正在按「' + spec.label + '」重新生成…');
            await refreshFromAI(preset);
            if (presetState.id !== preset.id) return;
            await replayPreset();
            markPreset(preset.id, presetState.steps ? null : 'failed');
          }, 400);
        } else {
          timer = setTimeout(function () { replayPreset(); }, 120);
        }
      });

      panel.appendChild(row);
    });
  }

  function fmtVal(spec, v) {
    const step = spec.step || 1;
    const txt = step < 1 ? Number(v).toFixed(2) : String(Math.round(v));
    return (v > 0 ? '+' : '') + txt;
  }

  function buildBasicSliders(wrap) {
    BASIC_SLIDERS.forEach(function (spec) {
      const row = document.createElement('div');
      row.className = 'ai-slider';
      row.innerHTML = '<div class="row"><span class="name">' + spec.label + '</span><span class="val">0</span></div>'
        + '<input type="range" min="' + spec.min + '" max="' + spec.max + '" step="' + spec.step + '" value="0">';
      const input = row.querySelector('input');
      const out = row.querySelector('.val');

      input.addEventListener('input', function () {
        const v = Number(input.value);
        out.textContent = (v > 0 ? '+' : '') + (spec.step < 1 ? v.toFixed(2) : String(Math.round(v)));
      });

      input.addEventListener('change', async function () {
        const v = Number(input.value);
        if (!canApply()) { addMsg('system', '⚠️ ' + applyHint()); return; }
        const prev = sliderState[spec.id] || 0;
        if (prev) {
          if (editorType === 'lightcraft') {
            await undoLightCraft();
          } else {
            await undoPhotoCraftSteps(prev);
            photocraftUndo.__steps = Math.max(0, (photocraftUndo.__steps || 0) - prev);
          }
          sliderState[spec.id] = 0;
        }
        if (v === 0) return;
        const applied = await commitCommands(spec.build(v));
        sliderState[spec.id] = applied;
        if (!applied) addMsg('system', '⚠️ 「' + spec.label + '」没生效');
      });

      wrap.appendChild(row);
    });
  }

  /* ── 姿势（实验）：背景不变，只换人的姿势 ── */
  const POSE_LS_ADMIN = 'ai.pose.admin';
  const poseState = {
    mode: 'full', catalog: null, group: 'full', poseId: null, angle: '正面',
    taskId: null, timer: null, srcDataUrl: '', resultUrl: '', started: false,
  };

  function poseAdminKey() {
    try { return localStorage.getItem(POSE_LS_ADMIN) || ''; } catch (e) { return ''; }
  }
  function poseSetAdmin(k) {
    try { k ? localStorage.setItem(POSE_LS_ADMIN, k) : localStorage.removeItem(POSE_LS_ADMIN); } catch (e) { /* 隐私模式 */ }
  }

  function poseHeaders() {
    const h = { 'Content-Type': 'application/json', 'X-API-Key': API_KEY };
    const k = poseAdminKey();
    if (k) h['X-Admin-Key'] = k;
    return h;
  }

  async function poseFetch(p, opts) {
    await baseReady;
    const res = await fetch(API_BASE + '/api/pose' + p, opts);
    const txt = await res.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch (e) { /* 非 JSON */ }
    if (!res.ok) throw new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
    return data;
  }

  function posePane(n) {
    document.querySelectorAll('.ai-pose-pane').forEach(function (p) {
      p.hidden = p.dataset.pane !== String(n);
    });
    document.querySelectorAll('.ai-pose-steps span').forEach(function (s) {
      s.classList.toggle('on', Number(s.dataset.step) <= n);
    });
  }

  const POSE_REASON = {
    no_person: '画面里没找到人', no_face: '没认出脸', multiple_people: '画面里不止一个人',
    not_full_body: '只拍到了半身', too_small: '照片太小', policy: '平台审核没过',
    pose_not_allowed: '这个姿势需要管理员模式', pose_not_found: '这个姿势不在了',
    no_sensenova_key: '服务器没配生图密钥',
  };

  async function poseCheck() {
    const box = document.getElementById('ai-pose-checks');
    const nextBtn = document.getElementById('ai-pose-next');
    if (!box || !nextBtn) return;
    nextBtn.disabled = true;
    box.innerHTML = '<li>正在检查这张照片…</li>';

    const shot = grabWorkCanvas(1600);
    if (!shot) {
      document.getElementById('ai-pose-photo').style.backgroundImage = '';
      box.innerHTML = '<li class="bad">先在编辑器里打开一张照片</li>';
      return;
    }
    poseState.srcDataUrl = shot.dataUrl;
    document.getElementById('ai-pose-photo').style.backgroundImage = 'url(' + shot.dataUrl + ')';

    try {
      const r = await poseFetch('/check', {
        method: 'POST', headers: poseHeaders(),
        body: JSON.stringify({ imageBase64: shot.dataUrl, mode: poseState.mode }),
      });
      if (r.ok) {
        const li = ['<li>✓ 检测到 ' + r.people + ' 个人</li>'];
        li.push('<li>' + (r.ratio >= 0.45 ? '✓ 全身构图' : '· 半身构图') + '（人物占画面 ' + Math.round(r.ratio * 100) + '%）</li>');
        li.push('<li>✓ 能认出脸</li>');
        if (poseState.mode === 'full' && r.ratio < 0.45) li.push('<li class="bad">· 选「全身」需要拍到脚，建议切半身</li>');
        box.innerHTML = li.join('');
        nextBtn.disabled = false;
      } else {
        box.innerHTML = '<li class="bad">✕ ' + escapeHtml(r.message || POSE_REASON[r.reason] || '这张照片不能用') + '</li>';
      }
    } catch (e) {
      box.innerHTML = '<li class="bad">✕ 检查失败：' + escapeHtml(e.message) + '</li>';
    }
  }

  async function poseLoadCatalog() {
    const groupsEl = document.getElementById('ai-pose-groups');
    if (!groupsEl) return;
    if (!poseState.catalog) {
      groupsEl.innerHTML = '<button disabled>载入中…</button>';
      try {
        poseState.catalog = await poseFetch('/catalog', { headers: poseHeaders() });
      } catch (e) {
        groupsEl.innerHTML = '';
        addMsg('system', '⚠️ 姿势库没载入：' + e.message);
        return;
      }
    }
    const groups = poseState.catalog.groups || [];
    if (!groups.some(function (g) { return g.key === poseState.group; })) {
      poseState.group = groups.length ? groups[0].key : 'full';
    }
    groupsEl.innerHTML = '';
    groups.forEach(function (g) {
      const b = document.createElement('button');
      b.dataset.group = g.key;
      b.className = g.key === poseState.group ? 'on' : '';
      b.innerHTML = escapeHtml(g.name) + (g.admin ? '<i class="adm">管理</i>' : '');
      b.addEventListener('click', function () {
        poseState.group = g.key;
        poseState.poseId = null;
        groupsEl.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
        poseFillFilters();
        poseRenderGrid();
        poseUpdateBar();
      });
      groupsEl.appendChild(b);
    });
    poseFillFilters();
    poseRenderGrid();
  }

  function poseCurrentGroup() {
    const gs = (poseState.catalog && poseState.catalog.groups) || [];
    for (let i = 0; i < gs.length; i++) if (gs[i].key === poseState.group) return gs[i];
    return gs[0] || null;
  }

  function poseFillFilters() {
    const g = poseCurrentGroup();
    const catSel = document.getElementById('ai-pose-cat');
    const angSel = document.getElementById('ai-pose-angle');
    if (!g || !catSel || !angSel) return;

    const cats = [];
    const angs = [];
    (g.poses || []).forEach(function (p) {
      if (cats.indexOf(p.category) < 0) cats.push(p.category);
      p.angles.forEach(function (a) { if (angs.indexOf(a.angle) < 0) angs.push(a.angle); });
    });
    catSel.innerHTML = '<option value="">全部分类</option>' + cats.map(function (c) {
      return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>';
    }).join('');
    angSel.innerHTML = angs.map(function (a) {
      return '<option value="' + escapeHtml(a) + '"' + (a === poseState.angle ? ' selected' : '') + '>' + escapeHtml(a) + '</option>';
    }).join('');
    if (angs.indexOf(poseState.angle) < 0 && angs.length) {
      poseState.angle = angs[0];
      angSel.value = angs[0];
    }
  }

  function poseRenderGrid() {
    const grid = document.getElementById('ai-pose-grid');
    const g = poseCurrentGroup();
    if (!grid || !g) return;
    const cat = document.getElementById('ai-pose-cat').value;
    const q = (document.getElementById('ai-pose-search').value || '').trim();

    const items = (g.poses || []).filter(function (p) {
      if (cat && p.category !== cat) return false;
      if (q && (p.name + p.no + p.category).indexOf(q) < 0) return false;
      return true;
    });

    grid.innerHTML = '';
    let shown = 0;
    items.forEach(function (p) {
      const ang = p.angles.filter(function (a) { return a.angle === poseState.angle; })[0] || p.angles[0];
      if (!ang) return;
      shown++;
      if (shown > 90) return;              // 一次最多渲染 90 个，够翻
      const b = document.createElement('button');
      b.className = 'ai-pose-item' + (p.id === poseState.poseId ? ' on' : '');
      b.dataset.pose = p.id;
      b.innerHTML = '<img loading="lazy" src="' + ang.thumb + '" alt=""><span>' + escapeHtml(p.no) + '</span>';
      b.title = p.name + ' · ' + p.category;
      b.addEventListener('click', function () {
        poseState.poseId = p.id;
        grid.querySelectorAll('.ai-pose-item').forEach(function (x) { x.classList.toggle('on', x === b); });
        poseUpdateBar();
      });
      grid.appendChild(b);
    });
    if (!shown) grid.innerHTML = '<div class="ai-pose-empty">这个分类下没有姿势</div>';
  }

  function poseUpdateBar() {
    const picked = document.getElementById('ai-pose-picked');
    const genBtn = document.getElementById('ai-pose-gen');
    if (!picked || !genBtn) return;
    const g = poseCurrentGroup();
    const p = g && (g.poses || []).filter(function (x) { return x.id === poseState.poseId; })[0];
    picked.textContent = p ? ('已选 ' + p.no + ' · ' + p.name) : '还没选姿势';
    genBtn.disabled = !p;
  }

  const POSE_STAGES = [
    ['gate', '检查照片', 10], ['plate', '拆主体与背景', 30],
    ['generate', '生成姿势', 50], ['composite', '合成回原背景', 85],
  ];

  function posePaintProgress(stage, progress, status, error) {
    const box = document.getElementById('ai-pose-progress');
    if (!box) return;
    if (status === 'failed') {
      const msg = POSE_REASON[error] || error || '生成失败';
      box.innerHTML = '<div class="row bad">✕ ' + escapeHtml(String(msg)) + '</div>'
        + '<button id="ai-pose-retry">重试</button>';
      const r = document.getElementById('ai-pose-retry');
      if (r) r.addEventListener('click', poseGenerate);
      return;
    }
    const done = status === 'done';
    box.innerHTML = POSE_STAGES.map(function (s) {
      const on = done || s[0] === stage;
      const passed = done || POSE_STAGES.findIndex(function (x) { return x[0] === stage; }) > POSE_STAGES.findIndex(function (x) { return x[0] === s[0]; });
      return '<div class="row' + (on ? ' on' : '') + '">'
        + '<span>' + (passed ? '✓ ' : on ? '● ' : '○ ') + s[1] + '</span>'
        + '<span>' + (passed || done ? '完成' : on ? Math.max(5, progress) + '%' : '') + '</span></div>';
    }).join('') + (done ? '<div class="row on">✓ 好了</div>' : '');
  }

  async function poseGenerate() {
    if (!poseState.poseId) return;
    const genBtn = document.getElementById('ai-pose-gen');
    if (genBtn) genBtn.disabled = true;
    poseState.resultUrl = '';
    document.getElementById('ai-pose-result').hidden = true;
    posePane(3);
    posePaintProgress('gate', 0, 'running');
    try {
      const r = await poseFetch('/swap', {
        method: 'POST', headers: poseHeaders(),
        body: JSON.stringify({ imageBase64: poseState.srcDataUrl, poseId: poseState.poseId, mode: poseState.mode }),
      });
      poseState.taskId = r.taskId;
      poseWatch(r.taskId);
    } catch (e) {
      posePaintProgress('gate', 0, 'failed', e.message);
      if (genBtn) genBtn.disabled = false;
    }
  }

  function poseWatch(taskId) {
    if (poseState.timer) clearInterval(poseState.timer);
    const t0 = Date.now();
    poseState.timer = setInterval(async function () {
      try {
        const s = await poseFetch('/swap/' + taskId, { headers: poseHeaders() });
        posePaintProgress(s.stage, s.progress, s.status, s.error);
        if (s.status === 'done') {
          clearInterval(poseState.timer); poseState.timer = null;
          poseShowResult(s.resultPath);
        } else if (s.status === 'failed') {
          clearInterval(poseState.timer); poseState.timer = null;
          const g = document.getElementById('ai-pose-gen'); if (g) g.disabled = false;
        }
      } catch (e) {
        if (Date.now() - t0 > 180000) {
          clearInterval(poseState.timer); poseState.timer = null;
          posePaintProgress('generate', 0, 'failed', '生成超时了，换个姿势再试');
        }
      }
    }, 2500);
  }

  function poseShowResult(path) {
    if (!path) return;
    poseState.resultUrl = location.origin + path;
    document.getElementById('ai-cmp-a').src = poseState.srcDataUrl;
    document.getElementById('ai-cmp-b').src = poseState.resultUrl;
    const dl = document.getElementById('ai-pose-dl');
    dl.href = poseState.resultUrl;
    dl.download = 'pose_' + (poseState.poseId || 'x').replace(/\./g, '_') + '_' + Date.now() + '.jpg';
    const top = document.getElementById('ai-cmp-top');
    const range = document.getElementById('ai-cmp-range');
    const applyClip = function () {
      top.style.clipPath = 'inset(0 ' + (100 - Number(range.value)) + '% 0 0)';
    };
    range.value = 50;
    applyClip();
    range.oninput = applyClip;
    document.getElementById('ai-pose-result').hidden = false;
    addMsg('system', '🧍 姿势照好了，注意手部细节可能要再挑一次');
  }

  function initPose() {
    if (poseState.started) return;
    poseState.started = true;

    document.querySelectorAll('#ai-pose-mode button').forEach(function (b) {
      b.addEventListener('click', function () {
        poseState.mode = b.dataset.mode;
        document.querySelectorAll('#ai-pose-mode button').forEach(function (x) { x.classList.toggle('on', x === b); });
        poseCheck();
      });
    });

    document.getElementById('ai-pose-next').addEventListener('click', async function () {
      posePane(2);
      await poseLoadCatalog();
    });

    document.getElementById('ai-pose-cat').addEventListener('change', poseRenderGrid);
    document.getElementById('ai-pose-angle').addEventListener('change', function (e) {
      poseState.angle = e.target.value;
      poseRenderGrid();
    });
    document.getElementById('ai-pose-search').addEventListener('input', function () {
      if (poseState.searchTimer) clearTimeout(poseState.searchTimer);
      poseState.searchTimer = setTimeout(poseRenderGrid, 160);
    });

    document.getElementById('ai-pose-gen').addEventListener('click', poseGenerate);
    document.getElementById('ai-pose-again').addEventListener('click', poseGenerate);
    document.getElementById('ai-pose-back').addEventListener('click', function () {
      posePane(2);
      poseUpdateBar();
    });

    document.getElementById('ai-pose-admin').addEventListener('click', async function () {
      const cur = poseAdminKey() ? '（已设置，留空则清除）' : '';
      const k = window.prompt('管理员口令' + cur, '');
      if (k === null) return;
      poseSetAdmin(k.trim());
      poseState.catalog = null;
      await poseLoadCatalog();
      addMsg('system', k.trim() ? '🔓 管理员模式已开启' : '🔒 管理员模式已关闭');
    });

    poseCheck();
  }

  function initDrawer() {
    const tabBtns = document.querySelectorAll('.ai-tabs button');
    tabBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        tabBtns.forEach(function (x) { x.classList.toggle('on', x === b); });
        document.querySelectorAll('.ai-body').forEach(function (body) {
          body.hidden = body.dataset.body !== b.dataset.tab;
        });
        if (b.dataset.tab === 'preset') paintPresetThumbs();
        if (b.dataset.tab === 'pose') initPose();
      });
    });

    const catBtns = document.querySelectorAll('#ai-cats button');
    catBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        catBtns.forEach(function (x) { x.classList.toggle('on', x === b); });
        presetState.category = b.dataset.cat;
        renderPresetGrid();
      });
    });

    renderPresetGrid();

    const wrap = document.getElementById('ai-slider-wrap');
    if (wrap) buildBasicSliders(wrap);
  }

  initDrawer();

  // ── Init ──
  // Detect editor on load
  detectEditor();

  connectWS();
})();
