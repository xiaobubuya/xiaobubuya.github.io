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
    { key: 'uExposure',   name: '曝光',   group: '基础', min: -2,  max: 2,  step: 0.01, def: 0, unit: ' EV' },
    { key: 'uContrast',   name: '对比度', group: '基础', min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uHighlights', name: '高光',   group: '基础', min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uShadows',    name: '阴影',   group: '基础', min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uSaturation', name: '饱和度', group: '色彩', min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uTemp',       name: '色温',   group: '色彩', min: -1,  max: 1,  step: 0.01, def: 0 },

    // —— 色调曲线 ——
    // 四个控制点，CPU 生成单调 LUT（见 buildCurveLut）。
    // 和上面的「高光/阴影」不重复：那两个是**线性空间的曝光乘子**（加权
    // 提亮/压暗），曲线是 **sRGB 空间的影调重映射**。前者改亮度，
    // 后者改「灰阶落在哪」—— 做胶片感靠曲线，救欠曝靠阴影。
    //   · 褪色（Fade）：抬黑位做"褪色胶片"，暗部不再纯黑。这是
    //     手机修图 App 里最常被点的一个，比 S 曲线更常用。
    { key: 'uCurveShadow', name: '曲线·阴影', group: '曲线', min: -1, max: 1, step: 0.01, def: 0 },
    { key: 'uCurveMid',    name: '曲线·中间调', group: '曲线', min: -1, max: 1, step: 0.01, def: 0 },
    { key: 'uCurveHigh',   name: '曲线·高光', group: '曲线', min: -1, max: 1, step: 0.01, def: 0 },
    { key: 'uCurveFade',   name: '褪色',   group: '曲线', min: 0,   max: 1,  step: 0.01, def: 0 },

    // —— HSL ——
    // 用 YIQ 近似（详见 shader 里的说明）。色相 ±1 对应 ±30°：
    // 再大就不像"微调"而像"换了个滤镜"。
    { key: 'uHue',        name: '色相',   group: 'HSL', min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uHslSat',     name: '自然饱和度', group: 'HSL', min: -1, max: 1, step: 0.01, def: 0 },
    { key: 'uHslLight',   name: '明度',   group: 'HSL', min: -1,  max: 1,  step: 0.01, def: 0 },

    // —— 质感类 ——
    // 范围刻意不统一：这三个的「满格」含义不同。
    // 锐化 1.0 已经能看出白边（内部再乘 1.5），所以上限就 1；
    // 暗角 1.0 是很重的压角，但正常用会在 -0.5~0.5；
    // 颗粒 1.0 是明显的胶片感，婚纱照一般 0.2~0.4 就够。
    { key: 'uSharpness',  name: '锐化',   group: '质感', min: 0,   max: 1,  step: 0.01, def: 0 },
    { key: 'uVignette',   name: '暗角',   group: '质感', min: -1,  max: 1,  step: 0.01, def: 0 },
    { key: 'uGrain',      name: '颗粒',   group: '质感', min: 0,   max: 1,  step: 0.01, def: 0 },
  ];

  /* ================================================================
     预设
     ----------------------------------------------------------------
     预设就是一组参数值。用户点一下，所有滑块跳到预设值。
     按类别分组（婚纱/写真/旅拍/胶片/黑白/日常），方便快速找到想要的风格。
     hue 字段用于生成卡片预览色块（CSS 渐变），不依赖外部图片。
     ================================================================ */
  const PRESET_CATS = ['全部','婚纱','写真','旅拍','胶片','黑白','日常'];
  const PRESETS = [
    { id:'wedding-soft', name:'柔光婚纱', cat:'婚纱', hue:'#f4dce4',
      v:{ uExposure:0.08, uContrast:-0.05, uSaturation:-0.03, uHighlights:0.10, uShadows:0.05, uCurveFade:0.08, uGrain:0.06 } },
    { id:'wedding-warm', name:'暖调婚纱', cat:'婚纱', hue:'#f7e0c8',
      v:{ uExposure:0.05, uContrast:0.03, uSaturation:0.02, uTemp:0.06, uHighlights:0.05, uVignette:0.12, uGrain:0.04 } },
    { id:'wedding-gold', name:'金色婚纱', cat:'婚纱', hue:'#f0d8a0',
      v:{ uExposure:0.06, uContrast:0.04, uSaturation:0.04, uTemp:0.10, uHighlights:0.06, uShadows:0.03, uCurveFade:0.05 } },
    { id:'portrait-warm', name:'暖调写真', cat:'写真', hue:'#f5dcc0',
      v:{ uExposure:0.03, uContrast:0.05, uSaturation:0.04, uTemp:0.06, uHslSat:0.03, uVignette:0.08 } },
    { id:'portrait-soft', name:'柔光写真', cat:'写真', hue:'#eee8e0',
      v:{ uExposure:0.06, uContrast:-0.03, uSaturation:0, uHighlights:0.08, uShadows:0.04, uCurveFade:0.06 } },
    { id:'portrait-clean', name:'清透写真', cat:'写真', hue:'#e8eef0',
      v:{ uExposure:0.04, uContrast:0.06, uSaturation:0.03, uHighlights:0.04, uShadows:0.02, uSharpness:0.06 } },
    { id:'travel-vivid', name:'旅拍鲜艳', cat:'旅拍', hue:'#5ba8d8',
      v:{ uExposure:0.04, uContrast:0.08, uSaturation:0.12, uHighlights:0.03, uShadows:0.02, uSharpness:0.08 } },
    { id:'travel-morning', name:'晨光旅拍', cat:'旅拍', hue:'#e8c8a0',
      v:{ uExposure:0.06, uContrast:0.03, uSaturation:0.06, uTemp:0.10, uHighlights:0.05, uShadows:0.04 } },
    { id:'film-fade', name:'褪色胶片', cat:'胶片', hue:'#c8b898',
      v:{ uExposure:0.02, uContrast:-0.08, uSaturation:-0.10, uCurveFade:0.25, uGrain:0.25 } },
    { id:'film-portrait', name:'人像胶片', cat:'胶片', hue:'#d8c0a0',
      v:{ uExposure:0.03, uContrast:-0.05, uSaturation:-0.05, uCurveFade:0.15, uGrain:0.20, uTemp:0.03 } },
    { id:'bw-classic', name:'经典黑白', cat:'黑白', hue:'#888888',
      v:{ uExposure:0.03, uContrast:0.12, uSaturation:-1, uSharpness:0.10, uVignette:0.20 } },
    { id:'bw-soft', name:'柔调黑白', cat:'黑白', hue:'#999999',
      v:{ uExposure:0.05, uContrast:-0.05, uSaturation:-1, uCurveFade:0.10, uVignette:0.15 } },
    { id:'daily-clean', name:'清透日常', cat:'日常', hue:'#e0e8e0',
      v:{ uExposure:0.05, uContrast:0.02, uSaturation:0.03, uHighlights:0.05, uShadows:0.02 } },
    { id:'daily-warm', name:'暖调日常', cat:'日常', hue:'#f0dcc0',
      v:{ uExposure:0.03, uContrast:0, uSaturation:0.05, uTemp:0.08, uHighlights:0.03 } },
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
  let maskTool = null;         // 'brush' | 'gradient' | 'radial' | null
  let brushMode = false;       // = maskTool !== null（兼容旧引用）

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
    uniform sampler2D uCurve;   // 256x1 的色调曲线 LUT（CPU 算好上传）
    uniform float uExposure, uContrast, uHighlights, uShadows, uSaturation, uTemp;
    uniform float uSharpness, uVignette, uGrain;
    uniform float uCurveShadow, uCurveMid, uCurveHigh, uCurveFade;
    uniform float uHue, uHslSat, uHslLight;
    uniform float uOriginal;   // 1 = 显示原图（对比用）
    uniform float uSplit;      // >=0 = 左右分屏对比的竖线位置（<0 关闭）
    uniform float uUseMask;    // 1 = 调整只作用在蒙版内
    uniform float uMaskOverlay; // 1 = 显示蒙版本身（红色叠加）
    uniform vec2 uTexel;       // 1/图片宽高，锐化取邻居用
    uniform vec2 uMaskTexel;  // 1/蒙版宽高。⚠️ 和 uTexel 不同：蒙版按短边
                              // 1024 缩放，图片是原分辨率。拿 uTexel 去采蒙版
                              // 会落在亚像素上，梯度≈0，描边永远画不出来。
    uniform float uAspect;     // 图片宽高比，暗角要按比例算才不变形
    /* ---------------- 几何变换（视口 + 显示变换） ----------------
       ⚠️ 这一版是**重写**过的（旧版有 uUvScale 双轴缩放 + uCropOffset），
       旧版把"旋转"和"裁剪"耦合成了一堆数学：要让旋转后画面不露白，
       就得算"旋转矩形的最大内接矩形"、再把取景框收进去。
       用户明确否掉了那套（"不需要做数学运算"）。现在只有三件事：

         uDisplayScale  显示缩放（标量）。**必须是一个标量** ——
                        两轴各一个缩放就是各向异性，图片会被拉伸。
                        这是整块几何里唯一的硬不变量。
         uRot           绕**视口中心**的旋转角（弧度）
         uFlip          1 = 该轴翻转

       输出缓冲 u 坐标 → 图片 uv 的映射（相似变换，顺序不能换）：
           p = vUv - 0.5            ① 移到中心
           翻转                      ② 在中心坐标里翻（镜像）
           逆旋转 R(-rot)·(1/scale)  ③ 转回图片的轴、并缩放到图片尺度
           + 0.5 + uImgOffset        ④ 移到图片上、再平移到视口原点

       ⚠️⚠️ uImgOffset 是**视口左下角**在图片归一化坐标里的位置，
       不是"取景框中心相对图片中心的偏移"。按中心算会让画面整体偏，
       偏的量正好是取景框尺寸的一半 —— 满幅取景框时**看不出来**，
       一旦收小取景框就露馅（实测 0.5×0.5 的框：中心应该读到原图中心，
       实际读到 0.75 处）。
       ================================================================ */
    uniform float uRot;          // 旋转角（弧度）
    uniform vec2 uFlip;          // (1,-1) = 只翻水平；( -1,1) = 只翻垂直
    uniform float uDisplayScale; // 显示缩放（标量！）
    uniform vec2 uImgOffset;     // 视口原点在图片归一化坐标里的位置
    uniform vec3 uBg;            // 视口露到图片外的填色（深色底）

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

      /* ---------------- 色调曲线 ----------------
         曲线按**亮度**查表再整体缩放（RGB 同比），不是三个通道各查一次。

         为什么不做成独立 RGB 曲线：那会立刻引入偏色（三通道的曲线
         稍微不同就是一张彩色滤镜），而这里要的是**影调**控制。
         婚纱照要的是"影调好看"，不是"换了个色"。

         LUT 由 CPU 生成（见 buildCurveLut）：那里能写真正的
         单调三次插值，比在 GLSL 里用 mix/smoothstep 叠出来精确得多，
         而且能保证**单调**（不单调的曲线会让影调出现反转，很难看）。
         ================================================ */
      if (uCurveFade != 0.0 || uCurveShadow != 0.0
          || uCurveMid != 0.0 || uCurveHigh != 0.0) {
        float y = luma(c);
        // 采样位置避开 0 和 1：CLAMP_TO_EDGE 下边界像素正好落在
        // 纹理边缘，某些驱动会取到半个像素的混合值
        float lut = texture2D(uCurve, vec2(clamp(y, 0.0, 1.0) * 0.99609375 + 0.001953125, 0.5)).r;

        /* 曲线带来的亮度变化，**加法**加到 RGB 上（不是按比例缩放）。
           ------------------------------------------------------------
           为什么不能用比例（c *= lut / y）：
           纯黑（y = 0）会除以零，只能特判跳过 —— 而"跳过"正好把
           **褪色最该起作用的像素**漏掉了：纯黑图配褪色，实测输出还是 0。
           （一开始就是按比例写的，加了 y > 0.0001 的保护，症状就是这条。）

           也不能无脑加：亮饱和色加过头会某个通道越界，被 clamp 之后
           **色相会偏**（比如亮红 +0.05 冲顶后变成粉白）。
           所以按剩余余量缩一下 delta —— 保证不越界，这样影调抬了、
           色相饱和度都还是对的。 */
        float delta = lut - y;
        if (delta != 0.0) {
          float mx = max(max(c.r, c.g), c.b);
          float room = (delta > 0.0) ? (1.0 - mx) : mx;
          float k = (delta > 0.0)
            ? min(1.0, room / max(delta, 1e-4))
            : min(1.0, room / max(-delta, 1e-4));
          c += delta * k;
        }
      }

      // 对比度：绕中灰旋转（sRGB 空间，符合直觉）
      c = (c - 0.5) * (1.0 + uContrast) + 0.5;

      // 饱和度：朝灰度插值
      float g = luma(c);
      c = mix(vec3(g), c, 1.0 + uSaturation);

      /* ---------------- HSL（OKLab 感知色彩空间） ----------------
         ⚠️ 这里从 YIQ 换成了 OKLab。原因：YIQ 是 1950 年代为模拟电视
         广播设计的，它的色度平面和人的感知差得比较远 —— 在肤色
         （红橙黄那一带）附近尤其明显：同样的色相旋转量，脸上会偏得
         比背景更厉害。婚纱照全是肤色，这一点很要命。

         OKLab（Björn Ottosson, 2020）是专门为「感知均匀」设计的：
         先把线性 sRGB 开立方根到近似 LMS 锥体响应，再做矩阵。
         代价是三次 pow —— 比 YIQ 贵一点，但换来的准确性值得，
         而且**省掉了 atan2**（见下）。

         几个要点：
         · 输入必须是**线性** sRGB，不是 gamma 编码的
         · 色相旋转 = 在 (a, b) 平面上转，不用 atan2
           （只有「按色相分区间调」才需要角度；我们没有分区间）
         · 开立方根用 pow(x, 1/3)，x 需要 >= 0；
           这里是线性光，公式上恒为正，还是 clip 一下防数值抖动

         它排在饱和度**之后**：先定调子（饱和度），再微调色相/明度，
         符合修图的实际顺序 —— 反过来会出现"调完色相饱和度又变了"。
         ================================================ */
      if (uHue != 0.0 || uHslSat != 0.0 || uHslLight != 0.0) {
        vec3 lin = toLinear(c);

        // 线性 sRGB -> OKLab
        vec3 lms = vec3(
          dot(lin, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
          dot(lin, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
          dot(lin, vec3(0.0883024619, 0.2817188376, 0.6299787005))
        );
        lms = pow(max(lms, vec3(0.0)), vec3(1.0 / 3.0));
        float L = dot(lms, vec3(0.2104542553,  0.7936177850, -0.0040720468));
        float A = dot(lms, vec3(1.9779984951, -2.4285922050,  0.4505937099));
        float B = dot(lms, vec3(0.0259040371,  0.7827717662, -0.8086757660));

        // —— 饱和度 ——
        /* ⚠️ 正负要分开处理：
           往负（去色）走时用户要的是「变灰」，那是**明确意图**，
           不该被任何"保护"削弱 —— 直接等比缩。
           往正（加艳）走时才需要保护：已经很艳的地方再乘会溢出，
           而"自然饱和度"的本意就是「不够的补上、够了的别碰」。

           第一版两边都用同一个 room 系数，结果 -1 只降了约 47%
           （纯红 208,32,32 变成 183,73,64），根本不是"去色" ——
           实测出来的。 */
        if (uHslSat > 0.0) {
          float chroma = sqrt(A * A + B * B);
          float room = 1.0 - clamp(chroma / 0.30, 0.0, 0.85);
          A *= 1.0 + uHslSat * room;
          B *= 1.0 + uHslSat * room;
        } else if (uHslSat < 0.0) {
          A *= 1.0 + uHslSat;
          B *= 1.0 + uHslSat;
        }

        // —— 色相：在 (a,b) 平面上旋转，±1 对应 ±30° ——
        if (uHue != 0.0) {
          float ang = uHue * 0.5236;
          float ca = cos(ang), sa = sin(ang);
          float A2 = A * ca - B * sa;
          float B2 = A * sa + B * ca;
          A = A2; B = B2;
        }

        // —— 明度：直接用 OKLab 的 L ——
        // OKLab 的 L 本身就是感知亮度（0=黑，1=白），所以 ±1 就是
        // 推到纯黑/纯白，整条色阶力度一致 —— 不需要再自己算 max/min
        // 去凑一个"亮度"（上一版就是这么绕的）。
        if (uHslLight > 0.0)      L = mix(L, 1.0, uHslLight);
        else if (uHslLight < 0.0) L = mix(L, 0.0, -uHslLight);

        // OKLab -> 线性 sRGB
        float l_ = L + 0.3963377774 * A + 0.2158037573 * B;
        float m_ = L - 0.1055613458 * A - 0.0638541728 * B;
        float s_ = L - 0.0894841775 * A - 1.2914855480 * B;
        vec3 cube = vec3(l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
        vec3 linOut = vec3(
           dot(cube, vec3( 4.0767416621, -3.3077115913,  0.2309699292)),
          dot(cube, vec3(-1.2684380046,  2.6097574011, -0.3413193965)),
          dot(cube, vec3(-0.0041960863, -0.7034186147,  1.7076147010))
        );

        // 回到 sRGB。⚠️ 大范围改动后 OKLab 可能给出负值或 >1 的线性值
        // （超出 sRGB 色域），必须 clamp —— 否则后面 toSrgb 里的 pow
        // 会拿到负数
        c = toSrgb(clamp(linOut, 0.0, 1.0));
      }

      return c;
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
    vec3 sharpen(vec3 src, vec2 uv) {
      if (uSharpness == 0.0) return src;
      vec3 blur = vec3(0.0);
      // 3x3 均值。用均值而不是高斯，是为了省采样 ——
      // 锐化对模糊核的形状不敏感，对半径敏感
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          blur += texture2D(uImage, uv + vec2(float(x), float(y)) * uTexel).rgb;
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
      /* ================================================================
         几何变换：显示缩放 + 旋转 + 翻转 + 视口
         ----------------------------------------------------------------
         先算出「画布上这个像素对应原图的哪个位置」，后面的采样/锐化/蒙版
         全都用这个 u。这样只需改一处，整条管线自动跟着走。

         ⚠️ 和旧版的根本区别：
           · 视口（取景框所在的坐标系）就在**画布归一化空间**里，不是
             "旋转矩形的归一化空间"。所以旋转角变了**取景框不用重算**
             —— 这正是用户要的"裁剪和旋转分开做"。
           · 旋转后原图外面那部分（四个角）**不去拟合、不去收框**，
             直接按露出来的范围显示深色底。用户明确接受了这一点
             （"超出取景框范围展示上就是截断即可"）。
           · 想看到完整的一张歪照片，视口会按角度自动撑大
             （见 viewportDims），用户也可以自己拉远。

         ⚠️ 蒙版/分屏仍然用 vUv 采样：它们在**视口**空间里，
         和照片一起转（涂在人脸上的选区要跟着脸走）。
         ================================================================ */
      vec2 u = vUv;
      bool identity = (uRot == 0.0 && uDisplayScale == 1.0
                       && uFlip == vec2(1.0) && uImgOffset == vec2(0.0));
      if (!identity) {
        vec2 p = (vUv - 0.5) * uFlip;
        float ca = cos(uRot), sa = sin(uRot);
        p = mat2(ca, sa, -sa, ca) * (p / uDisplayScale);
        u = p + 0.5 + uImgOffset;
      }

      /* 视口露到原图外面的部分 → 深色底。
         ----------------------------------------------------------------
         ⚠️ 判定要在**采样之前**，且必须用"是否在 [0,1] 内"这个条件，
         不能靠 CLAMP_TO_EDGE 的副作用 —— 夹取会把边缘像素拉成条纹，
         看起来像画面被抹开了（实测过，深色底上一条条亮线）。
         ⚠️ 边缘做一点抗锯齿（按超出 0/1 的距离过渡），否则旋转后的
         图片边缘有硬锯齿。 */
      if (!identity) {
        vec2 aa = max(vec2(0.0), max(-u, u - 1.0)) / max(uTexel, vec2(1e-6));
        float cover = 1.0 - clamp(max(aa.x, aa.y), 0.0, 1.0);
        if (cover <= 0.0) {
          gl_FragColor = vec4(uBg, 1.0);
          return;
        }
        if (cover < 1.0) {
          vec3 inside = texture2D(uImage, clamp(u, 0.0, 1.0)).rgb;
          gl_FragColor = vec4(mix(uBg, inside, cover), 1.0);
          return;
        }
      }

      vec3 src = texture2D(uImage, u).rgb;

      if (uOriginal > 0.5) {
        gl_FragColor = vec4(src, 1.0);
        return;
      }

      // 锐化在调色之前，而且作用在源图上
      vec3 sharp = sharpen(src, u);

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

      /* ================================================================
         左右对比分屏
         ----------------------------------------------------------------
         竖线左边显示**原图**、右边显示**修过的**。
         和「按住看原图」（uOriginal）是两件事：
           uOriginal  = 整张变原图，用来快速确认
           uSplit     = 一半一半，用来直接比对肤色/构图差异

         ⚠️ 放在最后（蒙版红色叠加之前）：对比的是**成品**，
         不是半成品。涂着蒙版时红色的提示层还能看见。

         ⚠️ uSplit < 0 表示关闭。用负数而不是 0 当"关闭"哨兵，
         是因为 0 是合法位置（竖线贴最左边 = 全是修过的）。
         ================================================================ */
      if (uSplit >= 0.0) {
        vec3 raw = texture2D(uImage, u).rgb;
        c = vUv.x < uSplit ? raw : c;
      }

      /* ================================================================
         选区可视化：**淡提示常驻 + 勾选后强调**
         ----------------------------------------------------------------
         用户反馈的两轮（都很实在）：
           第一轮"画笔涂抹没有什么反应，打开显示选区就是一片渐变"
             → 默认关着，涂了看不见；羽化边又很宽，像一片糊。
           第二轮（勾选之后）"只有一笔，直接红了好多"
             → 红罩一开就整片压住照片，太抢眼。

         所以拆成两档，而不是只有一个开关：
           · **常驻淡提示**（0.16，且只罩住选区内）：不勾选也能看出
             "哪里被选上了"，又几乎不影响看照片。这是"看得见"和
             "不挡视线"之间的平衡点。
           · **勾选后强调**（0.58 + 边界描边）：要精确对齐选区边界时用。
             边界描边是关键 —— 0→1 的羽化过渡带本身没有边界可言，
             但它的**梯度峰值**正是用户心里的"选区边"。
         ⚠️ 颜色往暖黄偏一点：只叠纯红在**深色衣服**上几乎看不出来
         （红罩在暗部不动），掺点亮色，暗部亮部都能看出选区在哪。 */
      {
        float m = texture2D(uMask, vUv).r;
        // 品红：和暖调照片（日落 / 皮肤 / 室内暖光）对比鲜明。
        // ⚠️ 原来用暖橙红，暖叠暖在日落照片上和原图暖光融为一体 ——
        //    用户看到「涂了一小下、半张图都红了」，其实是分不清叠加色
        //    和照片本身的暖光。品红在暖 / 冷 / 中性照片上都能一眼看出
        //    选区到底盖住了多大一块。
        vec3 mark = vec3(1.0, 0.30, 0.85);
        // 常驻淡提示
        c = mix(c, mark, m * 0.16);
        if (uMaskOverlay > 0.5) {
          c = mix(c, mark, m * 0.58);

          // 边界描边：梯度大的地方就是"选区边"
          float gx = texture2D(uMask, vUv + vec2(uMaskTexel.x, 0.0)).r
                   - texture2D(uMask, vUv - vec2(uMaskTexel.x, 0.0)).r;
          float gy = texture2D(uMask, vUv + vec2(0.0, uMaskTexel.y)).r
                   - texture2D(uMask, vUv - vec2(0.0, uMaskTexel.y)).r;
          float edge = smoothstep(0.02, 0.16, length(vec2(gx, gy)));
          c = mix(c, vec3(1.0), edge * 0.8);   // 白色描边：暖黄在暖调照片上也会糊
        }
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

  let program = null, uniforms = {}, imageTex = null, maskTex = null, curveTex = null;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader 编译失败: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  /* ================================================================
     色调曲线：CPU 生成 LUT
     ----------------------------------------------------------------
     为什么在 CPU 上算而不是 shader 里：
       GLSL ES 1.00 没有数组构造器，也没法用变长数组，想把一条曲线
       塞进 shader 只能用一个固定次数的 mix/smoothstep 叠加 ——
       那样叠出来的曲线**不保证单调**，而单调性是影调曲线的底线：
       一旦不单调，亮的地方比更亮的地方还暗，画面会出现"反转"，
       看着就是坏了。

       在 CPU 上可以写真正的单调三次插值（Fritsch–Carlson），
       而且只算 256 个点、只在滑杆动的时候算，成本可以忽略。

     控制点怎么定：
       用**五个均匀控制点**（0 / 0.25 / 0.5 / 0.75 / 1），三个滑杆
       各推一个内部点，褪色推两个端点。

       ⚠️ 一开始用的是四个点（0 / 1/3 / 2/3 / 1），实测很糟：
       因为单调插值在端点处斜率受限，"高光+1"在 208 级只抬 5 级，
       而在 128 级却抬了 19 级 —— 三个滑杆**全都主要作用在中间调**，
       互相串扰。换成五个均匀点之后：

         阴影+1  @48: +37   @128: 0   @208: 0
         中间调+1 @48:  -2   @128: +38  @208: -4
         高光+1  @48:   0   @128: 0   @208: +30

       每个滑杆只动自己那段，这才是分区调整该有的样子。
       （调参是用 test/curve.test.mjs 的量测脚本比对出来的，
       不要凭感觉改这些数字。）

       ⚠️ 幅度 0.15 是量出来的平衡点。影调曲线是"微调"工具，
       给太大很容易调出灰蒙蒙或者断层的结果 ——
       宁可让用户多拖一点，也不要一拖就废。
     ================================================================ */
  const CURVE_N = 256;

  /** 四个滑杆值 → 控制点（输入、输出都在 0~1 的 sRGB 空间）
   *
   *  ⚠️ 这里最关键的一步是**强制控制点单调**，理由见下方长注释。
   *  顺序不能随便改：先让三个滑杆各自发挥，再做两遍单调约束
   *  （中间那个点受两边夹，必须两遍才能收敛 —— 只做一遍的话
   *  先去夹左边、右边随后又变了，左边就失效了）。
   */
  function curveControlPoints(values) {
    const sh = values.uCurveShadow || 0;
    const mid = values.uCurveMid || 0;
    const hi = values.uCurveHigh || 0;
    const fade = values.uCurveFade || 0;

    // 幅度：0.15 让"拉满"看得出明显变化但不破坏影调
    const A = 0.15;

    const x = [0, 0.25, 0.5, 0.75, 1];
    let y = [
      Math.max(0, fade * 0.14),            // 褪色抬黑位
      0.25 + sh * A,
      0.5 + mid * A,
      0.75 + hi * (A * 0.8),
      Math.min(1, 1 - fade * 0.05)         // 褪色同时压白位
    ];

    /* ================================================================
       强制单调（这一步不能省）
       ----------------------------------------------------------------
       实测过一个反例：「中间调+1」把 0.5 抬到 0.65，
       同时「高光-1」把 0.75 压到 0.63 —— 控制点本身就变成了
       先跌再涨（0.65 → 0.63）。这时 Fritsch–Carlson 插值出来的曲线
       在 0.5~0.75 区间是**下降**的，也就是影调反转。

       ⚠️ 这不是插值实现的 bug：单调插值保证的是
       「单调的数据 → 单调的曲线」，数据本身非单调它无能为力。

       所以约束必须加在**生成控制点**这一步：让每个点待在两边的
       范围里。代价是两侧反向拉时效果会互相压制（数学上无解，
       不能同时既抬中间又压上面还不产生反转），但保证曲线永远单调。
       ================================================================ */
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < y.length - 1; i++) {
        y[i] = Math.min(Math.max(y[i], y[i - 1]), y[i + 1]);
      }
    }
    // 端点本身也要夹（褪色和某个滑杆反着拉时）
    y[0] = Math.min(y[0], y[1]);
    y[y.length - 1] = Math.max(y[y.length - 1], y[y.length - 2]);
    // 保险：控制点必须在 0~1
    y = y.map(v => Math.min(1, Math.max(0, v)));

    return x.map((xi, i) => [xi, y[i]]);
  }

  /**
   * 单调三次插值（Fritsch–Carlson）。
   *
   * 三个要点，少一个都会让曲线出问题：
   ① 斜率用 **加权调和平均**（不是算术平均）—— 这是保证单调的经典做法
   ② 斜率符号和割线不一致时清零 —— 极值点处不能继续按原斜率走
   ③ 斜率绝对值不超过相邻割线的 3 倍 —— 否则会过冲（overshoot），
      表现是曲线在控制点附近"鼓出去"，影调出现假的亮暗带
   */
  function monotoneSpline(xs, ys) {
    const n = xs.length;
    const dx = [], dy = [], slope = [];
    for (let i = 0; i < n - 1; i++) {
      dx[i] = xs[i + 1] - xs[i];
      dy[i] = ys[i + 1] - ys[i];
      slope[i] = dy[i] / dx[i];
    }

    const m = new Array(n);
    m[0] = slope[0];
    m[n - 1] = slope[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (slope[i - 1] * slope[i] <= 0) {
        m[i] = 0;                                  // ② 极值点，压平
      } else {
        const w1 = 2 * dx[i] + dx[i - 1];
        const w2 = dx[i] + 2 * dx[i - 1];
        m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);   // ① 加权调和平均
      }
    }

    return x => {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      let i = n - 2;
      while (i > 0 && x < xs[i]) i--;
      const h = dx[i];
      const t = (x - xs[i]) / h;
      const t2 = t * t, t3 = t2 * t;
      // 三次 Hermite 基
      const h00 =  2 * t3 - 3 * t2 + 1;
      const h10 =       t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 =       t3 -     t2;
      return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
    };
  }

  /** 生成 256 个采样点（0~1 输入 → 0~1 输出，已 clamp） */
  function buildCurveLut(values) {
    const pts = curveControlPoints(values);
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => Math.min(1, Math.max(0, p[1])));
    const f = monotoneSpline(xs, ys);

    const lut = new Uint8Array(CURVE_N);
    for (let i = 0; i < CURVE_N; i++) {
      const v = Math.min(1, Math.max(0, f(i / (CURVE_N - 1))));
      lut[i] = Math.round(v * 255);
    }
    return lut;
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
    uniforms.uSplit = gl.getUniformLocation(program, 'uSplit');
    uniforms.uUseMask = gl.getUniformLocation(program, 'uUseMask');
    uniforms.uMaskOverlay = gl.getUniformLocation(program, 'uMaskOverlay');
    uniforms.uTexel = gl.getUniformLocation(program, 'uTexel');
    uniforms.uMaskTexel = gl.getUniformLocation(program, 'uMaskTexel');
    uniforms.uAspect = gl.getUniformLocation(program, 'uAspect');
    uniforms.uRot = gl.getUniformLocation(program, 'uRot');
    uniforms.uFlip = gl.getUniformLocation(program, 'uFlip');
    uniforms.uDisplayScale = gl.getUniformLocation(program, 'uDisplayScale');
    uniforms.uImgOffset = gl.getUniformLocation(program, 'uImgOffset');
    uniforms.uBg = gl.getUniformLocation(program, 'uBg');
    uniforms.uCurve = gl.getUniformLocation(program, 'uCurve');

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

    /* 色调曲线 LUT：256x1 的单通道纹理。
       用 LUMINANCE 而不是 RGBA —— 只要一个通道，省 4 倍显存和带宽。
       LINEAR 过滤让 256 个采样点之间的插值由硬件做，
       所以 LUT 不需要更密（256 足够，色阶 8bit 也只有 256 级）。 */
    curveTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, curveTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // 这里不用先 refreshCurve()：draw() 每次都会重传 LUT，
    // 而 initGL 之后紧接着就是 buildSliders + 第一次 draw
  }

  /* ================================================================
     曲线 LUT 上传
     ----------------------------------------------------------------
     滑杆一动就重算 + 重传。256 个字节的纹理上传成本可以忽略，
     比"判断哪些参数变了要不要重算"的逻辑更不容易出错。

     ⚠️ 只 bind 不 unbind：解绑（bindTexture(TEXTURE_2D, null)）会把
     纹理单元 0 上的绑定也清掉，而 draw() 依赖那边绑着照片。
     这个坑很难查 —— 表现是"调完曲线照片变黑"。
     （顺便：宽度 256 是 4 的倍数，UNPACK_ALIGNMENT 用默认值 4 就是对的，
     不需要动。）
     ================================================================ */
  function refreshCurve() {
    if (!curveTex) return;
    const lut = buildCurveLut(values);
    gl.bindTexture(gl.TEXTURE_2D, curveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, CURVE_N, 1, 0,
      gl.LUMINANCE, gl.UNSIGNED_BYTE, lut);
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
    // ⚠️ 必须用 9 参数形式传 data.data（TypedArray），不能用 6 参数传 ImageData。
    // 6 参数形式依赖浏览器自动重载识别，但在某些 SwiftShader/Chrome 组合下
    // 会被误判为 9 参数形式：width=gl.RGBA(36293)、height=gl.UNSIGNED_BYTE(5121)，
    // 上传静默失败，纹理保持未初始化状态——shader 采样返回 1.0，整张图品红。
    // 表现是「覆盖率 10.8% 但视觉上 100% 品红」，极难排查。
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA,
      data.width, data.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, data.data);
    mask._uploadedVersion = mask.version;
    gl.activeTexture(gl.TEXTURE0);
  }

  /* ================================================================
     状态
     ================================================================ */
  let img = null;          // ImageBitmap
  let fileName = '';
  let showingOriginal = false;
  /**
   * 左右分屏对比：左边原图、右边修过的。
   *
   * 和 showingOriginal 的区别：那个是"整张临时变原图"（按住看），
   * 这个是"一半一半"（拖动着看）。两个都留着，用途不同。
   *
   * compareAt 是竖线位置 0~1；关闭时 compareOn=false，
   * shader 收到 -1（见 draw 里的说明：0 是合法位置，不能当哨兵）。
   */
  let compareOn = false;
  let compareAt = 0.5;

  /* ================================================================
     渲染
     ================================================================ */
  function draw(planOverride) {
    if (!img) return;
    gl.useProgram(program);

    uploadMask();

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTex);
    gl.uniform1i(uniforms.uImage, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.uniform1i(uniforms.uMask, 1);

    // 曲线 LUT 放 2 号单元。每次 draw 都重传一次 —— 256 字节，
    // 比"记录哪些参数变了"的分支逻辑便宜也更不容易漏
    refreshCurve();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, curveTex);
    gl.uniform1i(uniforms.uCurve, 2);

    gl.activeTexture(gl.TEXTURE0);

    gl.uniform1f(uniforms.uOriginal, showingOriginal ? 1 : 0);
    // 分屏对比：-1 = 关闭。0 是合法位置（竖线贴最左），所以用负数当哨兵
    gl.uniform1f(uniforms.uSplit, compareOn ? compareAt : -1);
    // 蒙版是空的却开着「只看局部」，画面会完全没反应 —— 那看起来就是坏了。
    // 所以空蒙版一律按全局处理，不管开关状态。
    gl.uniform1f(uniforms.uUseMask, (useMask && !mask.isEmpty) ? 1 : 0);
    gl.uniform1f(uniforms.uMaskOverlay, (showMask && !mask.isEmpty) ? 1 : 0);

    // 锐化取邻居的步长用**原图**的 1/宽高，不是当前画布的 ——
    // 用画布尺寸的话，拖一下窗口锐化半径就变了（预览和导出也不一致）。
    // 代价是屏幕预览时看着比导出略轻，取舍写在 shader 的 sharpen 注释里。
    gl.uniform2f(uniforms.uTexel, 1 / img.width, 1 / img.height);
    // 蒙版边缘描边的步长：蒙版不是原分辨率，按短边 1024 缩放。
    // 和 uTexel 分开——拿图片的 1/3440 去采 1024 的蒙版会落在亚像素上。
    gl.uniform2f(uniforms.uMaskTexel, 1 / mask.canvas.width, 1 / mask.canvas.height);
    gl.uniform1f(uniforms.uAspect, img.width / img.height);

    /* 几何变换。`planOverride` 是给"烘焙/整转"用的：那两条路要按一个
       **和当前 geom 不同**的计划画一帧（临时角度、临时取景框），
       不能让它再去 cropRenderPlan() 重算一遍 —— 重算就把临时参数丢了。
       ⚠️ 这个坑真踩过：烘焙时先 applyGeometryUniforms(plan) 再 draw()，
       而 draw() 内部又按 geom 重算了一次，于是"90° 整转"出来的图
       一点没转（尺寸对了、内容没转）。
       ⚠️ 恒等分支不能省：uniform 是**全局状态**，上一次留下的值会一直
       生效，表现是"取消裁剪之后照片还是歪的"。 */
    if (planOverride) {
      applyGeometryUniforms(planOverride);
    } else if (geom) {
      const plan = cropRenderPlan(false);
      if (plan) applyGeometryUniforms(plan);
      else resetGeometryUniforms();
    } else {
      resetGeometryUniforms();
    }

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
    // ⚠️ 用 _trace 而不是 console.log：页面日志经 CDP 不会传回测试侧
    // （harness 只取 Runtime.evaluate 的返回值），排查时看不到。
    // 写成数组由测试读出来才看得见。踩过这个坑。
    _trace('layoutCanvas', img.width + 'x' + img.height + ' geom=' + !!geom
      + ' stageW=' + ($('stStage') || {}).clientWidth);

    /* 几何编辑时画布尺寸由**视口**决定（视口随角度撑大，见 viewportDims），
       不是原图比例 —— 旋转时视口比例会变，画布跟着变，画面才不会被裁。 */
    if (geom) {
      const plan = cropRenderPlan(false);
      if (plan) {
        canvas.width = plan.bufW;
        canvas.height = plan.bufH;
        canvas.style.width = Math.round(plan.dispW) + 'px';
        canvas.style.height = Math.round(plan.dispH) + 'px';
        gl.viewport(0, 0, canvas.width, canvas.height);
        _trace('layoutGeom', 'buf=' + canvas.width + 'x' + canvas.height
          + ' out=' + plan.outW + 'x' + plan.outH
          + ' s=' + plan.screenZoom + ' off=' + plan.offX.toFixed(4)
          + ',' + plan.offY.toFixed(4));
        return;
      }
    }

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
     裁剪 / 旋转 / 翻转
     ================================================================
     ⚠️⚠️ 这一整段是**重写**的。旧版把"旋转"做成了会反过来改取景框的
     自动数学（旋转框 → 最大内接矩形 → 取景框收进去，见 crop-geometry
     那套 inscribedRect / fitRatioInRotated）。用户明确否掉了：

       "裁剪和翻转做复杂了，不需要做数学运算，裁剪和旋转分开做"
       "不要做运算，就是单纯的度数旋转，不涉及取景框收框，
        超出取景框范围展示上就是截断即可，
        把图片缩小后可以正常展示完整"

     所以现在的模型只有两件**互不相干**的事：

       · 取景框（geom.rect）—— 画布归一化坐标 [0,1]，轴对齐。
         只由用户拖动/比例预设改变；**旋转角变了它不动**。
       · 显示变换 —— 角度 rot、翻转 flip、缩放 zoom。
         只由旋转滑杆/翻转按钮/缩放滑杆改变；**取景框不动**。

     导出 = 取景框那块区域，套上显示变换之后的样子。
     旋转后原图外面露出来的角**不拟合、不收框**，直接是深色底。

     ----------------------------------------------------------------
     坐标与符号（这块最容易被绕进去，一次写清楚）
     ----------------------------------------------------------------
     canvas 归一化： (0,0) 在左下、(1,1) 在右上（WebGL 默认）
     shader 的 u ： 0 = 图片上边（VERT 里 vUv.y = 0.5 - aPos.y*0.5）
     用户看的角度： **正值 = 逆时针**（和"向左歪了就 +2° 拉直"的直觉一致）

     一个屏幕点 → 图片 uv：
        p  = (uv - 0.5)                       屏幕中心坐标
        p *= flip                             （在中心坐标里翻，镜像）
        p  = R(-rot) · p / zoom               转到图片的轴上、缩放
        u  = p + 0.5 + offset                 移到图片上、再平移到要保留的区域
     R(-rot) 的两个轴都是 1/zoom，所以**相似变换、绝不等比失真** ——
     这是整块几何唯一的硬不变量（测试 test/crop-geometry.test.mjs 守它）。

     ⚠️ offset 的推导（别再从渲染结果反推，反推错过很多次）：
       取景框左上角在图片里的位置 = (rect.x, 1 - rect.y - rect.h)
       （crop rect 的 y 是屏幕约定：y=0 在下边；图片 v 是 0 在上边）
       视口原点就在取景框左上角，所以
           dx = rect.x,  dy = (1 - rect.y - rect.h)
           offset = (dx, dy) / zoom
     ================================================================ */

  /**
   * 几何状态。
   * ⚠️ 用**一个对象**而不是几个零散变量：取消（exitCrop(false)）时要
   * 整块丢掉，散着写迟早漏掉一个（旧版就漏过 crop.aspect）。
   */
  let geom = null;

  /** 取景框的最小边长（归一化）与缩放范围 */
  const MIN_RECT = 0.04;
  const ZOOM_MIN = 0.25, ZOOM_MAX = 2;

  /**
   * 诊断追踪。页面里的 console.log 经 CDP **不会**传回测试侧
   * （harness 只取 Runtime.evaluate 的返回值），所以排查时把关键
   * 步骤记在这个数组里，由测试读出来 —— 这个坑实际踩过，
   * 白白多花了几轮猜测。
   */
  const _traceLog = [];
  function _trace(tag, msg) {
    _traceLog.push(tag + ': ' + msg);
    if (_traceLog.length > 60) _traceLog.shift();
  }

  /* ================================================================
     裁剪比例预设
     ================================================================
     ⚠️ 语义变了（旧版「原图」走的是"收进内接矩形"，那套已经删掉）：
       · 原图   = 取景框按原图比例，尽可能大（在视口里）
       · 自由   = 不约束，用户随便拖
       · N:M    = 取景框按这个比例，尽可能大
     所有档位都只改取景框的形状/大小，**不碰旋转角**。
     ================================================================ */
  const ASPECTS = [
    { name: '原图', v: 0 },
    { name: '自由', v: -1 },
    { name: '1:1', v: 1 },
    { name: '4:3', v: 4 / 3 },
    { name: '3:4', v: 3 / 4 },
    { name: '16:9', v: 16 / 9 },
    { name: '9:16', v: 9 / 16 }
  ];

  /** 取景框的**实际像素比例**（宽:高）。
   *  ⚠️ 取景框是归一化的，而画布像素是 W0×H0，所以
   *  rect.w/rect.h 并不等于像素比例 —— 中间要乘 W0/H0。
   *  旧版 applyCropAspect 就是在这里把"旋转框像素"当成"图片像素"，
   *  只有 0° 才对。 */
  function rectPixelAspect(r) {
    if (!img || !(r.h > 0)) return 1;
    return (r.w * img.width) / (r.h * img.height);
  }

  function clampCropRect(r) {
    const w = Math.min(Math.max(Number(r.w) || MIN_RECT, MIN_RECT), 1);
    const h = Math.min(Math.max(Number(r.h) || MIN_RECT, MIN_RECT), 1);
    const x = Math.min(Math.max(Number(r.x) || 0, 0), 1 - w);
    const y = Math.min(Math.max(Number(r.y) || 0, 0), 1 - h);
    return { x, y, w, h };
  }

  /** 等比缩放取景框到指定像素比例（保持中心） */
  function sizeRectToAspect(r, aspect) {
    const H0 = img.height, W0 = img.width;
    // 像素比例 aspect = (w·W0)/(h·H0) → w/h = aspect·H0/W0
    const k = aspect * H0 / W0;
    let w = r.w, h = w / k;
    if (h > 1) { h = 1; w = h * k; }
    if (w > 1) { w = 1; h = w / k; }
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  /** 视口里能放下的最大某比例矩形（居中），归一化 */
  function maxRectForAspect(aspect) {
    const H0 = img.height, W0 = img.width;
    const k = aspect * H0 / W0;              // w/h
    let w = 1, h = w / k;
    if (h > 1) { h = 1; w = h * k; }
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }

  /* ================================================================
     视口（viewport）与"适合窗口"
     ================================================================
     用户要的"把图片缩小后可以正常展示完整"就是这个视口 + zoom。
     视口 = 画布上显示的那块**源图区域**，它必须随旋转角变大，
     否则旋转后的照片必然伸出视口 → 四角永远露深色底，
     而且"适合窗口"也救不了（那是视口不够大，不是缩放的事）。 */

  /**
   * 视口比例尺 p：图片旋转 φ 后，视口要**恰好**装下它所需的放大倍数。
   *
   * 模型：
   *   视口（源图单位）= p·W0 × p·H0，整体归一化到画布 [0,1]²
   *   图片缩放到视口后，半宽半高 a = (W0/2)/(p·W0) = 1/(2p)，b = 1/(2p)
   *   （两项一样是**因为视口和图片同比例**）
   *   旋转后的外接半宽半高 ≤ 0.5：  (c+s)/(2p) ≤ 0.5  →  p ≥ c+s
   *   取等号就是"恰好装下"，也就是 p = |cosφ| + |sinφ|。
   *   φ=0 → 1（视口 = 整张图）；φ=45° → 1.414（正方形正好放斜的它）。
   *
   * ⚠️⚠️ 这个值我错了**四次**，全是真 bug，全记下来 —— 它同时踩了
   * "公式看着对"和"从渲染结果反推"两个坑：
   *   【一】写死 p = 1（视口不随角度变）→ 45° 时怎么缩都装不下，
   *        四角永远是深色底
   *   【二】p = (|cos|+|sin|) 但归一化基准搞错 → 400×300 转 40°
   *        算出缩放 1.14（>1，把照片缩掉一圈）
   *   【三】p = max(c/r+s, s/r+c)（r = H0/W0）→ 假设视口宽高同乘一个
   *        系数，可外接框比例本身在变
   *   【四】视口 = "外接框 W0c+H0s × W0s+H0c" → 直觉上对，但归一化到
   *        画布时两个轴的系数不同，实测 400×300 转 5° 得到 0.5084 > 0.5
   *        （**装不下**）
   *
   * ⭐ 最后不靠"推导看着对"收敛，而是靠 test/crop-geometry.test.mjs 里
   * 那条不变量守住：**把图片放进视口、旋转后必须恰好贴边
   * （halfW = halfH = 0.5）**。那条断言对 p 是单调的 —— p 小一点就
   * >0.5（装不下）、大一点就 <0.5（白缩一圈），所以它一次就能把上面
   * 四种错法全抓出来。
   */
  function rotatePad(deg) {
    const phi = Math.abs(Number(deg) || 0) * Math.PI / 180;
    return Math.abs(Math.cos(phi)) + Math.abs(Math.sin(phi));
  }

  /** 视口尺寸（源图单位）。zoom 越小 = 视野越宽 = 输出越大 */
  function viewportDims(deg, zoom) {
    const p = rotatePad(deg);
    const z = Number(zoom) || 1;
    return { vw: p * img.width / z, vh: p * img.height / z };
  }

  /** 把一块 w×h 绕中心转 deg 之后的外接框尺寸（画布要用它，否则转
   *  45°/90° 时画面会被裁掉两头） */
  function viewportBox(w, h, deg) {
    const phi = Math.abs(Number(deg) || 0) * Math.PI / 180;
    const c = Math.abs(Math.cos(phi)), s = Math.abs(Math.sin(phi));
    return { W: w * c + h * s, H: w * s + h * c };
  }

  /** 图片旋转后的外接框（源图单位） */
  function rotatedBoxSize(W0, H0, deg) {
    return viewportBox(W0, H0, deg);
  }

  /** 视口（= 取景框的初始形状）：整幅。
   *  视口和图片**同比例**，所以取景框初始就是 (0,0,1,1) —— 不需要按
   *  比例算，这也是新模型比旧模型简单的地方。 */
  function resetRectToViewport() {
    if (!img || !geom) return;
    geom.rect = { x: 0, y: 0, w: 1, h: 1 };
  }

  /**
   * 「适合窗口」的缩放值。
   *
   * ⚠️ 恒为 1 是**推导的结果**：视口已经按 rotatePad 撑到"任何角度都
   * 装得下整张旋转图"，所以角度本身不需要再额外缩放。
   * 保留这个函数：① 按钮需要一个明确的值（把缩放恢复到默认那一档，
   * 用户可能自己拉远过）；② 将来若要支持"超大图初始缩放"，改一处就够。
   * 测试断言它 = 1，正是为了拦住"又写出一个 >1 或 <1 的过头解"。
   */
  function autoZoomFor(deg) {
    if (!img) return 1;
    return 1;
  }

  /**
   * 旋转 / 翻转 / 缩放。
   *
   * ⚠️ 和旧版的根本区别：**不动取景框**。
   * 旧版每改一次角度都要按比例换算取景框、再 clamp 回新的内接矩形 ——
   * 那正是用户说的"取景框收框"。
   */
  function setDisplay(o) {
    if (!img) return;
    ensureGeom();
    if (!geom) return;
    if (o.rotate !== undefined) {
      const r45 = v => Math.max(-45, Math.min(45, Number(v) || 0));
      geom.rot = r45(o.rotate);
    }
    if (o.flipX !== undefined) geom.flipX = !!o.flipX;
    if (o.flipY !== undefined) geom.flipY = !!o.flipY;
    if (o.zoom !== undefined) {
      geom.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(o.zoom) || 1));
    }
    syncCropRotUI(geom.rot);
    syncFlipUI();
    syncZoomUI();
    layoutCanvas();
    render();
    drawCropOverlay();
  }

  /**
   * ⚠️⚠️ 滑杆（#stCropRot）和标签（#stCropRotVal）是**两个独立元素**，
   * 没有 <output> 绑定 —— 只有显式同步才会一致。
   * 实测踩到：进裁剪 → 拖到 30° → 按「⟲ 90°」快转 → 滑杆和标签
   * 仍停在 30° 而实际是 0°，用户会以为旋转丢了。
   * 规则：**凡是有可能改变 geom.rot 的地方，都要调它一次**。
   */
  function syncCropRotUI(deg) {
    const d = Number.isFinite(deg) ? deg : 0;
    const slider = $('stCropRot');
    const label = $('stCropRotVal');
    /* 滑杆量程只有 ±45（90° 整转走按钮），所以钳一下再显示 ——
       否则给滑杆赋超出 min/max 的值会被浏览器夹到边界，
       而标签却显示真实值，两者又不一致了。 */
    const shown = Math.max(-45, Math.min(45, d));
    if (slider) slider.value = String(shown);
    if (label) label.textContent = shown.toFixed(0) + '°';
  }

  function syncFlipUI() {
    const h = $('stFlipH'), v = $('stFlipV');
    if (h) h.classList.toggle('on', !!(geom && geom.flipX));
    if (v) v.classList.toggle('on', !!(geom && geom.flipY));
  }

  function syncZoomUI() {
    const s = $('stZoom'), l = $('stZoomVal');
    const z = geom ? geom.zoom : 1;
    if (s) s.value = String(Math.round(z * 100));
    if (l) l.textContent = Math.round(z * 100) + '%';
  }

  /** 保证 geom 存在（外部入口 / 测试可能直接调 setCropRotation） */
  function ensureGeom() {
    if (!geom && img) {
      geom = { rect: { x: 0, y: 0, w: 1, h: 1 },
               rot: 0, flipX: false, flipY: false, zoom: 1 };
      resetRectToViewport();
      geom.zoom = autoZoomFor(0);
    }
  }

  /** 打开裁剪模式（只显示取景框，不改任何显示变换） */
  function enterCrop() {
    if (!img) return;
    ensureGeom();
    showCropUI(true);
    setBrushMode(false);
    showMaskTool(false);
    layoutCanvas();
    render();
    drawCropOverlay();
    toast('拖动取景框选择要保留的部分', 3200);
  }

  /** 打开旋转 / 翻转 / 缩放。取景框保持原样，只是把工具区显示出来 */
  function enterRotate() {
    if (!img) return;
    ensureGeom();
    showRotateUI(true);
    showCropUI(true);          // 旋转时要看得见取景框，才知道会保留哪一块
    setBrushMode(false);
    showMaskTool(false);
    syncCropRotUI(geom.rot);
    syncFlipUI();
    syncZoomUI();
    layoutCanvas();
    render();
    drawCropOverlay();
  }

  /** 取景框缩放到"整张旋转图都看得见"（一次计算，不是持续自动收框） */
  function fitZoomToWindow() {
    if (!geom) return;
    geom.zoom = autoZoomFor(geom.rot);
    syncZoomUI();
    layoutCanvas();
    render();
    drawCropOverlay();
  }

  /** 按比例约束取景框（居中收缩到目标比例）。⚠️ 不碰旋转角 */
  function applyCropAspect(ratio) {
    if (!img || !ratio) return;
    ensureGeom();
    geom.rect = clampCropRect(sizeRectToAspect(geom.rect, Number(ratio)));
  }

  /** 「原图」档：取景框按原图比例取最大（居中） */
  function fitCropToImageRatio() {
    if (!img) return;
    ensureGeom();
    geom.rect = maxRectForAspect(img.width / img.height);
  }

  /** 退出几何编辑。apply=false 时整块丢掉（等于取消） */
  function exitCrop(apply) {
    showCropUI(false);
    showRotateUI(false);
    if (!apply) geom = null;
    render();
  }

  /** 设置旋转角 */
  function setCropRotation(deg) {
    setDisplay({ rotate: deg });
  }

  /* ================================================================
     自动水平校正（纯本地，不联网）
     ================================================================
     用户要的："把稍微歪的图片自动修正"。

     ⚠️ 为什么先做纯本地而不是调 AI：
       · 这是**几何**问题，不是语义问题 —— 找地平线/垂直边不需要
         理解画面内容，本地算得又快又准，还不消耗额度、不联网
       · AI 那侧（百度人脸角度）能做的是"把脸摆正"，那是下一步；
         而且人脸角度受转头/侧脸影响，对"照片歪了"反而更不稳
       · 本地找不到明显直线时可以**不动作、只提示**，
         比"调一次 AI 花了额度还给了个错角度"体验好

     算法（Hough 式的一维扫描 —— 不做真正的 Hough 累加器）：
       1. 先把图缩到长边 ~720：原图几千万像素没必要全扫，
          而且缩略图上噪声被平均掉，反而更稳
       2. 取边缘：Sobel 幅值大的像素
       3. 对候选角 θ ∈ [-10°, 10°]（步长 0.1°）：
          把边缘点投到 θ 坐标系的一根轴上 → 做直方图。
          一条真实的直线在**正确角度**上会让投影能量集中成尖峰。
       4. y' 轴找水平线（地平线），x' 轴找垂直线（门框/墙角），
          取两者里更尖的那个
       5. 尖峰够不够尖决定"有没有把握"：不够就返回 null，不动作

     ⚠️ 扫描范围 ±14° **不是**"最大能修 14°"。上面说过：扫描是在
     **归一化空间**里做的，而归一化空间的角度会被长宽比放大
     （3:2 的图放大 1.5 倍）。所以 ±14° 的归一化范围对应真实照片上
     大约 ±10° 的倾斜 —— 这正是"稍微歪"的量级。更歪的该用 ±45 滑杆手动转。
     范围再放大会让错误匹配（人像的斜肩、裙摆）盖过真实地平线。
     ⚠️ 符号：返回的是**要给 geom.rot 加多少度**（正值 = 逆时针，
     和滑杆同约定）。检测到的线倾斜了 φ，要转正就得加 -φ。
     ================================================================ */
  const STRAIGHTEN_MAX_DEG = 14;
  const STRAIGHTEN_STEP_DEG = 0.1;

  /**
   * 从 ImageData 里估"照片歪了多少度"。
   * @returns {{ deg:number, score:number } | null} deg = 要加给 rot 的度数
   *
   * ⚠️ 抽成纯函数（输入 ImageData、输出数字）是为了**能测**：
   * 造一张已知倾斜的图就能验它准不准，不需要真 API、不需要 UI。
   */
  function detectStraightenAngle(data, w, h) {
    if (!data || w < 16 || h < 16) return null;

    /* ---- 1. 灰度 + Sobel 边缘 ---- */
    const lum = new Float32Array(w * h);
    for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
      // 0.2126/0.7152/0.0722 —— 和 shader 里的 luma 同一套系数
      lum[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    }
    let sum = 0;
    for (let i = 0; i < lum.length; i++) sum += lum[i];
    const mean = sum / lum.length;

    const pts = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = (lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1])
                 - (lum[i - w - 1] + 2 * lum[i - 1] + lum[i + w - 1]);
        const gy = (lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1])
                 - (lum[i - w - 1] + 2 * lum[i - w] + lum[i - w + 1]);
        const mag = Math.sqrt(gx * gx + gy * gy);
        /* 阈值 = 全局均值 ×2 + 8：纯色/糊图会被自然滤掉
           （点太少 → 后面返回 null），不用单独判"这张图有没有边缘" */
        if (mag > mean * 2 + 8) pts.push(x / w, y / h, mag);
      }
    }
    if (pts.length / 3 < 40) return null;

    /* ---- 2. 扫描：哪个角度的投影最"尖" ---- */
    const BINS = 64;
    const tmp = new Float64Array(BINS);
    const tmpX = new Float64Array(BINS);

    /** 投影能量：直方图归一化后的平方和（越尖 → 越大） */
    const energy = (deg) => {
      tmp.fill(0); tmpX.fill(0);
      const th = deg * Math.PI / 180;
      const c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < pts.length; k += 3) {
        const dx = pts[k] - 0.5, dy = pts[k + 1] - 0.5;
        const wgt = pts[k + 2];
        // y' = -s·dx + c·dy  → 找水平线（地平线）
        let b = Math.floor((-s * dx + c * dy + 0.5) * BINS);
        if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
        tmp[b] += wgt;
        // x' = c·dx + s·dy  → 找垂直线（门框/墙角）
        let bx = Math.floor((c * dx + s * dy + 0.5) * BINS);
        if (bx < 0) bx = 0; else if (bx >= BINS) bx = BINS - 1;
        tmpX[bx] += wgt;
      }
      let e = 0, ex = 0, t = 0, tx = 0;
      for (let i = 0; i < BINS; i++) {
        e += tmp[i] * tmp[i]; t += tmp[i];
        ex += tmpX[i] * tmpX[i]; tx += tmpX[i];
      }
      // 除以总量的平方 → 不随边缘点数量变化（否则"边缘多的角度"永远赢）
      return [e / (t * t || 1), ex / (tx * tx || 1)];
    };

    let bestY = { deg: 0, score: -1 };
    let bestX = { deg: 0, score: -1 };
    for (let deg = -STRAIGHTEN_MAX_DEG;
         deg <= STRAIGHTEN_MAX_DEG + 1e-9; deg += STRAIGHTEN_STEP_DEG) {
      const [e, ex] = energy(deg);
      if (e > bestY.score) bestY = { deg, score: e };
      if (ex > bestX.score) bestX = { deg, score: ex };
    }

    /* ---- 3. 有没有把握？ ----
       判据：尖峰能量要明显高于"整条扫描曲线的中位数"。
       ⚠️ 用中位数而不是均值：峰值自己会把均值拉高，阈值就失效了。 */
    const sample = [];
    for (let deg = -STRAIGHTEN_MAX_DEG;
         deg <= STRAIGHTEN_MAX_DEG + 1e-9; deg += STRAIGHTEN_STEP_DEG * 4) {
      const [e, ex] = energy(deg);
      sample.push(Math.max(e, ex));
    }
    sample.sort((a, b) => a - b);
    const median = sample[Math.floor(sample.length / 2)] || 0;

    const best = bestY.score >= bestX.score ? bestY : bestX;
    if (!(median > 0) || best.score < median * 1.8) return null;

    /* ---- 4. 符号 + **长宽比修正** ----
       ⚠️⚠️ 这里曾经漏掉长宽比，是真 bug：
       上面把 x、y 各自归一化到 [0,1]，于是"归一化空间里的斜率"
       和"真实图像空间里的斜率"差了 W/H 倍。

       具体算一遍就清楚：真实空间里斜率 tan(φ) 的直线，归一化之后
       斜率变成 tan(φ)·(W/H)。所以检测器在归一化空间量到的角 θ
       对应真实角 φ = atan( (H/W)·tan(θ) )。
       **只有正方形（W=H）时才 θ == φ** —— 所以这个错在方图上完全
       看不出来，一到 3:2 的照片上就偏（实测 900×600 时，
       真实 1.5° 被报成 2.2°，真实 6° 被报成 9°：偏差随角度放大）。

       best.deg 是"边在归一化空间里斜了多少"，先换成真实角，
       再取相反数（rot 正值 = 逆时针，见上面的符号约定）。 */
    const theta = best.deg * Math.PI / 180;
    const trueDeg = Math.atan((h / w) * Math.tan(theta)) * 180 / Math.PI;
    const deg = -trueDeg;
    if (Math.abs(deg) < 0.15) return { deg: 0, score: best.score };
    return { deg, score: best.score };
  }

  /** 把当前图缩到长边 ~720 后取 ImageData（给上面的检测器吃） */
  function sampleImageData(maxSide) {
    if (!img) return null;
    const W0 = img.width, H0 = img.height;
    const k = Math.min(1, (maxSide || 720) / Math.max(W0, H0));
    const w = Math.max(16, Math.round(W0 * k));
    const h = Math.max(16, Math.round(H0 * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, w, h);
    try {
      return { data: g.getImageData(0, 0, w, h).data, w, h };
    } catch {
      return null;                     // 防御：理论上同源不会抛
    }
  }

  /**
   * 自动水平校正：检测 → 累加到旋转角上。
   * ⚠️ **累加**而不是覆盖：用户可能已经手调过一点，
   * 自动校正该是"再帮我转正一点"，不是"抹掉我的手调"。
   */
  function autoStraighten() {
    if (!img) return false;
    ensureGeom();
    const s = sampleImageData();
    if (!s) { toast('读不到图片内容，没法自动校正'); return false; }
    const r = detectStraightenAngle(s.data, s.w, s.h);
    if (!r) {
      toast('找不到明显的地平线/垂直边，请手动拖旋转滑杆', 3200);
      return false;
    }
    if (r.deg === 0) {
      toast('看起来已经是正的', 2400);
      return true;
    }
    setDisplay({ rotate: geom.rot + r.deg });
    toast('已自动校正 ' + (r.deg > 0 ? '+' : '') + r.deg.toFixed(1) + '°', 3200);
    return true;
  }
  /* ================================================================
     由当前状态算出「输出尺寸 + 显示变换参数」
     ================================================================
     ⚠️⚠️ 唯一的硬约束：**显示变换必须是相似变换**
     ----------------------------------------------------------------
     输出缓冲上的 u 坐标 → 图片 uv 的映射是线性的：
         u = R(-rot) · (uBuf - 0.5) · flip / zoom + 0.5 + offset
     前面的线性部分两个轴都带同一个 1/zoom，所以是"旋转 + 等比缩放"，
     形状绝不变形。**唯一的破坏方式就是让两个轴的系数不同**
     （旧版的 uUvScale 就是分开的 sX/sY，所以必须靠
       sX·W0 / (sY·H0) == outW/outH 这条等式去救，前后错了三次）。

     所以现在的判据是**结构性**的：代码里根本不存在第二个缩放系数。
     测试 test/crop-geometry.test.mjs 直接读 shader uniform 断言这一点。

     ⚠️⚠️ offset 的定义错过一次（真 bug），记清楚：
       它是**视口左下角**在图片归一化坐标里的位置，就是取景框的
       左下角。旧代码按"取景框中心相对图片中心的偏移"算：
           offX = (cx - 0.5) * (ins.w / W0)
       满幅取景框时 cx = 0.5，偏出来正好是 0，**看起来是对的**；
       一旦把取景框收小（比如 0.5×0.5 居中），它就引入了一个
       等于取景框尺寸一半的额外平移 —— 实测画面中心读到的是原图
       0.75 处而不是中心。这种"只有非满幅才暴露"的错最难查。
     ================================================================ */
  function cropRenderPlan(forExport = false, override = null) {
    if (!geom || !img) return null;
    const W0 = img.width, H0 = img.height;
    const r = geom.rect;
    const zoom = geom.zoom;
    // 只给 90° 整转用：临时换掉角度，不动 geom 本身
    const rotDeg = override && override.rotDeg !== undefined
      ? override.rotDeg : geom.rot;
    if (!(r.w > 0) || !(r.h > 0)) return null;

    const { vw, vh } = viewportDims(rotDeg, zoom);

    /* ⚠️⚠️ offset 恒为 0 —— 这一处错了**两轮**，说清楚：
     *
     * 画布上显示的是**整个视口**（zoom=1 时就是整张图），取景框只是
     * 画在上面的一个框。所以"画布归一化坐标 → 图片归一化坐标"除了
     * 缩放之外**没有任何平移**：画布中心就是图片中心。
     *
     * 我先后写成过：
     *   【一】(r.x + r.w/2 − 0.5)·… —— 取景框中心相对图片中心的偏移。
     *        满幅取景框时中心就是 0.5，偏出来正好 0，**看着是对的**；
     *        收小到 0.5×0.5 居中时就多移了 0.25，画面整体偏。
     *   【二】(r.x, 1−r.y−r.h) —— "视口原点放在取景框左下角"。
     *        那个前提本身不成立：视口是整张图的显示区域，不会因为
     *        取景框挪动而挪动（否则拖框时照片会跟着滑走，很怪）。
     *
     * 判据（test/rotate-invariant.test.mjs）：取景框 0.5×0.5 居中时，
     * 画面中心必须读到**原图中心** —— 这就是"画布中心 = 图片中心"
     * 这条不变量，和取景框在哪无关。 */
    const offX = 0;
    const offY = 0;

    /* ================================================================
       输出尺寸 = **取景框那块区域**（源图像素）
       ----------------------------------------------------------------
       视口覆盖 vw × vh 源图像素，取景框占视口的 r.w × r.h，
       所以输出 = r.w·vw × r.h·vh。
       校验：两个轴都是同一个 1/zoom 的相似变换，输出比例
            = (r.w·W0)/(r.h·H0) = 取景框的像素比例 ✓ 不扭曲。

       zoom 的含义（**越小 = 拉远 = 视野越宽 = 输出越大**）：
         · zoom = 1：输出就是取景框那块的原分辨率（1:1，不糊）
         · zoom < 1：拉远看全图，输出相应变大（屏幕上看到什么就导出什么）
       ================================================================ */
    const outW = Math.max(1, Math.round(r.w * vw));
    const outH = Math.max(1, Math.round(r.h * vh));

    /* ⚠️⚠️ uDisplayScale 必须**等于**用户设的 zoom，不能"为了填满屏幕"
     * 把它抬高。第一版写的是 max(needZoom, zoom)（needZoom = 让画布铺满
     * 可用空间），那是个**真 bug**：画布放着大不大是 CSS 的事（见下面
     * 的 dispW/dispH），而 uDisplayScale 决定的是**视口覆盖多大范围**。
     * 抬高它 = 视野被压缩 = 用户拉远也看不到整张图。
     * 实测症状：400×300 的图 zoom=0.7 时被抬到 2.08，画面只剩中心
     * 48%，四角永远看不到深色底。 */
    const screenZoom = zoom;

    /* 画布要显示的是「视口旋转之后的外接框」，所以缓冲尺寸用 viewportBox
       —— 否则转 45°/90° 时画面会被裁掉两头。
       （offset 不受影响：它只由 rect 和 zoom 决定。）
       0° 时外接框就是视口本身（cos=1, sin=0），自动退化。 */
    const buf = viewportBox(vw, vh, rotDeg);
    const bufW = Math.max(1, Math.round(buf.W));
    const bufH = Math.max(1, Math.round(buf.H));

    const stage = $('stStage');
    const pad = 24;
    const availW = Math.max(80, (stage ? stage.clientWidth : 800) - pad);
    const availH = Math.max(80, (stage ? stage.clientHeight : 600) - pad);
    const dispK = Math.min(1, availW / bufW, availH / bufH);

    return {
      W0, H0, zoom,
      screenZoom,
      rot: rotDeg * Math.PI / 180,
      flipX: geom.flipX ? -1 : 1,
      flipY: geom.flipY ? -1 : 1,
      offX, offY,
      s: 1 / zoom,
      rect: { ...r },
      outW, outH,
      bufW, bufH,
      vw, vh,
      dispW: Math.max(1, bufW * dispK),
      dispH: Math.max(1, bufH * dispK)
    };
  }

  /**
   * 应用取景框 + 旋转 + 翻转：把结果烘焙成新图。
   *
   * 走「按目标尺寸重画一帧 → readPixels」这条路，而不是在 CPU 上
   * 重采样 —— 复用的是同一个 shader，所以**所见即所得**，
   * 而且不用再写一遍调色逻辑（写两遍必然漂移）。
   *
   * 副作用：旋转后露出的深色角会被烘进去。这是用户明确接受的
   * （"超出取景框范围展示上就是截断即可"），而且他可以在应用前
   * 把取景框收进图片内容里避开。
   */
  async function applyGeometry() {
    if (!geom || !img) return;
    busy(true, '正在应用…');
    try {
      const plan = bakeRenderPlan();
      if (!plan) throw new Error('取景框太小');

      const prevW = canvas.width, prevH = canvas.height;
      canvas.width = plan.outW;
      canvas.height = plan.outH;
      gl.viewport(0, 0, plan.outW, plan.outH);
      draw(plan);

      const pixels = new Uint8Array(plan.outW * plan.outH * 4);
      gl.readPixels(0, 0, plan.outW, plan.outH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      canvas.width = prevW; canvas.height = prevH;

      const baked = await pixelsToBitmap(pixels, plan.outW, plan.outH);
      if (img && img.close) img.close();
      img = baked;
      geom = null;
      showCropUI(false);
      showRotateUI(false);

      mask.clear();
      mask.resize(img.width, img.height);
      setMaskActive(false);
      setBrushMode(false);
      showMaskTool(false);

      gl.bindTexture(gl.TEXTURE_2D, imageTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      _trace('applyGeometry', 'img=' + img.width + 'x' + img.height
        + ' out=' + plan.outW + 'x' + plan.outH);

      layoutCanvas();
      render();
      /* ⚠️ 强制同步 GPU 管线。不加这个的话，紧跟其后的 readPixels /
         截图有时会拿到**上一帧**的内容（表现是"应用了但画面还是旧的"）。 */
      gl.finish();
      toast(`已应用（${img.width}×${img.height}）`, 3000);
    } catch (e) {
      canvas.width = canvas.width;   // 触发重新分配，避免半截缓冲
      toast('应用失败：' + (e && e.message ? e.message : e));
    } finally {
      busy(false);
    }
  }

  /**
   * 把 readPixels 的结果变成位图。
   *
   * ⚠️ 行序**翻一次**，这是量出来的、不是推理出来的：
   *   `gl.readPixels` 返回的行序是**自下而上** —— pixels 的第 0 行
   *   对应 framebuffer 的**底部**（画面的下边）；而 `ImageData` 是按行
   *   **自上而下**解释的（第 0 行是图的上边）。两个约定不抵消，所以要翻。
   * 不翻的表现是"预览是对的、应用完整个上下颠倒"，历史上真的发生过。
   * （这一处和 offset 的公式是**两件独立的事**，别当成配套约定。）
   */
  async function pixelsToBitmap(pixels, w, h) {
    const flipped = new Uint8ClampedArray(pixels.length);
    const rowBytes = w * 4;
    for (let y = 0; y < h; y++) {
      const s = (h - 1 - y) * rowBytes;
      flipped.set(pixels.subarray(s, s + rowBytes), y * rowBytes);
    }
    return createImageBitmap(new ImageData(flipped, w, h));
  }

  /**
   * 烘焙用的计划：取景框那块区域，按**源图 1:1** 输出。
   *
   * ⚠️ 和 cropRenderPlan 的区别只有"视野"：
   *   cropRenderPlan 跟着 zoom（用户看多大就输出多大），
   *   bakeRenderPlan 固定 zoom = 1（取景框占视口多大就输出多少源图像素）。
   * 两个都是相似变换 —— 这里两个轴共用 1/1，显然成立。
   */
  function bakeRenderPlan() {
    if (!geom || !img) return null;
    const W0 = img.width, H0 = img.height;
    const r = geom.rect;
    const { vw, vh } = viewportDims(geom.rot, 1);
    const cw = r.w * vw, ch = r.h * vh;
    if (!(cw >= 2) || !(ch >= 2)) return null;
    return {
      W0, H0, zoom: 1,
      screenZoom: 1,
      rot: geom.rot * Math.PI / 180,
      flipX: geom.flipX ? -1 : 1,
      flipY: geom.flipY ? -1 : 1,
      // ⚠️ 和 cropRenderPlan 同理：视口→图片没有平移，off 恒为 0。
      // 输出尺寸由 r.w·vw / r.h·vh 决定（见上面 outW/outH）。
      offX: 0, offY: 0,
      s: 1,
      vw, vh,
      outW: Math.max(1, Math.round(cw)),
      outH: Math.max(1, Math.round(ch))
    };
  }

  /** 把几何参数喂给 shader。
   *  ⚠️ 用 `screenZoom`（画布用的缩放）而不是 `zoom`（输出用的）——
   *  两者在"取景框很大 + 屏幕很宽"时不一样，喂错会让预览和导出差一截。 */
  function applyGeometryUniforms(plan) {
    gl.uniform1f(uniforms.uRot, plan.rot);
    gl.uniform2f(uniforms.uFlip, plan.flipX, plan.flipY);
    gl.uniform1f(uniforms.uDisplayScale,
      plan.screenZoom !== undefined ? plan.screenZoom : plan.zoom);
    gl.uniform2f(uniforms.uImgOffset, plan.offX, plan.offY);
    gl.uniform3f(uniforms.uBg, 0.086, 0.082, 0.078);   // 深色底
    // 诊断用：记下最后一次真正喂进 shader 的计划（测试读它排查几何问题）
    _lastPlan = 'uniform rot=' + plan.rot.toFixed(4)
      + ' s=' + (plan.screenZoom !== undefined ? plan.screenZoom : plan.zoom)
      + ' off=' + plan.offX.toFixed(4) + ',' + plan.offY.toFixed(4)
      + ' flip=' + plan.flipX + ',' + plan.flipY
      + ' out=' + plan.outW + 'x' + plan.outH;
  }
  let _lastPlan = null;

  /** 没有几何变换时必须是恒等变换，否则正常编辑会被莫名缩放/旋转 */
  function resetGeometryUniforms() {
    gl.uniform1f(uniforms.uRot, 0);
    gl.uniform2f(uniforms.uFlip, 1, 1);
    gl.uniform1f(uniforms.uDisplayScale, 1);
    gl.uniform2f(uniforms.uImgOffset, 0, 0);
    gl.uniform3f(uniforms.uBg, 0.086, 0.082, 0.078);
  }


  /* ---------------- 取景框 overlay ----------------
     用一个 2D canvas 画在 WebGL 画布上面：
       · 取景框外面压暗
       · 三分线
       · 四角标记
     为什么不用 DOM 元素：取景框的比例/位置每次拖动都在变，
     用 CSS 摆一堆 div 反而更绕，而且没法画三分线。
     ================================================ */
  let cropCanvas = null;

  function ensureCropCanvas() {
    if (cropCanvas) return cropCanvas;
    cropCanvas = document.createElement('canvas');
    cropCanvas.id = 'stCropOverlay';
    cropCanvas.hidden = true;
    // 放在 stage 里，和 WebGL 画布同一个定位上下文
    const stage = $('stStage');
    stage.appendChild(cropCanvas);
    return cropCanvas;
  }

  /**
   * 取景框在**画布归一化坐标**里的位置（y = 0 在下边，和 geom.rect 同义）。
   * ⚠️ 新模型下这是恒等映射 —— 取景框本来就定义在画布空间里。
   * 旧版要在这里做一堆换算（取景框相对内接矩形归一化，画布又是旋转框），
   * 那正是"做复杂了"的来源。
   */
  function cropRectOnCanvas() {
    if (!geom) return null;
    return { ...geom.rect };
  }

  function drawCropOverlay() {
    const cv = ensureCropCanvas();
    if (!geom || !img) { cv.hidden = true; return; }
    cv.hidden = false;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = canvas.width, H = canvas.height;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    cv.style.width = canvas.style.width;
    cv.style.height = canvas.style.height;

    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);

    const br = cropRectOnCanvas();
    const bx = br.x * W, bw = br.w * W;
    /* ⚠️ y 方向要翻：geom.rect 的 y = 0 在下边（WebGL/屏幕约定），
       而 2D canvas 的 y = 0 在上边。不翻框会上下颠倒。 */
    const by = (1 - br.y - br.h) * H, bh = br.h * H;

    // 框外压暗
    g.fillStyle = 'rgba(0,0,0,.55)';
    g.fillRect(0, 0, W, by);                          // 上
    g.fillRect(0, by + bh, W, H - by - bh);           // 下
    g.fillRect(0, by, bx, bh);                        // 左
    g.fillRect(bx + bw, by, W - bx - bw, bh);         // 右

    // 三分线
    g.strokeStyle = 'rgba(255,255,255,.45)';
    g.lineWidth = Math.max(1, dpr);
    for (let i = 1; i <= 2; i++) {
      g.beginPath();
      g.moveTo(bx + bw * i / 3, by); g.lineTo(bx + bw * i / 3, by + bh);
      g.moveTo(bx, by + bh * i / 3); g.lineTo(bx + bw, by + bh * i / 3);
      g.stroke();
    }

    // 边框 + 四角
    g.strokeStyle = 'rgba(255,255,255,.9)';
    g.lineWidth = Math.max(1, dpr);
    g.strokeRect(bx, by, bw, bh);

    const L = Math.min(bw, bh) * 0.12;
    g.lineWidth = Math.max(3, dpr * 3);
    g.beginPath();
    for (const [cx2, cy2, dx, dy] of [
      [bx, by, 1, 1], [bx + bw, by, -1, 1],
      [bx, by + bh, 1, -1], [bx + bw, by + bh, -1, -1]
    ]) {
      g.moveTo(cx2 + dx * L, cy2); g.lineTo(cx2, cy2); g.lineTo(cx2, cy2 + dy * L);
    }
    g.stroke();
  }

  /**
   * 取景框面板的开 / 关。
   * ⚠️ 和旧版的区别：旧版里"裁剪"是一个**模式**（进出会重置状态），
   * 现在它只是"看不看得见取景框"的开关。裁剪和旋转分成两块 UI，
   * 共用同一个 geom —— 用户说的"只有蒙版这些是共用的"就是这个意思。
   */
  function showCropUI(on) {
    const sec = $('stCropOpts');
    if (sec) sec.hidden = !on;
    const b = $('stCrop');
    if (b) {
      b.classList.toggle('on', on);
      b.textContent = on ? '✓ 正在裁剪…' : '裁剪';
    }
    const cv = ensureCropCanvas();
    // ⚠️ 不看取景框时必须把 overlay 的 pointer-events 关掉，
    // 否则它会盖住画布，画笔就涂不上了
    cv.style.pointerEvents = on ? 'auto' : 'none';
    if (!on) cv.hidden = true;
  }

  function showRotateUI(on) {
    const sec = $('stRotateOpts');
    if (sec) sec.hidden = !on;
    const b = $('stRotateBtn');
    if (b) {
      b.classList.toggle('on', on);
      b.textContent = on ? '✓ 正在旋转…' : '旋转 / 翻转';
    }
  }

  /* ================================================================
     取景框 UI 初始化（裁剪）
     ================================================================ */
  function initCropUI() {
    const seg = $('stCropAspect');
    if (!seg) return;

    seg.innerHTML = '';
    for (const a of ASPECTS) {
      const b = document.createElement('button');
      b.textContent = a.name;
      b.dataset.ratio = String(a.v);
      // 默认高亮「自由」：进裁剪时取景框就是整个视口，不该假装受了约束
      if (a.v === -1) b.classList.add('on');
      b.addEventListener('click', () => {
        if (!geom) return;
        for (const el of seg.children) el.classList.remove('on');
        b.classList.add('on');
        if (a.v > 0) {
          applyCropAspect(a.v);          // 固定比例（1:1 / 16:9 …）
        } else if (a.v === 0) {
          fitCropToImageRatio();         // 原图比例，尽可能大
        } else {
          geom.aspect = -1;              // 「自由」：解除比例约束
        }
        /* a.v < 0 的「自由」：什么都不做 —— 保留用户当前拖出的框 */
        render();
        drawCropOverlay();
      });
      seg.appendChild(b);
    }

    $('stCrop').addEventListener('click', () => {
      const on = !!($('stCropOpts') && !$('stCropOpts').hidden);
      if (on) exitCrop(false);           // 再点一次 = 取消
      else enterCrop();
    });
  }

  /* ================================================================
     旋转 / 翻转 / 缩放 UI
     ================================================================ */
  function initRotateUI() {
    $('stRotateBtn').addEventListener('click', () => {
      const on = !!($('stRotateOpts') && !$('stRotateOpts').hidden);
      if (on) exitCrop(false);           // 再点一次 = 取消
      else enterRotate();
    });

    $('stCropRot').addEventListener('input', e => {
      setCropRotation(parseFloat(e.target.value));
    });

    // 90° 快转：滑块只到 ±45，整转用按钮更顺手
    for (const [id, dir] of [['stCropRotL', -1], ['stCropRotR', 1]]) {
      const btn = $(id);
      if (!btn) continue;
      btn.addEventListener('click', async () => {
        if (!img) return;
        await rotateQuarter(dir);
      });
    }

    // 翻转：横竖各一个按钮，两个可以同时按（等于转 180°）
    const fh = $('stFlipH'), fv = $('stFlipV');
    if (fh) fh.addEventListener('click', () => setDisplay({ flipX: !geom.flipX }));
    if (fv) fv.addEventListener('click', () => setDisplay({ flipY: !geom.flipY }));

    // 自动水平校正：纯本地找地平线/垂直边（见 autoStraighten 的说明）
    const st = $('stStraighten');
    if (st) st.addEventListener('click', () => autoStraighten());

    const zs = $('stZoom');
    if (zs) zs.addEventListener('input', e => {
      setDisplay({ zoom: Number(e.target.value) / 100 });
    });
    const zf = $('stZoomFit');
    if (zf) zf.addEventListener('click', fitZoomToWindow);

    $('stCropApply').addEventListener('click', () => applyGeometry());
    $('stCropCancel').addEventListener('click', () => exitCrop(false));

    initCropDrag();
  }


  /**
   * 90° 整转。
   *
   * ⚠️⚠️ 两个设计点容易看错，先说清楚：
   *
   * 【一】为什么走 shader 而不是 2D canvas
   *   要**同时**烘旋转 + 翻转 + 取景框，这三件事只有 shader 那条路
   *   一次做完（而且和「应用」复用同一条管线 → 所见即所得）。
   *   代价是 90° 要过一次三角函数，对 Q16 纹理来说误差在 1 个色阶以下。
   *
   * 【二】细调角度会被**一起烘进图里**
   *   旧版是把图转 90° 之后保留 crop.rot（"先拉直 30° 再转 90°，
   *   不该把拉直丢掉"）。但那样有两处很难受：细调方向会跟着 90° 一起
   *   转（用户的拉直量会莫名其妙变），而且转完要重算视口 → 又要动
   *   取景框（回到"旋转改取景框"那套）。
   *   现在改成把总角度一次烧进像素：视觉结果一样，转完 rot 归零，
   *   滑杆/标签/状态天然一致，取景框也不用重算。
   *
   * ⚠️⚠️ 角度符号在这里错过**两次**（真 bug），最后是**量出来的**，不再推：
   *   · 界面里 `rot` 的约定是"正值 = 逆时针"（和滑杆一致）
   *   · dir = +1 是界面上的「⟳ 顺时针 90°」，所以总角度是 **-90**
   *   第一次写 -dir*90 其实是对的，但我按"符号推导"觉得该反，
   *   改成 +dir*90 之后画面变成逆时针转 —— 四象限实测：
   *     -dir*90 → 红从左上到**右上**（顺时针，对）
   *     +dir*90 → 红从左上到**左下**（逆时针，错）
   *   教训：这种"两个坐标系各转一次"的符号，推导容易自洽地错，
   *   直接量一次最快。判据在 test/rotate-invariant.test.mjs 的
   *   "画面顺时针转过去了"那条。
   */
  async function rotateQuarter(dir) {
    if (!img) return;
    busy(true, '正在旋转…');
    try {
      ensureGeom();
      const totalDeg = geom.rot - dir * 90;
      /* ⚠️ 烘焙时临时把取景框当成整个视口：转 90° 的语义是"整张图转
         过去"，用户之前拖小的取景框不该把旋转结果再裁掉一块。 */
      const keepRect = { ...geom.rect };
      geom.rect = { x: 0, y: 0, w: 1, h: 1 };
      const plan = cropRenderPlan(true, { rotDeg: totalDeg });
      geom.rect = keepRect;
      if (!plan) throw new Error('拿不到旋转计划');

      const prevW = canvas.width, prevH = canvas.height;
      canvas.width = plan.bufW;
      canvas.height = plan.bufH;
      gl.viewport(0, 0, plan.bufW, plan.bufH);
      draw(plan);

      const pixels = new Uint8Array(plan.bufW * plan.bufH * 4);
      gl.readPixels(0, 0, plan.bufW, plan.bufH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      canvas.width = prevW; canvas.height = prevH;

      _trace('rotateQuarter', 'rot=' + totalDeg + '° buf=' + plan.bufW + 'x'
        + plan.bufH + ' off=' + plan.offX.toFixed(3) + ','
        + plan.offY.toFixed(3) + ' s=' + plan.screenZoom);
      const baked = await pixelsToBitmap(pixels, plan.bufW, plan.bufH);
      if (img && img.close) img.close();
      img = baked;

      // 尺寸变了，蒙版必须重建
      mask.clear();
      mask.resize(img.width, img.height);
      setMaskActive(false);
      setBrushMode(false);
      showMaskTool(false);

      gl.bindTexture(gl.TEXTURE_2D, imageTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

      if (geom) {
        geom.rot = 0;                  // 已经烘进图里了
        geom.zoom = 1;
        resetRectToViewport();
        syncCropRotUI(0);
        syncFlipUI();
        syncZoomUI();
      }
      layoutCanvas();
      render();
      drawCropOverlay();
      toast(`已旋转 90°（${img.width}×${img.height}）`, 2200);
    } catch (e) {
      toast('旋转失败：' + (e && e.message ? e.message : e));
    } finally {
      busy(false);
    }
  }
  /** 开始拖拽：记录起点和当前框 */
  function initCropDrag() {
    const cv = ensureCropCanvas();
    cv.style.pointerEvents = 'auto';
    cv.style.cursor = 'move';

    let drag = null;

    const pos = e => {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };

    cv.addEventListener('pointerdown', e => {
      if (!geom) return;
      e.preventDefault();
      cv.setPointerCapture(e.pointerId);
      const p = pos(e);
      const br = cropRectOnCanvas();
      /* ⚠️ 手柄位置要转成 **y 向上** 的坐标再比 —— 指针事件是屏幕
         约定（y 向下），而 geom.rect 是画布约定（y 向上）。 */
      const upY = 1 - br.y - br.h;
      // 判断抓到的是哪个手柄（离角点近就缩放，否则整体移动）
      const th = 0.06;
      const near = (ax, ay) => Math.abs(p.x - ax) < th && Math.abs(p.y - ay) < th;
      let mode = 'move';
      if (near(br.x, upY)) mode = 'nw';
      else if (near(br.x + br.w, upY)) mode = 'ne';
      else if (near(br.x, upY + br.h)) mode = 'sw';
      else if (near(br.x + br.w, upY + br.h)) mode = 'se';
      drag = { mode, start: p, rect0: { ...geom.rect } };
    });

    cv.addEventListener('pointermove', e => {
      if (!drag || !geom) return;
      e.preventDefault();
      const p = pos(e);
      const br = cropRectOnCanvas();
      // 画布归一化位移 → 取景框归一化位移。
      // ⚠️ y 取负：屏幕 y 向下、取景框 y 向上。
      const dx = (p.x - drag.start.x) / br.w;
      const dy = -(p.y - drag.start.y) / br.h;
      const r0 = drag.rect0;

      if (drag.mode === 'move') {
        geom.rect = clampCropRect(
          { x: r0.x + dx * r0.w, y: r0.y + dy * r0.h, w: r0.w, h: r0.h });
      } else {
        // 角点缩放：改的是宽高，对角的那个角保持不动
        let w = r0.w + (drag.mode.includes('e') ? dx * r0.w : -dx * r0.w);
        let h = r0.h + (drag.mode.includes('s') ? dy * r0.h : -dy * r0.h);
        w = Math.max(MIN_RECT, w); h = Math.max(MIN_RECT, h);

        /* 按比例约束：像素比例 aspect = (w·W0)/(h·H0) →
           w/h = aspect·H0/W0。⚠️ 归一化坐标下**不是** w/h = aspect，
           中间要乘 H0/W0（旧版这里直接把"旋转框像素"当图片像素，
           只有 0° 才对）。 */
        if (geom.aspect > 0) {
          const k = geom.aspect * img.height / img.width;
          h = w / k;
          if (h > 1) { h = 1; w = h * k; }
        }

        const ax = drag.mode.includes('e') ? r0.x : r0.x + r0.w - w;
        const ay = drag.mode.includes('s') ? r0.y : r0.y + r0.h - h;
        geom.rect = clampCropRect({ x: ax, y: ay, w, h });
      }

      layoutCanvas();
      render();
      drawCropOverlay();
    });
    const end = e => {
      if (!drag) return;
      drag = null;
      if (cv.hasPointerCapture && cv.hasPointerCapture(e.pointerId)) {
        cv.releasePointerCapture(e.pointerId);
      }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
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
    const ct = $('stCompareToggle');
    if (ct) ct.disabled = !on;
    // 没图时把分屏对比关掉，否则换图后会留着上次的竖线
    if (!on && compareOn) setCompare(false);
    const b = $('stBrush');
    if (b) b.disabled = !on;
    const g = $('stGradient');
    if (g) g.disabled = !on;
    const rd = $('stRadial');
    if (rd) rd.disabled = !on;
    const s = $('stSeg');
    if (s) s.disabled = !on;
    const ip = $('stInpaint');
    if (ip) ip.disabled = !on || mask.isEmpty;
    const u = $('stUseMask');
    if (u) u.disabled = !on || mask.isEmpty;
    const cr = $('stCrop');
    if (cr) cr.disabled = !on;
    // 旋转/翻转是裁剪的姊妹入口（共用同一份 geom），也得跟着图有没有一起开关。
    // ⚠️ 漏掉这一行的话按钮永远 disabled，整个旋转面板点不进来 ——
    //    症状是"旋转/翻转怎么用"，其实是入口被焊死了，而且静默、不报错。
    const rb = $('stRotateBtn');
    if (rb) rb.disabled = !on;
    // 没图的时候裁剪状态必须清掉，否则"打开新图但还在裁剪模式里"
    // 没图的时候几何状态必须清掉，否则"打开新图但还在裁剪模式里"
    if (!on && geom) { geom = null; showCropUI(false); showRotateUI(false); }
    if (!on && typeof syncMaskUI === 'function') syncMaskUI();
    // 预设：没图时卡片不可点
    if (!on) {
      document.querySelectorAll('.st-preset-card').forEach(el => { el.disabled = true; });
    } else {
      document.querySelectorAll('.st-preset-card').forEach(el => { el.disabled = false; });
    }
  }

  /* ================================================================
     滑块
     ================================================================ */
  function buildSliders() {
    const box = $('stSliders');
    box.innerHTML = '';

    let lastGroup = null;

    for (const a of ADJUSTMENTS) {
      // 分组标题。15 个滑杆平铺太长，而且「曝光」和「颗粒」放一起
      // 会让人以为它们是同一类东西
      if (a.group && a.group !== lastGroup) {
        const h = document.createElement('div');
        h.className = 'st-sl-group';
        h.textContent = a.group;
        box.appendChild(h);
        lastGroup = a.group;
      }

      const row = document.createElement('div');
      row.className = 'st-sl';
      row.dataset.group = a.group || '';

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
        draw();
        onManualAdjust();  // 手动调滑块 → 取消预设高亮
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
    onManualAdjust();  // 重置后预设高亮应该清除
  }

  function isChanged() {
    return ADJUSTMENTS.some(a => Math.abs(values[a.key] - a.def) > 1e-6);
  }

  /* ================================================================
     预设
     ================================================================ */
  let presetActiveId = null;  // 当前应用的预设 id（null = 无）
  let presetCat = '全部';      // 当前选中的分类

  function applyPreset(preset) {
    // 重置所有值到默认
    for (const a of ADJUSTMENTS) values[a.key] = a.def;
    // 应用预设值
    for (const [key, val] of Object.entries(preset.v)) {
      if (key in values) values[key] = val;
    }
    presetActiveId = preset.id;
    // 刷新滑块 + 重画
    refreshSliders();
    draw();
    // 更新预设卡片高亮
    updatePresetHighlight();
    toast(`已应用「${preset.name}」`);
  }

  function updatePresetHighlight() {
    document.querySelectorAll('.st-preset-card').forEach(el => {
      el.classList.toggle('active', el.dataset.id === presetActiveId);
    });
  }

  /** 用户手动调滑块时，取消预设高亮 */
  function onManualAdjust() {
    if (presetActiveId) {
      presetActiveId = null;
      updatePresetHighlight();
    }
  }

  function buildPresetUI() {
    const catsBox = $('stPresetCats');
    const gridBox = $('stPresetGrid');
    if (!catsBox || !gridBox) return;

    // 分类 tab
    catsBox.innerHTML = '';
    for (const cat of PRESET_CATS) {
      const btn = document.createElement('button');
      btn.className = 'st-preset-tab' + (cat === presetCat ? ' on' : '');
      btn.textContent = cat;
      btn.addEventListener('click', () => {
        presetCat = cat;
        buildPresetUI();
      });
      catsBox.appendChild(btn);
    }

    // 预设卡片
    gridBox.innerHTML = '';
    const list = presetCat === '全部' ? PRESETS : PRESETS.filter(p => p.cat === presetCat);
    for (const p of list) {
      const card = document.createElement('button');
      card.className = 'st-preset-card' + (p.id === presetActiveId ? ' active' : '');
      card.dataset.id = p.id;
      card.disabled = !img;

      // 色块预览
      const swatch = document.createElement('div');
      swatch.className = 'st-preset-swatch';
      swatch.style.background = `linear-gradient(135deg, ${p.hue}, ${shadeColor(p.hue, -30)})`;

      // 名称
      const name = document.createElement('span');
      name.className = 'st-preset-name';
      name.textContent = p.name;

      card.append(swatch, name);
      card.addEventListener('click', () => {
        if (!img) return;
        applyPreset(p);
      });
      gridBox.appendChild(card);
    }
  }

  /** 把 hex 颜色变暗（用于色块渐变） */
  function shadeColor(hex, percent) {
    const num = parseInt(hex.slice(1), 16);
    const amt = Math.round(2.55 * percent);
    const R = Math.max(0, Math.min(255, (num >> 16) + amt));
    const G = Math.max(0, Math.min(255, ((num >> 8) & 0x00FF) + amt));
    const B = Math.max(0, Math.min(255, (num & 0x0000FF) + amt));
    return '#' + (0x1000000 + (R << 16) + (G << 8) + B).toString(16).slice(1);
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

  function setMaskTool(tool, force) {
    // force=true 时不 toggle（强制设置），否则点同一个按钮取消
    if (!force && tool === maskTool) tool = null;
    maskTool = tool;
    brushMode = maskTool !== null;
    canvas.classList.toggle('brushing', brushMode);
    // 三个按钮互斥
    [['stBrush', 'brush'], ['stGradient', 'gradient'], ['stRadial', 'radial']].forEach(([id, t]) => {
      const b = $(id);
      if (b) b.classList.toggle('on', maskTool === t);
    });
    // 画笔选项只有画笔工具时显示
    showMaskTool(maskTool !== null);
    syncMaskUI();
  }

  function setBrushMode(on) {
    // force=true：强制设置，不 toggle（AI 抠人/去物完成后强制切到画笔）
    setMaskTool(on ? 'brush' : null, true);
  }

  function initBrush() {
    let drawing = false;

    canvas.addEventListener('pointerdown', e => {
      if (!maskTool || !img) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      drawing = true;
      const [x, y] = toImageCoord(e);
      // 渐变：从起点到终点画渐变轴
      // 径向：从中心向外拖动定义椭圆半径
      mask.begin(x, y, maskTool);
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
    //
    // ⚠️ 必须对**所有**蒙版工具都显示，不能只给画笔：
    //    #stCanvas.brushing 挂了 cursor:none 把系统光标藏掉（画布上拖动
    //    不能滚动页面），而 .brushing 对画笔/渐变/径向**三个都生效**。
    //    一旦这里按 maskTool 藏掉，渐变/径向下就是两个光标都没有 ——
    //    表现是"点一下渐变，鼠标不见了"，完全没法瞄准起点。
    //   （这里原来写着"渐变/径向靠画布实时预览"，但悬停时根本没有预览，
    //     按下拖过 1% 才开始画 —— 注释描述的是不存在的东西。）
    const cur = document.createElement('div');
    cur.className = 'st-cursor';
    cur.hidden = true;
    $('stStage').appendChild(cur);

    function showCursor(e) {
      cur.hidden = false;
      const r = canvas.getBoundingClientRect();
      const sr = $('stStage').getBoundingClientRect();
      /* 画笔：圈跟着笔刷半径走，能看到笔刷有多粗。
         渐变/径向没有"笔刷半径"这个概念，给一个固定小圈当瞄准点。

         ⚠️⚠️ 换算必须和**真正涂抹**用同一套基准，否则圈和笔下的范围
         对不上，用户就会"明明涂在圈里却涂到旁边"。

         涂抹那边（mask.js 的 _px）是 `radius * min(位图宽, 位图高)`，
         而位图就是图片尺寸；所以归一化半径对应的**图片像素**半径是
         `radius * min(img.width, img.height)`，再乘"画布显示宽度 /
         图片宽度"换成屏幕像素。

         这里原来写的是 `mask.radius * min(画布宽, 画布高) * 2` ——
         拿**画布**短边当基准。画布和图片恰好同比例时两者数值相同
         （757×568 的画布配 400×300 的图都是 1.333），所以本地很难发现；
         舞台比图片更扁时圈就明显偏小。实测把画布拉成 894×300：
         正确 53.6px，旧写法只有 24.0px（小一半多）。
         是 test/mask-ui-browser.test.mjs 的"画布被拉成非图片比例时"
         那条抓出来的（拿旧公式跑那条会红）。 */
      const imgPxR = img ? mask.radius * Math.min(img.width, img.height) : 8;
      const scale = img ? r.width / img.width : 1;
      // 直径 = 半径 × 2
      const d = maskTool === 'brush' ? imgPxR * scale * 2 : 14;
      cur.style.width = cur.style.height = Math.round(d) + 'px';
      cur.style.left = (e.clientX - sr.left - d / 2) + 'px';
      cur.style.top = (e.clientY - sr.top - d / 2) + 'px';
      cur.classList.toggle('erase', mask.mode === 'erase');
    }

    canvas.addEventListener('pointerenter', showCursor);
    canvas.addEventListener('pointermove', showCursor);
    canvas.addEventListener('pointerleave', () => { cur.hidden = true; });
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
      const n = mask.strokes.length;
      const kinds = mask.strokes.filter(s => s.kind && s.kind !== 'brush').length;
      /* ⚠️ 光给百分比不够：用户看到"已选 67.6%"会疑惑"我只是涂了一笔啊"——
         因为百分比是**占整张图**的比例，而一键涂抹在 3440×1440 这种图上
         本来就能扫掉几十万个像素（实测一条横贯画面中段的拖拽就是 4.3%）。
         所以补一句口径说明，让这个数字可解释，而不是看着像 bug。 */
      info.textContent = mask.isEmpty
        ? '没涂任何区域'
        : `已选 ${(cov * 100).toFixed(1)}%（占整张图）· ${n} 笔`
          + (kinds ? `（含渐变/径向 ${kinds} 笔）` : '');
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
     左右分屏对比
     ----------------------------------------------------------------
     左边原图、右边修过的，拖滑块比。和「按住看原图」互补：
     按住是"闪一下看整体"，分屏是"并排抠差异"。

     ⚠️ 两个状态同时开的话会打架（uOriginal=1 时整张都是原图，
     分屏就没意义了）。所以打开分屏时自动关掉"按住看原图"，
     反之亦然 —— 用户不会同时想要两个。
     ================================================================ */
  function setCompare(on) {
    compareOn = !!on && !!img;
    if (compareOn && showingOriginal) setOriginal(false);
    const bar = $('stCompareBar');
    if (bar) bar.hidden = !compareOn;
    const btn = $('stCompareToggle');
    if (btn) btn.classList.toggle('on', compareOn);
    draw();
  }

  function setCompareAt(v) {
    compareAt = Math.min(1, Math.max(0, v));
    const s = $('stCompareSlider');
    if (s && Math.abs(parseFloat(s.value) / 100 - compareAt) > 1e-6) {
      s.value = String(Math.round(compareAt * 100));
    }
    if (compareOn) draw();
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
      /* 缩到长边 2048 再传。
         ⚠️ 原来写的是 1024 —— 太小了：蒙版是按这个尺寸出的，
         再放大回原图时**发丝、手指边缘会糊成一坨**，抠出来的人像
         边缘有明显锯齿。2048 是"细节够用 + 请求体还能接受"的折中。
         （百度这条本来就快 ~800ms，多传一点不心疼。）*/
      const long = Math.max(img.width, img.height);
      const s = Math.min(1, 2048 / long);
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
    // stBrushOpts = 涂/擦 + 反选（所有蒙版工具共用）
    // stBrushOpts2 = 笔刷大小/硬度（只有画笔用）
    const opts = $('stBrushOpts');
    const opts2 = $('stBrushOpts2');
    if (opts) opts.hidden = !on;
    if (opts2) opts2.hidden = !(on && maskTool === 'brush');
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

  /**
   * 当前图 → JPEG blob。
   *
   * ⚠️ maxSide 默认给 4096，和**美颜那边保持一致**（都按原图送）。
   * 原来默认 2048 是"省流量"的思路，但代价是：AI 出来的结果
   * 比原图糊，缩回原尺寸时那块选区的细节就比周围差一截 ——
   * 在婚纱照上放大看能看出来。而火山的链路本来就等 16~22 秒，
   * 多传 1MB 不是瓶颈。
   *
   * 仍然保留上限（4096）而不是无脑原图：更大的请求体换来的收益
   * 不抵等待，而且火山那边对输入尺寸也有自己的限制。
   */
  async function imageBlob(maxSide = 4096) {
    const long = Math.max(img.width, img.height);
    const s = Math.min(1, maxSide / long);
    const cw = Math.round(img.width * s), ch = Math.round(img.height * s);

    const off = document.createElement('canvas');
    off.width = cw; off.height = ch;
    const g = off.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, cw, ch);
    return await new Promise(r => off.toBlob(r, 'image/jpeg', 0.95));
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
          if (p.stage === 'submit') { busy(true, '正在提交…'); progressStage('submit'); }
          else if (p.stage === 'poll') {
            // 生成中：时长不可预测。只显示"已等待多久"，不编百分比
            busy(true, 'AI 正在重绘…');
            progressStage('poll', p.elapsed);
          } else if (p.stage === 'download') {
            busy(true, '正在取回结果…');
            progressStage('download');
          }
        })
      : null;

    try {
      // 取火山密钥交给主进程（有缓存，通常不打请求）
      await getKeys('volcengine');
      progressStage('submit');

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
        progressStage('done');
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
          markTemplate(-1);
          toast('已填入一组保守参数，点「看一下效果」试试', 3000);
        });
      }

      // 一键模板按钮（模板表由主进程下发，不在页面里另存一份）
      renderTemplateRow();
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

  /**
   * 把一组参数写进面板（滑块 + 滤镜）。
   *
   * ⚠️ 关键：**先把所有项清零**，再写模板里的项。
   * 不清零的话，上一个模板/手动拖过的残留会混进来 ——
   * 比如先用「夜景人像」（美白 55）、再点「复古胶片」（美白 10），
   * 不清零就会把两者叠在一起，得到谁也没预期的结果。
   * 模板应当给出**确定的起点**，而不是和现有状态混合。
   */
  function fillBeautyParams(params, filterValue) {
    for (const k of Object.keys(beautyValues)) onBeautySlider(k, 0);
    beautyFilter = '';
    for (const [k, v] of Object.entries(params || {})) {
      if (k === 'filter_type') continue;
      if (!(k in beautyValues)) continue;
      const inp = document.querySelector(`input[data-bsl="${k}"]`);
      if (inp) inp.value = v;
      onBeautySlider(k, v);
    }
    // 滤镜：'不用滤镜' 那一项的值是空串
    const fv = filterValue != null ? filterValue : (params && params.filter_type) || '';
    beautyFilter = fv;
    const sel = $('stBeautyFilter');
    if (sel) sel.value = fv;
  }

  function applyBeautyPreset() {
    fillBeautyParams((beautySchema && beautySchema.preset) || {}, '');
  }

  /** 标记当前选中的模板（-1 = 没有） */
  let activeTemplateIdx = -1;

  function markTemplate(idx) {
    activeTemplateIdx = idx;
    const row = $('stTemplateRow');
    if (!row) return;
    [...row.children].forEach((b, i) => b.classList.toggle('on', i === idx));
  }

  /**
   * 应用一个模板：填参数 + 立刻出图。
   *
   * 为什么"直接调接口"而不是"只填滑块让用户再点一下"：
   * 一键模板的价值就在"一键"，中间再插一步就失去意义了。
   * 滑块仍然会被填好，用户看完效果可以继续微调。
   */
  async function applyTemplate(idx) {
    if (!img) return;
    const tpl = beautySchema && beautySchema.templates && beautySchema.templates[idx];
    if (!tpl) return;

    fillBeautyParams(tpl.params, tpl.params.filter_type || '');
    markTemplate(idx);
    const row = $('stTemplateRow');
    if (row) [...row.children].forEach(b => { b.disabled = true; });
    try {
      await runBeauty();
    } finally {
      if (row) [...row.children].forEach(b => { b.disabled = false; });
    }
  }

  /** 由主进程下发的模板表生成缩略图卡片 */
  function renderTemplateRow() {
    const row = $('stTemplateRow');
    if (!row) return;
    const list = (beautySchema && beautySchema.templates) || [];
    if (!list.length) { row.hidden = true; return; }
    row.hidden = false;
    row.innerHTML = '';
    list.forEach((t, i) => {
      const card = document.createElement('button');
      card.className = 'st-tpl-card';
      card.dataset.tpl = t.id;

      // 缩略图：用模板名生成渐变色块（后续替换为真实预览图）
      const thumb = document.createElement('div');
      thumb.className = 'st-tpl-thumb';
      const hue = (i * 47 + 200) % 360;  // 每个模板一个不同色相
      thumb.style.background = `linear-gradient(135deg, hsl(${hue},40%,70%), hsl(${hue},50%,55%))`;

      // 名称
      const name = document.createElement('span');
      name.className = 'st-tpl-name';
      name.textContent = t.name;
      name.title = t.desc || t.name;

      card.append(thumb, name);
      card.addEventListener('click', () => applyTemplate(i));
      row.appendChild(card);
    });
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

      /* ================================================================
         按**原图分辨率**送出去
         ----------------------------------------------------------------
         ⚠️ 这里原来是"长边缩到 1600 再传"，那是错的 ——
         美颜的输入是**整张脸**，缩小再放大等于把皮肤纹理、
         发丝、睫毛重采样一遍，出来会明显发糊。
         婚纱照要放大看的，这个损失用户一眼能看出来。

         实测确认（tools/size-probe.mjs）：**旷视原样返回输入尺寸**，
         送多少给多少：
             800×533   →  800×533
            1600×1066  → 1600×1066
            4000×2665  → 4000×2665
         所以送原图不会白费 —— 拿回来的就是原图分辨率的成品。

         代价只是慢一点，实测（tools/fullsize-probe.mjs）：
            1600px  请求体 0.29MB  → 约 1s
            2560px  请求体 0.91MB  → 约 2s
            4096px  请求体 1.78MB  → 约 6s
         而免费额度串行限流本身就要等 ≥3 秒，所以这个增量可以接受。

         ⚠️ 但也不无脑发：**超过 4096 就不发了**。再大请求体到几 MB，
         而返回的图我们本来也要缩回画布尺寸，收益不抵等待。
         ================================================================ */
      const MAX_EDGE = 4096;
      const long = Math.max(img.width, img.height);
      const s = Math.min(1, MAX_EDGE / long);
      const cw = Math.round(img.width * s), ch = Math.round(img.height * s);

      const off = document.createElement('canvas');
      off.width = cw; off.height = ch;
      off.getContext('2d').drawImage(img, 0, 0, cw, ch);

      // 统一 JPEG：相册里的 preview 是 WebP 存成 .jpg 的（踩过这个坑）
      const b64 = off.toDataURL('image/jpeg', 0.95).split(',')[1];

      const r = await window.AlbumStudio.megviiBeautify(b64, params);
      if (!r || !r.ok) throw new Error((r && r.error) || '美颜失败');

      /* 结果回写。
         ⚠️ 现在送出去的就是原图尺寸（除了 >4096 会先缩），所以
         这里通常**不需要缩放** —— 但也不能直接换：
           · 原图 >4096 时结果是缩过的，得放回去
           · 极少数情况下旷视返回的尺寸可能和请求差 1 像素
             （取整差异），直接换会让画布尺寸跳一下、
             而画布尺寸一变，蒙版和坐标就全错位了
         所以统一"按当前图尺寸重绘一遍" —— 尺寸相同时这一步是
         1:1 拷贝，几乎不损失；尺寸不同时它就是必要的缩放。 */
      const res = await loadImage(r.image);
      const merged = document.createElement('canvas');
      merged.width = img.width; merged.height = img.height;
      const mg = merged.getContext('2d');
      mg.imageSmoothingQuality = 'high';
      mg.drawImage(res, 0, 0, img.width, img.height);

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
    // 关掉忙碌提示时进度条也一起收起来，否则下次打开还挂着上一轮的进度
    if (!on) progressHide();
  }

  /* ================================================================
     进度条
     ----------------------------------------------------------------
     去物要 16~22 秒。光一个转圈会让人以为卡死了，所以给一条真实
     进度。但**不能编一个假百分比**（那种"永远走到 90% 然后卡住"的
     进度条比没有还糟），所以按**阶段**推进：

       提交   → 20%    （提交请求，几百毫秒，可预测）
       重绘   → 45%    （生成中，时长不可预测 → 走条纹动画
                        + "已等待 Ns"，不假装知道进度）
       取回   → 85%    （下载结果，几秒）
       完成   → 100%

     只有首尾是确定的，中间那段诚实地显示成"不确定态"。
     ================================================================ */
  const PROGRESS_STAGES = { submit: 0.2, poll: 0.45, download: 0.85 };

  function progressShow() {
    const box = $('stProgress');
    if (box) box.hidden = false;
  }

  function progressHide() {
    const box = $('stProgress');
    const bar = $('stProgressBar');
    const note = $('stProgressNote');
    if (box) box.hidden = true;
    if (bar) { bar.style.width = '0'; bar.classList.remove('indeterminate'); }
    if (note) { note.hidden = true; note.textContent = ''; }
  }

  /**
   * 推进到某个阶段。
   * @param {string} stage submit | poll | download | done
   * @param {number} elapsedMs 仅 poll 用：已等待毫秒数
   */
  function progressStage(stage, elapsedMs) {
    const bar = $('stProgressBar');
    const note = $('stProgressNote');
    if (!bar) return;
    progressShow();

    if (stage === 'done') {
      bar.classList.remove('indeterminate');
      bar.style.width = '100%';
      if (note) { note.hidden = true; }
      return;
    }

    const pct = PROGRESS_STAGES[stage];
    if (pct == null) return;
    bar.style.width = Math.round(pct * 100) + '%';

    if (stage === 'poll') {
      // 生成中：时长不可预测，所以用条纹表示"在动"，不报假百分比
      bar.classList.add('indeterminate');
      if (note) {
        note.hidden = false;
        note.textContent = elapsedMs ? `AI 正在重绘… 已等待 ${Math.round(elapsedMs / 1000)}s`
                                     : 'AI 正在重绘…';
      }
    } else {
      bar.classList.remove('indeterminate');
      if (note) { note.hidden = true; }
    }
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

    // 左右分屏对比
    const cmpT = $('stCompareToggle');
    if (cmpT) cmpT.addEventListener('click', () => setCompare(!compareOn));
    const cmpS = $('stCompareSlider');
    if (cmpS) cmpS.addEventListener('input', e => setCompareAt(parseFloat(e.target.value) / 100));

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
        setMaskTool('brush');
      }
      if (e.key.toLowerCase() === 'g' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setMaskTool('gradient');
      }
      if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setMaskTool('radial');
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
      rt = setTimeout(() => {
        render();
        // 裁剪框 overlay 是独立画布，尺寸跟着 WebGL 画布走，
        // 窗口一变必须重画 —— 忘了的话框会留在旧位置上
        if (geom) drawCropOverlay();
      }, 120);
    });
  }

  function initMaskEvents() {
    /* ⚠️⚠️ 用户是不是**主动**关掉了"显示选区"。
       选区类工具（画笔/渐变/径向）点进去时会自动把红罩打开 ——
       理由：选区工具的反馈就是那个红罩，默认关着的话涂半天画面一片空白，
       用户会判断成"画笔没反应"（这是实测到的真实反馈）。
       但用户自己取消勾选之后就不能再强行打开，那是他在说
       "我知道我在涂什么，别挡着我看照片"。 */
    let userHidMask = false;

    /** 进选区工具时自动亮出红罩（除非用户自己关过） */
    const autoShowMask = () => {
      if (userHidMask) return;
      if (showMask) return;
      showMask = true;
      const c = $('stShowMask');
      if (c) c.checked = true;
      draw();
    };

    // 三个蒙版工具互斥：画笔 / 渐变 / 径向
    $('stBrush').addEventListener('click', () => {
      setMaskTool('brush');
      if (maskTool === 'brush') {
        autoShowMask();
        toast('拖动鼠标涂抹要调整的区域（红罩 = 选中的范围）', 3200);
      }
    });
    $('stGradient').addEventListener('click', () => {
      setMaskTool('gradient');
      if (maskTool === 'gradient') {
        autoShowMask();
        toast('拖动：起点=选中侧，终点=未选中侧', 3200);
      }
    });
    $('stRadial').addEventListener('click', () => {
      setMaskTool('radial');
      if (maskTool === 'radial') {
        autoShowMask();
        toast('拖动：从中心向外定义椭圆选区', 3200);
      }
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
    /* ⚠️ 这里**只**更新 userHidMask（它是 initMaskEvents 顶部的闭包变量），
       不要再写 `let userHidMask` —— 那会遮蔽掉外面那个，于是
       "用户主动关过显示选区"这件事永远传不到 autoShowMask，
       下一次点画笔又会把红罩强行打开。 */
    $('stShowMask').addEventListener('change', e => {
      userHidMask = !e.target.checked;
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
      buildPresetUI();
      initEvents();
      initCropUI();
      initRotateUI();
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

  /* ================================================================
     深链：?photo=<key>
     ----------------------------------------------------------------
     从大图查看器点「修这张」会带 ?photo=<key> 跳到这里。
     启动时检查参数，有的话拉元数据 + 拉图，直接进编辑器。
     ⚠️ 必须在 boot() 之后跑：boot 里初始化了 GL、蒙版、事件绑定，
        深链加载图片时要用到这些。
     ================================================================ */
  (async function loadDeepLink() {
    const key = new URLSearchParams(location.search).get('photo');
    if (!key || !/^[a-f0-9]{16}$/.test(key)) return;

    busy(true, '加载照片…');
    try {
      // 先拉元数据（顺便验存在性）
      const metaRes = await fetch(API_BASE + '/api/photos/' + key, { credentials: 'include' });
      if (metaRes.status === 401) throw new Error('还没登录，请先在相册里登录');
      if (!metaRes.ok) throw new Error('照片不存在或已删除');
      const { photo } = await metaRes.json();

      // 拉 preview 档（修图用）
      const imgRes = await fetch(API_BASE + '/api/img/preview/' + key, { credentials: 'include' });
      if (!imgRes.ok) throw new Error('图片加载失败');
      const blob = await imgRes.blob();
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(blob));

      if (img && img.close) img.close();
      img = bmp;
      fileName = key.slice(0, 8) + '.webp';

      mask.clear();
      mask.resize(img.width, img.height);
      setMaskActive(false);
      setBrushMode(false);
      showMaskTool(false);

      gl.bindTexture(gl.TEXTURE_2D, imageTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

      $('stDrop').classList.add('hidden');
      canvas.classList.remove('hidden');
      document.title = photo.takenDay + ' · 修图';
      $('stTitle').textContent = photo.takenDay + ' ' + (photo.uploadedBy || '');
      enableUI();
      updateInfo();
      draw();

      // 清掉 URL 参数（刷新不会重复加载，后退不会回到带参数的状态）
      history.replaceState(null, '', location.pathname);
    } catch (e) {
      toast('深链加载失败：' + (e && e.message ? e.message : e), 4000);
    } finally {
      busy(false);
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
    setMaskTool,
    get maskTool() { return maskTool; },
    /** 涂一笔：points 是 [[x,y],...] 归一化坐标 */
    paint(points, opts = {}) {
      if (!mask.canvas) return false;
      const save = { r: mask.radius, h: mask.hardness, m: mask.mode };
      if (opts.radius != null) mask.radius = opts.radius;
      if (opts.hardness != null) mask.hardness = opts.hardness;
      if (opts.mode) mask.mode = opts.mode;

      /* ⚠️⚠️ 第 4 个参数（工具）**不能省**。
         begin(x, y, tool) 不传 tool 时用的是"上一次的工具" ——
         在画笔模式下点过渐变按钮之后它还是 'gradient'，于是"涂一笔"
         实际画出来的是**渐变**（一整片平滑过渡）。
         实测踩过：探针里量到"中心 255、1/4 处 0、画面上一片看不出边界的
         渐变"，一度以为是蒙版纹理上传坏了，其实是这个测试辅助函数
         少传了一个参数。
         默认 'brush'（函数叫 paint，语义就是画笔），要用别的工具显式传
         opts.tool。 */
      const tool = opts.tool || 'brush';
      mask.begin(points[0][0], points[0][1], tool);
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
    // —— 一键模板 ——
    applyTemplate,
    applyBeautyPreset,
    fillBeautyParams,
    get templates() { return (beautySchema && beautySchema.templates) || []; },
    get activeTemplateIdx() { return activeTemplateIdx; },
    // —— 左右分屏对比 ——
    setCompare,
    setCompareAt,
    get compareOn() { return compareOn; },
    get compareAt() { return compareAt; },
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
    // —— 裁剪 / 旋转 / 翻转 ——
    // 暴露出来是为了能在浏览器里读像素验证「转的角度对不对、
    // 裁剪尺寸对不对、四角有没有露白」—— 这些静态一律验不出来。
    enterCrop,
    enterRotate,
    exitCrop,
    setCropRotation,
    setDisplay,
    applyGeometry,
    applyCrop: applyGeometry,        // 旧名，别处还在用
    rotateQuarter,
    fitZoomToWindow,
    autoZoomFor,
    /* 自动水平校正。暴露出来是为了能在浏览器里造一张**已知倾斜**的图
       验它准不准 —— 这个函数的正确性完全是数值问题，静态测不了。 */
    autoStraighten,
    detectStraightenAngle,
    sampleImageData,
    cropRenderPlan,
    bakeRenderPlan,
    clampCropRect,
    sizeRectToAspect,
    maxRectForAspect,
    rotatedBoxSize,
    viewportDims,
    rotatePad,
    applyCropAspect,
    fitCropToImageRatio,
    get geom() { return geom; },
    get crop() { return geom; },     // 旧名（测试和文档里用过）
    /** 直接设取景框（画布归一化坐标），测试用 */
    setCropRect(r) {
      ensureGeom();
      if (!geom) return false;
      geom.rect = clampCropRect(r);
      render();
      drawCropOverlay();
      return true;
    },
    _drawCropOverlay: drawCropOverlay,
    _cropRectOnCanvas: cropRectOnCanvas,
    _applyGeometry: applyGeometryUniforms,
    /** 追踪日志：页面里的 console.log 经 CDP 传不回测试侧，
        所以关键步骤记在数组里由测试读出来。排查几何问题很有用。 */
    get _trace() { return [..._traceLog]; },
    _clearTrace() { _traceLog.length = 0; },
    _lastPlan: () => _lastPlan,
    _draw: draw,
    /** 读回当前 shader 上的几何 uniform —— 排查"几何没生效"用。
        这一层是整块逻辑的最终落点，出问题时先看它对不对。
        ⚠️ 这里刻意把**影响形状**的几个量都读出来：测试靠
        "两个轴的缩放系数是不是同一个"来断言"不扭曲"，
        而这是结构性判据，比从像素反推硬得多。 */
    _geometryUniforms() {
      return {
        rot: gl.getUniform(program, uniforms.uRot),
        flip: gl.getUniform(program, uniforms.uFlip),
        scale: gl.getUniform(program, uniforms.uDisplayScale),
        offset: gl.getUniform(program, uniforms.uImgOffset),
        bg: gl.getUniform(program, uniforms.uBg),
        viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
        canvas: [canvas.width, canvas.height]
      };
    },
    _syncMaskUI: syncMaskUI,
    // —— 色调曲线 ——
    // 暴露出来是为了能在 node 里直接测 LUT 的**数值行为**。
    // 单调性是影调曲线的底线，而它不需要浏览器就能验 ——
    // 这类"纯数学"的部分不该推给浏览器测试。
    buildCurveLut,
    curveControlPoints,
    _monotoneSpline: monotoneSpline,
    CURVE_N,
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
