/**
 * AI Chat Widget — 悬浮聊天组件
 * 嵌入 PhotoCraft / LightCraft 编辑器页面
 *
 * Usage: <script src="/ai-widget.js"></script>
 *
 * Integration:
 * - PhotoCraft: window.photocraft.getImage() / setImage()
 * - LightCraft: window.lightcraft.getImage() / setImage()
 */
(function() {
  'use strict';

  // Use Cloudflare Tunnel URL for HTTPS WebSocket support
  // This avoids mixed content blocking on GitHub Pages (HTTPS)
  const TUNNEL_URL = 'https://shops-voip-storage-click.trycloudflare.com';
  
  const API_BASE = TUNNEL_URL;
  const WS_URL = TUNNEL_URL.replace('https:', 'wss:') + '/ws?key=bubu';
  const API_KEY = 'bubu';

  // ── State ──
  let ws = null;
  let currentImage = null;
  let currentTaskId = null;
  let isProcessing = false;
  let currentTool = 'photocraft';
  let panelOpen = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let editorType = null; // 'photocraft' | 'lightcraft' | null
  const MAX_RECONNECT = 10;

  // ── Editor Integration ──
  function detectEditor() {
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

  async function getEditorImage() {
    if (editorType === 'photocraft' && window.photocraft.getImage) {
      return window.photocraft.getImage();
    }
    if (editorType === 'lightcraft' && window.lightcraft.getImage) {
      return window.lightcraft.getImage();
    }
    return null;
  }

  async function sendResultToEditor(resultUrl) {
    if (!editorType) return false;
    
    try {
      // Download result image
      const res = await fetch(resultUrl);
      const blob = await res.blob();
      const reader = new FileReader();
      
      return new Promise((resolve) => {
        reader.onload = async () => {
          const dataUrl = reader.result;
          if (editorType === 'photocraft' && window.photocraft.setImage) {
            try {
              await window.photocraft.setImage(dataUrl);
              resolve(true);
            } catch (e) {
              console.warn('[AI Widget] Failed to set image in PhotoCraft:', e);
              resolve(false);
            }
          } else if (editorType === 'lightcraft' && window.lightcraft.setImage) {
            try {
              await window.lightcraft.setImage(dataUrl);
              resolve(true);
            } catch (e) {
              console.warn('[AI Widget] Failed to set image in LightCraft:', e);
              resolve(false);
            }
          } else {
            resolve(false);
          }
        };
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      console.warn('[AI Widget] Failed to send result to editor:', e);
      return false;
    }
  }

  async function autoLoadEditorImage() {
    if (!editorType) return;
    
    const dataUrl = await getEditorImage();
    if (!dataUrl) {
      addMsg('system', '⚠️ 无法从编辑器获取图片，请手动上传');
      return;
    }
    
    addMsg('system', '📷 已从 ' + editorType + ' 获取图片，正在上传...');
    
    // Convert data URL to Blob
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], 'editor_image.png', { type: 'image/png' });
    
    // Upload to server
    await uploadFile(file);
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

    #ai-widget-toolbar{display:flex;gap:4px;padding:8px 14px;border-bottom:1px solid #333;flex-shrink:0}
    #ai-widget-tool{flex:1;border:1px solid #444;background:#16213e;color:#aaa;padding:5px 8px;font-size:11px;border-radius:6px;cursor:pointer;transition:all .2s;text-align:center}
    #ai-widget-tool.active{background:#2d8cf0;color:#fff;border-color:#2d8cf0}
    #ai-widget-tool:hover:not(.active){background:#222;color:#fff}
    #ai-widget-tool:disabled{opacity:.5;cursor:not-allowed}

    #ai-widget-messages{flex:1;overflow-y:auto;padding:12px;min-height:200px;max-height:300px}
    #ai-widget-messages .msg{max-width:85%;margin-bottom:10px;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.5;word-wrap:break-word}
    #ai-widget-messages .msg.user{margin-left:auto;background:#2d8cf0;color:#fff}
    #ai-widget-messages .msg.bot{background:#252540;color:#ddd}
    #ai-widget-messages .msg.system{background:transparent;color:#888;font-size:11px;text-align:center;max-width:100%}
    #ai-widget-messages .msg.error{background:#3d1515;color:#e74c3c}
    #ai-widget-messages .msg img{max-width:100%;border-radius:6px;margin-top:6px;cursor:pointer}

    #ai-widget-input{display:flex;gap:6px;padding:10px 14px;border-top:1px solid #333;flex-shrink:0}
    #ai-widget-input input{flex:1;background:#16213e;border:1px solid #444;color:#fff;padding:8px 12px;border-radius:8px;font-size:13px;outline:none}
    #ai-widget-input input:focus{border-color:#2d8cf0}
    #ai-widget-input button{background:#2d8cf0;color:#fff;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500}
    #ai-widget-input button:disabled{opacity:.5;cursor:not-allowed}
    #ai-widget-input .upload-btn{background:#333;padding:8px 10px}
    #ai-widget-input .upload-btn:hover{background:#444}

    #ai-widget-hint{padding:4px 14px;font-size:10px;color:#666;text-align:center;flex-shrink:0}
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
    <div id="ai-widget-toolbar">
      <button class="tool active" data-tool="photocraft" id="ai-tool-photo">🎨 调色</button>
      <button class="tool" data-tool="lightcraft" id="ai-tool-light">🖼️ 修图</button>
    </div>
    <div id="ai-widget-messages">
      <div class="msg system">上传图片，用自然语言描述你想要的效果</div>
    </div>
    <div id="ai-widget-input">
      <input type="file" id="ai-file-input" accept="image/*" style="display:none">
      <button class="upload-btn" id="ai-upload-btn" title="上传图片">📷</button>
      <input type="text" id="ai-msg-input" placeholder="输入修图指令..." disabled>
      <button id="ai-send-btn" disabled>发送</button>
    </div>
    <div id="ai-widget-hint" id="ai-upload-hint"></div>
  `;
  document.body.appendChild(panel);

  // ── DOM refs ──
  const dot = document.getElementById('ai-widget-dot');
  const statusText = document.getElementById('ai-widget-status-text');
  const messagesEl = document.getElementById('ai-widget-messages');
  const msgInput = document.getElementById('ai-msg-input');
  const sendBtn = document.getElementById('ai-send-btn');
  const fileInput = document.getElementById('ai-file-input');
  const uploadBtn = document.getElementById('ai-upload-btn');
  const uploadHint = document.getElementById('ai-upload-hint');
  const toolPhoto = document.getElementById('ai-tool-photo');
  const toolLight = document.getElementById('ai-tool-light');

  // ── WebSocket ──
  function connectWS() {
    if (ws && ws.readyState <= 1) return;

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      setStatus('online', '已连接');
      reconnectAttempts = 0;
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
  }

  function handleServerMsg(msg) {
    switch (msg.type) {
      case 'ack':
        addMsg('system', '📨 任务已提交: ' + msg.taskId);
        break;

      case 'thinking':
        addMsg('bot', '🤔 ' + msg.thought);
        break;

      case 'command':
        addMsg('bot', '🎯 <b>' + msg.explanation + '</b><br><code style="font-size:11px;color:#888">' + msg.command + '</code>');
        break;

      case 'progress':
        addMsg('system', '⏳ ' + msg.message);
        break;

      case 'log':
        // Ignore logs for cleaner UI
        break;

      case 'done':
        isProcessing = false;
        sendBtn.disabled = false;
        addMsg('bot', '✅ 处理完成!');
        showResult(msg.resultUrl, msg.commands);
        break;

      case 'error':
        isProcessing = false;
        sendBtn.disabled = false;
        addMsg('error', '❌ ' + (msg.message || msg.code));
        break;
    }
  }

  // ── Upload ──
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) uploadFile(e.target.files[0]);
    e.target.value = '';
  });

  // Drag & drop on panel
  panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.style.borderColor = '#2d8cf0'; });
  panel.addEventListener('dragleave', () => { panel.style.borderColor = '#333'; });
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    panel.style.borderColor = '#333';
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) uploadFile(file);
  });

  async function uploadFile(file) {
    addMsg('system', '📤 正在上传 ' + file.name + ' (' + (file.size / 1024).toFixed(1) + 'KB)...');
    uploadBtn.disabled = true;

    try {
      const form = new FormData();
      form.append('image', file);

      const res = await fetch(API_BASE + '/api/upload', {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY },
        body: form,
      });
      const data = await res.json();

      if (data.filename) {
        currentImage = { filename: data.filename, originalName: file.name, size: data.size };
        msgInput.disabled = false;
        sendBtn.disabled = false;
        uploadHint.textContent = '📷 ' + data.filename;
        addMsg('system', '✅ 已上传: ' + data.filename);
      } else {
        addMsg('error', '❌ 上传失败: ' + (data.error || '未知错误'));
      }
    } catch (err) {
      addMsg('error', '❌ 上传失败: ' + err.message);
    } finally {
      uploadBtn.disabled = false;
    }
  }

  // ── Send ──
  async function send() {
    if (!currentImage || isProcessing) return;
    const text = msgInput.value.trim();
    if (!text) return;

    msgInput.value = '';
    isProcessing = true;
    sendBtn.disabled = true;
    addMsg('user', text);

    // WebSocket
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'chat',
        message: text,
        imageFilename: currentImage.filename,
        tool: currentTool,
      }));
    }

    // HTTP fallback
    try {
      const res = await fetch(API_BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body: JSON.stringify({
          message: text,
          imageFilename: currentImage.filename,
          tool: currentTool,
        }),
      });
      const data = await res.json();
      if (data.taskId) {
        currentTaskId = data.taskId;
      }
    } catch (err) {
      console.error('[AI Widget] HTTP chat failed:', err);
    }
  }

  sendBtn.addEventListener('click', send);
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // ── Tool selector ──
  document.querySelectorAll('#ai-widget-toolbar .tool').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('#ai-widget-toolbar .tool').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
      currentTool = button.dataset.tool;
      msgInput.placeholder = currentTool === 'lightcraft'
        ? '输入修图指令，如：磨皮、提亮、去雾...'
        : '输入调色指令，如：调亮一点，加暖色调...';
    });
  });

  // ── Result preview ──
  async function showResult(url, commands) {
    let fullUrl = url;
    if (url.startsWith('/')) fullUrl = API_BASE + url;
    
    let html = '<div>✅ 处理完成</div><img src="' + fullUrl + '" onclick="window.open(this.src)">';
    if (commands && commands.length) {
      html += '<div style="font-size:11px;color:#888;margin-top:4px">🎯 ' + commands.join(', ') + '</div>';
    }
    
    // Auto-apply to editor if in editor mode
    if (editorType) {
      html += '<div style="margin-top:8px;font-size:11px;color:#2ecc71">📥 正在自动应用到编辑器...</div>';
    }
    
    html += '<div style="font-size:11px;color:#888;margin-top:4px">📥 右键图片可保存</div>';
    addMsg('bot', html);
    
    // Auto-apply to editor
    if (editorType) {
      const success = await sendResultToEditor(fullUrl);
      if (success) {
        addMsg('system', '✅ 已自动应用到编辑器');
      } else {
        addMsg('error', '❌ 自动应用失败，请手动下载');
      }
    }
  }

  // ── Panel toggle ──
  btn.addEventListener('click', async () => {
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    btn.innerHTML = panelOpen ? '✕' : '✨<span class="badge">!</span>';
    
    if (panelOpen) {
      connectWS();
      
      // Detect editor and auto-load image
      const editorName = detectEditor();
      if (editorName) {
        addMsg('system', '🔗 已连接 ' + editorName + ' 编辑器');
        
        // Disable tool switching when in editor (auto-detected)
        toolPhoto.disabled = true;
        toolLight.disabled = true;
        
        // Auto-load image from editor
        await autoLoadEditorImage();
      }
      
      msgInput.focus();
    }
  });

  document.getElementById('ai-widget-close').addEventListener('click', () => {
    panelOpen = false;
    panel.classList.remove('open');
    btn.innerHTML = '✨<span class="badge">!</span>';
  });

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
