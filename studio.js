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
    uniform float uAspect;     // 图片宽高比，暗角要按比例算才不变形
    uniform float uRot;        // 旋转角（弧度，逆时针）
    uniform vec2 uUvScale;     // 采样缩放 x/y（分开：旋转后两轴比例不同）
    uniform vec2 uCropOffset;  // 裁剪中心在原图中的偏移（相对 0.5 中心的归一化值）

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
         几何变换：裁剪 + 旋转
         ----------------------------------------------------------------
         先算出「画布上这个像素对应原图的哪个位置」，后面的采样/锐化/蒙版
         全都用这个 u。这样只需改一处，整条管线自动跟着走。

         ⚠️ 用 u 而不是就地改 vUv：蒙版是按**原图坐标**存的
         （mask.js 写的是图片坐标，和 vUv 同一套语义），
         所以蒙版必须继续用 vUv 采样 —— 用 u 的话蒙版会跟着一起转，
         涂了人脸结果局部调整跑到别处去了。

         ⚠️ 只有「非恒等」时才启用。crop 模式下必然非恒等；
         正常编辑时 rot=0 且 uvScale=1 且 offset=0，是恒等变换。
         ================================================================ */
      vec2 u = vUv;
      if (uRot != 0.0 || uUvScale != vec2(1.0) || uCropOffset != vec2(0.0)) {
        vec2 p = (vUv - 0.5) * uUvScale + uCropOffset;
        float ca = cos(uRot), sa = sin(uRot);
        p = mat2(ca, sa, -sa, ca) * p;
        u = p + 0.5;
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
    uniforms.uAspect = gl.getUniformLocation(program, 'uAspect');
    uniforms.uRot = gl.getUniformLocation(program, 'uRot');
    uniforms.uUvScale = gl.getUniformLocation(program, 'uUvScale');
    uniforms.uCropOffset = gl.getUniformLocation(program, 'uCropOffset');
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
    gl.uniform1f(uniforms.uAspect, img.width / img.height);

    // 几何变换：有裁剪就喂裁剪参数，没有就走恒等 ——
    // ⚠️ 恒等分支不能省：uniform 是**全局状态**，上一次裁剪留下的值
    // 会一直生效，表现是"取消裁剪之后照片还是歪的"。
    if (crop) {
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
    _trace('layoutCanvas', img.width + 'x' + img.height + ' crop=' + !!crop
      + ' stageW=' + ($('stStage') || {}).clientWidth);

    // 裁剪模式下画布尺寸由「取景框比例」决定，不是原图比例
    if (crop) {
      const plan = cropRenderPlan(false);
      if (plan) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = plan.outW;
        canvas.height = plan.outH;
        canvas.style.width = Math.round(plan.outW / dpr) + 'px';
        canvas.style.height = Math.round(plan.outH / dpr) + 'px';
        gl.viewport(0, 0, canvas.width, canvas.height);
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
     裁剪 + 旋转
     ================================================================
     这是本项目里第一组**几何**变换，和之前的像素级调整完全不同：
     它会改变输出尺寸和坐标系。所以做法上刻意保守：

       · 参数化（不是累积变换）：只存「旋转角 + 裁剪框」两个状态，
         每次渲染从零算一遍。累积矩阵一旦出错会越滚越离谱，
         而且没法"重置"。
       · **应用时烘焙**成新图，不长期挂着变换。

     ⚠️ 为什么不把变换长期挂在渲染链上（像 Lightroom 那样非破坏）：
     我们整个坐标系建立在「画布像素 ↔ 原图归一化坐标」这个恒等关系上
     —— 画笔、蒙版、AI 的 bbox、暗角的 uAspect 全都依赖它。
     长期挂变换意味着要把这条关系改成复合映射，改动面覆盖
     蒙版引擎、画笔、去物、美颜、导出，而且每一处都要单独验证。
     烘焙的代价是「应用后不能撤销到变换前的调整」，
     收益是其余所有功能完全不用动 —— 这个取舍是划算的。

     ----------------------------------------------------------------
     坐标系（这是最容易搞错的地方，先讲清楚）
     ----------------------------------------------------------------
     三个空间：

       ① 原图空间 (W0,H0)      照片本身
       ② 旋转框空间 (W,H)      原图绕中心旋转 φ 之后的**外接**矩形
                                （裁剪框固定为轴对齐，就在这个空间里）
       ③ 画布空间              屏幕上看到的那块

     旋转角 φ 一确定，②就定了。取景框（裁剪框）在②里是轴对齐矩形，
     用户可以拖、可以按比例约束。

     ⚠️ 旋转后四角会露白，所以裁剪框必须落在「旋转后的**内接**矩形」
     里 —— 这就是 inscribedRect() 的作用。它保证任何合法裁剪框
     都完全落在图片内容内。

     裁剪框不确定时**不给变换**（恒等），正常编辑就完全不受影响。
     ================================================================ */

  /** 旋转/裁剪状态（null = 没有裁剪，走恒等变换） */
  let crop = null;


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

  /* 每次旋转角度变化都要重算「内接矩形」，裁剪框也随之 rebase。
     ⚠️ 用归一化坐标（相对旋转框 W×H）而不是像素：
     这样旋转角度一变，只要把归一化值 clamp 回新的内接矩形就行，
     不用做像素换算。 */
  const ASPECTS = [
    { name: '自由', v: 0 },
    { name: '1:1', v: 1 },
    { name: '4:3', v: 4 / 3 },
    { name: '3:4', v: 3 / 4 },
    { name: '16:9', v: 16 / 9 },
    { name: '9:16', v: 9 / 16 }
  ];

  /**
   * 旋转后图片的**内接矩形**（归一化，0~1，相对旋转框 W×H）。
   *
   * 推导：旋转框里放一个居中的轴对齐矩形 (w,h)，要求它旋转 φ 之后
   * 仍在原图 (W0,H0) 内。四个角里只有两个独立约束：
   *     w·cosφ + h·sinφ ≤ W0      ……(A)
   *     w·sinφ + h·cosφ ≤ H0      ……(B)
   * 最大面积解一定在 A 或 B 的边界上，所以**算两个候选、取面积大的那个**：
   *     候选1（贴着 A）：w = W0/c，h = (H0 - w·s)/c
   *     候选2（贴着 B）：h = H0/c，w = (W0 - h·s)/c
   * 两个都算出来，只要另一条不等式也满足就是合法解；取面积大的。
   *
   * ⚠️⚠️ 这个函数错过两次，把两次都记下来：
   *
   * 【错法一】用 `critical = max(H0/W0, W0/H0)` 当阈值分两种情形，
   * 横图和竖图各写一遍 —— 阈值判断反了。症状：
   *   400×300 转 30° 输出 322×14（一条 14px 细缝），
   *   转 45° 输出 358×253（**超出旋转边界**，会画出原图外的区域）。
   *
   * 【错法二】改成单阈值之后，仍然先算一个再 `min(W0, w)` 钳制 ——
   * 而**钳过的 w 又被代回 h 的公式**，等于破坏了自己刚写的方程。
   * 实测 30° 给出 400×79.7（面积只有正确值的 1/8）。
   *
   * ⚠️ 还有一条隐含契约必须守住：**φ = 0 时必须返回 (W0, H0)**。
   * 调用方（enterCrop / currentInscribed）用 ins.w/box.W 把取景框
   * 归一化到旋转框，并假定 0° 时内接矩形就是整张图。
   * 破坏它会让 crop.rect 在无旋转时就不是满幅。
   *
   * 正确性由 test/crop-geometry.test.mjs 里的"数值最优性"断言守住：
   * 候选解必须真的满足两条不等式，且面积不小于"数值求出的最大值×0.99"。
   * 那种断言能一次性抓住上面两种错法。
   */
  function inscribedRect(W0, H0, phi) {
    const c = Math.abs(Math.cos(phi));
    const s = Math.abs(Math.sin(phi));
    if (c < 1e-9) return { w: 1, h: 1 };          // 90°：退化，由整转处理
    if (s < 1e-9) return { w: W0, h: H0 };        // 0°：就是整张图

    /* ================================================================
       求"旋转后仍整块在原图内"的**最大**轴对齐矩形
       ----------------------------------------------------------------
       约束（两个角顶到边界）：
         (A)  w·c + h·s ≤ W0
         (B)  w·s + h·c ≤ H0
       面积 w·h 的最大值在可行域边界上。

       ⚠️⚠️ 这个函数前后错了**三次**，每次症状都不同，别再走回头路：
         【一】按 `max(H0/W0, W0/H0)` 分横竖图，阈值写反 →
              30° 给出 322×14（一条细缝），45° 给出**越界**的矩形。
         【二】固定公式算一个再 min 钳制，钳过的值又代回另一条公式 →
              越界约 12%。
         【三】枚举"两条约束线上的点 + 交点"取面积最大 ——
              交点公式在 det = c²−s² ≈ 0（45° 附近）时**除以零**，
              给出 600×1.0 这种既越界又无意义的解。
              而且多数角度还不是最优（45° 只拿到最优的 22%）。

       ⭐ 最后结论：这是**一维约束优化**，解析解要分情况讨论、
       还带奇点，不如直接扫。
       对每个 w，满足两条约束的最大 h 是
           h(w) = min( (W0 − w·c)/s , (H0 − w·s)/c , H0 )
       在 w ∈ (0, W0] 上取 w·h(w) 最大的点。
       1600 步足够精确（步长 0.06%）；
       只在"旋转角/取景框变化"时算一次，不在每帧的热路径上，
       所以这点计算量完全可以接受 —— 换来的是**不会再有奇点**。

       正确性由 test/crop-geometry.test.mjs 的"合法性 + 最优性"两条断言
       守住（用同口径的数值金标准对照，误差 < 0.5%）。
       ================================================================ */
    const hAt = w => Math.min((W0 - w * c) / s, (H0 - w * s) / c, H0);

    const STEPS = 1600;
    let bw = W0, bh = hAt(W0);
    let best = bw > 0 && bh > 0 ? bw * bh : -1;

    for (let i = 1; i <= STEPS; i++) {
      const w = W0 * i / STEPS;
      const h = hAt(w);
      if (!(h > 0)) continue;
      const area = w * h;
      if (area > best) { best = area; bw = w; bh = h; }
    }

    if (!(best > 0)) return { w: W0 * c, h: H0 * c };   // 兜底（正常到不了）

    // 只做防御性钳制，且**不改变可行性**
    let w = Math.max(1, Math.min(W0, bw));
    let h = Math.max(1, Math.min(H0, bh));
    if (w * c + h * s > W0) h = Math.max(1, (W0 - w * c) / s);
    if (w * s + h * c > H0) w = Math.max(1, (H0 - h * c) / s);

    return { w, h };
  }

  /** 旋转框（外接矩形）的尺寸 */
  function rotatedBoxSize(W0, H0, phi) {
    const c = Math.abs(Math.cos(phi));
    const s = Math.abs(Math.sin(phi));
    return { W: W0 * c + H0 * s, H: W0 * s + H0 * c };
  }

  /**
   * 把裁剪框 clamp 回合法范围（内接矩形内，且不小于最小尺寸）。
   * 旋转角一变就要调一次 —— 内接矩形缩小了，原来的框可能已经越界。
   */
  function clampCropRect(cr, inW, inH) {
    // 内接矩形在旋转框里的位置（居中）
    const ix = (1 - inW) / 2, iy = (1 - inH) / 2;
    const minSide = 0.08;

    let w = Math.min(Math.max(cr.w, minSide), inW);
    let h = Math.min(Math.max(cr.h, minSide), inH);
    let x = Math.min(Math.max(cr.x, ix), ix + inW - w);
    let y = Math.min(Math.max(cr.y, iy), iy + inH - h);
    return { x, y, w, h };
  }

  /** 当前旋转角对应的内接矩形（归一化到旋转框） */
  function currentInscribed() {
    if (!img) return { inW: 1, inH: 1 };
    const phi = (crop ? crop.rot : 0) * Math.PI / 180;
    const box = rotatedBoxSize(img.width, img.height, phi);
    const ins = inscribedRect(img.width, img.height, phi);
    return { inW: ins.w / box.W, inH: ins.h / box.H };
  }

  /** 打开裁剪模式 */
  function enterCrop() {
    if (!img) return;
    const phi = 0;
    const box = rotatedBoxSize(img.width, img.height, phi);
    const ins = inscribedRect(img.width, img.height, phi);
    // 初始取景框 = 整个内接矩形
    crop = {
      rot: 0,
      rect: { x: (1 - ins.w / box.W) / 2, y: (1 - ins.h / box.H) / 2,
              w: ins.w / box.W, h: ins.h / box.H },
      aspect: 0
    };
    setBrushMode(false);
    showMaskTool(false);
    showCropUI(true);
    layoutCanvas();
    render();
    drawCropOverlay();
    toast('拖动取景框选择要保留的部分，或调上面的旋转', 3600);
  }

  /** 退出裁剪模式。保留参数不应用（等于取消） */
  function exitCrop(apply) {
    showCropUI(false);
    if (!apply) {
      crop = null;
    }
    render();
  }

  /** 设置旋转角；内接矩形随之变化，裁剪框要 rebase */
  function setCropRotation(deg) {
    if (!crop || !img) return;
    // 归一化坐标是相对**旋转框**的，旋转角一变框就变了 ——
    // 所以不能直接把旧的归一化值搬过来，要按比例换算
    const oldBox = rotatedBoxSize(img.width, img.height,
      crop.rot * Math.PI / 180);
    const newBox = rotatedBoxSize(img.width, img.height, deg * Math.PI / 180);
    const px = { x: crop.rect.x * oldBox.W, y: crop.rect.y * oldBox.H,
                 w: crop.rect.w * oldBox.W, h: crop.rect.h * oldBox.H };

    crop.rot = deg;
    crop.rect = { x: px.x / newBox.W, y: px.y / newBox.H,
                  w: px.w / newBox.W, h: px.h / newBox.H };

    const { inW, inH } = currentInscribed();
    crop.rect = clampCropRect(crop.rect, inW, inH);
    if (crop.aspect) applyCropAspect(crop.aspect);

    const r = $('stCropRotVal');
    if (r) r.textContent = deg.toFixed(0) + '°';
    layoutCanvas();
    render();
    drawCropOverlay();
  }

  /** 按比例约束裁剪框（居中收缩到目标比例） */
  function applyCropAspect(ratio) {
    if (!crop) return;
    crop.aspect = ratio;
    if (!ratio) return;
    const { inW, inH } = currentInscribed();
    const phi = crop.rot * Math.PI / 180;
    const box = rotatedBoxSize(img.width, img.height, phi);
    const ins = inscribedRect(img.width, img.height, phi);

    /* ⚠️⚠️ 比例预设要的是**图片上的**宽高比，不是旋转框里的。
       而 crop.rect 是"相对内接矩形"归一化的，内接矩形在横纵上
       相对旋转框的比例不同（ins.w/box.W ≠ ins.h/box.H，旋转后必然如此）。

       旧写法 `h = w / ratio`（w、h 都取旋转框像素）只在
       ins.w/box.W == ins.h/box.H 时才等于图片比例 —— 也就是**只有 0°**
       才对。旋转后选 16:9 实际得到的是别的比例。
       反例（400×300 转 45°，选 16:9）：旧写法算出图片上 2.133 的框。

       正解：先在内接矩形里按目标比例取最大的框（内接矩形和图片同比例，
       所以在它里面按 ratio 取就是图片上的 ratio），再换算回框单位。 */
    const inPx = { w: inW * box.W, h: inH * box.H };
    let w = inPx.w, h = w / ratio;
    if (h > inPx.h) { h = inPx.h; w = h * ratio; }

    // 归一化：横向除以 box.W、纵向除以 box.H（两者不同，所以不能共用一个数）
    const nw = w / box.W, nh = h / box.H;
    const cx = crop.rect.x + crop.rect.w / 2;
    const cy = crop.rect.y + crop.rect.h / 2;
    crop.rect = clampCropRect(
      { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh }, inW, inH);
  }

  /**
   * 应用裁剪 + 旋转：把结果烘焙成新图。
   *
   * 走「按目标尺寸重画一帧 → readPixels」这条路，而不是在 CPU 上
   * 重采样 —— 复用的是同一个 shader，所以**所见即所得**，
   * 而且不用再写一遍调色逻辑（写两遍必然漂移）。
   */
  async function applyCrop() {
    if (!crop || !img) return;
    const prevRect = crop.rect, prevRot = crop.rot;
    busy(true, '正在应用…');
    try {
      // ⚠️ 必须传 true 走**导出**分支。默认参数是预览模式，
      // 返回的是屏幕尺寸（比如 832×624）—— 拿它当输出尺寸的话，
      // 裁剪出来的图会变成屏幕分辨率，而且比原图还大。
      // 这个 bug 实际发生过：400×300 的图"裁剪"完变成 832×624。
      const plan = cropRenderPlan(true);
      if (!plan) throw new Error('取景框太小');

      // 切到目标分辨率重画
      const prevW = canvas.width, prevH = canvas.height;
      canvas.width = plan.outW;
      canvas.height = plan.outH;
      gl.viewport(0, 0, plan.outW, plan.outH);
      applyGeometryUniforms(plan);
      draw();

      const pixels = new Uint8Array(plan.outW * plan.outH * 4);
      gl.readPixels(0, 0, plan.outW, plan.outH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      /* 行序：**翻一次**。
         ----------------------------------------------------------------
         ⚠️ 这一处和 cropRenderPlan 里 offY 的公式是**两处独立的事**，
         不要当成"配套约定"（我第一次就是这么误判的，把翻行删了，
         结果烘焙出来的图整个上下颠倒 —— 预览是对的、应用完就反了）。

         为什么必须翻（这次是量出来的，不是推理出来的）：
         `gl.readPixels` 返回的行序是**自下而上** —— pixels 的第 0 行
         对应 framebuffer 的**底部**（也就是画面的**下**边）。
         而 `ImageData` 是按行**自上而下**解释的：它的第 0 行是图的**上**边。
         两个约定不抵消，所以要把行序倒过来。

         实测证据（test/_probe-crop-map.mjs，一行编码图）：
           · 不翻：烘焙出的位图顶部 srcV=0.996、底部 srcV=0.004 → 上下反
           · 翻一次：顶部/底部与预览一致 ✅

         ⚠️ 上次留有"翻一次才对"的注释，结论是对的，
         但当时 offY 也错着，两个错误互相抵消，于是这条注释的说服力
         被后来的我低估了。教训：**注释里的"实测依据"要写清楚
         当时还错着什么**，否则后人会把正确的部分一起推翻。 */
      const flipped = new Uint8ClampedArray(pixels.length);
      const rowBytes = plan.outW * 4;
      for (let y = 0; y < plan.outH; y++) {
        const src = (plan.outH - 1 - y) * rowBytes;
        flipped.set(pixels.subarray(src, src + rowBytes), y * rowBytes);
      }

      const bmp = await createImageBitmap(new ImageData(flipped, plan.outW, plan.outH));

      // 换图 + 重置一切跟尺寸相关的东西
      if (img && img.close) img.close();
      img = bmp;
      crop = null;
      showCropUI(false);

      mask.clear();
      mask.resize(img.width, img.height);
      setMaskActive(false);
      setBrushMode(false);
      showMaskTool(false);

      gl.bindTexture(gl.TEXTURE_2D, imageTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      _trace('applyCrop:afterUpload', 'img=' + img.width + 'x' + img.height
        + ' tex=' + gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WIDTH || 0x1000)
        + 'x' + gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_HEIGHT || 0x1001)
        + ' canvas=' + canvas.width + 'x' + canvas.height);

      render();
      _trace('applyCrop:afterRender', 'canvas=' + canvas.width + 'x' + canvas.height
        + ' img=' + img.width + 'x' + img.height + ' crop=' + !!crop);
      /* ⚠️ 强制同步 GPU 管线。
         不加这个的话，紧跟其后的 readPixels / 截图有时会拿到**上一帧**
         的内容（表现是"应用了裁剪但画面还是旧的"）。
         它是异步提交的，刚 texImage2D 上传的新纹理不一定已经生效。
         代价只是一次同步等待 —— 这个操作本来就不在热路径上。 */
      gl.finish();
      toast(`已应用裁剪（${img.width}×${img.height}）`, 3000);
    } catch (e) {
      // 失败要把状态还原，否则用户会卡在一个半应用的状态里
      crop.rect = prevRect; crop.rot = prevRot;
      canvas.width = canvas.width;   // 触发重新分配，避免半截缓冲
      toast('应用裁剪失败：' + (e && e.message ? e.message : e));
    } finally {
      busy(false);
    }
  }

  /**
   * 由当前状态算出「输出尺寸 + UV 变换参数」。
   *
   * ================================================================
   * ⭐ 唯一的硬约束：**采样映射必须是相似变换**
   * ================================================================
   * 渲染就是"输出矩形 ← 采样源图里的某个矩形"，一个线性映射。
   * 形状不扭曲的充要条件：
   *
   *     sX / sY == W0 / H0
   *
   * 而 sX 的定义就是 outW/W0、sY 是 outH/H0（见下），代入即：
   *
   *     outW / outH == W0 / H0          ← 输出比例必须等于图片比例
   *
   * ⚠️⚠️ 这一条**错过很多次**，每次都换个样子冒出来，务必记住：
   *
   * 【错法一】用一个标量 `s = ins.w/box.W` 同时管 x 和 y。
   *   取景框正好等于内接矩形时蒙对，把框拖小就错。
   *
   * 【错法二】`sX = r.w*ins.w/W0; sY = r.h*ins.h/H0`。
   *   看起来对，但它隐含假设"取景框比例 == 输出比例"。
   *   实测（用户反馈"旋转明显不对，像扭曲"）：
   *   400×300 转 10°，输出算成 267×184（比例 1.451），
   *   而图是 1.333 → sX/sY = 1.091 ≠ 1.333 → **画面被压扁**。
   *   45° 时两个比例碰巧相等，所以"有时看着是对的"，
   *   极难从现象反推。
   *
   * 【错法三】预览画布按 `viewW/viewH`（取景框在旋转框里的比例）建，
   *   而导出按 outW/outH —— 旋转后内接矩形缩小，两者分道扬镳。
   *   表现是预览被拉伸、导出正常（或反过来）。
   *
   * ⭐ 正确做法（一次把三处都钉住）：
   *   取景框在**旋转框**里归一化，而旋转框里 1 单位 = 图片空间里的
   *   ins.w（横）/ ins.h（纵）。所以取景框覆盖的图片区域是：
   *       regW = r.w · ins.w
   *       regH = r.h · ins.h
   *   规定输出比例恒等于图片比例，解出"覆盖比例 k"：
   *       outW = k · W0,  outH = k · H0
   *       k = min(regW / W0, regH / H0)
   *   于是 sX = k、sY = k（**相等**，映射自然不扭曲）。
   *   k 的含义是"输出的实际清晰度相对原图的比例"，
   *   旋转 45° 时会掉到约 0.66 —— 这是旋转裁切的必然代价
   *   （能覆盖的区域本来就变小了），不是 bug。
   *
   * ⚠️ 预览和导出共用同一个 k（只有像素尺寸的缩放不同），
   * 否则会出现"预览好好的、导出构图偏了"。
   *
   * ⚠️⚠️ 两个坐标系的 y 方向**相反**（这是裁剪里最容易绕晕的地方）：
   *   · `crop.rect` 是**屏幕约定**：y = 0 在画面**下**边、y = 1 在上边
   *     （依据：cropRectOnCanvas() 里 r.y = 1 时框画在画布顶部）
   *   · shader 采样的 `u.y` 是**图片约定**：0 = 图**上**边
   *     （VERT 里 vUv.y = 0.5 - aPos.y*0.5，画面顶部 vUv.y = 0）
   *   所以下面由 cy 算 offY 时必须**取负号**。
   * ================================================================
   */
  function cropRenderPlan(forExport = false) {
    if (!crop || !img) return null;
    const W0 = img.width, H0 = img.height;
    const phi = crop.rot * Math.PI / 180;
    const box = rotatedBoxSize(W0, H0, phi);
    const ins = inscribedRect(W0, H0, phi);

    const r = crop.rect;
    /* 取景框覆盖的图片区域（像素）。
       ⚠️ 用 inset 换算，不能用 r.w*box.W —— 那得到的是"旋转框像素"，
       而旋转框比图片大，直接拿来当图片区域会把画面放大。 */
    const regW = r.w * ins.w;
    const regH = r.h * ins.h;
    if (regW < 2 || regH < 2) return null;

    /* 采样缩放：**采样比例必须等于输出比例**（否则画面被拉伸）
       ----------------------------------------------------------------
       ⚠️⚠️ 这是裁剪里唯一真正重要的约束，也是前后错了三次的地方。

       "输出比例"由**取景框**决定 —— 用户选了 16:9，导出就必须是 16:9
       （比例预设是真实功能，见 applyCropAspect）。
       所以**不能**拿"图片比例"当输出比例，那会把比例预设废掉。

       取景框覆盖的图片区域是 regW×regH。采样区域是它的同形缩放，
       所以直接用这块就行：
           sX = regW / W0      （占源图宽度的比例）
           sY = regH / H0
           outW = regW, outH = regH
       校验：sX/sY = regW/regH = outW/outH ✓
       三个量（采样区间、输出、取景框）比例自然一致，不会扭曲。

       ⚠️ 注意：**只有取景框比例恰好等于图片比例时**才是"原分辨率、
       零缩放"；选了别的比例就是一次有意的裁切，这是用户要的行为，
       不是 bug。旋转会让 ins 变小，于是 regW/regH 随之变小 ——
       等价于"旋转后画面清晰度下降"，这是旋转裁切的必然代价。

       ⚠️ 历史上错的三种写法（都记着，别再回去）：
         【一】`s = ins.w/box.W` 一个标量管两轴 → 拖小取景框就错。
         【二】先算注册区域再按**图片比例**取子窗口（k = min(regW/W0,
              regH/H0)）→ 输出比例变成图片比例，**比例预设失效**，
              而且预览画布跟着用图片比例 → 用户看到"旋转后画面被拉伸"。
              实测 400×300 转 45°：画布 1.333 而内接矩形比例 1.775，
              画面上有明显的横向拉伸。
         【三】预览画布按 `viewW/viewH`（旋转框像素比例）建，
              和导出比例不一致 → 预览与导出两个样。
       ================================================================ */
    const sX = regW / W0;
    const sY = regH / H0;

    /* 采样区间的中心 = 取景框中心，换算到图片坐标。
       ⚠️ 两个坐标系的 y 方向**相反**，所以 y 的偏移要取**负号**：
         · crop.rect 是**屏幕约定**：y = 0 在画面下边、y = 1 在上边
         · shader 采样的 u.y 是**图片约定**：0 = 图**上**边
           （VERT 里 vUv.y = 0.5 - aPos.y*0.5）
       两者不一致，offY 不取负号画面就会上下颠倒。 */
    const cx = r.x + r.w / 2;                    // 旋转框归一化（水平）
    const cy = r.y + r.h / 2;                    // 旋转框归一化（屏幕约定）
    /* 旋转框归一化 → 图片归一化的换算：
       旋转框中心对应图片中心；0° 时旋转框就是图片，所以直接线性映射。 */
    const offX = (cx - 0.5) * (ins.w / W0);
    const offY = -(cy - 0.5) * (ins.h / H0);

    if (forExport) {
      return {
        outW: Math.max(1, Math.round(regW)),
        outH: Math.max(1, Math.round(regH)),
        sX, sY, rot: phi, offX, offY, W0, H0
      };
    }

    /* 预览：按屏幕可用空间放，**比例用取景框比例**（= 导出比例）。 */
    const stage = $('stStage');
    const pad = 24;
    const availW = Math.max(80, stage.clientWidth - pad);
    const availH = Math.max(80, stage.clientHeight - pad);
    const outAspect = regW / regH;
    let w = availW, h = w / outAspect;
    if (h > availH) { h = availH; w = h * outAspect; }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    return {
      outW: Math.max(1, Math.round(w * dpr)),
      outH: Math.max(1, Math.round(h * dpr)),
      sX, sY, rot: phi, offX, offY, W0, H0
    };
  }

  /** 把几何参数喂给 shader */
  function applyGeometryUniforms(plan) {
    gl.uniform1f(uniforms.uRot, plan.rot);
    gl.uniform2f(uniforms.uUvScale, plan.sX, plan.sY);
    gl.uniform2f(uniforms.uCropOffset, plan.offX, plan.offY);
  }

  /** 没有裁剪时必须是恒等变换，否则正常编辑会被莫名缩放/旋转 */
  function resetGeometryUniforms() {
    gl.uniform1f(uniforms.uRot, 0);
    gl.uniform2f(uniforms.uUvScale, 1, 1);
    gl.uniform2f(uniforms.uCropOffset, 0, 0);
  }

  /* ---------------- 裁剪框 overlay ----------------
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

  /** 裁剪框在画布上的像素位置（canvas 坐标，y 向下） */
  function cropRectOnCanvas() {
    if (!crop) return null;
    const r = crop.rect;
    const baseX = (1 - r.w) / 2, baseY = (1 - r.h) / 2;
    return {
      x: (r.x - baseX) / r.w,
      y: (r.y - baseY) / r.h,
      w: 1 / r.w,
      h: 1 / r.h
    };
  }

  function drawCropOverlay() {
    const cv = ensureCropCanvas();
    if (!crop || !img) { cv.hidden = true; return; }
    cv.hidden = false;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = canvas.width, H = canvas.height;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    cv.style.width = canvas.style.width;
    cv.style.height = canvas.style.height;

    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);

    const br = cropRectOnCanvas();
    const bx = br.x * W, by = br.y * H, bw = br.w * W, bh = br.h * H;

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

  function showCropUI(on) {
    const sec = $('stCropOpts');
    if (sec) sec.hidden = !on;
    const b = $('stCrop');
    if (b) {
      b.classList.toggle('on', on);
      b.textContent = on ? '✓ 裁剪中…' : '裁剪 / 旋转';
    }
    const cv = ensureCropCanvas();
    // ⚠️ 非裁剪模式下必须把 overlay 的 pointer-events 关掉，
    // 否则它会盖住画布，画笔就涂不上了
    cv.style.pointerEvents = on ? 'auto' : 'none';
    if (!on) cv.hidden = true;
  }

  /* ================================================================
     裁剪 UI 初始化
     ================================================================ */
  function initCropUI() {
    const seg = $('stCropAspect');
    if (!seg) return;

    seg.innerHTML = '';
    for (const a of ASPECTS) {
      const b = document.createElement('button');
      b.textContent = a.name;
      b.dataset.ratio = String(a.v);
      if (!a.v) b.classList.add('on');
      b.addEventListener('click', () => {
        if (!crop) return;
        for (const el of seg.children) el.classList.remove('on');
        b.classList.add('on');
        // ⚠️ 先清掉当前比例再设新的：applyCropAspect 会按目标比例
        // 重算尺寸，如果旧的 aspect 还留着，clampCropRect 会把它拉回去
        crop.aspect = 0;
        if (a.v) applyCropAspect(a.v);
        render();
        drawCropOverlay();
      });
      seg.appendChild(b);
    }

    $('stCrop').addEventListener('click', () => {
      if (crop) exitCrop(false);      // 再点一次 = 取消
      else enterCrop();
    });

    $('stCropRot').addEventListener('input', e => {
      setCropRotation(parseFloat(e.target.value));
    });

    // 90° 快转：超出 ±45 的范围，直接烘焙一次
    // （滑块只到 ±45，90° 用按钮更顺手；走"应用 + 重新进入"这条路）
    for (const [id, dir] of [['stCropRotL', -1], ['stCropRotR', 1]]) {
      const btn = $(id);
      if (!btn) continue;
      btn.addEventListener('click', async () => {
        if (!img) return;
        await rotateQuarter(dir);
      });
    }

    $('stCropApply').addEventListener('click', () => applyCrop());
    $('stCropCancel').addEventListener('click', () => exitCrop(false));

    initCropDrag();
  }

  /**
   * 90° 整转：直接用 canvas 的 2D 变换烘焙，不走 shader。
   *
   * 为什么不走 shader 的旋转：90° 是**精确置换**（行列互换），
   * 用 2D drawImage 一步到位、零重采样误差；而走 shader 要经过
   * 浮点三角函数，虽然也能对，但没必要。
   */
  async function rotateQuarter(dir) {
    const t0 = Date.now();
    busy(true, '正在旋转…');
    try {
      // 先按当前参数渲染一帧（含已有的调色），再整体转
      const src = document.createElement('canvas');
      src.width = img.width; src.height = img.height;
      const sg = src.getContext('2d');
      // 用 WebGL 画布的内容：切到原分辨率重画一帧
      const prevW = canvas.width, prevH = canvas.height;
      canvas.width = img.width; canvas.height = img.height;
      gl.viewport(0, 0, img.width, img.height);
      resetGeometryUniforms();          // 90° 单独做，不带裁剪
      draw();
      sg.drawImage(canvas, 0, 0);
      canvas.width = prevW; canvas.height = prevH;

      const out = document.createElement('canvas');
      out.width = img.height; out.height = img.width;
      const og = out.getContext('2d');
      og.translate(out.width / 2, out.height / 2);
      og.rotate(dir * Math.PI / 2);
      og.drawImage(src, -src.width / 2, -src.height / 2);

      const bmp = await createImageBitmap(out);
      if (img && img.close) img.close();
      img = bmp;

      // 尺寸变了，蒙版必须重建
      mask.clear();
      mask.resize(img.width, img.height);
      setMaskActive(false);
      setBrushMode(false);
      showMaskTool(false);

      gl.bindTexture(gl.TEXTURE_2D, imageTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

      if (crop) {
        // 在裁剪模式里转 90°：重新算内接矩形和取景框
        const keepRot = crop.rot;
        crop = null;
        enterCrop();
        setCropRotation(keepRot);
      }
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
      if (!crop) return;
      e.preventDefault();
      cv.setPointerCapture(e.pointerId);
      const p = pos(e);
      const br = cropRectOnCanvas();
      // 判断抓到的是哪个手柄（离角点近就缩放，否则整体移动）
      const th = 0.06;
      const near = (ax, ay) => Math.abs(p.x - ax) < th && Math.abs(p.y - ay) < th;
      let mode = 'move';
      if (near(br.x, br.y)) mode = 'nw';
      else if (near(br.x + br.w, br.y)) mode = 'ne';
      else if (near(br.x, br.y + br.h)) mode = 'sw';
      else if (near(br.x + br.w, br.y + br.h)) mode = 'se';
      drag = { mode, start: p, rect0: { ...crop.rect } };
    });

    cv.addEventListener('pointermove', e => {
      if (!drag || !crop) return;
      e.preventDefault();
      const p = pos(e);
      const br = cropRectOnCanvas();
      // 画布归一化位移 → 裁剪框归一化位移
      const dx = (p.x - drag.start.x) / br.w;
      const dy = (p.y - drag.start.y) / br.h;
      const r0 = drag.rect0;
      const { inW, inH } = currentInscribed();

      if (drag.mode === 'move') {
        crop.rect = clampCropRect(
          { x: r0.x + dx * r0.w, y: r0.y + dy * r0.h, w: r0.w, h: r0.h },
          inW, inH);
      } else {
        // 角点缩放：改的是宽高，对角的那个角保持不动
        let w = r0.w + (drag.mode.includes('e') ? dx * r0.w : -dx * r0.w);
        let h = r0.h + (drag.mode.includes('s') ? dy * r0.h : -dy * r0.h);
        w = Math.max(0.05, w); h = Math.max(0.05, h);

        if (crop.aspect) {
          // 按比例：先定宽，再算高（宽是拖动的主轴）
          const box = rotatedBoxSize(img.width, img.height, crop.rot * Math.PI / 180);
          h = (w * box.W) / (crop.aspect * box.H);
        }

        const ax = drag.mode.includes('e') ? r0.x : r0.x + r0.w - w;
        const ay = drag.mode.includes('s') ? r0.y : r0.y + r0.h - h;
        crop.rect = clampCropRect({ x: ax, y: ay, w, h }, inW, inH);
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
    const s = $('stSeg');
    if (s) s.disabled = !on;
    const ip = $('stInpaint');
    if (ip) ip.disabled = !on || mask.isEmpty;
    const u = $('stUseMask');
    if (u) u.disabled = !on || mask.isEmpty;
    const cr = $('stCrop');
    if (cr) cr.disabled = !on;
    // 没图的时候裁剪状态必须清掉，否则"打开新图但还在裁剪模式里"
    if (!on && crop) { crop = null; showCropUI(false); }
    if (!on && typeof syncMaskUI === 'function') syncMaskUI();
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

  /** 由主进程下发的模板表生成按钮 */
  function renderTemplateRow() {
    const row = $('stTemplateRow');
    if (!row) return;
    const list = (beautySchema && beautySchema.templates) || [];
    if (!list.length) { row.hidden = true; return; }
    row.hidden = false;
    row.innerHTML = '';
    list.forEach((t, i) => {
      const b = document.createElement('button');
      b.textContent = t.name;
      // desc 放到 title 里：面板窄，一屏放不下 8 个带说明的卡片
      b.title = t.desc || t.name;
      b.dataset.tpl = t.id;
      b.addEventListener('click', () => applyTemplate(i));
      row.appendChild(b);
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
      rt = setTimeout(() => {
        render();
        // 裁剪框 overlay 是独立画布，尺寸跟着 WebGL 画布走，
        // 窗口一变必须重画 —— 忘了的话框会留在旧位置上
        if (crop) drawCropOverlay();
      }, 120);
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
      initCropUI();
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
    // —— 裁剪 / 旋转 ——
    // 暴露出来是为了能在浏览器里读像素验证「转的角度对不对、
    // 裁剪尺寸对不对、四角有没有露白」—— 这些静态一律验不出来。
    enterCrop,
    exitCrop,
    setCropRotation,
    applyCrop,
    rotateQuarter,
    cropRenderPlan,
    inscribedRect,
    rotatedBoxSize,
    applyCropAspect,
    get crop() { return crop; },
    /** 直接设裁剪框（归一化，相对旋转框），测试用 */
    setCropRect(r) {
      if (!crop) return false;
      const { inW, inH } = currentInscribed();
      crop.rect = clampCropRect(r, inW, inH);
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
    _draw: draw,
    /** 读回当前 shader 上的几何 uniform —— 排查"裁剪没生效"用。
        这一层是整块逻辑的最终落点，出问题时先看它对不对。 */
    _geometryUniforms() {
      return {
        rot: gl.getUniform(program, uniforms.uRot),
        scale: gl.getUniform(program, uniforms.uUvScale),
        offset: gl.getUniform(program, uniforms.uCropOffset),
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
