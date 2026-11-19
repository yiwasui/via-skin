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
  var MODELS = [
    { name: 'haru',   path: 'models/haru/Haru.model3.json' },
    { name: 'hiyori', path: 'models/hiyori/Hiyori.model3.json' },
    // Rice 在画布里画得比别的模型小一圈，单独给个放大系数，否则缩成火柴人
    { name: 'rice',   path: 'models/rice/Rice.model3.json', zoom: 1.9 },
    { name: 'mao',    path: 'models/mao/Mao.model3.json' }
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
  var ENGINE = {
    core: [
      'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
      'https://fastly.jsdelivr.net/npm/live2dcubismcore@1.0.2/live2dcubismcore.min.js',
      'https://unpkg.com/live2dcubismcore@1.0.2/live2dcubismcore.min.js'
    ],
    pixi: npmAll('pixi.js@6.5.10/dist/browser/pixi.min.js'),
    display: npmAll('pixi-live2d-display@0.4.0/dist/cubism4.min.js')
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

  var view = { app: null, model: null, host: null, w: 0, zoom: 1 };

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
    if (!app || !model || !host) return;
    var b = boxSize(), W = b.w, H = b.h;

    host.style.width = W + 'px';
    host.style.height = H + 'px';
    app.renderer.resize(W, H);

    // 按**实际画出来的范围**缩放，不用画布尺寸：官方样例的画布留白各不相同
    // （Rice 的画布大、人小，按画布缩就缩成一个火柴人）。
    model.scale.set(1);
    model.position.set(0, 0);
    var bb = null;
    try { model.update(0); bb = model.getLocalBounds(); } catch (_) {}
    var im = model.internalModel;
    var x0 = 0, y0 = 0;
    var w0 = (im && im.originalWidth) || model.width || 1;
    var h0 = (im && im.originalHeight) || model.height || 1;
    if (bb && bb.width > 1 && bb.height > 1) {
      x0 = bb.x; y0 = bb.y; w0 = bb.width; h0 = bb.height;
    }

    var s = Math.min(W * 0.96 / w0, H * 0.98 / h0) * (view.zoom || 1);
    model.scale.set(s);
    model.x = (W - w0 * s) / 2 - x0 * s;
    model.y = H - h0 * s - y0 * s;
    view.w = W;
  }

  /* ---------------- 引擎脚本：用到才拉 ---------------- */

  var engineReady = null;

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

  function ensureEngine() {
    if (engineReady) return engineReady;
    // ⚠️ 顺序不能换：pixi-live2d-display 的 cubism4 插件在**脚本加载那一刻**就检查
    //    Live2DCubismCore 是否已存在，core 后加载会报
    //    "Could not find Cubism 4 runtime"。所以 core → pixi → display。
    engineReady = loadScript(ENGINE.core)
      .then(function () { return loadScript(ENGINE.pixi); })
      .then(function () { return loadScript(ENGINE.display); });
    return engineReady;
  }

  /* ---------------- 建渲染器 ---------------- */

  function bootModel(url, zoom) {
    return ensureEngine().then(function () {
      var PIXI = global.PIXI;
      if (!PIXI || !PIXI.live2d) throw new Error('no pixi live2d');

      view.zoom = zoom || 1;
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
        try {
          var mm = model.internalModel && model.internalModel.motionManager;
          if (mm && mm.groups && Object.keys(mm.groups).length) model.motion('Idle');
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
          bootModel(url, m.zoom).then(null, function () {
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
