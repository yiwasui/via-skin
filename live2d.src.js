/* ============================ Live2D（Cubism 4 引擎） ============================ */
/* ---------------- 拖动 + 点按换形象（内联模块） ---------------- */
/* ==========================================================================
   2026-11-19：从 live2d-widget（Cubism 2）换成 pixi-live2d-display（Cubism 4）。
   为什么换：官方样例库（唯一写明可自由公开使用的素材池）现在全是 moc3，
   旧引擎读不了。旧引擎连 5 个 Cubism 2 模型一起退役，想回退就 revert 这个文件。

   代价（实测体积，gzip）：pixi 6 122KB + pixi-live2d-display 28KB + core 41KB
   ≈ 190KB，与旧方案（L2Dwidget 9KB + pixi4 101KB + Cubism2 core）基本持平。
   引擎脚本改为**用到才加载**：只有真要出小人时才拉，且三家 CDN 轮试。

   另外：换形象仍然整页刷新（引擎没有可靠的 destroy），旧文档整体丢掉，
   动画循环随之消失，代价是一下白屏。
   ========================================================================== */
(function (global) {
  'use strict';

  // 换形象的顺序表。点一下小人切到下一个；首访随机起始，之后记住。
  // 全部是自托管的 Cubism 4 模型：path 相对仓库根，模型目录自包含。
  // 体积（贴图已转 WebP）：haru 0.89M / hiyori 1.09M / rice 1.31M / mao 1.50M
  // kind 决定用哪套引擎：c2 = Cubism 2（.model.json / index.json），c4 = Cubism 3/4/5（.model3.json）。
  // 两套各拉各的，只出一个小人，另一套的脚本不会下载。
  // fit = 模型「实际画出东西」的范围 [x, y, w, h]（模型坐标，y 向下）。
  // 各家画布留白差别极大（nepgear 人只占画布右下角五分之一，sagiri 几乎顶满），
  // 按画布缩会一个变火柴人一个被切掉。这张表是 2026-11-19 用 _measure_ink.js
  // 把每个模型渲成透明 PNG、量 alpha 包围盒得到的；换模型要重量。
  var MODELS = [
    // ---- 原来的 5 个（Cubism 2）----
    { name: 'rem',      kind: 'c2', pkg: 'live2d-widget-model-rem',    ver: '1.0.1', file: 'rem.model.json',
      fit: [707, 201, 1117, 2847] },
    { name: 'sagiri',   kind: 'c2', pkg: 'live2d-widget-model-sagiri', ver: '1.0.0', file: 'sagiri.model.json',
      fit: [21, 0, 1179, 2132] },
    { name: 'mikoto',   kind: 'c2', pkg: 'live2d-widget-model-mikoto', ver: '1.0.0', file: 'mikoto.model.json',
      fit: [400, 306, 515, 694], zoom: 1.09 },
    { name: 'murakumo', kind: 'c2', path: 'models/murakumo/index.json',
      fit: [204, 27, 535, 997] },
    { name: 'nepgear',  kind: 'c2', path: 'models/nepgear/index.json',
      fit: [1040, 2345, 1645, 2542] },
    // ---- 2026-11-19 新增（Cubism 4，官方样例）----
    { name: 'haru',     kind: 'c4', path: 'models/haru/Haru.model3.json',
      fit: [775, 232, 870, 3980] },
    { name: 'hiyori',   kind: 'c4', path: 'models/hiyori/Hiyori.model3.json',
      fit: [1032, 327, 968, 3743] },
    { name: 'rice',     kind: 'c4', path: 'models/rice/Rice.model3.json',
      fit: [2628, 410, 904, 2432] },
    { name: 'mao',      kind: 'c4', path: 'models/mao/Mao.model3.json',
      fit: [215, 770, 4325, 7440] }
  ];

  // 引擎脚本，按顺序加载（core → pixi → display，顺序不能换，见 ensureEngine）。
  // ⚠️ core 用**官方 CDN 的最新版**（Cubism 5）：npm 上的 live2dcubismcore@1.0.x 是
  //    2019 年的 Cubism 4 core，读新样例会报笼统的 "Unknown error"（Mao 就栽在这）。
  var NPM = [
    'https://fastly.jsdelivr.net/npm/',
    'https://cdn.jsdelivr.net/npm/',
    'https://gcore.jsdelivr.net/npm/',
    'https://unpkg.com/'
  ];
  function npmAll(rel) {
    var out = [];
    for (var i = 0; i < NPM.length; i++) out.push(NPM[i] + rel);
    return out;
  }
  // 两套引擎：c4 给 moc3，c2 给老的 .model.json。共用一个 pixi。
  // c2 的 core 是 Cubism 2 的 live2d.min.js（官方早停更，社区留着 gh 镜像）。
  var ENGINE = {
    c4: {
      core: [
        'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
        'https://fastly.jsdelivr.net/npm/live2dcubismcore@1.0.2/live2dcubismcore.min.js',
        'https://unpkg.com/live2dcubismcore@1.0.2/live2dcubismcore.min.js'
      ],
      pixi: npmAll('pixi.js@6.5.10/dist/browser/pixi.min.js'),
      display: npmAll('pixi-live2d-display@0.4.0/dist/cubism4.min.js')
    },
    // 老模型仍用 live2d-widget 3.1.4（它自带的 pixi4 + Cubism2 core）。
    // 试过把它塞进 pixi6：缩放口径、画布裁切全对不上，五个老模型没一个长得和原来一样。
    // 与其硬凑，不如两套各管各的 —— 反正一次只出一个小人。
    c2: {
      widget: npmAll('live2d-widget@3.1.4/lib/L2Dwidget.min.js')
    }
  };
  // 自托管模型的地址前缀（via-skin 仓库根）。
  // ⚠️ 别用 jsDelivr 的 gh 源：它对仓库里的**图片**一律 301 到 raw.githubusercontent，
  //    手机拿不到 → 模型只剩骨架。所以走 Pages 直出，三家公共反代兜底。
  var GH = [
    'https://yiwasui.github.io/via-skin/',
    'https://gh-proxy.com/https://raw.githubusercontent.com/yiwasui/via-skin/main/',
    'https://ghfast.top/https://raw.githubusercontent.com/yiwasui/via-skin/main/',
    'https://ghproxy.net/https://raw.githubusercontent.com/yiwasui/via-skin/main/'
  ];

  var PROBE_MS = 3500;   // 单次探 model.json 的上限
  var WARM_MS  = 9000;   // 等纹理/moc 进缓存的上限（超时也照样 init，别无限等）
  var SCRIPT_MS = 8000;  // 单个引擎脚本的加载上限

  var K_MODEL = 'l2d:model';   // 上次是第几个形象
  var K_CDN   = 'l2d:cdn';     // 上次探通的 CDN 下标（下次优先用）
  var K_POS   = 'l2d:pos';     // 上次拖到的位置 {x,y}
  var K_SWAP  = 'l2d:swapped'; // 刚换过形象（只用来弹一次名字）
  var TAP_TOL = 6;             // 手指移动小于这个距离算「点一下」
  var ATTACH_TIMEOUT = 15000;

  /* ---- 预取 ----
     当前形象画出来之后，趁空闲把**下一个**形象的主纹理先下进 HTTP 缓存，
     切换时就是缓存命中。PREFETCH = 0 关掉；1 = 只备下一个；2 = 备下两个。 */
  var PREFETCH = 1;
  var PREFETCH_DELAY = 4000;
  var PREFETCH_TEX = 4;        // 每个形象预取几张纹理
  var PREFETCH_MS = 20000;

  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      if (val === null) localStorage.removeItem(key);
      else localStorage.setItem(key, val);
    } catch (_) { /* 隐私模式写不进去，就别记忆 */ }
    return null;
  }

  function readIndex() {
    var i = parseInt(store(K_MODEL), 10);
    if (!isFinite(i) || i < 0) i = Math.random() * MODELS.length | 0; // 第一次随机
    return i % MODELS.length;
  }

  /* ---------------- 拖动 ---------------- */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  var state = null;   // 当前落点 {x,y}
  var lockTimers = [];   // 组件初始化期间的重试计时器

  function readStoredPos() {
    var raw = store(K_POS);
    if (!raw) return null;
    try {
      var p = JSON.parse(raw);
      if (isFinite(p.x) && isFinite(p.y)) return p;
    } catch (_) {}
    return null;
  }

  function restorePos(host) {
    var p = readStoredPos();
    if (!p) {                      // 没存过：沿用页面 CSS 的右下角位置
      var r = host.getBoundingClientRect();
      p = { x: r.left, y: r.top };
    }
    state = p;
    applyPos(host, p.x, p.y);
  }

  /* 容器建完后还会整体改写一次 style，会把 left/top 一起抹掉，
     而且改写时机不固定。所以盯住 style 属性：一旦发现不是我们写的值就重新落位。 */
  function lockPos(host) {
    stopLock();
    var budget = 15;

    function target() {
      var w = host.offsetWidth || 120, h = host.offsetHeight || 200;
      return {
        x: clamp(state.x, 0, Math.max(0, innerWidth - w)),
        y: clamp(state.y, 0, Math.max(0, innerHeight - h))
      };
    }

    function reapply() {
      if (!state || budget <= 0) return;
      var t = target();
      if (host.style.getPropertyValue('left') === t.x + 'px' &&
          host.style.getPropertyValue('top') === t.y + 'px') return;
      budget--;
      applyPos(host, t.x, t.y);
    }

    var mo = new MutationObserver(reapply);
    mo.observe(host, { attributes: true, attributeFilter: ['style'] });
    lockTimers.push(mo);
    reapply();
    lockTimers.push(setTimeout(stopLock, 4000));
  }

  function stopLock() {
    lockTimers.forEach(function (t) {
      if (t && t.disconnect) t.disconnect(); else clearTimeout(t);
    });
    lockTimers = [];
  }

  function applyPos(host, x, y) {
    var w = host.offsetWidth || 120, h = host.offsetHeight || 200;
    x = clamp(x, 0, Math.max(0, innerWidth - w));
    y = clamp(y, 0, Math.max(0, innerHeight - h));
    // 页面 CSS 里 right/bottom 带 !important，内联必须同样带 !important 才压得住
    host.style.setProperty('left', x + 'px', 'important');
    host.style.setProperty('top', y + 'px', 'important');
    host.style.setProperty('right', 'auto', 'important');
    host.style.setProperty('bottom', 'auto', 'important');
    host.style.setProperty('touch-action', 'none', 'important');
    host.style.setProperty('cursor', 'grab', 'important');
  }

  function bindDrag(host, onTap) {
    var sx = 0, sy = 0, ox = 0, oy = 0, moved = false, active = false;

    function down(e) {
      if (!(host.contains(e.target) || e.target === host)) return;
      if (e.button !== undefined && e.button !== 0) return;
      active = true; moved = false;
      var r = host.getBoundingClientRect();
      ox = r.left; oy = r.top;
      sx = e.clientX; sy = e.clientY;
      stopLock();
      host.style.setProperty('cursor', 'grabbing', 'important');
    }

    function move(e) {
      if (!active) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) < TAP_TOL && Math.abs(dy) < TAP_TOL) return;
      moved = true;
      state = { x: ox + dx, y: oy + dy };
      applyPos(host, state.x, state.y);
      if (e.cancelable) e.preventDefault();
    }

    function up() {
      if (!active) return;
      active = false;
      host.style.setProperty('cursor', 'grab', 'important');
      if (moved) {
        var r = host.getBoundingClientRect();
        state = { x: Math.round(r.left), y: Math.round(r.top) };
        store(K_POS, JSON.stringify(state));
      } else {
        onTap();
      }
    }

    // 必须用捕获阶段：canvas 上还有引擎自己的点击处理
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', function () { active = false; }, true);

    if (!('PointerEvent' in global)) {
      document.addEventListener('touchstart', function (e) {
        var t = e.touches[0];
        down({ target: e.target, clientX: t.clientX, clientY: t.clientY });
      }, { passive: true, capture: true });
      document.addEventListener('touchmove', function (e) {
        var t = e.touches[0];
        move({ clientX: t.clientX, clientY: t.clientY, cancelable: e.cancelable, preventDefault: function () { e.preventDefault(); } });
      }, { passive: false, capture: true });
      document.addEventListener('touchend', up, true);
      document.addEventListener('touchcancel', function () { active = false; }, true);
    }
  }

  /* ---------------- 换形象 ---------------- */

  function next() {
    var i = (readIndex() + 1) % MODELS.length;
    store(K_MODEL, String(i));
    store(K_SWAP, '1');
    location.reload();
  }

  /* ---------------- 换完弹一次名字 ---------------- */

  function toastIfSwapped() {
    if (store(K_SWAP) !== '1') return;
    store(K_SWAP, null);
    var d = document.createElement('div');
    d.textContent = MODELS[readIndex()].name;
    d.style.cssText = 'position:fixed;left:50%;bottom:84px;transform:translateX(-50%);' +
      'padding:6px 14px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;' +
      'font:13px/1.4 -apple-system,sans-serif;z-index:2147483647;pointer-events:none;' +
      'opacity:1;transition:opacity .5s';
    document.body.appendChild(d);
    setTimeout(function () { d.style.opacity = '0'; }, 1100);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 1700);
  }

  /* ---------------- 容器与渲染 ---------------- */

  var view = { app: null, model: null, host: null, w: 0, zoom: 1, kind: 'c4', entry: null };

  function ensureHost() {
    var host = document.getElementById('live2d-widget');
    if (!host) {
      host = document.createElement('div');
      host.id = 'live2d-widget';
      (document.body || document.documentElement).appendChild(host);
    }
    view.host = host;
    return host;
  }

  /* 容器尺寸跟着视口走：宽度与旧版一致（34vw，最多 200px），高按 1:1.5。 */
  function boxSize() {
    var w = Math.round(global.innerWidth * 0.34);
    w = clamp(w, 88, 200);
    return { w: w, h: Math.round(w * 1.5) };
  }

  function fit() {
    var app = view.app, model = view.model, host = view.host;
    // 老引擎自己管尺寸，别插手
    if (!app || !model || !host) return;
    var b = boxSize(), W = b.w, H = b.h;

    host.style.width = W + 'px';
    host.style.height = H + 'px';
    app.renderer.resize(W, H);

    var m = view.entry || {};
    var im = model.internalModel;
    var ow = (im && im.originalWidth) || model.width || 1;
    var oh = (im && im.originalHeight) || model.height || 1;

    // 有实测墨迹就用墨迹（所有模型统一口径，看起来一样大、一样站在框底）；
    // 没量过的退回画布四角，至少不会缩成点。
    var x0, y0, w0, h0;
    // ⚠️ 老模型（c2）不用墨迹表：它们的画布就是可见范围，按画布走才不会把下半身
    //    顶到画布外被裁掉（mikoto 就栽在这，只露一个胸像）。c4 才用墨迹。
    if (m.fit && view.kind !== 'c2') {
      var pad = 0.04;
      x0 = m.fit[0] - m.fit[2] * pad;
      y0 = m.fit[1] - m.fit[3] * pad;
      w0 = m.fit[2] * (1 + pad * 2);
      h0 = m.fit[3] * (1 + pad * 2);
    } else {
      x0 = 0; y0 = 0; w0 = ow; h0 = oh;
    }

    var s = Math.min(W * 0.96 / w0, H * 0.98 / h0) * (view.zoom || 1);
    model.scale.set(s);
    model.x = (W - w0 * s) / 2 - x0 * s;
    model.y = H - h0 * s - y0 * s;
    view.w = W;
  }

  /* ---------------- 引擎脚本：用到才拉 ---------------- */

  var engineReady = {};

  function loadScript(urls) {
    return new Promise(function (done, fail) {
      var i = 0;
      (function tryNext() {
        if (i >= urls.length) return fail(new Error('script ' + urls[0]));
        var s = document.createElement('script');
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return; settled = true;
          s.onload = s.onerror = null;
          if (s.parentNode) s.parentNode.removeChild(s);
          tryNext();
        }, SCRIPT_MS);
        s.src = urls[i++];
        s.async = true;
        s.onload = function () {
          if (settled) return; settled = true;
          clearTimeout(timer);
          done();
        };
        s.onerror = function () {
          if (settled) return; settled = true;
          clearTimeout(timer);
          if (s.parentNode) s.parentNode.removeChild(s);
          tryNext();
        };
        document.head.appendChild(s);
      })();
    });
  }

  function ensureEngine(kind) {
    if (engineReady[kind]) return engineReady[kind];
    var e = ENGINE[kind];
    if (e.widget) {
      engineReady[kind] = loadScript(e.widget);   // 老引擎：一个脚本搞定
      return engineReady[kind];
    }
    // ⚠️ 顺序不能换：pixi-live2d-display 的插件在**脚本加载那一刻**就检查对应运行时，
    //    core 后加载会报 "Could not find Cubism 4 runtime"。core → pixi → display。
    engineReady[kind] = loadScript(e.core)
      .then(function () { return loadScript(e.pixi); })
      .then(function () { return loadScript(e.display); });
    return engineReady[kind];
  }

  /* ---------------- 建渲染器 ---------------- */

  /* 老引擎：交给 L2Dwidget 自己建 DOM（它会造 #live2d-widget），尺寸沿用 120×200，
     和 11-18 之前一模一样。 */
  function bootOld(url) {
    return ensureEngine('c2').then(function () {
      if (!global.L2Dwidget) throw new Error('no L2Dwidget');
      global.L2Dwidget.init({
        model: { jsonPath: url },
        display: { position: 'fixed', width: 120, height: 200, hOffset: 0, vOffset: -14 },
        mobile: { show: true, scale: 0.7 },
        react: { opacityDefault: 0.9, opacityOnHover: 1 },
        dialog: false,
        log: false
      });
      attach();
      return global.L2Dwidget;
    });
  }

  function bootModel(url, entry) {
    entry = entry || {};
    if ((entry.kind || 'c4') === 'c2') return bootOld(url);
    return ensureEngine(entry.kind || 'c4').then(function () {
      var PIXI = global.PIXI;
      if (!PIXI || !PIXI.live2d) throw new Error('no pixi live2d');

      view.zoom = entry.zoom || 1;
      view.kind = entry.kind || 'c4';
      view.entry = entry;
      var host = ensureHost();
      var b = boxSize();
      host.style.width = b.w + 'px';
      host.style.height = b.h + 'px';

      var app = new PIXI.Application({
        width: b.w,
        height: b.h,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(global.devicePixelRatio || 1, 2)
      });
      host.appendChild(app.view);
      view.app = app;

      return PIXI.live2d.Live2DModel.from(url, { autoInteract: false }).then(function (model) {
        app.stage.addChild(model);
        view.model = model;
        fit();
        // 待机动作：官方样例都带 Idle 组，随机播一条，播完自动轮换
        // 待机动作：官方样例叫 Idle，老模型有 idle / 其他叫法，挑一个能用的
        try {
          var mm = model.internalModel && model.internalModel.motionManager;
          var gs = mm && mm.groups ? Object.keys(mm.groups) : [];
          if (gs.length) {
            var g = gs.indexOf('Idle') >= 0 ? 'Idle' : null;
            for (var gi = 0; !g && gi < gs.length; gi++) if (/idle/i.test(gs[gi])) g = gs[gi];
            model.motion(g || gs[0]);
          }
        } catch (_) {}
        attach();
        return model;
      });
    });
  }

  /* ---------------- 等容器出现并接管 ---------------- */

  function attach() {
    var t0 = Date.now();
    (function poll() {
      var host = document.getElementById('live2d-widget');
      if (host && host.offsetWidth) {
        if (global.__l2dBound) return;      // 只绑一次
        global.__l2dBound = true;
        restorePos(host);
        lockPos(host);
        bindDrag(host, next);
        fit();
        var rt = 0, lastW = global.innerWidth;
        global.addEventListener('resize', function () {
          if (Math.abs(global.innerWidth - lastW) < 2) return;
          lastW = global.innerWidth;
          clearTimeout(rt);
          rt = setTimeout(function () {
            fit();
            var r = host.getBoundingClientRect();
            applyPos(host, r.left, r.top);
          }, 150);
        });
        return;
      }
      if (Date.now() - t0 > ATTACH_TIMEOUT) return;
      setTimeout(poll, 150);
    })();
  }

  /* ---------------- 加载：先探地址、再预热纹理，最后才建模型 ---------------- */

  var pendingExtra = null;

  function hostsFor(m) { return m.path ? GH : NPM; }

  function assetUrl(prefix, m) {
    if (m.path) return prefix + m.path;
    return prefix + m.pkg + '@' + m.ver + '/assets/' + m.file;
  }

  /* 两种格式的字段名不一样：Cubism 4 在 FileReferences 里（Moc / Textures），
     Cubism 2 是平的（model / textures）。统一成 {moc, tex}。 */
  function refsOf(json) {
    var f = json && json.FileReferences;
    if (f) return { moc: f.Moc, tex: f.Textures || [] };
    return { moc: json && json.model, tex: (json && json.textures) || [] };
  }

  function probe(url, ms) {
    if (!global.fetch || !global.AbortController) return Promise.resolve('blind');
    return new Promise(function (done) {
      var ac = new AbortController();
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return; settled = true;
        try { ac.abort(); } catch (_) {}
        done(null);
      }, ms);
      fetch(url, { signal: ac.signal }).then(function (r) {
        if (settled) return;
        if (!r.ok) { settled = true; clearTimeout(timer); return done(null); }
        r.json().then(function (j) {
          if (settled) return; settled = true; clearTimeout(timer); done(j || {});
        }, function () {
          if (settled) return; settled = true; clearTimeout(timer); done({});
        });
      }, function () {
        if (settled) return; settled = true; clearTimeout(timer); done(null);
      });
    });
  }

  /* 预热：主纹理 + moc 一起先下进 HTTP 缓存，再建模型 */
  function prewarm(base, json, cb, ms) {
    var ref = refsOf(json);
    var urls = [];
    if (typeof ref.tex[0] === 'string') urls.push(base + ref.tex[0]);
    if (typeof ref.moc === 'string') urls.push(base + ref.moc);
    if (!urls.length) return cb();

    var left = urls.length, done = false;
    var timer = setTimeout(fin, ms);
    function fin() {
      if (done) return; done = true;
      clearTimeout(timer);
      cb();
    }
    function tick() { if (!done && --left <= 0) fin(); }
    for (var k = 0; k < urls.length; k++) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', urls[k], true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = tick;
      xhr.timeout = ms;
      xhr.send();
    }
  }

  /* 依次试：CDN 内轮换 → 该模型所有 CDN 都不通就换下一个模型。
     总预算 25s：最坏情况是全网都不通，不能让页面一直转圈。 */
  var TOTAL_MS = 25000;

  function cdnOrder(hosts) {
    var good = parseInt(store(K_CDN), 10);
    var order = [];
    if (isFinite(good) && good >= 0 && good < hosts.length) order.push(good);
    for (var i = 0; i < hosts.length; i++) if (i !== good) order.push(i);
    return order;
  }

  function start(depth, t0) {
    depth = depth || 0;
    t0 = t0 || Date.now();
    if (depth >= 3 || Date.now() - t0 > TOTAL_MS) return;
    var idx = readIndex();
    var m = MODELS[idx];
    var hosts = hostsFor(m);
    var order = cdnOrder(hosts);
    var firstTry = true;
    var i = 0;

    (function tryCdn() {
      if (i >= order.length) {
        store(K_MODEL, String((idx + 1) % MODELS.length));
        start(depth + 1, t0);
        return;
      }
      var ci = order[i++];
      var url = assetUrl(hosts[ci], m);
      probe(url, PROBE_MS).then(function (json) {
        if (json === null) {
          if (firstTry) store(K_CDN, null);
          firstTry = false;
          return tryCdn();
        }
        store(K_CDN, String(ci));
        var go = function () {
          bootModel(url, m).then(null, function () {
            store(K_MODEL, String((idx + 1) % MODELS.length));
            start(depth + 1, t0);
          });
        };
        if (json === 'blind') return go();
        var base = url.slice(0, url.lastIndexOf('/') + 1);
        prewarm(base, json, go, WARM_MS);
      });
    })();
  }

  function init() {
    global.__l2dInit = true;
    var idx = readIndex();
    store(K_MODEL, String(idx));   // 首次随机后就定下来
    pendingExtra = null;
    toastIfSwapped();
    start(0);
    schedulePrefetch();
    return true;
  }

  /* ---------------- 预取下一个形象 ---------------- */

  function fetchWarm(url, cb) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';   // 只要进缓存，内容不解析
      xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = function () { cb(); };
      xhr.timeout = PREFETCH_MS;
      xhr.send();
    } catch (e) { cb(); }
  }

  function prefetchOne(offset, cb) {
    var m = MODELS[(readIndex() + offset) % MODELS.length];
    var hosts = hostsFor(m);
    var i = 0;
    (function tryCdn() {
      if (i >= hosts.length) return cb();
      var url = assetUrl(hosts[i++], m);
      probe(url, PROBE_MS).then(function (json) {
        if (json === null) return tryCdn();
        if (json === 'blind') return cb();
        var base = url.slice(0, url.lastIndexOf('/') + 1);
        var ref = refsOf(json);
        var jobs = [];
        if (typeof ref.moc === 'string') jobs.push({ url: base + ref.moc, bin: true });
        ref.tex.slice(0, PREFETCH_TEX).forEach(function (t) {
          if (typeof t === 'string') jobs.push({ url: base + t, bin: false });
        });
        if (!jobs.length) return cb();
        var left = jobs.length;
        jobs.forEach(function (j) {
          var done = function () { if (!--left) cb(); };
          if (j.bin) fetchWarm(j.url, done);
          else {
            var img = new Image();
            img.onload = img.onerror = done;
            img.src = j.url;
          }
        });
      })['catch'](function () { cb(); });
    })();
  }

  function schedulePrefetch() {
    if (PREFETCH <= 0) return;
    var conn = navigator.connection || {};
    if (conn.saveData) return;
    if (/2g/i.test(conn.effectiveType || '')) return;
    setTimeout(function () {
      if (document.hidden) return;
      var k = 1;
      (function nextOne() {
        if (k > PREFETCH) return;
        prefetchOne(k++, nextOne);
      })();
    }, PREFETCH_DELAY);
  }

  global.Live2DHand = {
    init: init,
    next: next,
    models: MODELS,
    current: function () { return MODELS[readIndex()].name; },
    resetPos: function () { store(K_POS, null); location.reload(); },
    resetModel: function () { store(K_MODEL, null); location.reload(); }
  };
})(window);

/* ---- 入口：等首屏画完再拉引擎，别和熊与粒子抢带宽 ---- */
(function () {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const conn = navigator.connection || {};
  if (conn.saveData) return;

  function boot() {
    if (typeof Live2DHand !== 'undefined') Live2DHand.init();
  }

  if ('requestIdleCallback' in window) requestIdleCallback(boot, { timeout: 3000 });
  else setTimeout(boot, 1500);
})();
