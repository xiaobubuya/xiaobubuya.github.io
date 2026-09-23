/* ================================================================
   修图 —— WebGL 实时调色管线
   ================================================================
   设计要点：

   ① 单趟 shader 出全部效果
      所有调整都在一个 fragment shader 里算完，滑块一变只更新 uniform
      再画一帧。所以是「拖动即见」的实时预览，不是处理一次等几秒。
      这是所有专业修图软件的做法。

   ② 在正确的色彩空间里做正确的运算
      曝光、高光、阴影必须在线性空间里算 —— sRGB 是给显示用的
      非线性编码，直接在上面乘系数会得到发灰、发闷的结果。
      对比度和饱和度则留在 sRGB 空间，因为那更接近人眼的直觉预期。
      这个区分是「看起来专业」和「看起来像滤镜」的分界线。

   ③ 预览按屏幕尺寸渲染，导出才用原始分辨率
      4096×2730 的照片在预览时按显示尺寸渲染，保证 60fps；
      点导出时才把画布切到原始分辨率重画一次。
      预览和导出用同一个 shader，所以所见即所得。

   ④ 不碰网络
      照片全程在内存和 GPU 里，不上传任何地方。
   ================================================================ */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  /* ================================================================
     调整项定义
     ----------------------------------------------------------------
     key 对应 shader 里的 uniform，范围统一 -1 ~ 1（除了曝光用 EV）。
     默认值 0 = 不改变。
     ================================================================ */
  const ADJUSTMENTS = [
    { key: 'uExposure',   name: '曝光',   min: -2,  max: 2,  step: 0.01, def: 0, unit: ' EV' },
    { key: 'uContrast',   name: '对比度', min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uHighlights', name: '高光',   min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uShadows',    name: '阴影',   min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uSaturation', name: '饱和度', min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uTemp',       name: '色温',   min: -1,  max: 1,  step: 0.01, def: 0 },
  ];

  const values = {};
  ADJUSTMENTS.forEach(a => { values[a.key] = a.def; });

  /* ================================================================
     shader
     ================================================================ */
  const VERT = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  const FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uImage;
    uniform float uExposure, uContrast, uHighlights, uShadows, uSaturation, uTemp;
    uniform float uOriginal;   // 1 = 显示原图（对比用）

    // sRGB <-> 线性。这两个函数是「正确调色」的地基：
    // 曝光/高光/阴影必须在线性空间里做，否则会发灰发闷
    vec3 toLinear(vec3 c) {
      return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
    }
    vec3 toSrgb(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
    }
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      vec3 c = texture2D(uImage, vUv).rgb;

      if (uOriginal > 0.5) {
        gl_FragColor = vec4(c, 1.0);
        return;
      }

      c = toLinear(c);

      // 曝光：线性空间下乘 2^EV
      c *= pow(2.0, uExposure);

      // 高光 / 阴影：按亮度分区加权，避免影响中间调。
      //
      // ⚠️ 系数是「作用幅度」，必须明显小于 1，否则 -1 就等于乘 0。
      // 第一版写成 c += uHighlights * hiW * c，
      // 实测亮灰 240 直接掉到 84、暗灰 48 掉到 1 —— 那是抹平不是压暗。
      //
      // 阴影还做了不对称：提亮给足幅度（暗部本来就需要更多提亮才看得出来），
      // 压暗时收敛，免得直接压成死黑。
      // 阴影的权重区间必须收窄。
      // 第一版用 smoothstep(0.0, 0.45, l)，而中灰的线性亮度是 0.216 ——
      // 落在区间内拿到 53% 权重，导致「阴影+1」把中灰 128 抬到了 156。
      // 中间调被带动，是分区调整最典型的失误。
      // 0.20 这个上界：中灰权重为 0，暗灰(48)权重约 0.93。
      float l = luma(c);
      float hiW = smoothstep(0.30, 1.0, l);
      float loW = 1.0 - smoothstep(0.0, 0.20, l);
      c *= 1.0 + uHighlights * hiW * 0.5;
      c *= 1.0 + uShadows * loW * (uShadows > 0.0 ? 1.0 : 0.5);

      // 色温：暖 → 抬红压蓝；冷 → 反之。轻微抬绿保持亮度观感
      c.r *= 1.0 + uTemp * 0.18;
      c.b *= 1.0 - uTemp * 0.18;
      c.g *= 1.0 + abs(uTemp) * 0.02;

      c = toSrgb(c);

      // 对比度：绕中灰旋转（sRGB 空间，符合直觉）
      c = (c - 0.5) * (1.0 + uContrast) + 0.5;

      // 饱和度：朝灰度插值
      float g = luma(c);
      c = mix(vec3(g), c, 1.0 + uSaturation);

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `;

  /* ================================================================
     WebGL 初始化
     ================================================================ */
  const canvas = $('stCanvas');
  const gl = canvas.getContext('webgl', {
    // 导出时要读画布内容，必须开这个 —— 否则可能读到已被清空的缓冲
    preserveDrawingBuffer: true,
    antialias: false,
    alpha: false
  });

  let program = null, uniforms = {}, imageTex = null;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader 编译失败: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function initGL() {
    if (!gl) throw new Error('这个浏览器不支持 WebGL');

    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('shader 链接失败: ' + gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);

    // 全屏四边形
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1
    ]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    for (const a of ADJUSTMENTS) uniforms[a.key] = gl.getUniformLocation(program, a.key);
    uniforms.uImage = gl.getUniformLocation(program, 'uImage');
    uniforms.uOriginal = gl.getUniformLocation(program, 'uOriginal');

    // 纹理：非 2 的幂也要能重复/夹取
    imageTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, imageTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }

  /* ================================================================
     状态
     ================================================================ */
  let img = null;          // ImageBitmap
  let fileName = '';
  let showingOriginal = false;

  /* ================================================================
     渲染
     ================================================================ */
  function draw() {
    if (!img) return;
    gl.useProgram(program);
    gl.bindTexture(gl.TEXTURE_2D, imageTex);
    gl.uniform1i(uniforms.uImage, 0);
    gl.uniform1f(uniforms.uOriginal, showingOriginal ? 1 : 0);
    for (const a of ADJUSTMENTS) gl.uniform1f(uniforms[a.key], values[a.key]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 顺手刷新底部信息。
    // 放在这里而不是各调用点，是因为「拖动滑杆时计数不更新」就是这么漏的 ——
    // 有几个入口忘了加，而 draw() 是所有入口的必经之路。
    updateInfo();
  }

  /** 按容器尺寸和图片比例算出画布该多大（考虑 DPR 保证清晰） */
  function layoutCanvas() {
    if (!img) return;
    const stage = $('stStage');
    const pad = 24;
    const availW = Math.max(80, stage.clientWidth - pad);
    const availH = Math.max(80, stage.clientHeight - pad);

    let w = availW, h = w * img.height / img.width;
    if (h > availH) { h = availH; w = h * img.width / img.height; }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);   // 上限 2，省点性能
    canvas.style.width = Math.round(w) + 'px';
    canvas.style.height = Math.round(h) + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function render() {
    layoutCanvas();
    draw();
    updateInfo();
  }

  /* ================================================================
     打开图片
     ================================================================ */
  async function openFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|bmp|tiff?)$/i.test(file.name)) {
      toast('这个文件看起来不是图片');
      return;
    }

    busy(true, '读取中…');
    try {
      let bmp;
      try {
        bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        // 某些浏览器对 imageOrientation 支持不好，退回默认
        bmp = await createImageBitmap(file);
      }

      if (img && img.close) img.close();
      img = bmp;
      fileName = file.name;

      gl.bindTexture(gl.TEXTURE_2D, imageTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

      $('stDrop').classList.add('hidden');
      canvas.classList.remove('hidden');
      document.title = fileName + ' · 修图';
      $('stTitle').textContent = fileName;

      enableUI(true);
      resetAll(false);
      render();
    } catch (e) {
      toast('打不开这个文件：' + (e && e.message ? e.message : e));
    } finally {
      busy(false);
    }
  }

  function enableUI(on) {
    $('stExport').disabled = !on;
    $('stReset').disabled = !on;
    $('stCompare').disabled = !on;
  }

  /* ================================================================
     滑块
     ================================================================ */
  function buildSliders() {
    const box = $('stSliders');
    box.innerHTML = '';

    for (const a of ADJUSTMENTS) {
      const row = document.createElement('div');
      row.className = 'st-sl';

      const top = document.createElement('div');
      top.className = 'st-sl-top';

      const name = document.createElement('span');
      name.className = 'st-sl-name';
      name.textContent = a.name;
      name.title = '双击回到默认值';

      const val = document.createElement('span');
      val.className = 'st-sl-val';

      top.append(name, val);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = a.min; input.max = a.max; input.step = a.step;
      input.value = a.def;
      input.dataset.key = a.key;

      const show = () => {
        const v = values[a.key];
        const changed = Math.abs(v - a.def) > 1e-6;
        val.textContent = fmt(a, v);
        val.classList.toggle('changed', changed);
        input.value = v;
      };

      input.addEventListener('input', () => {
        values[a.key] = parseFloat(input.value);
        show();
        draw();          // 只重画，不重新布局 —— 拖动时要的是极致跟手
      });

      // 双击名字复位
      name.addEventListener('dblclick', () => {
        values[a.key] = a.def;
        show();
        draw();
      });

      a._show = show;
      row.append(top, input);
      box.appendChild(row);
      show();
    }
  }

  function fmt(a, v) {
    if (a.key === 'uExposure') return (v > 0 ? '+' : '') + v.toFixed(2) + ' EV';
    const n = Math.round(v * 100);
    return (n > 0 ? '+' : '') + n;
  }

  function refreshSliders() {
    for (const a of ADJUSTMENTS) if (a._show) a._show();
  }

  function resetAll(redraw = true) {
    for (const a of ADJUSTMENTS) values[a.key] = a.def;
    refreshSliders();
    if (redraw) draw();
  }

  function isChanged() {
    return ADJUSTMENTS.some(a => Math.abs(values[a.key] - a.def) > 1e-6);
  }

  /* ================================================================
     对比原图
     ================================================================ */
  function setOriginal(on) {
    if (showingOriginal === on) return;
    showingOriginal = on;
    $('stCompare').classList.toggle('on', on);
    draw();
  }

  /* ================================================================
     导出
     ================================================================ */
  async function exportImage() {
    if (!img) return;
    busy(true, '导出中…');
    try {
      const prevW = canvas.width, prevH = canvas.height;

      // 切到原始分辨率重画一次 —— 用的是同一个 shader，所见即所得
      canvas.width = img.width;
      canvas.height = img.height;
      gl.viewport(0, 0, img.width, img.height);
      showingOriginal = false;
      draw();

      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.95));
      if (!blob) throw new Error('生成图片失败');

      // 存成 xxx-修.jpg，不覆盖原图
      const base = fileName.replace(/\.[^.]+$/, '') || 'photo';
      const out = base + '-edit.jpg';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = out;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);

      // 恢复预览
      canvas.width = prevW; canvas.height = prevH;
      gl.viewport(0, 0, prevW, prevH);
      draw();

      toast(`已导出 ${out}（${img.width}×${img.height}）`, 3200);
    } catch (e) {
      toast('导出失败：' + (e && e.message ? e.message : e));
      render();
    } finally {
      busy(false);
    }
  }

  /* ================================================================
     界面小工具
     ================================================================ */
  let toastTimer = null;
  function toast(msg, ms = 2400) {
    const t = $('stToast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function busy(on, text) {
    $('stBusy').hidden = !on;
    if (text) $('stBusyText').textContent = text;
  }

  function updateInfo() {
    if (!img) { $('stInfo').textContent = '—'; return; }
    const changed = ADJUSTMENTS.filter(a => Math.abs(values[a.key] - a.def) > 1e-6).length;
    $('stInfo').textContent =
      `${img.width}×${img.height} · ${(img.width * img.height / 1e6).toFixed(1)}MP`
      + (changed ? ` · 已调整 ${changed} 项` : ' · 未调整');
  }

  /* ================================================================
     事件绑定
     ================================================================ */
  function initEvents() {
    const pick = () => $('stFile').click();
    $('stOpen').addEventListener('click', pick);
    $('stOpen2').addEventListener('click', pick);
    $('stFile').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) openFile(f);
      e.target.value = '';       // 允许再次选同一个文件
    });

    $('stExport').addEventListener('click', exportImage);
    $('stReset').addEventListener('click', () => {
      resetAll();
      toast('已重置');
    });

    // 按住看原图
    const cmp = $('stCompare');
    const down = e => { e.preventDefault(); setOriginal(true); };
    const up = () => setOriginal(false);
    cmp.addEventListener('pointerdown', down);
    cmp.addEventListener('pointerup', up);
    cmp.addEventListener('pointerleave', up);
    cmp.addEventListener('pointercancel', up);

    // 拖拽打开
    const stage = $('stStage');
    let dragDepth = 0;
    ['dragenter', 'dragover'].forEach(t => stage.addEventListener(t, e => {
      e.preventDefault();
      $('stDrop').classList.add('dragover');
    }));
    stage.addEventListener('dragleave', e => {
      e.preventDefault();
      if (e.target === stage) $('stDrop').classList.remove('dragover');
    });
    stage.addEventListener('drop', e => {
      e.preventDefault();
      $('stDrop').classList.remove('dragover');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) openFile(f);
    });

    // 键盘
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === '\\') { e.preventDefault(); setOriginal(!showingOriginal); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); pick(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); exportImage(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); resetAll(); toast('已重置'); }
    });

    // 面板收起（窄屏）
    $('stPanelToggle').addEventListener('click', () => {
      const p = $('stPanel');
      p.classList.toggle('collapsed');
      $('stPanelToggle').textContent = p.classList.contains('collapsed') ? '▾' : '▸';
      setTimeout(render, 60);
    });

    let rt = null;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(render, 120);
    });
  }

  /* ================================================================
     启动
     ================================================================ */
  (function boot() {
    try {
      initGL();
      buildSliders();
      initEvents();
      updateInfo();
    } catch (e) {
      busy(false);
      const d = $('stDrop');
      if (d) {
        d.innerHTML = '<div class="st-drop-icon">⚠️</div>'
          + '<h2>打不开修图功能</h2>'
          + '<p>' + (e && e.message ? e.message : e) + '</p>';
      }
      console.error(e);
    }
  })();

  // 给自动化测试留的口子。
  //
  // ⚠️ setValue 必须走「改值 + 刷新界面 + 重画」这条完整路径，
  // 不能只改 values 再 _draw() —— 那样滑杆显示和「已调整 N 项」
  // 不会跟着变，测试看到的状态和用户看到的就不是一回事。
  // （一开始就是这么写的，结果测试里设了参数但界面显示 0，白测一轮。）
  window.Studio = {
    get image() { return img; },
    values,
    ADJUSTMENTS,
    openFile,
    resetAll,
    setOriginal,
    setValue(key, v) {
      values[key] = v;
      const a = ADJUSTMENTS.find(x => x.key === key);
      if (a && a._show) a._show();
      draw();
    },
    isChanged,
    _draw: draw
  };
})();
