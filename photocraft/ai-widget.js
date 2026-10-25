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

  // Use Cloudflare Tunnel URLs for HTTPS WebSocket support
  // This avoids mixed content blocking on GitHub Pages (HTTPS)
  // API server (muyaya-api) is on port 3001
  const API_TUNNEL_URL = 'https://main-lawsuit-sewing-pregnancy.trycloudflare.com';
  // AI Agent server is on port 3000
  const AI_TUNNEL_URL = 'https://cancelled-heater-supporters-tier.trycloudflare.com';

  const API_BASE = API_TUNNEL_URL;
  // WebSocket connects to AI Agent server (port 3000)
  const WS_URL = AI_TUNNEL_URL.replace('https:', 'wss:') + '/ws?key=bubu';
  const API_KEY = 'bubu';

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
    if (window.lightcraft && window.lightcraft.hasImage) {
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

    let applied = 0;
    for (const cmd of commands) {
      if (!cmd.key || typeof cmd.value !== 'number') continue;
      try {
        const mapped = mapToPhotoCraftCommand(cmd.key, cmd.value);
        if (mapped) {
          await window.execute_command(mapped.commandId, JSON.stringify(mapped.params));
          applied++;
        }
      } catch (e) {
        console.warn('[AI Widget] PhotoCraft command failed:', cmd.key, ':', e.message);
      }
    }
    return applied > 0;
  }

  /**
   * Execute adjustment commands in the editor.
   * Tries PhotoCraft AI Bridge first, then Studio (legacy), then Canvas 2D fallback.
   */
  async function executeEditorCommands(commands) {
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
    #ai-widget-btn{position:fixed;bottom:20px;right:20px;z-index:99999;background:#2d8cf0;color:#fff;width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;font-size:26px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.3);transition:transform .2s,box-shadow .2s}
    #ai-widget-btn:hover{transform:scale(1.1);box-shadow:0 6px 20px rgba(0,0,0,.4)}
    #ai-widget-btn .badge{position:absolute;top:-2px;right:-2px;background:#e74c3c;color:#fff;font-size:10px;width:16px;height:16px;border-radius:50%;display:none;align-items:center;justify-content:center}
    #ai-widget-btn .badge.show{display:flex}

    #ai-widget-panel{position:fixed;bottom:90px;right:20px;z-index:99998;width:400px;max-height:560px;background:#1a1a2e;border:1px solid #333;border-radius:12px;display:none;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden}
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
  `;

  // ── Inject CSS ──
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── Inject HTML ──
  const btn = document.createElement('button');
  btn.id = 'ai-widget-btn';
  btn.title = 'AI 修图';
  btn.innerHTML = '✨<span class="badge">!</span>';
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'ai-widget-panel';
  panel.innerHTML = `
    <div id="ai-widget-header">
      <span class="title">✨ AI 修图</span>
      <span class="status"><span class="dot" id="ai-widget-dot"></span><span id="ai-widget-status-text">连接中</span></span>
      <button id="ai-widget-close" title="关闭">✕</button>
    </div>
    <div id="ai-widget-messages">
      <div class="msg system">直接描述你想要的效果，AI 会在编辑器中实时调整</div>
    </div>
    <div id="ai-widget-input">
      <input type="text" id="ai-msg-input" placeholder="描述修图需求..." disabled>
      <button id="ai-clear-btn" class="clear-btn" title="重置调整" disabled>⟲</button>
      <button id="ai-send-btn" disabled>发送</button>
    </div>
  `;
  document.body.appendChild(panel);

  // ── DOM refs ──
  const dot = document.getElementById('ai-widget-dot');
  const statusText = document.getElementById('ai-widget-status-text');
  const messagesEl = document.getElementById('ai-widget-messages');
  const msgInput = document.getElementById('ai-msg-input');
  const sendBtn = document.getElementById('ai-send-btn');
  const clearBtn = document.getElementById('ai-clear-btn');

  // ── WebSocket ──
  function connectWS() {
    if (ws && ws.readyState <= 1) return;

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

  function formatCommandsHtml(commands) {
    if (!commands || !commands.length) return '';
    let html = '<div class="cmd-list">';
    for (const cmd of commands) {
      html += '<div class="cmd-item"><span class="key">' + cmd.key + '</span> = <span class="val">' + cmd.value.toFixed(2) + '</span></div>';
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

      const res = await fetch(API_BASE + '/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body: JSON.stringify({ message: text, tool: currentTool }),
      });

      const data = await res.json();

      if (data.commands && data.commands.length > 0) {
        activeCommands = data.commands;
        addMsg('bot', '🎯 ' + (data.explanation || '已生成调整参数') + formatCommandsHtml(data.commands));

        // Execute commands in browser
        addMsg('system', '⚡ 正在应用到编辑器...');

        const success = executeCommands(data.commands);
        if (success) {
          addMsg('system', '✅ 已应用到编辑器，可撤销');
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
  clearBtn.addEventListener('click', () => {
    if (!activeCommands.length) return;

    if (editorType === 'studio' && window.Studio.resetAll) {
      window.Studio.resetAll();
      addMsg('system', '⟲ 已重置所有调整');
    } else {
      // Restore original image if available
      addMsg('system', '⟲ 请手动重置编辑器');
    }
    activeCommands = [];
  });

  // ── Panel toggle ──
  btn.addEventListener('click', async () => {
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    btn.innerHTML = panelOpen ? '✕' : '✨<span class="badge">!</span>';

    if (panelOpen) {
      connectWS();

      // Detect editor
      const editorName = detectEditor();
      if (editorName) {
        // Check for PhotoCraft AI Bridge (new API)
        if (editorType === 'photocraft' && hasPhotoCraftAIBridge()) {
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
    btn.innerHTML = '✨<span class="badge">!</span>';
  });

  // ── Drag & drop ──
  panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.style.borderColor = '#2d8cf0'; });
  panel.addEventListener('dragleave', () => { panel.style.borderColor = '#333'; });

  // ── Init ──
  // Detect editor on load
  const detectedEditor = detectEditor();
  if (detectedEditor) {
    // Show badge to indicate integration
    const badge = btn.querySelector('.badge');
    if (badge) badge.classList.add('show');
  }

  connectWS();
})();
