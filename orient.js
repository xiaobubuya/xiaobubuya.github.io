/* ================================================================
   屏幕方向控制
   ================================================================
   为什么需要它：相册画布是横版（3:2），手机竖着拿的时候画布只能占
   屏幕中间一小条，翻页也只能单页。让用户能主动切到横屏，
   编辑和翻页都会舒服很多。

   两种实现路径，能力差别很大：

   ① Screen Orientation API（screen.orientation.lock）
      真正把系统 UI 转过去，页面视口真的变成横的 ——
      所有布局、手势坐标都不用改。但要浏览器支持，
      且标签页里必须先全屏（已装到桌面的 PWA 不用）。

   ② 退而求其次：提示用户手动物理转手机
      iOS Safari 至今不支持 lock()，只能这么做。

   所以这个模块的策略是：能锁就锁，不能锁就如实告诉用户，
   而不是假装切了、结果内容歪着显示要用户歪头看。
   ================================================================ */
(function (root) {
  'use strict';

  const so = () => (typeof screen !== 'undefined' ? screen.orientation : null);

  /** 浏览器是否支持锁定方向 */
  function canLock() {
    const o = so();
    return !!(o && typeof o.lock === 'function');
  }

  /**
   * 内容区域当前是否横着。
   *
   * ⚠️ 用视口宽高，而不是 screen.orientation.type。
   * 后者是「设备物理方向」，和真正能用于布局的宽高不一定一致 ——
   * 桌面浏览器、无头环境、分屏、以及某些折叠屏上都会对不上
   * （实测无头 Chrome 里 type 报 landscape-primary，而视口是 420×900 竖屏）。
   * 决定单页还是跨页、画布能画多大的，是视口，所以这里也以视口为准。
   */
  function isLandscape() {
    return window.innerWidth > window.innerHeight;
  }

  /** 是否已经由我们锁成了横屏 */
  let locked = false;
  function isLocked() { return locked; }

  /** 锁定横屏。失败时抛出，由调用方决定怎么提示。 */
  async function lockLandscape() {
    if (!canLock()) throw new Error('unsupported');

    try {
      // 已安装为 PWA 时直接就能锁
      await so().lock('landscape');
      locked = true;
      return 'locked';
    } catch {
      // 普通标签页里需要先全屏 —— 全屏本身也顺带把地址栏收起来，
      // 编辑时可用空间更大
      try {
        if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
        await so().lock('landscape');
        locked = true;
        return 'fullscreen';
      } catch (e) {
        locked = false;
        // 锁不上就顺手把全屏也退掉 —— 否则用户会莫名其妙停在全屏里，
        // 而想要的效果（横屏）并没有发生
        try {
          if (document.fullscreenElement && document.exitFullscreen) {
            await document.exitFullscreen();
          }
        } catch { /* 忽略 */ }
        throw e;
      }
    }
  }

  /** 解除锁定，恢复跟随设备 */
  async function unlock() {
    locked = false;
    try { if (so() && so().unlock) so().unlock(); } catch { /* 忽略 */ }
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      }
    } catch { /* 忽略 */ }
  }

  /**
   * 监听方向或全屏状态变化。
   * 用户手动退出全屏时锁定会失效，这里同步回状态，
   * 免得按钮还亮着但实际已经解锁了。
   */
  function onChange(cb) {
    const fire = () => cb({ landscape: isLandscape(), locked });
    window.addEventListener('resize', fire);
    window.addEventListener('orientationchange', () => setTimeout(fire, 150));
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && locked) {
        // 全屏被用户退掉了 → 锁定也随之失效
        locked = false;
        try { if (so() && so().unlock) so().unlock(); } catch { /* 忽略 */ }
      }
      fire();
    });
    if (so() && so().addEventListener) so().addEventListener('change', fire);
  }

  root.Orient = { canLock, isLandscape, isLocked, lockLandscape, unlock, onChange };
})(typeof window !== 'undefined' ? window : globalThis);
