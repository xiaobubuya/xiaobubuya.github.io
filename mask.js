/* ================================================================
   蒙版引擎
   ================================================================
   一块蒙版就是一张灰度图：白 = 选中，黑 = 没选中。

   它是整个修图链路里最关键的中间产物，因为三个功能都要用它：

     ① 局部调整 —— 画笔涂哪儿，调整就作用在哪儿
     ② 去物（火山即梦）—— 需要告诉 AI「要抹掉的东西在哪」
     ③ 人像分割（百度）—— 分割结果本身就是一块蒙版

   也就是说：蒙版做对了，剩下三个功能都只是「拿蒙版去用」。

   ----------------------------------------------------------------
   为什么用「描边(stroke)」而不是「像素位图」当数据源
   ----------------------------------------------------------------
   直觉做法是维护一张 canvas，鼠标画到哪就画到哪。但那样有三个问题：

     · 撤销只能存整张位图的快照 —— 4000×2700 一张 43MB，存十步就爆内存
     · 改笔刷大小要重画整张 —— 之前的笔画没法用新尺寸重绘
     · 导出/上传要传整张位图

   所以这里存的是**矢量描边**：每笔就是 {points, radius, erase}，
   撤销 = 弹出最后一笔，改尺寸 = 用新参数重画所有笔画。
   内存小、可重放、可序列化。位图只是它的「渲染结果」，用完就扔。

   这是个刻意的取舍：牺牲一点渲染开销，换撤销和参数化的自由度。
   实测 100 笔左右的蒙版重绘在 10ms 内，够用。
   ================================================================ */
(function (global) {
  'use strict';

  const MAX_STROKES = 200;      // 超过就丢最老的，防止无限增长
  const DEFAULT_RADIUS = 0.04;  // 归一化半径（相对图片短边）

  class Mask {
    constructor() {
      this.w = 0;
      this.h = 0;
      this.strokes = [];
      this.canvas = null;       // 离屏位图，render() 后有效
      this.dirty = true;
      // 内容版本号：每次内容变就 +1。
      // GPU 那边靠比对这个号决定要不要重传纹理 ——
      // 用 dirty 判断会出错，因为 render() 会把 dirty 清掉，
      // 而 render() 可能发生在「即将上传」之前。
      this.version = 0;
      this.mode = 'add';        // add | erase
      this.radius = DEFAULT_RADIUS;
      this.hardness = 0.5;      // 0 = 全羽化，1 = 硬边
      this.opacity = 1;
      this._cur = null;         // 正在画的这一笔
    }

    /** 换图片尺寸 —— 归一化坐标不受影响，但位图要重建 */
    resize(w, h) {
      if (this.w === w && this.h === h) return;
      this.w = w;
      this.h = h;
      this.canvas = document.createElement('canvas');
      // 蒙版不需要原分辨率：它只是个权重图，按短边 1024 采样足够
      // （羽化边缘本身就是模糊的，再高的分辨率没有信息量）
      const scale = Math.min(1, 1024 / Math.max(w, h));
      this.canvas.width = Math.max(1, Math.round(w * scale));
      this.canvas.height = Math.max(1, Math.round(h * scale));
      this.dirty = true;
      this.version++;
      this._onChange();
    }

    get isEmpty() { return this.strokes.length === 0 && !this._cur; }

    /** 内容变化时通知外部（studio.js 用来刷新按钮和重画） */
    _onChange() {
      if (typeof this.onchange === 'function') this.onchange();
    }

    /** 归一化半径 → 位图像素半径 */
    _px(r) {
      return Math.max(1, r * Math.min(this.canvas.width, this.canvas.height));
    }

    /* ------------------------------------------------------------
       画一笔
       ------------------------------------------------------------ */

    /** 开始新的一笔。x/y 是 0~1 归一化坐标 —— 这样换分辨率不用换算
     *  kind: 'brush'（默认）| 'gradient' | 'radial' */
    begin(x, y, kind) {
      if (!this.canvas) return;
      this._cur = {
        points: [[x, y]],
        kind: kind || 'brush',
        radius: this.radius,
        hardness: this.hardness,
        opacity: this.opacity,
        erase: this.mode === 'erase'
      };
      this._paint(this._cur);   // 点一下也要有印子
      this.version++;
      this._onChange();
    }

    /** 笔画中途加一个点。
     *  gradient/radial 只更新第二个点（替换不追加），画笔追加 */
    extend(x, y) {
      const s = this._cur;
      if (!s) return false;

      // 渐变 / 径向：第二个点代表"另一端"或"外半径"，直接替换
      if (s.kind === 'gradient' || s.kind === 'radial') {
        if (s.kind === 'radial') {
          // 径向：传入的是指针位置，要算相对中心的半径。
          // ⚠️ 必须留一个最小半径：纯横向（或纯纵向）拖动时有一个分量
          //    恰好是 0，若只兜底到 1 个像素，椭圆会塌成一条线 ——
          //    画布看起来毫无反应，而且不报任何错。
          const [cx, cy] = s.points[0];
          const minR = 0.03;
          x = Math.max(minR, Math.abs(x - cx));
          y = Math.max(minR, Math.abs(y - cy));
        }
        s.points.length = 2;
        s.points[1] = [x, y];
        // ⚠️ 不能像画笔那样增量画（这里曾经就是 _paint(s)）。渐变/径向是
        //    一次**整画布**填充，而且用 lighter（加法）：每拖一步再叠一遍，
        //    中间那段的白就越来越饱和（拖两下中点从 128 变 255，
        //    平滑过渡变成硬边）。
        // 所以这里只更新点并标脏，全量重绘交给随后的 draw() 那一次
        // render()（render 会清空后按 strokes 重放，天然不累加）。
        // ⚠️ 必须**自己**标脏：end() 不设 dirty（见下面的 end()），
        //    这里漏标的话 toTextureData() 会以为画布是干净的而跳过重绘，
        //    脏画布一直留着，上传到 GPU 的纹理也永远是错的。
        this.dirty = true;
        this.version++;
        this._onChange();
        return true;
      }

      const last = s.points[s.points.length - 1];
      const dx = x - last[0], dy = y - last[1];
      // 采样间隔按半径的 1/4 走。太密浪费，太疏会画成折线
      const minStep = s.radius * 0.25;
      if (Math.hypot(dx, dy) < minStep) return false;

      s.points.push([x, y]);
      this._paintSegment(s, last, [x, y]);
      this.version++;
      this._onChange();
      return true;
    }

    /** 结束这一笔 */
    end() {
      const s = this._cur;
      this._cur = null;
      if (!s) return false;
      // 渐变 / 径向只点了没拖：不该进历史 ——
      // 否则笔数虚增、撤销要多按一次，空笔画还能把 MAX_STROKES 占满。
      // （位图这边本来就没画东西：begin() 虽然调了 _paint()，但
      //   _paintGradient/_paintRadial 在 points.length < 2 时直接 return。
      //   所以这里丢掉的只是一条空记录，不是已经画上去的印子。）
      // ⚠️ 注意 end() **不设 dirty**（和上面 extend() 不同）：这里丢的这笔
      //    本来就没画出来，不需要重绘；真要重绘也由调用方负责。
      if (s.kind && s.kind !== 'brush' && s.points.length < 2) return false;
      this.strokes.push(s);
      if (this.strokes.length > MAX_STROKES) this.strokes.shift();
      this.version++;
      this._onChange();
      return true;
    }

    /** 放弃正在画的一笔（比如 pointercancel） */
    abort() {
      if (!this._cur) return false;
      this._cur = null;
      this.dirty = true;
      this.version++;
      this.render();
      this._onChange();
      return true;
    }

    /* ------------------------------------------------------------
       渲染
       ------------------------------------------------------------ */

    /**
     * 把所有笔画重画到位图。
     *
     * 为什么不增量画：擦除会让增量画变得很麻烦 —— 擦一笔之后，
     * 如果只擦掉当前位图上的像素，再撤销这笔记就得整张重来。
     * 全量重绘永远正确，代价是几毫秒，换来的是简单和可撤销。
     */
    render() {
      if (!this.canvas) return;
      const ctx = this.canvas.getContext('2d');
      const { width: W, height: H } = this.canvas;

      ctx.clearRect(0, 0, W, H);
      for (const s of this.strokes) this._paint(s, ctx);
      if (this._cur) this._paint(this._cur, ctx);

      this.dirty = false;
    }

    /** 画一笔（从空白开始重放） */
    _paint(s, ctx) {
      ctx = ctx || this.canvas.getContext('2d');
      if (s.bitmap) return this._paintBitmap(s, ctx);
      if (s.kind === 'gradient') return this._paintGradient(s, ctx);
      if (s.kind === 'radial') return this._paintRadial(s, ctx);
      if (s.points.length === 1) {
        this._dot(s, s.points[0], ctx);
        return;
      }
      for (let i = 1; i < s.points.length; i++) {
        this._paintSegment(s, s.points[i - 1], s.points[i], ctx);
      }
    }

    /**
     * 画一笔「位图描边」（反选、AI 蒙版）。
     *
     * bitmap 存的是 dataURL 而不是 Image 对象，因为 Image 的加载是异步的 ——
     * 而 render() 是同步的，重放时图片还没解码完就会画出空白。
     * 这里缓存在 s._img 上，第一次遇到时同步画不出来就等它加载完再重画一次。
     */
    _paintBitmap(s, ctx) {
      if (s._img) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.drawImage(s._img, 0, 0, this.canvas.width, this.canvas.height);
        ctx.restore();
        return;
      }
      if (s._loading) return;
      s._loading = true;
      const im = new Image();
      im.onload = () => {
        s._img = im;
        s._loading = false;
        this.dirty = true;
        this.render();
        if (typeof this.onchange === 'function') this.onchange();
      };
      im.onerror = () => { s._loading = false; };
      im.src = s.bitmap;
    }

    /** 线性渐变蒙版：从 points[0] 到 points[1] 画一条渐变轴。
     *  起点侧全白（选中），终点侧全透明（未选中），中间平滑过渡。
     *  ⚠️ Y 翻转和画笔一致：归一化坐标 y=1 是图片顶部。 */
    _paintGradient(s, ctx) {
      if (s.points.length < 2) return;
      const p0 = s.points[0], p1 = s.points[s.points.length - 1];
      const x1 = p0[0] * this.canvas.width, y1 = (1 - p0[1]) * this.canvas.height;
      const x2 = p1[0] * this.canvas.width, y2 = (1 - p1[1]) * this.canvas.height;

      ctx.save();
      ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'lighter';
      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.restore();
    }

    /** 径向蒙版：以 points[0] 为中心，points[1] 为外半径（归一化坐标）。
     *  中心全白（选中），边缘全透明（未选中），椭圆形平滑过渡。 */
    _paintRadial(s, ctx) {
      if (s.points.length < 2) return;
      const [cx, cy] = s.points[0];
      const [rx, ry] = s.points[s.points.length - 1];
      const cxp = cx * this.canvas.width, cyp = (1 - cy) * this.canvas.height;
      const rxp = Math.max(1, rx * this.canvas.width), ryp = Math.max(1, ry * this.canvas.height);
      const maxR = Math.max(rxp, ryp);

      ctx.save();
      ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'lighter';
      ctx.translate(cxp, cyp);
      ctx.scale(rxp / maxR, ryp / maxR);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, maxR);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(-maxR, -maxR, maxR * 2, maxR * 2);
      ctx.restore();
    }

    _dot(s, p, ctx) {
      const r = this._px(s.radius);
      ctx.save();
      this._brushStyle(s, ctx, p);
      ctx.beginPath();
      ctx.arc(p[0] * this.canvas.width, (1 - p[1]) * this.canvas.height, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    _paintSegment(s, a, b, ctx) {
      ctx = ctx || this.canvas.getContext('2d');
      const r = this._px(s.radius);
      // ⚠️ Y 翻转：笔画点用的是「图片坐标」（y 向上，和 toImageCoord 一致），
      // 而 canvas 是 y 向下的。这里翻这一次，且**只翻这一次**。
      // 漏了或者多翻，画面就整个上下颠倒。
      const ax = a[0] * this.canvas.width, ay = (1 - a[1]) * this.canvas.height;
      const bx = b[0] * this.canvas.width, by = (1 - b[1]) * this.canvas.height;

      ctx.save();
      // 用「沿路径连续盖章」而不是画粗线：
      // lineCap/lineJoin 在急转弯处会露出尖角，而盖章的圆是均匀的。
      // 代价是点数多，但间隔控制在半径 1/4，重叠足够平滑。
      const dist = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(dist / (r * 0.25)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        // ⚠️ 每个章都必须重算 fillStyle。
        // 羽化是「以落笔点为圆心的径向渐变」，而渐变一旦创建就固定在
        // 画布坐标系上。只算一次然后沿路径盖的话，除了起点附近那一小块，
        // 其余章都落在渐变半径之外 —— 全是透明的。
        // 表现是：一条线只留下两个端点的小圆点，中间完全空。
        // （这个 bug 让「局部调整」看起来像纹理没上传，查了很久。）
        // 传回「图片坐标」（y 向上），_brushStyle 内部再翻一次
        this._brushStyle(s, ctx, [x / this.canvas.width, 1 - y / this.canvas.height]);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    /** 笔刷的填充样式。硬度和羽化都靠径向渐变实现 */
    _brushStyle(s, ctx, p) {
      if (s.erase) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#000';
        return;
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = s.opacity;

      const r = this._px(s.radius);
      const h = s.hardness == null ? 0.5 : s.hardness;
      if (h >= 0.99) {
        ctx.fillStyle = '#fff';
        return;
      }
      // 实心区占 hardness 的比例，剩下的是羽化过渡
      const x = p[0] * this.canvas.width, y = (1 - p[1]) * this.canvas.height;
      const g = ctx.createRadialGradient(x, y, r * h, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
    }

    /* ------------------------------------------------------------
       编辑操作
       ------------------------------------------------------------ */

    undo() {
      if (!this.strokes.length) return false;
      this.strokes.pop();
      this.dirty = true;
      this.version++;
      this.render();
      this._onChange();
      return true;
    }

    clear() {
      if (!this.strokes.length && !this._cur) return false;
      this.strokes = [];
      this._cur = null;
      this.dirty = true;
      this.version++;
      this.render();
      this._onChange();
      return true;
    }

    /** 反选 —— 抠出人之后想改背景时很有用 */
    invert() {
      if (!this.canvas) return;
      const ctx = this.canvas.getContext('2d');
      const { width: W, height: H } = this.canvas;

      // 先把当前内容读出来（因为下一步要在同一张画布上画反相）
      const before = ctx.getImageData(0, 0, W, H);
      const src = document.createElement('canvas');
      src.width = W; src.height = H;
      src.getContext('2d').putImageData(before, 0, 0);

      // 整张填白，再用 destination-out 把原来的白区挖掉 —— 得到反相
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(src, 0, 0);
      ctx.globalCompositeOperation = 'source-over';

      // 位图变成了「一块和描边无关的图」，所以扔掉描边历史。
      // 这是有代价的（不能撤销回画笔状态），但比留着一份对不上的
      // 历史更诚实 —— 撤销完发现画面没变才是真的让人困惑。
      this.strokes = [];
      const snap = this._snapshot();
      this.strokes = [snap];
      this._cur = null;
      this.dirty = false;
      this.version++;
      this._onChange();
    }

    /**
     * 把当前位图包成一笔"位图描边"。
     * 用于反选、AI 蒙版这类无法用笔画描述的内容 —— 包起来之后
     * 它就能参与重绘、撤销、擦除，和普通笔画一样。
     */
    _snapshot() {
      return { points: [], bitmap: this.canvas.toDataURL('image/png'), erase: false };
    }

    /** 把位图形式的蒙版灌进来（AI 分割结果走这条路） */
    setFromCanvas(src) {
      if (!this.canvas) return;
      const ctx = this.canvas.getContext('2d');
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(src, 0, 0, this.canvas.width, this.canvas.height);
      this.strokes = [this._snapshot()];
      this._cur = null;
      this.dirty = false;
      this.version++;
      this._onChange();
    }

    /* ------------------------------------------------------------
       导出
       ------------------------------------------------------------ */

    /** 给 shader 用的纹理数据（灰度图打包成 RGBA，LUMINANCE 兼容性差） */
    toTextureData() {
      if (this.dirty) this.render();
      if (!this.canvas) return null;
      const ctx = this.canvas.getContext('2d');
      const d = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      // 只用 R 通道，但 WebGL1 里 LUMINANCE 各浏览器行为不一致，直接 RGBA 更稳
      return d;
    }

    /** 覆盖率 0~1 —— 用来判断「用户是不是涂了东西」和显示进度 */
    coverage() {
      if (this.dirty) this.render();
      if (!this.canvas) return 0;
      const ctx = this.canvas.getContext('2d');
      const d = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 8) sum++;   // 阈值滤掉羽化边缘的噪声
      }
      return sum / (this.canvas.width * this.canvas.height);
    }
  }

  global.Mask = Mask;
})(window);
