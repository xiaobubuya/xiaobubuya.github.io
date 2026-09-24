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
     key 对应 shader 里的 uniform，默认值 0 = 不改变。

     ⚠️ 加一个新调整项要同步改四处，漏掉任何一处都是**静默失效**：
       ① 这里加定义
       ② FRAG 里加 `uniform float uXxx;`
       ③ FRAG 的 main() 里真的用上它
       ④ draw() 会自动遍历赋值（用 ADJUSTMENTS 循环，不用手加）
     test/adjustments.test.mjs 静态比对①③之间的一致性，
     加完记得把 test/adjust-browser.test.mjs 里的调整项**数量**也改掉
     （那里有个硬编码的 9）。

     范围不强行统一：曝光 ±2 EV，质感类各自定义（见下方注释）。
     ================================================================ */
  const ADJUSTMENTS = [
    { key: 'uExposure',   name: '曝光',   min: -2,  max: 2,  step: 0.01, def: 0, unit: ' EV' },
    { key: 'uContrast',   name: '对比度', min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uHighlights', name: '高光',   min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uShadows',    name: '阴影',   min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uSaturation', name: '饱和度', min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uTemp',       name: '色温',   min: -1,  max: 1,  step: 0.01, def: 0 },

    // —— 质感类 ——
    // 范围刻意不统一：这三个的「满格」含义不同。
    // 锐化 1.0 已经能看出白边（内部再乘 1.5），所以上限就 1；
    // 暗角 1.0 是很重的压角，但正常用会在 -0.5~0.5；
    // 颗粒 1.0 是明显的胶片感，婚纱照一般 0.2~0.4 就够。
    { key: 'uSharpness',  name: '锐化',   min: 0,   max: 1,  step: 0.01, def: 0 },
    { key: 'uVignette',   name: '暗角',   min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uGrain',      name: '颗粒',   min: 0,   max: 1,  step: 0.01, def: 0 },
  ];

  const values = {};
  ADJUSTMENTS.forEach(a => { values[a.key] = a.def; });

  /* ================================================================
     蒙版状态
     ----------------------------------------------------------------
     全局调整和局部调整共用同一组滑块 —— 差别只在「作用范围」。
     这个设计是刻意的：用户学会了一次滑块，就同时会了局部调整，
     不需要再去学一套独立的局部工具。

     useMask 在涂了东西之后自动打开（见 setMaskActive），
     因为涂了半天发现调整没变化，是最容易让人以为「坏了」的情况。
     ================================================================ */
  const mask = new window.Mask();
  let useMask = false;
  let showMask = false;
  let brushMode = false;      // 画笔工具是否激活（激活时画布上拖动是画画不是平移）

  /* ================================================================
     shader
     ================================================================ */
  const VERT = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      // ⚠️ Y 翻转放在这里，**不要**用 UNPACK_FLIP_Y_WEBGL。
      //
      // 原因（实测确认）：图片是 ImageBitmap，而这个 Chrome/SwiftShader
      // 组合在 texImage2D 收到 ImageBitmap 时会**忽略** UNPACK_FLIP_Y_WEBGL ——
      // 不管设 true 还是 false，纹理都是倒的。
      //
      // 在着色器里翻是唯一可靠的做法，而且不花额外开销。
      // 症状是整张预览图上下颠倒（一开始没发现，是因为测试图是对称的）。
      vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  const FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uImage;
    uniform sampler2D uMask;
    uniform float uExposure, uContrast, uHighlights, uShadows, uSaturation, uTemp;
    uniform float uSharpness, uVignette, uGrain;
    uniform float uOriginal;   // 1 = 显示原图（对比用）
    uniform float uUseMask;    // 1 = 调整只作用在蒙版内
    uniform float uMaskOverlay; // 1 = 显示蒙版本身（红色叠加）
    uniform vec2 uTexel;       // 1/图片宽高，锐化取邻居用
    uniform float uAspect;     // 图片宽高比，暗角要按比例算才不变形

    // sRGB <-> 线性。这两个函数是「正确调色」的地基：
    // 曝光/高光/阴影必须在线性空间里做，否则会发灰发闷
    vec3 toLinear(vec3 c) {
      return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
    }
    vec3 toSrgb(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
    }
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    /** 这一趟调色的全部逻辑，抽出来是为了局部调整时能调两次 */
    vec3 grade(vec3 c) {
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
      return mix(vec3(g), c, 1.0 + uSaturation);
    }

    /* ================================================================
       锐化（USM）—— 在**原始分辨率**的源图上做，不在 grade() 里
       ----------------------------------------------------------------
       为什么不能放进 grade()：grade 在局部调整时会被调用两次，
       而锐化每多调一次就多采样 9 次纹理。放在外面只做一次。
       更要紧的是 grade() 是逐像素的纯颜色运算，塞邻域采样进去
       会把它变成"有状态的函数"，后面再加局部调整就会出错。

       ⚠️ 步长必须用**原图**的 1/宽高，不能用当前画布的。
       预览画布是按屏幕尺寸渲染的（见 layoutCanvas），用画布尺寸的话
       拖一下窗口锐化半径就变了，预览和导出也对不上。
       用原图 texel 的代价是屏幕预览时看着比导出略轻 ——
       这是两者不一致里代价最小的取舍。
       ================================================================ */
    vec3 sharpen(vec3 src) {
      if (uSharpness == 0.0) return src;
      vec3 blur = vec3(0.0);
      // 3x3 均值。用均值而不是高斯，是为了省采样 ——
      // 锐化对模糊核的形状不敏感，对半径敏感
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          blur += texture2D(uImage, vUv + vec2(float(x), float(y)) * uTexel).rgb;
        }
      }
      blur /= 9.0;
      // USM：原图 + 幅度 ×（原图 - 模糊）。幅度上限 1.5，
      // 再高暗部会出现明显的白边
      return clamp(src + (src - blur) * uSharpness * 1.5, 0.0, 1.0);
    }

    /* ================================================================
       颗粒 —— 用便宜的哈希噪声，不是真的胶片颗粒
       ----------------------------------------------------------------
       用 hash 而不是预生成噪声图：省一张纹理，而且不用管平铺接缝。

       ⚠️ 强度必须按亮度调制。均匀叠加的话暗部会浮出一层灰雾
       （暗部本来就没多少余量），而亮部完全看不出来 ——
       这是"数码噪点"和"胶片颗粒"的区别。
       ================================================================ */
    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    vec3 grain(vec3 c) {
      if (uGrain == 0.0) return c;
      // 按像素坐标取噪声，保证每个像素固定不变（不然一动就闪）
      float n = hash21(gl_FragCoord.xy) - 0.5;
      // 中间调给满，暗部和亮部收敛
      float mid = 1.0 - abs(luma(c) - 0.5) * 2.0;
      mid = mid * mid;                 // 让收窄更明显一点
      return c + n * uGrain * 0.12 * (0.35 + 0.65 * mid);
    }

    /* ================================================================
       暗角
       ----------------------------------------------------------------
       ⚠️ 用 uAspect 修正后再量距离，否则圆形暗角在宽图上会变成
       上下先暗。除以 max(1.0, uAspect) 是为了让系数不随图片比例变化 ——
       否则同一张图裁成正方形，"暗角 -0.5"的强度会跳变。

       ⚠️ 符号：**正值压暗、负值提亮**。
       第一版写成 c * (1.0 + amt) 且 amt 直接取 uVignette，
       结果 0.9 把四角从 128 抬到了 216 —— 越大越亮，方向反了。
       正确是 1 - amt：正值减小系数（压暗），负值增大系数（提亮）。

       两种幅度要分开收敛：提亮时收敛一点，免得四角糊成一片白。
       ================================================================ */
    vec3 vignette(vec3 c) {
      if (uVignette == 0.0) return c;
      vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0) / max(1.0, uAspect);
      float r = length(d) * 1.414;      // 归一化：角上约等于 1
      // 从中心向外开始压，中心 1/3 完全不碰（否则人脸先暗下去）
      float w = smoothstep(0.35, 1.05, r);

      // 把符号揉进 amt 里：正值 → 正 amt → 乘 (1-amt) 压暗；
      // 负值 → 负 amt → (1-amt) 大于 1 → 提亮。
      // 一个表达式同时表达「压暗/提亮」和「提亮时收敛到 0.6」，
      // 比写成两个返回分支更难把符号搞反。
      float amt = uVignette * w * (uVignette > 0.0 ? 1.0 : 0.6);
      return c * (1.0 - amt);
    }

    void main() {
      vec3 src = texture2D(uImage, vUv).rgb;

      if (uOriginal > 0.5) {
        gl_FragColor = vec4(src, 1.0);
        return;
      }

      // 锐化在调色之前，而且作用在源图上
      vec3 sharp = sharpen(src);

      // ⚠️ 局部调整时混的也是 sharp 而不是 src ——
      // 混 src 的话，涂了蒙版之后锐化会在蒙版内被"混掉"，
      // 表现是「涂哪哪变糊」，正好和预期相反
      vec3 c = grade(sharp);

      // 局部调整：按蒙版权重把「调过的」和「原图」混合回来。
      //
      // 关键点是**在线性空间里混**。第一版在最后（sRGB 空间）混，
      // 结果蒙版边缘出现一圈发灰的过渡带 —— 因为 sRGB 是非线性的，
      // 两个颜色的中间值不等于中间亮度。线性空间里混才是物理正确的。
      if (uUseMask > 0.5) {
        float m = texture2D(uMask, vUv).r;
        c = mix(toLinear(sharp), toLinear(c), m);
        c = toSrgb(c);
      }

      // 暗角和颗粒放在蒙版混合**之后**：它们是"整张照片的收尾处理"，
      // 不是"某个区域的调整"。放进蒙版里的话，涂一小块区域会让
      // 那块的暗角被抹掉，看起来像破了个洞。
      c = vignette(c);
      c = grain(c);

      c = clamp(c, 0.0, 1.0);

      // 蒙版可视化：涂过的地方罩一层红。
      // 用 0.45 的不透明度而不是纯色，是为了还能看清底下照片的细节 ——
      // 涂眼睛的时候需要看见眼睛在哪。
      if (uMaskOverlay > 0.5) {
        float m = texture2D(uMask, vUv).r;
        c = mix(c, vec3(1.0, 0.15, 0.15), m * 0.45);
      }

      gl_FragColor = vec4(c, 1.0);
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

  let program = null, uniforms = {}, imageTex = null, maskTex = null;

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
    uniforms.uMask = gl.getUniformLocation(program, 'uMask');
    uniforms.uOriginal = gl.getUniformLocation(program, 'uOriginal');
    uniforms.uUseMask = gl.getUniformLocation(program, 'uUseMask');
    uniforms.uMaskOverlay = gl.getUniformLocation(program, 'uMaskOverlay');
    uniforms.uTexel = gl.getUniformLocation(program, 'uTexel');
    uniforms.uAspect = gl.getUniformLocation(program, 'uAspect');

    // 纹理：非 2 的幂也要能重复/夹取
    imageTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, imageTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // 图片源是 ImageBitmap，这个标志对它无效（见 VERT 说明）。
    // 仍然设成 false 是为了语义清楚：我们不依赖它，翻转在着色器里做。
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // 蒙版纹理。
    //
    // ⚠️ 这里**不能**翻 Y，因为翻的动作已经统一挪到顶点着色器里了
    // （见 VERT 的说明）。蒙版位图本身是按「图片坐标」写的
    // （mask.js 里已经翻过一次），和 vUv 同一套朝上语义，
    // 直接传就行。这里要是再翻，蒙版就和照片对不上了 ——
    // 表现是「涂上半张脸，下半张变亮」。
    maskTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /**
   * 把蒙版位图推上 GPU。
   *
   * ⚠️ 判断依据是「位图版本号」而不是 mask.dirty。
   * 一开始用的是 dirty，结果第一笔永远不显示：paintRect → draw()
   * 会先调 render()，而 render() 结尾把 dirty 清成了 false，
   * 等 uploadMask() 再看时已经是「干净」的，于是跳过上传 ——
   * 表现就是「涂了半天画面没反应」，但覆盖率又是对的，极难排查。
   *
   * 现在改成：mask 每次内容变化就 ++mask.version，
   * 这里只比较版本号，和渲染时机彻底解耦。
   */
  function uploadMask() {
    if (!mask.canvas) return;
    if (mask._uploadedVersion === mask.version) return;
    const data = mask.toTextureData();
    if (!data) return;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
    mask._uploadedVersion = mask.version;
    gl.activeTexture(gl.TEXTURE0);
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

    uploadMask();

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTex);
    gl.uniform1i(uniforms.uImage, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.uniform1i(uniforms.uMask, 1);
    gl.activeTexture(gl.TEXTURE0);

    gl.uniform1f(uniforms.uOriginal, showingOriginal ? 1 : 0);
    // 蒙版是空的却开着「只看局部」，画面会完全没反应 —— 那看起来就是坏了。
    // 所以空蒙版一律按全局处理，不管开关状态。
    gl.uniform1f(uniforms.uUseMask, (useMask && !mask.isEmpty) ? 1 : 0);
    gl.uniform1f(uniforms.uMaskOverlay, (showMask && !mask.isEmpty) ? 1 : 0);

    // 锐化取邻居的步长用**原图**的 1/宽高，不是当前画布的 ——
    // 用画布尺寸的话，拖一下窗口锐化半径就变了（预览和导出也不一致）。
    // 代价是屏幕预览时看着比导出略轻，取舍写在 shader 的 sharpen 注释里。
    gl.uniform2f(uniforms.uTexel, 1 / img.width, 1 / img.height);
    gl.uniform1f(uniforms.uAspect, img.width / img.height);

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

      // 蒙版跟着图片尺寸重建。⚠️ 必须在 enableUI/draw 之前 ——
      // 蒙版位图没建好时 begin() 会直接 return，表现是「画笔涂不上」。
      // clear() 也要调：只 resize 的话旧图的笔画会被重放到新图上
      // （归一化坐标是通用的，长宽比一变选区就跑到别的地方去了）。
      mask.clear();
      mask.resize(img.width, img.height);
      setMaskActive(false);
      setBrushMode(false);
      showMaskTool(false);

      gl.bindTexture(gl.TEXTURE_2D, imageTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

      // 蒙版纹理也要立刻清空，否则会残留上一张图的选区

      $('stDrop').classList.add('hidden');
      canvas.classList.remove('hidden');
      document.title = fileName + ' · 修图';
      $('stTitle').textContent = fileName;

      enableUI(true);
      resetAll(false);
      syncMaskUI();
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
    const b = $('stBrush');
    if (b) b.disabled = !on;
    const s = $('stSeg');
    if (s) s.disabled = !on;
    const ip = $('stInpaint');
    if (ip) ip.disabled = !on || mask.isEmpty;
    const u = $('stUseMask');
    if (u) u.disabled = !on || mask.isEmpty;
    if (!on && typeof syncMaskUI === 'function') syncMaskUI();
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
     画笔
     ================================================================ */

  /** 屏幕坐标 → 图片归一化坐标（0~1）。蒙版和 shader 共享这套坐标 */
  function toImageCoord(e) {
    const r = canvas.getBoundingClientRect();
    return [
      (e.clientX - r.left) / r.width,
      1 - (e.clientY - r.top) / r.height   // Y 翻转：屏幕向下，纹理向上
    ];
  }

  function setBrushMode(on) {
    brushMode = on && !!img;
    canvas.classList.toggle('brushing', brushMode);
    const b = $('stBrush');
    if (b) b.classList.toggle('on', brushMode);
    syncMaskUI();
  }

  function initBrush() {
    let drawing = false;

    canvas.addEventListener('pointerdown', e => {
      if (!brushMode || !img) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      drawing = true;
      mask.begin(...toImageCoord(e));
      draw();
    });

    canvas.addEventListener('pointermove', e => {
      if (!drawing) return;
      e.preventDefault();
      // getCoalescedEvents 能拿到两次 rAF 之间被浏览器合并掉的中间点。
      // 不用它的话快速画圈会变成多边形，边缘全是直线段。
      //
      // ⚠️ 但它可能是空的 —— 合成事件（自动化测试）就是空数组，
      // 某些浏览器在特定情况下也会返回空。直接遍历空数组的话
      // 整条线都画不出来，只留下落笔那一个点，而且不报任何错。
      // 所以空的时候必须退回用事件本身。
      let evs = null;
      try { evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null; } catch {}
      if (!evs || !evs.length) evs = [e];

      let moved = false;
      for (const ev of evs) {
        if (mask.extend(...toImageCoord(ev))) moved = true;
      }
      if (moved) draw();
    });

    const finish = e => {
      if (!drawing) return;
      drawing = false;
      if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
      if (mask.end()) {
          setMaskActive(true);
        draw();
      }
      syncMaskUI();
    };

    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', e => {
      if (!drawing) return;
      drawing = false;
      mask.abort();
      draw();
    });

    // 自定义光标：画一个和笔刷等大的圈。
    // 用 CSS 光标做不到跟随笔刷大小，所以用一个绝对定位的 div。
    const cur = document.createElement('div');
    cur.className = 'st-cursor';
    cur.hidden = true;
    $('stStage').appendChild(cur);
    canvas.addEventListener('pointerenter', () => { if (brushMode) cur.hidden = false; });
    canvas.addEventListener('pointerleave', () => { cur.hidden = true; });
    canvas.addEventListener('pointermove', e => {
      if (!brushMode) { cur.hidden = true; return; }
      cur.hidden = false;
      const r = canvas.getBoundingClientRect();
      const d = mask.radius * Math.min(r.width, r.height) * 2;
      cur.style.width = cur.style.height = Math.round(d) + 'px';
      const sr = $('stStage').getBoundingClientRect();
      cur.style.left = (e.clientX - sr.left - d / 2) + 'px';
      cur.style.top = (e.clientY - sr.top - d / 2) + 'px';
      cur.classList.toggle('erase', mask.mode === 'erase');
    });
  }

  /** 涂了东西就自动打开局部模式，否则用户会以为调整坏了 */
  function setMaskActive(on) {
    useMask = on;
    const c = $('stUseMask');
    if (c) c.checked = on;
    syncMaskUI();
  }

  function syncMaskUI() {
    const cov = mask.isEmpty ? 0 : mask.coverage();
    const info = $('stMaskInfo');
    if (info) {
      info.textContent = mask.isEmpty
        ? '没涂任何区域'
        : `已选 ${(cov * 100).toFixed(1)}% · ${mask.strokes.length} 笔`;
    }
    const uc = $('stUseMask');
    if (uc) {
      uc.disabled = mask.isEmpty;
      uc.checked = useMask;
    }
    const clear = $('stMaskClear');
    if (clear) clear.disabled = mask.isEmpty;
    const undo = $('stMaskUndo');
    if (undo) undo.disabled = !mask.strokes.length;
    const inv = $('stMaskInvert');
    if (inv) inv.disabled = mask.isEmpty;
    const seg = $('stSeg');
    if (seg) seg.disabled = !img;
    // 抹掉选区：没有选区时不能点（不然不知道抹哪儿）。
    // 桌面版才真的能跑，网页版点下去会给提示说明原因。
    const inp = $('stInpaint');
    if (inp) {
      inp.disabled = !img || mask.isEmpty;
      inp.classList.toggle('dim', !hasInpaint());
      inp.title = hasInpaint()
        ? '抹掉选区里的东西（火山即梦）'
        : '需要在桌面版「修图 App」里使用（浏览器有跨域限制）';
    }
    ['stBrushAdd', 'stBrushErase'].forEach(id => {
      const el = $(id);
      if (el) el.classList.toggle('on', (id === 'stBrushAdd') === (mask.mode === 'add'));
    });
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
     AI 抠人像（百度人体分析）
     ----------------------------------------------------------------
     只在桌面版里可用：浏览器直接调百度会被 CORS 挡住（实测三家都挡），
     所以走 Electron 主进程转发。网页版就把按钮禁掉并说明原因。
     ================================================================ */
  function hasDesktop() {
    return !!(window.AlbumStudio && window.AlbumStudio.baiduBodySeg);
  }

  async function segmentPerson() {
    if (!img) return;
    if (!hasDesktop()) {
      toast('AI 抠人需要桌面版的「修图 App」\n浏览器里调不通（跨域限制）', 3600);
      return;
    }

    busy(true, '正在识别…');
    try {
      // 先把百度密钥取好交给主进程（有 10 分钟缓存，通常不打请求）
      await getKeys('baidu').catch(() => {});
      // 先把当前图缩到长边 1024 再传 —— 百度接口对分辨率没那么敏感，
      // 但传原图(4000px)会让请求体变成好几 MB，白等好几秒。
      const long = Math.max(img.width, img.height);
      const s = Math.min(1, 1024 / long);
      const cw = Math.round(img.width * s), ch = Math.round(img.height * s);

      const off = document.createElement('canvas');
      off.width = cw; off.height = ch;
      off.getContext('2d').drawImage(img, 0, 0, cw, ch);

      // 百度只认 JPEG / PNG。统一转 JPEG，避免 WebP 被拒
      // （相册里的 preview 就是 WebP 存成 .jpg 的，踩过这个坑）
      const b64 = off.toDataURL('image/jpeg', 0.9).split(',')[1];

      const res = await window.AlbumStudio.baiduBodySeg(b64);
      if (!res || !res.ok) throw new Error((res && res.error) || '识别失败');

      if (!res.persons) {
        toast(res.message || '没有检测到人像');
        return;
      }

      // 把返回的蒙版贴进来。
      // ⚠️ 百度回的 labelmap 是**裸 base64**，不带 data: 前缀，
      // 直接塞给 Image.src 是加载不出来的（而且不报错，只是一直不触发
      // onload，表现成「点了没反应」）。这里补一道防御，
      // 不管上游给的是裸 base64 还是完整 data URL 都能work。
      const src = /^data:/.test(res.mask) ? res.mask : 'data:image/png;base64,' + res.mask;
      const m = await loadImage(src);
      mask.setFromCanvas(m);
      setMaskActive(true);
      setBrushMode(true);
      showMaskTool(true);
      draw();
      toast(`抠出 ${res.persons} 个人，可以直接调亮度或换背景`, 3200);
    } catch (e) {
      toast('识别失败：' + (e && e.message ? e.message : e));
    } finally {
      busy(false);
    }
  }

  function loadImage(src) {
    return new Promise((ok, no) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => no(new Error('蒙版图解码失败'));
      im.src = src;
    });
  }

  function showMaskTool(on) {
    const opts = $('stBrushOpts');
    const opts2 = $('stBrushOpts2');
    if (opts) opts.hidden = !on;
    if (opts2) opts2.hidden = !on;
  }

  /* ================================================================
     密钥保险箱（客户端侧）
     ----------------------------------------------------------------
     密钥存在服务端（加密），客户端按需取，本地缓存 10 分钟。

     取的动作必须在**页面**里做：密钥接口要登录，而 Cookie 是
     httpOnly 的，Electron 主进程读不到 —— 只有页面能发这个请求。

     取到之后做两件事：
       ① 自己缓存 10 分钟（省掉重复请求）
       ② prime 给主进程（它才是真正发 AI 请求的那一方）
     ================================================================ */
  const VAULT_TTL = 10 * 60 * 1000;
  const vaultCache = new Map();       // provider → { secret, at }

  async function getKeys(provider, force) {
    const now = Date.now();
    if (!force) {
      const hit = vaultCache.get(provider);
      if (hit && now - hit.at < VAULT_TTL) return hit.secret;
    }

    const r = await fetch(`${API_BASE}/api/vault/${provider}`, {
      credentials: 'include'
    });

    if (r.status === 401) throw new Error('没登录，取不到密钥。请先在相册里登录。');
    if (r.status === 404) {
      throw new Error(`服务端还没配置 ${provider} 的密钥`);
    }
    if (!r.ok) throw new Error(`取密钥失败 HTTP ${r.status}`);

    const body = await r.json();
    if (!body || !body.secret) throw new Error('密钥接口返回了空内容');

    vaultCache.set(provider, { secret: body.secret, at: Date.now() });

    // 交给主进程缓存。失败也不阻断 —— 主进程那边会自己回退到本地文件
    if (hasDesktop() && window.AlbumStudio.vaultPrime) {
      await window.AlbumStudio.vaultPrime(provider, body.secret, API_BASE).catch(() => {});
    }
    return body.secret;
  }

  /** 改了密钥之后要清两边缓存，否则要等 10 分钟才生效 */
  async function invalidateKeys(provider) {
    if (provider) vaultCache.delete(provider);
    else vaultCache.clear();
    if (hasDesktop() && window.AlbumStudio.vaultInvalidate) {
      await window.AlbumStudio.vaultInvalidate(provider).catch(() => {});
    }
  }

  /* ================================================================
     去物（火山即梦）
     ----------------------------------------------------------------
     为什么上传在网页这边做、生成在 App 那边做：

       上传要带登录 Cookie，而 Cookie 是 httpOnly 的，
       Electron 主进程拿不到 —— 只有页面能发这个请求。
       火山不给 CORS 头，网页里 fetch 会被浏览器拦掉 ——
       只有主进程能发那个请求。

     所以是「谁能干谁干」，中间用公网 URL 交接。
     ================================================================ */
  const API_BASE = 'https://api.muyaya.world';

  /** 把当前图传到临时上传，换一个火山能抓的公网 URL */
  async function uploadForAI(blob) {
    // ① 申请通行证
    const c = await fetch(API_BASE + '/api/tmp', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!c.ok) throw new Error('申请上传通行证失败 HTTP ' + c.status);
    const { token, publicUrl } = await c.json();

    // ② 传字节。火山只吃 JPEG / PNG，所以这里统一转 JPEG
    const up = await fetch(API_BASE + '/api/tmp/' + token, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob
    });
    if (!up.ok) {
      // 失败就把通行证删掉，别留垃圾
      fetch(API_BASE + '/api/tmp/' + token, { method: 'DELETE', credentials: 'include' })
        .catch(() => {});
      const e = await up.json().catch(() => ({}));
      throw new Error(e.message || ('上传失败 HTTP ' + up.status));
    }

    return {
      url: publicUrl,
      // 用完即删。放在 finally 里执行，不管是成功还是出错都清掉 ——
      // 反正 10 分钟也会自动过期，但主动删更干净
      cleanup: () => fetch(API_BASE + '/api/tmp/' + token, {
        method: 'DELETE', credentials: 'include'
      }).catch(() => {})
    };
  }

  /** 当前图 → JPEG blob（必要的话先缩到长边 2048，省上传时间和流量） */
  async function imageBlob(maxSide = 2048) {
    const long = Math.max(img.width, img.height);
    const s = Math.min(1, maxSide / long);
    const cw = Math.round(img.width * s), ch = Math.round(img.height * s);

    const off = document.createElement('canvas');
    off.width = cw; off.height = ch;
    off.getContext('2d').drawImage(img, 0, 0, cw, ch);
    return await new Promise(r => off.toBlob(r, 'image/jpeg', 0.92));
  }

  async function removeObject() {
    if (!img) return;
    if (!hasInpaint()) {
      toast('去物需要桌面版的「修图 App」\n浏览器里调不通（跨域限制）', 3600);
      return;
    }
    if (mask.isEmpty) {
      toast('先用画笔涂出要抹掉的东西', 3000);
      setBrushMode(true);
      showMaskTool(true);
      return;
    }

    // 从蒙版算包围盒和占比，用来生成"改哪里、改多大"的描述
    const stats = maskStats();
    if (!stats) { toast('选区是空的'); return; }

    // 用户想抹掉什么。给个输入框而不是固定文案 ——
    // 提示词说得越具体，生成的结果越准
    const intent = await askIntent();
    if (intent === null) return;      // 用户取消

    busy(true, '正在准备…');
    let up = null;
    const offProgress = hasInpaint()
      ? window.AlbumStudio.onInpaintProgress(p => {
          if (p.stage === 'submit') busy(true, '正在提交…');
          else if (p.stage === 'poll') {
            const s = Math.round((p.elapsed || 0) / 1000);
            busy(true, `AI 正在重绘… ${s}s`);
          } else if (p.stage === 'download') busy(true, '正在取回结果…');
        })
      : null;

    try {
      // 取火山密钥交给主进程（有缓存，通常不打请求）
      await getKeys('volcengine');

      const blob = await imageBlob();
      up = await uploadForAI(blob);

      busy(true, '正在提交…');
      const r = await window.AlbumStudio.volcInpaint({
        imageUrl: up.url,
        bbox: stats.bbox,
        coverage: stats.coverage,
        intent,
        timeoutMs: 150000
      });

      if (!r.ok) throw new Error(r.error || '生成失败');
      if (r.image) {
        applyInpaintResult(r.image, blob, stats);
        toast(`已抹掉（${(r.totalMs / 1000).toFixed(1)}s）`, 3200);
      }
    } catch (e) {
      toast('去物失败：' + (e && e.message ? e.message : e), 4800);
    } finally {
      if (offProgress) offProgress();
      if (up) up.cleanup();
      busy(false);
    }
  }

  /* ================================================================
     把一张位图换成当前编辑图
     ----------------------------------------------------------------
     去物和美颜都要做这件事，所以抽出来。原来这段内联在
     applyInpaintResult 里，复制一份的话迟早两边不一致。
     ================================================================ */
  async function swapImage(source) {
    const bmp = await createImageBitmap(source);
    if (img && img.close) img.close();
    img = bmp;
    gl.bindTexture(gl.TEXTURE_2D, imageTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    render();
  }

  /**
   * 把 AI 的结果贴回来。
   *
   * ⚠️ 这里有个容易忽略的点：上传前如果缩过图，返回的结果尺寸
   * 和画布上的原图对不上。所以不能直接整张替换 ——
   * 要按「选区周围」这块取回来，缩放到原图坐标再合成。
   *
   * 而且 AI 会把整张图重画一遍（它还改了色彩和细节），
   * 所以只拿选区那一块，其他地方保留原图，才不会被"顺手美化"。
   */
  function applyInpaintResult(dataUrl, uploadedBlob, stats) {
    loadImage(dataUrl).then(res => {
      // 把结果缩放到和当前画布一致
      const off = document.createElement('canvas');
      off.width = img.width; off.height = img.height;
      const octx = off.getContext('2d');
      octx.drawImage(res, 0, 0, img.width, img.height);

      const w = off.width, h = off.height;
      // bbox 是纹理坐标（y 向上），画布是 y 向下，这里翻回去
      const bx0 = Math.floor(stats.bbox.x0 * w);
      const bx1 = Math.ceil(stats.bbox.x1 * w);
      const by0 = Math.floor((1 - stats.bbox.y1) * h);
      const by1 = Math.ceil((1 - stats.bbox.y0) * h);

      // 往外扩一点，让接缝落在羽化区外面
      const pad = Math.round(Math.min(w, h) * 0.02);
      const sx = Math.max(0, bx0 - pad), sy = Math.max(0, by0 - pad);
      const sw = Math.min(w, bx1 + pad) - sx, sh = Math.min(h, by1 + pad) - sy;

      // 整张换成新图（AI 重画了全图，但只有选区可信）
      const merged = document.createElement('canvas');
      merged.width = w; merged.height = h;
      const mctx = merged.getContext('2d');
      // 原图当底
      mctx.drawImage(img, 0, 0);
      // 只把选区那块盖上去
      const piece = document.createElement('canvas');
      piece.width = sw; piece.height = sh;
      piece.getContext('2d').drawImage(off, sx, sy, sw, sh, 0, 0, sw, sh);

      // 用蒙版裁一下这块，边缘才不会出现生硬的矩形接缝
      const pc = piece.getContext('2d');
      pc.globalCompositeOperation = 'destination-in';
      const mc = mask.canvas;
      pc.drawImage(mc, sx * mc.width / w, sy * mc.height / h,
        sw * mc.width / w, sh * mc.height / h, 0, 0, sw, sh);

      mctx.drawImage(piece, sx, sy);

      // 合成结果替换当前图
      swapImage(merged).then(() => {
        // 结果已经"烤"进图里了，蒙版留着没意义，清掉
        mask.clear();
        setMaskActive(false);
        setBrushMode(false);
        showMaskTool(false);
        render();
        toast('已应用，可以继续修或导出', 2600);
      });
    }).catch(e => toast('结果应用失败：' + e.message));
  }

  /* ================================================================
     美颜（旷视 Face++）
     ----------------------------------------------------------------
     和抠人、去物的关键差别：这条链路**只要 0.7 秒**，同步返回。
     所以交互可以做成「调完点一下 → 看效果 → 决定要不要」。

     ----------------------------------------------------------------
     为什么不做成「拖滑块实时预览」
     ----------------------------------------------------------------
     试过这么想：拖一下发一次请求，0.7 秒就回来了，看起来很适合实时。

     但旷视免费额度的**并发只有 1**。拖动滑块一秒钟能触发十几次，
     结果是一路 CONCURRENCY_LIMIT_EXCEEDED（403），
     表现成「拖了半天没反应，偶尔闪一下」—— 比不做实时还糟。

     所以做成显式的一步：调参数 → 点「看一下效果」→ 出预览 →
     应用 或 撤销。这样每次点击 = 一次请求，天然串行。
     （主进程那边还有一层 3 秒最小间隔兜底，见 ai-megvii.js。）

     ----------------------------------------------------------------
     为什么预览不直接落盘
     ----------------------------------------------------------------
     一次美颜会消耗免费额度，用户点之前不知道效果好不好。
     所以结果先摆在预览浮层里：满意点「应用」才换掉画布上的图，
     不满意点「撤销」，原图原封不动。
     ================================================================ */

  /** 参数表 / 滤镜表 / 预设：从主进程读，不在页面里再抄一份 */
  let beautySchema = null;
  /** 当前滑块值：key → 0~100 */
  const beautyValues = {};
  let beautyFilter = '';
  /**
   * 美颜前的原图备份（null 表示当前没有可撤销的美颜）。
   * 留着它是为了「撤销」—— 美颜不是可逆运算，反算不回来。
   */
  let beautyBackup = null;

  function hasBeauty() {
    return !!(window.AlbumStudio && window.AlbumStudio.megviiBeautify);
  }

  /**
   * 生成美颜面板。
   *
   * ⚠️ 参数定义来自主进程（megviiSchema），不在这里写死。
   * 两边各存一份的话，加参数时漏改一边，症状是
   * 「滑块拖了但没效果」—— 这类静默失效最难查，
   * 之前 window.AlbumStudio 大小写那次就是这么坑的。
   */
  async function initBeauty() {
    const body = $('stBeautyBody');
    if (!body) return;

    if (!hasBeauty()) {
      body.innerHTML = '<div class="st-beauty-empty">'
        + '美颜需要桌面版的「修图 App」<br>（浏览器里调不通，跨域限制）</div>';
      return;
    }

    try {
      const s = await window.AlbumStudio.megviiSchema();
      if (!s || !s.ok) throw new Error((s && s.error) || '读不到参数表');
      beautySchema = s;

      for (const p of s.params) beautyValues[p.key] = 0;

      const groups = { skin: '肤质', face: '脸型' };
      let html = '';

      for (const [g, label] of Object.entries(groups)) {
        const list = s.params.filter(p => p.group === g);
        if (!list.length) continue;
        html += `<div class="st-beauty-group">${label}</div>`;
        for (const p of list) {
          html += ''
            + `<label class="st-bsl" data-key="${p.key}">`
            + `  <span>${p.name}</span>`
            + `  <input type="range" min="0" max="100" step="1" value="0" data-bsl="${p.key}">`
            + `  <span class="st-bsl-val" data-val="${p.key}">0</span>`
            + '</label>';
        }
      }

      // 滤镜
      if (s.filters && s.filters.length) {
        const common = s.filters.filter(f => f.common);
        const rest = s.filters.filter(f => !f.common && f.value);
        const none = s.filters.filter(f => !f.value);
        html += '<div class="st-beauty-group">滤镜</div>';
        html += '<label class="st-bsl"><span>效果</span><select id="stBeautyFilter">';
        for (const f of none) html += `<option value="">${f.name}</option>`;
        for (const f of common) html += `<option value="${f.value}">${f.name}</option>`;
        if (rest.length) {
          html += '<optgroup label="更多">';
          for (const f of rest) html += `<option value="${f.value}">${f.name}</option>`;
          html += '</optgroup>';
        }
        html += '</select></label>';
      }

      // 动作按钮
      html += ''
        + '<div class="st-mask-row" style="margin-top:2px">'
        + '  <button id="stBeautyGo" class="st-btn wide ai">✨ 看一下效果</button>'
        + '</div>'
        + '<div class="st-beauty-empty" id="stBeautyHint">'
        + '   0 = 不碰这一项。不动的项不会发给旷视 ——'
        + '   它这些参数的默认值是 50，全发出去会把脸改得不像本人。'
        + '</div>';

      body.innerHTML = html;

      // 滑块
      body.querySelectorAll('input[data-bsl]').forEach(inp => {
        inp.addEventListener('input', () => onBeautySlider(inp.dataset.bsl, inp.value));
      });

      // 滤镜
      const sel = $('stBeautyFilter');
      if (sel) sel.addEventListener('change', () => { beautyFilter = sel.value; });

      $('stBeautyGo').addEventListener('click', runBeauty);

      // 一键美颜：填预设，不直接发请求 —— 让用户先看到参数再决定
      const pre = $('stBeautyPreset');
      if (pre) {
        pre.addEventListener('click', () => {
          applyBeautyPreset();
          toast('已填入一组保守参数，点「看一下效果」试试', 3000);
        });
      }
    } catch (e) {
      body.innerHTML = '<div class="st-beauty-empty">美颜面板打不开：'
        + String(e && e.message || e) + '</div>';
    }
  }

  function onBeautySlider(key, raw) {
    const v = Math.max(0, Math.min(100, Math.round(Number(raw) || 0)));
    beautyValues[key] = v;

    const val = document.querySelector(`[data-val="${key}"]`);
    if (val) val.textContent = v;
    const row = document.querySelector(`.st-bsl[data-key="${key}"]`);
    if (row) row.classList.toggle('on', v > 0);
  }

  function applyBeautyPreset() {
    const preset = (beautySchema && beautySchema.preset) || {};
    for (const [k, v] of Object.entries(preset)) {
      beautyValues[k] = v;
      const inp = document.querySelector(`input[data-bsl="${k}"]`);
      if (inp) inp.value = v;
      onBeautySlider(k, v);
    }
  }

  /** 只挑出 > 0 的项。0 的含义是「别碰这一项」，不是「调成 0」 */
  function beautyParams() {
    const out = {};
    for (const [k, v] of Object.entries(beautyValues)) if (v > 0) out[k] = v;
    if (beautyFilter) out.filter_type = beautyFilter;
    return out;
  }

  async function runBeauty() {
    if (!img) return;
    if (!hasBeauty()) {
      toast('美颜需要桌面版的「修图 App」\n浏览器里调不通（跨域限制）', 3600);
      return;
    }

    const params = beautyParams();
    if (!Object.keys(params).length) {
      toast('先把某个滑块拖起来，或者点「一键美颜」\n全 0 的话调过去只是白费一次额度', 3600);
      return;
    }

    busy(true, '正在美颜…');
    try {
      // 密钥走保险箱（有 10 分钟缓存，通常不打请求）
      await getKeys('megvii');

      // 长边 1600 再传。旷视按张计费不按像素，但没有理由把
      // 4000px 的原图（几 MB）塞进请求体 —— 白等上传时间。
      // 1600 和相册里 preview 档一致，做婚礼相册足够。
      const long = Math.max(img.width, img.height);
      const s = Math.min(1, 1600 / long);
      const cw = Math.round(img.width * s), ch = Math.round(img.height * s);

      const off = document.createElement('canvas');
      off.width = cw; off.height = ch;
      off.getContext('2d').drawImage(img, 0, 0, cw, ch);

      // 统一 JPEG：相册里的 preview 是 WebP 存成 .jpg 的（踩过这个坑）
      const b64 = off.toDataURL('image/jpeg', 0.92).split(',')[1];

      const r = await window.AlbumStudio.megviiBeautify(b64, params);
      if (!r || !r.ok) throw new Error((r && r.error) || '美颜失败');

      // 结果缩回原图尺寸再换。旷视返回值是按我们发过去的尺寸出的，
      // 直接换上去的话画布会突然"变小"（其实是图变小了）——
      // 而且原图上万一有别的调整，尺寸一变坐标就全错。
      const res = await loadImage(r.image);
      const merged = document.createElement('canvas');
      merged.width = img.width; merged.height = img.height;
      merged.getContext('2d').drawImage(res, 0, 0, img.width, img.height);

      // 先留住原图，才能撤销。
      // 只在**第一次**美颜前留 —— 连着美颜两次，撤销要回到最初那张，
      // 不是回到"上一次美颜后"。
      if (!beautyBackup) beautyBackup = img;
      else if (img && img.close && img !== beautyBackup) img.close();

      await swapImage(merged);

      const n = r.applied ? Object.keys(r.applied).length : 0;
      showPreview(`已美颜 · ${n} 项 · ${r.ms}ms`);
      toast('不满意就点「撤销」', 2400);
    } catch (e) {
      toast('美颜失败：' + (e && e.message ? e.message : e), 5200);
    } finally {
      busy(false);
    }
  }

  function showPreview(tip) {
    const box = $('stPreview');
    if (!box) return;
    const t = $('stPreviewTip');
    if (t && tip) t.textContent = tip;
    box.hidden = false;
  }

  function hidePreview() {
    const box = $('stPreview');
    if (box) box.hidden = true;
  }

  /** 「就这样」：清掉备份，美颜结果正式留下 */
  function keepBeauty() {
    if (beautyBackup && beautyBackup.close && beautyBackup !== img) {
      beautyBackup.close();
    }
    beautyBackup = null;
    hidePreview();
    toast('已保留，可以继续修或导出', 2200);
  }

  /**
   * 撤销美颜：换回改动前那张。
   *
   * 用备份而不是「记住参数反算」—— 美颜不是可逆运算，
   * 反算不可能还原。留一张原图是最省事也最可靠的做法
   * （代价是编辑期间多占一份内存，可以接受）。
   */
  async function undoBeauty() {
    if (!beautyBackup) { hidePreview(); return; }
    const back = beautyBackup;
    beautyBackup = null;
    hidePreview();
    try {
      await swapImage(back);      // swapImage 会负责关掉被替换掉的那张
      toast('已撤销，回到美颜前', 2200);
    } catch (e) {
      toast('撤销失败：' + (e && e.message ? e.message : e));
    }
  }

  /** 从蒙版位图算 {bbox, coverage}。和主进程 ai-inpaint.js 的算法一致 */
  function maskStats() {
    // ⚠️ 坐标朝向（这块来来回回错过两次，务必看懂再改）
    //
    // 完整链路：
    //
    //   鼠标屏幕坐标  y 向下
    //        │ toImageCoord：1 - y/h  →  翻成 y 向上
    //        ▼
    //   笔画点（图片坐标，y 向上）
    //        │ mask._paintSegment：(1 - y) * h  →  翻成 canvas 的 y 向下
    //        ▼
    //   蒙版位图（canvas 坐标，y 向下）
    //        │ 这里 maskStats：1 - y/h  →  翻回 y 向上
    //        ▼
    //   bbox（图片坐标，y 向上）→ 交给 AI 描述方位
    //
    // 一翻一翻再翻回来，看着啰嗦，但每一步都是必须的：
    // mask.js 必须用 canvas 坐标画，而 describeRegion 必须收 y 向上的坐标。
    //
    // 踩过的坑：把这里当成"已经翻过了"而不翻 —— 结果在画面上方涂，
    // 报给 AI 的却是"下方"，AI 就去改了完全不相干的地方，
    // 成品看起来"就是不对劲"，极难归因。要靠在真机涂一笔、对比 bbox 才查得出来。
    if (!mask.canvas) return null;
    const d = mask.toTextureData();
    const { data, width, height } = d;
    let x0 = width, y0 = height, x1 = -1, y1 = -1, n = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4] > 8) {
          n++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;

    return {
      // 位图 y 向下 → 翻回图片坐标的 y 向上（见上面那段链路说明）
      bbox: {
        x0: x0 / width,
        y0: 1 - (y1 + 1) / height,
        x1: (x1 + 1) / width,
        y1: 1 - y0 / height
      },
      coverage: n / (width * height),
      pixels: n
    };
  }

  /** 问用户要抹掉什么。返回 null 表示取消 */
  function askIntent() {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'st-ask';
      wrap.innerHTML = ''
        + '<div class="st-ask-box">'
        + '  <h3>要抹掉什么？</h3>'
        + '  <p class="dim">说具体一点，AI 抹得越准</p>'
        + '  <input id="stAskInput" type="text" placeholder="例如：背景里的路人 / 电线杆 / 水印" maxlength="60">'
        + '  <div class="st-ask-btns">'
        + '    <button class="st-btn" data-act="cancel">取消</button>'
        + '    <button class="st-btn primary" data-act="ok">开始抹掉</button>'
        + '  </div>'
        + '</div>';
      document.body.appendChild(wrap);

      const input = wrap.querySelector('#stAskInput');
      const done = v => { wrap.remove(); resolve(v); };

      wrap.querySelector('[data-act="cancel"]').onclick = () => done(null);
      wrap.querySelector('[data-act="ok"]').onclick = () => done(input.value.trim() || '多余的物体');
      wrap.addEventListener('click', e => { if (e.target === wrap) done(null); });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') done(input.value.trim() || '多余的物体');
        if (e.key === 'Escape') done(null);
        e.stopPropagation();     // 别让全局快捷键把输入吃掉
      });
      setTimeout(() => input.focus(), 50);
    });
  }

  function hasInpaint() {
    return !!(window.AlbumStudio && window.AlbumStudio.volcInpaint);
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
    const scope = (useMask && !mask.isEmpty) ? '局部' : '';
    $('stInfo').textContent =
      `${img.width}×${img.height} · ${(img.width * img.height / 1e6).toFixed(1)}MP`
      + (changed ? ` · ${scope}已调整 ${changed} 项` : ' · 未调整');
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

      // 画笔相关。⌘Z 在有笔画时优先撤销笔画，没笔画才轮到「重置调整」——
      // 这个优先级是修图软件的通用约定，用户按 ⌘Z 想撤的多半是刚画的那一笔
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        if (mask.strokes.length) {
          e.preventDefault();
          if (mask.undo()) { syncMaskUI(); draw(); }
          return;
        }
      }
      if (e.key.toLowerCase() === 'b' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setBrushMode(!brushMode);
        showMaskTool(brushMode);
      }
      if (e.key.toLowerCase() === 'e' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        mask.mode = mask.mode === 'erase' ? 'add' : 'erase';
        syncMaskUI();
        toast(mask.mode === 'erase' ? '画笔：擦除' : '画笔：涂抹', 1600);
      }
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        const d = e.key === '[' ? -0.005 : 0.005;
        mask.radius = Math.min(0.25, Math.max(0.01, mask.radius + d));
        const r = $('stRadius');
        if (r) r.value = mask.radius;
      }
      // 空格按住看选区
      if (e.key === 'm' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const c = $('stShowMask');
        if (c) { c.checked = !c.checked; showMask = c.checked; draw(); }
      }
    });

    // 面板收起（窄屏）
    $('stPanelToggle').addEventListener('click', () => {
      const p = $('stPanel');
      p.classList.toggle('collapsed');
      $('stPanelToggle').textContent = p.classList.contains('collapsed') ? '▾' : '▸';
      setTimeout(render, 60);
    });

    initMaskEvents();
    initBrush();

    // 网页版禁用 AI 抠人并说明原因，而不是让用户点了没反应
    if (!hasDesktop()) {
      const seg = $('stSeg');
      if (seg) seg.title = '需要在桌面版「修图 App」里使用（浏览器有跨域限制）';
    }

    let rt = null;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(render, 120);
    });
  }

  function initMaskEvents() {
    // 画笔开关
    $('stBrush').addEventListener('click', () => {
      const on = !brushMode;
      setBrushMode(on);
      showMaskTool(on);
      if (on) toast('拖动鼠标涂抹要调整的区域', 2600);
    });

    // 涂 / 擦
    $('stBrushAdd').addEventListener('click', () => { mask.mode = 'add'; syncMaskUI(); });
    $('stBrushErase').addEventListener('click', () => { mask.mode = 'erase'; syncMaskUI(); });

    // 笔刷大小 / 硬度
    $('stRadius').addEventListener('input', e => {
      mask.radius = parseFloat(e.target.value);
    });
    $('stHardness').addEventListener('input', e => {
      mask.hardness = parseFloat(e.target.value);
    });

    // 显示选区
    $('stShowMask').addEventListener('change', e => {
      showMask = e.target.checked;
      draw();
    });

    // 局部调整总开关
    $('stUseMask').addEventListener('change', e => {
      useMask = e.target.checked;
      draw();
      toast(useMask ? '调整只作用于涂过的区域' : '调整作用于全图', 2000);
    });

    $('stMaskUndo').addEventListener('click', () => {
      if (mask.undo()) { syncMaskUI(); draw(); }
    });

    $('stMaskClear').addEventListener('click', () => {
      if (!mask.clear()) return;
      setMaskActive(false);
      syncMaskUI();
      draw();
      toast('已清空选区');
    });

    $('stMaskInvert').addEventListener('click', () => {
      mask.invert();
      setMaskActive(true);
      syncMaskUI();
      draw();
      toast('已反选');
    });

    $('stSeg').addEventListener('click', segmentPerson);
    $('stInpaint').addEventListener('click', removeObject);

    // 美颜结果的去留
    const ok = $('stPreviewOk'), no = $('stPreviewCancel');
    if (ok) ok.addEventListener('click', keepBeauty);
    if (no) no.addEventListener('click', undoBeauty);
  }

  /* ================================================================
     启动
     ================================================================ */
  (function boot() {
    try {
      // 蒙版内容一变就刷新按钮状态。
      // 这样「涂了一笔 → 撤销按钮变可点」不用在每个调用点手写，
      // 漏掉一处就会出现「按钮灰着但明明能撤销」这种别扭状态。
      mask.onchange = () => { syncMaskUI(); };
      initGL();
      buildSliders();
      initEvents();
      updateInfo();
      // 美颜面板要等主进程回参数表，不能拖住启动 ——
      // 失败也只是那一块显示"用不了"，不影响其他功能
      initBeauty();
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
    _draw: draw,

    // —— 蒙版 ——
    // 测试要能像用户一样涂一笔。直接给归一化坐标，内部走
    // begin/extend/end 这条和鼠标完全相同的路径，
    // 这样测出来的行为才等于用户看到的行为。
    mask,
    get useMask() { return useMask; },
    setUseMask: setMaskActive,
    setShowMask(on) { showMask = on; const c = $('stShowMask'); if (c) c.checked = on; draw(); },
    setBrushMode,
    /** 涂一笔：points 是 [[x,y],...] 归一化坐标 */
    paint(points, opts = {}) {
      if (!mask.canvas) return false;
      const save = { r: mask.radius, h: mask.hardness, m: mask.mode };
      if (opts.radius != null) mask.radius = opts.radius;
      if (opts.hardness != null) mask.hardness = opts.hardness;
      if (opts.mode) mask.mode = opts.mode;

      mask.begin(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) mask.extend(points[i][0], points[i][1]);
      mask.end();

      mask.radius = save.r; mask.hardness = save.h; mask.mode = save.m;
      setMaskActive(true);
      showMaskTool(true);
      syncMaskUI();
      draw();
      return true;
    },
    maskCoverage() { return mask.coverage(); },
    /**
     * 用一个矩形区域当选区（测局部调整时比涂一笔更可控）。
     *
     * ⚠️ 必须画成「之」字形的来回扫，不能只沿矩形轮廓走一圈 ——
     * 描边是路径不是填充，只描边的话中间是空的。
     * （第一版就是这么写的：测试里量到中心像素是 0，
     *   一度以为是纹理上传坏了，查了半天才发现是测试自己的问题。）
     */
    paintRect(x0, y0, x1, y1) {
      const lines = 14;
      const pts = [];
      for (let i = 0; i <= lines; i++) {
        const y = y0 + (y1 - y0) * i / lines;
        // 一行从左到右，下一行从右到左，省掉回程的空走
        if (i % 2 === 0) { pts.push([x0, y], [x1, y]); }
        else { pts.push([x1, y], [x0, y]); }
      }
      return this.paint(pts, { radius: 0.045, hardness: 0.9 });
    },
    segmentPerson,
    hasDesktop,
    // —— 去物 ——
    hasInpaint,
    removeObject,
    // —— 美颜 ——
    hasBeauty,
    runBeauty,
    keepBeauty,
    undoBeauty,
    /** 这次会发出去的参数（只含 > 0 的项 + 滤镜），测试要断言这个 */
    beautyParams,
    get beautyValues() { return { ...beautyValues }; },
    setBeautyValue: onBeautySlider,
    get beautyFilter() { return beautyFilter; },
    setBeautyFilter(v) { beautyFilter = v; const s = $('stBeautyFilter'); if (s) s.value = v; },
    applyBeautyPreset,
    get beautySchema() { return beautySchema; },
    get _beautyBackup() { return beautyBackup; },
    _swapImage: swapImage,
    getKeys,
    invalidateKeys,
    maskStats,
    uploadForAI,
    imageBlob,
    _syncMaskUI: syncMaskUI,
    /** 给测试读像素用（导出和预览共用同一块画布） */
    _canvas() { return canvas; },
    _mask() { return mask; },
    /**
     * 临时缩放**渲染尺寸**（模拟拖窗口），在缩放状态下调用 measure()，
     * 然后自动还原。给测试验「锐化步长不随画布变化」用。
     *
     * 为什么把「测量」当回调传进来：第一版是直接返回缩放后的画布宽度，
     * 但它在返回之前就把样式还原了 —— 调用方拿到宽度后再去 readPixels，
     * 读到的已经是还原后那一帧。必须"在缩放状态下测完再还"。
     *
     * ⚠️ 也不要在外面直接改 canvas.width：那样 viewport 会留在旧尺寸上、
     * CSS 尺寸和后备缓冲不一致，readPixels 拿到的是垃圾。
     */
    _atScale(scale, measure) {
      if (!img) return measure();
      const stage = $('stStage');
      const prevW = stage.style.width;
      const prevFlex = stage.style.flex;
      const prevMax = stage.style.maxWidth;
      const base = stage.clientWidth || document.documentElement.clientWidth || 1000;

      // ⚠️ 只写 style.width 是**没用的**：#stStage 在 .st-main 这个 flex 容器里，
      // flex 布局会忽略 inline width，clientWidth 仍是旧值。
      // （测试里踩过：改完画布宽度一点没变，断言直接报"没测到东西"。）
      // 必须同时把 flex 收掉，再给 min/max-width 钉死。
      const target = Math.max(80, Math.round(base * scale));
      stage.style.flex = 'none';
      stage.style.width = target + 'px';
      stage.style.maxWidth = target + 'px';
      void stage.offsetWidth;          // 强制同步布局，别让 clientWidth 还是旧值
      render();
      try {
        return measure();
      } finally {
        stage.style.width = prevW;
        stage.style.flex = prevFlex;
        stage.style.maxWidth = prevMax;
        void stage.offsetWidth;
        render();
      }
    }
  };
})();
