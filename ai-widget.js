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
   * Map Studio-style adjustment keys to PhotoCraft command IDs.
   * Translates the 60+ Studio params to PhotoCraft's command system.
   */
  function mapToPhotoCraftCommand(key, value) {
    const map = {
      'exposure': { commandId: 'adjust.exposure', params: { amount: value } },
      'contrast': { commandId: 'adjust.contrast', params: { amount: value } },
      'highlights': { commandId: 'adjust.highlights', params: { amount: value } },
      'shadows': { commandId: 'adjust.shadows', params: { amount: value } },
      'whites': { commandId: 'adjust.whites', params: { amount: value } },
      'blacks': { commandId: 'adjust.blacks', params: { amount: value } },
      'temperature': { commandId: 'adjust.colorTemperature', params: { amount: value } },
      'tint': { commandId: 'adjust.colorTint', params: { amount: value } },
      'vibrance': { commandId: 'adjust.vibrance', params: { amount: value } },
      'saturation': { commandId: 'adjust.saturation', params: { amount: value } },
      'hue': { commandId: 'adjust.hue', params: { amount: value } },
      'redHue': { commandId: 'adjust.hueSaturation.red', params: { hue: value } },
      'orangeHue': { commandId: 'adjust.hueSaturation.orange', params: { hue: value } },
      'yellowHue': { commandId: 'adjust.hueSaturation.yellow', params: { hue: value } },
      'greenHue': { commandId: 'adjust.hueSaturation.green', params: { hue: value } },
      'blueHue': { commandId: 'adjust.hueSaturation.blue', params: { hue: value } },
      'purpleHue': { commandId: 'adjust.hueSaturation.purple', params: { hue: value } },
      'magentaHue': { commandId: 'adjust.hueSaturation.magenta', params: { hue: value } },
      'redSaturation': { commandId: 'adjust.hueSaturation.red', params: { saturation: value } },
      'orangeSaturation': { commandId: 'adjust.hueSaturation.orange', params: { saturation: value } },
      'yellowSaturation': { commandId: 'adjust.hueSaturation.yellow', params: { saturation: value } },
      'greenSaturation': { commandId: 'adjust.hueSaturation.green', params: { saturation: value } },
      'blueSaturation': { commandId: 'adjust.hueSaturation.blue', params: { saturation: value } },
      'purpleSaturation': { commandId: 'adjust.hueSaturation.purple', params: { saturation: value } },
      'magentaSaturation': { commandId: 'adjust.hueSaturation.magenta', params: { saturation: value } },
      'redLightness': { commandId: 'adjust.hueSaturation.red', params: { lightness: value } },
      'orangeLightness': { commandId: 'adjust.hueSaturation.orange', params: { lightness: value } },
      'yellowLightness': { commandId: 'adjust.hueSaturation.yellow', params: { lightness: value } },
      'greenLightness': { commandId: 'adjust.hueSaturation.green', params: { lightness: value } },
      'blueLightness': { commandId: 'adjust.hueSaturation.blue', params: { lightness: value } },
      'purpleLightness': { commandId: 'adjust.hueSaturation.purple', params: { lightness: value } },
      'magentaLightness': { commandId: 'adjust.hueSaturation.magenta', params: { lightness: value } },
      'splitShadowsHue': { commandId: 'adjust.splitToning', params: { shadowsHue: value } },
      'splitShadowsSaturation': { commandId: 'adjust.splitToning', params: { shadowsSaturation: value } },
      'splitHighlightsHue': { commandId: 'adjust.splitToning', params: { highlightsHue: value } },
      'splitHighlightsSaturation': { commandId: 'adjust.splitToning', params: { highlightsSaturation: value } },
      'splitBalance': { commandId: 'adjust.splitToning', params: { balance: value } },
      'clarity': { commandId: 'adjust.clarity', params: { amount: value } },
      'dehaze': { commandId: 'adjust.dehaze', params: { amount: value } },
      'vignetteAmount': { commandId: 'adjust.vignette', params: { amount: value } },
      'vignetteFeather': { commandId: 'adjust.vignette', params: { feather: value } },
      'vignetteMidpoint': { commandId: 'adjust.vignette', params: { midpoint: value } },
      'grainAmount': { commandId: 'adjust.grain', params: { amount: value } },
      'grainScale': { commandId: 'adjust.grain', params: { scale: value } },
      'grainRoughness': { commandId: 'adjust.grain', params: { roughness: value } },
      'sharpening': { commandId: 'adjust.sharpening', params: { amount: value } },
      'sharpeningRadius': { commandId: 'adjust.sharpening', params: { radius: value } },
      'sharpeningThreshold': { commandId: 'adjust.sharpening', params: { threshold: value } },
    };
    return map[key] || null;
  }

  /**
   * Execute commands in PhotoCraft via AI Bridge (preferred after Rust patch).
   */
  async function executePhotoCraftCommands(commands) {
    if (!hasPhotoCraftAIBridge() || !window.has_session()) return false;

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
    for (const cmd of commands) {
      try {
        // Native PhotoCraft command from /api/parse: { id, params }.
        if (cmd && typeof cmd.id === 'string' && cmd.id) {
          const params = cmd.params && typeof cmd.params === 'object' ? cmd.params : {};
          submit(cmd.id, params);
          applied++;
          continue;
        }
        // Legacy Studio-style adjustment: { key, value }.
        if (cmd && cmd.key && typeof cmd.value === 'number') {
          const mapped = mapToPhotoCraftCommand(cmd.key, cmd.value);
          if (mapped) {
            submit(mapped.commandId, mapped.params);
            applied++;
          }
        }
      } catch (e) {
        console.warn('[AI Widget] PhotoCraft command failed:', cmd && (cmd.id || cmd.key), ':', e.message);
      }
    }
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
  async function undoLightCraft() {
    const keys = Object.keys(lightcraftUndo).filter(k => k !== '__treatment');
    const hadTreatment = '__treatment' in lightcraftUndo;
    if ((!keys.length && !hadTreatment) || !hasLightCraft()) return false;
    // 顺序有讲究：先拨回 treatment，再写回数值。
    // 实测"把值写回原值"是像素级精确（AE=0），而 develop.reset 会回到引擎默认值、
    // 跟这张照片的初始状态有细微差别（AE≈1.5 万），所以 reset 只当兜底。
    try {
      if (hadTreatment && (await lightcraftTreatment()) !== lightcraftUndo.__treatment) {
        await window.lightcraft.command('develop.treatment', '{}');
      }
      const values = Object.create(null);
      for (const k of keys) values[k] = lightcraftUndo[k];
      if (Object.keys(values).length) {
        await window.lightcraft.command('develop.set', JSON.stringify({ values }));
      }
      for (const k in lightcraftUndo) delete lightcraftUndo[k];
      return true;
    } catch (e) {
      console.warn('[AI Widget] 按值复原失败，退回 develop.reset:', e && e.message);
      try {
        await window.lightcraft.command('develop.reset', '{}');
        if (hadTreatment && (await lightcraftTreatment()) !== 'color') {
          await window.lightcraft.command('develop.treatment', '{}');
        }
        for (const k in lightcraftUndo) delete lightcraftUndo[k];
        return true;
      } catch (e2) {
        return false;
      }
    }
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
        await window.lightcraft.command('develop.set', JSON.stringify({ values }));
        // 记下改前的值（develop.reset 失败时兜底，用不上也无害）
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
   * 取当前工作区画布，缩到长边 1024 后转 data URL。
   * 供 /api/parse 做视觉分析（定位类需求）；画布被跨域污染时返回 null。
   */
  function grabWorkCanvas(maxEdge) {
    maxEdge = maxEdge || 1024;
    const canvas = editorType === 'photocraft'
      ? document.getElementById('photocraft_canvas')
      : editorType === 'lightcraft'
        ? document.getElementById('lightcraft_canvas')
        : null;
    if (!canvas || !canvas.width || !canvas.height) return null;

    const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
    const w = Math.max(1, Math.round(canvas.width * scale));
    const h = Math.max(1, Math.round(canvas.height * scale));

    try {
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      tmp.getContext('2d').drawImage(canvas, 0, 0, w, h);
      return {
        dataUrl: tmp.toDataURL('image/png'),
        // 画布内在分辨率 = 文档尺寸（与 CSS 显示缩放无关）
        width: canvas.width,
        height: canvas.height,
      };
    } catch (e) {
      console.warn('[AI Widget] 画布跨域污染，跳过视觉分析:', e.message);
      return null;
    }
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
    #ai-widget-btn{position:fixed;z-index:99999;background:#2d8cf0;color:#fff;width:56px;height:56px;border-radius:50%;border:none;cursor:grab;font-size:26px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.3);transition:transform .2s,box-shadow .2s;touch-action:none;user-select:none}
    #ai-widget-btn:hover{transform:scale(1.1);box-shadow:0 6px 20px rgba(0,0,0,.4)}
    #ai-widget-btn.dragging{cursor:grabbing;transition:none;box-shadow:0 10px 26px rgba(0,0,0,.5)}
    #ai-widget-btn .badge{position:absolute;top:-2px;right:-2px;background:#e74c3c;color:#fff;font-size:10px;width:16px;height:16px;border-radius:50%;display:none;align-items:center;justify-content:center}
    #ai-widget-btn .badge.show{display:flex}

    #ai-widget-panel{position:fixed;z-index:99998;width:400px;max-height:560px;background:#1a1a2e;border:1px solid #333;border-radius:12px;display:none;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden}
    #ai-widget-panel.open{display:flex}

    #ai-widget-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#16213e;border-bottom:1px solid #333;flex-shrink:0}
    #ai-widget-header .title{font-size:14px;font-weight:600;color:#fff;display:flex;align-items:center;gap:6px}
    #ai-widget-header .status{display:flex;align-items:center;gap:4px;font-size:11px;color:#888}
    #ai-widget-header .dot{width:8px;height:8px;border-radius:50%;background:#666}
    #ai-widget-header .dot.online{background:#2ecc71}
    #ai-widget-header .dot.offline{background:#e74c3c}
    #ai-widget-close{background:none;border:none;color:#888;font-size:18px;cursor:pointer;padding:2px 6px;border-radius:4px}
    #ai-widget-close:hover{color:#fff;background:#333}

    #ai-widget-messages{flex:1;overflow-y:auto;padding:12px;min-height:200px;max-height:350px}
    #ai-widget-messages .msg{max-width:85%;margin-bottom:10px;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.5;word-wrap:break-word}
    #ai-widget-messages .msg.user{margin-left:auto;background:#2d8cf0;color:#fff}
    #ai-widget-messages .msg.bot{background:#252540;color:#ddd}
    #ai-widget-messages .msg.system{background:transparent;color:#888;font-size:11px;text-align:center;max-width:100%}
    #ai-widget-messages .msg.error{background:#3d1515;color:#e74c3c}
    #ai-widget-messages .msg .cmd-list{margin-top:6px;font-size:11px;color:#aaa;background:#1a1a2e;padding:6px 8px;border-radius:6px;max-height:80px;overflow-y:auto}
    #ai-widget-messages .msg .cmd-item{margin-bottom:2px}
    #ai-widget-messages .msg .cmd-item .key{color:#56b6c2;font-weight:600}
    #ai-widget-messages .msg .cmd-item .val{color:#98c379}

    #ai-widget-input{display:flex;gap:6px;padding:10px 14px;border-top:1px solid #333;flex-shrink:0}
    #ai-widget-input input{flex:1;background:#16213e;border:1px solid #444;color:#fff;padding:8px 12px;border-radius:8px;font-size:13px;outline:none}
    #ai-widget-input input:focus{border-color:#2d8cf0}
    #ai-widget-input button{background:#2d8cf0;color:#fff;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500}
    #ai-widget-input button:disabled{opacity:.5;cursor:not-allowed}
    #ai-widget-input .clear-btn{background:#333;padding:8px 10px}
    #ai-widget-input .clear-btn:hover{background:#444}

    /* ── 右侧抽屉（覆盖上面的浮动面板定位） ── */
    #ai-widget-panel{position:fixed;top:0;right:0;bottom:0;width:400px;max-height:none;
      background:#1e2126;border:none;border-left:1px solid #3a3f46;border-radius:0;
      box-shadow:-10px 0 34px rgba(0,0,0,.45);transform:translateX(100%);
      transition:transform .2s ease;overflow:hidden}
    #ai-widget-panel.open{transform:none}
    @media (max-width:760px){#ai-widget-panel{width:min(400px,92vw)}}

    /* 收起状态的唤起手柄 */
    #ai-widget-handle{position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:99999;
      width:34px;height:120px;border:none;border-radius:10px 0 0 10px;
      background:linear-gradient(180deg,#5a9bff,#3d7eff);color:#fff;cursor:pointer;
      display:flex;align-items:center;justify-content:center;
      box-shadow:-4px 0 14px rgba(0,0,0,.4);padding:0;font-family:inherit}
    #ai-widget-handle:hover{width:40px}
    #ai-widget-handle span{writing-mode:vertical-rl;font-size:11px;letter-spacing:2px;user-select:none}

    /* 标签页 */
    .ai-tabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid #3a3f46;flex-shrink:0}
    .ai-tabs button{background:none;border:none;color:#8b929b;font-size:12.5px;
      padding:7px 14px;border-radius:7px 7px 0 0;cursor:pointer;border-bottom:2px solid transparent}
    .ai-tabs button.on{color:#fff;background:#262a31;border-bottom-color:#3d7eff}

    .ai-body{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}
    .ai-body[hidden]{display:none}

    /* 预设网格 */
    .ai-preset-wrap{flex:1;overflow-y:auto;padding:12px}
    .ai-preset-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}
    .ai-preset{border:1px solid #3a3f46;border-radius:9px;overflow:hidden;cursor:pointer;
      background:#262a31;transition:border-color .15s}
    .ai-preset:hover{border-color:#3d7eff}
    .ai-preset.on{border-color:#3d7eff;box-shadow:0 0 0 1px #3d7eff inset}
    .ai-preset .thumb{height:62px;background:linear-gradient(135deg,#2a3140,#1d2229);position:relative}
    .ai-preset .thumb::after{content:"";position:absolute;inset:0;
      background:linear-gradient(45deg,rgba(90,155,255,.22),transparent 60%)}
    .ai-preset .nm{padding:7px 9px;font-size:11.5px;color:#cfd4da}

    /* 调整滑块 */
    .ai-slider-wrap{flex:1;overflow-y:auto;padding:14px 14px 18px;display:flex;flex-direction:column;gap:15px}
    .ai-slider .row{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
    .ai-slider .name{font-size:12px;color:#cfd4da}
    .ai-slider .val{font-size:11.5px;color:#5a9bff;font-variant-numeric:tabular-nums}
    .ai-slider input[type=range]{width:100%;-webkit-appearance:none;height:4px;border-radius:2px;
      background:#3a3f46;outline:none;cursor:pointer}
    .ai-slider input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;
      border-radius:50%;background:#5a9bff;border:2px solid #1e2126;box-shadow:0 1px 4px rgba(0,0,0,.5)}
    .ai-slider input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;
      background:#5a9bff;border:2px solid #1e2126}
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
      <button data-tab="preset">预设</button>
      <button data-tab="adjust">调整</button>
    </div>
    <div class="ai-body" data-body="chat">
      <div id="ai-widget-messages">
        <div class="msg system">直接描述你想要的效果，AI 会在编辑器中实时调整</div>
      </div>
      <div id="ai-widget-input">
        <input type="text" id="ai-msg-input" placeholder="描述修图需求..." disabled>
        <button id="ai-clear-btn" class="clear-btn" title="重置调整" disabled>⟲</button>
        <button id="ai-send-btn" disabled>发送</button>
      </div>
    </div>
    <div class="ai-body" data-body="preset" hidden>
      <div class="ai-preset-wrap"><div class="ai-preset-grid" id="ai-preset-grid"></div></div>
    </div>
    <div class="ai-body" data-body="adjust" hidden>
      <div class="ai-slider-wrap" id="ai-slider-wrap"></div>
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
          addMsg('system', '✅ 已应用到编辑器，可撤销');
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
    if (!activeCommands.length) return;

    if (editorType === 'studio' && window.Studio.resetAll) {
      window.Studio.resetAll();
      addMsg('system', '⟲ 已重置所有调整');
    } else if (editorType === 'lightcraft' && hasLightCraft()) {
      const ok = await undoLightCraft();
      addMsg('system', ok ? '⟲ 已重置全部调整（像素回到原图）' : '⟲ 没有可撤销的调整');
    } else {
      // Restore original image if available
      addMsg('system', '⟲ 请手动重置编辑器');
    }
    activeCommands = [];
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
  panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.style.borderColor = '#2d8cf0'; });
  panel.addEventListener('dragleave', () => { panel.style.borderColor = '#333'; });

  // ── 抽屉：标签页 / 预设 / 滑块 ──
  const PRESETS = [
    { name: '电影感',   commands: [{ key: 'contrast', value: 15 }, { key: 'saturation', value: -10 }, { key: 'temperature', value: 5 }] },
    { name: '日系清透', commands: [{ key: 'exposure', value: 8 }, { key: 'contrast', value: -6 }, { key: 'saturation', value: 6 }] },
    { name: '复古胶片', commands: [{ key: 'contrast', value: 12 }, { key: 'saturation', value: -15 }, { key: 'temperature', value: 10 }] },
    { name: '黑白',     commands: [{ key: 'saturation', value: -100 }] },
    { name: '暖调',     commands: [{ key: 'temperature', value: 20 }, { key: 'exposure', value: 5 }] },
    { name: '冷调',     commands: [{ key: 'temperature', value: -20 }] },
  ];

  const SLIDERS = [
    { key: 'exposure',    label: '亮度',   min: -100, max: 100 },
    { key: 'contrast',    label: '对比度', min: -100, max: 100 },
    { key: 'saturation',  label: '饱和度', min: -100, max: 100 },
    { key: 'temperature', label: '色温',   min: -100, max: 100 },
    { key: 'vibrance',    label: '自然饱和度', min: -100, max: 100 },
  ];

  function initDrawer() {
    const tabBtns = document.querySelectorAll('.ai-tabs button');
    tabBtns.forEach((b) => {
      b.addEventListener('click', () => {
        tabBtns.forEach((x) => x.classList.toggle('on', x === b));
        document.querySelectorAll('.ai-body').forEach((body) => {
          body.hidden = body.dataset.body !== b.dataset.tab;
        });
      });
    });

    const grid = document.getElementById('ai-preset-grid');
    if (grid) {
      PRESETS.forEach((preset) => {
        const card = document.createElement('div');
        card.className = 'ai-preset';
        card.innerHTML = '<div class="thumb"></div><div class="nm">' + preset.name + '</div>';
        card.addEventListener('click', async () => {
          grid.querySelectorAll('.ai-preset').forEach((x) => x.classList.toggle('on', x === card));
          const ok = await executePhotoCraftCommands(preset.commands);
          addMsg('system', ok ? '🎨 已应用预设「' + preset.name + '」' : '⚠️ 预设需在 PhotoCraft 中打开');
        });
        grid.appendChild(card);
      });
    }

    const wrap = document.getElementById('ai-slider-wrap');
    if (wrap) {
      SLIDERS.forEach((spec) => {
        const row = document.createElement('div');
        row.className = 'ai-slider';
        row.innerHTML =
          '<div class="row"><span class="name">' + spec.label + '</span><span class="val">0</span></div>' +
          '<input type="range" min="' + spec.min + '" max="' + spec.max + '" value="0">';
        const input = row.querySelector('input');
        const out = row.querySelector('.val');
        input.addEventListener('input', () => {
          out.textContent = (Number(input.value) > 0 ? '+' : '') + input.value;
        });
        input.addEventListener('change', () => {
          const value = Number(input.value);
          if (value === 0) return;
          executePhotoCraftCommands([{ key: spec.key, value: value }]).then((ok) => {
            if (!ok) addMsg('system', '⚠️ 调整需在 PhotoCraft 中打开');
          });
        });
        wrap.appendChild(row);
      });
    }
  }
  initDrawer();

  // ── Init ──
  // Detect editor on load
  detectEditor();

  connectWS();
})();
