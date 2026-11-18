/* ============================ Live2D（延迟加载） ============================ */
/* ---------------- 拖动 + 点按换形象（内联模块） ---------------- */
/* ==========================================================================
   Live2D 增强：可拖动 + 点一下换形象
   --------------------------------------------------------------------------
   替换页面里原来的 L2Dwidget.init({...}) 调用：
       Live2DHand.init();          // 位置、形象都会自动从上次记住的状态恢复
   依赖：live2d-widget 3.x 已加载（window.L2Dwidget 存在）

   为什么换形象用整页刷新，而不是原地重建：
   live2d-widget 3.1.4 没有 destroy 接口（源码里 0 个 destroy），重复 init 会
   多出一块 canvas 和一条动画循环；老循环画在已经摘掉的 canvas 上照样跑，
   手机换几次就卡。刷新把旧文档整个丢掉，循环随之消失，代价是一下白屏。

   浏览器要求：localStorage 可写（隐私模式可能抛错，已兜底为不记忆）。
   ========================================================================== */
(function (global) {
  'use strict';

  // 换形象的顺序表。点一下小人切到下一个；首访随机起始，之后记住。
  // 加/减形象只动这里：pkg + ver + file 拼成资源地址（前缀见下面 CDNS）。
  // ver 每个包不一样 —— rem 1.0.1、sagiri/mikoto 1.0.0；带 path 的走自托管，不用 pkg/ver。
  // 写错版本号会 404，加新形象前先用 assets/<name>.model.json 验一遍。
  // 体积（贴图已转 WebP，弱网下越大越慢）：
  //   murakumo 0.44M / mikoto 1.11M / nepgear 1.21M / sagiri 1.24M / rem 1.33M
  var MODELS = [
    // 2026-11-18 她的意思：老模型看腻了，只留 rem / sagiri / mikoto 三个，
    // 另外两个换成自托管的（贴图转 WebP，见下）。
    { name: 'rem',      pkg: 'live2d-widget-model-rem',      ver: '1.0.1', file: 'rem.model.json' },
    { name: 'sagiri',   pkg: 'live2d-widget-model-sagiri',   ver: '1.0.0', file: 'sagiri.model.json' },
    { name: 'mikoto',   pkg: 'live2d-widget-model-mikoto',   ver: '1.0.0', file: 'mikoto.model.json' },
    // 这两个是从社区库挪进本仓库的（npm 上没有），path 相对仓库根
    { name: 'murakumo', path: 'models/murakumo/index.json' },
    { name: 'nepgear',  path: 'models/nepgear/index.json' }
  ];
  // 资源 CDN，按顺序试。jsdelivr 的三个域名轮着试完再退到 unpkg。
  // 末尾两家是 jsdelivr 的国内公共反代 —— 公共镜像随时可能挂，只当最后兜底。
  // ⚠️ 别再往这里加 npmmirror：阿里那套有包名白名单，live2d-widget-model-*
  //    会被 403「is not allow to unpkg files」（11/15 实测）。
  var CDNS = [
    'https://fastly.jsdelivr.net/npm/',
    'https://cdn.jsdelivr.net/npm/',
    'https://gcore.jsdelivr.net/npm/',
    'https://unpkg.com/',
    'https://cdn.jsdmirror.com/npm/',
    'https://jsd.onmicrosoft.cn/npm/'
  ];
  // 自托管模型的地址前缀（via-skin 仓库根）。npm 那六家对它是无效的 ——
  // 包名不存在，所以单独一组，同样三家 jsDelivr 域名轮试。
  var GH = [
    // ⚠️ 不能用 jsDelivr：它对 gh 源里的**图片**一律 301 到 raw.githubusercontent，
    //    手机（国内）拿不到 → 模型渲染不出来。npm 源没这问题，所以老模型仍走 CDNS。
    //    只剩公共反代能用，四家轮试，全挂就让 start() 换下一个形象。
    'https://gh-proxy.com/https://raw.githubusercontent.com/yiwasui/via-skin/main/',
    'https://ghfast.top/https://raw.githubusercontent.com/yiwasui/via-skin/main/',
    'https://ghproxy.net/https://raw.githubusercontent.com/yiwasui/via-skin/main/',
    'https://ghproxy.cc/https://raw.githubusercontent.com/yiwasui/via-skin/main/'
  ];
  /* 11/18：她反馈“有时候半天才加载出来”。原来单次探址 6s、六家轮着撞，
     最坏 36s 全花在等超时上。降到 3.5s，并记住上次探通的那一家 —— 同一网络
     下次直接从它开始，省掉前面几次空等。 */
  var PROBE_MS = 3500;   // 单次探 model.json 的上限
  var WARM_MS  = 9000;   // 等纹理/moc 进缓存的上限（超时也照样 init，别无限等）

  var K_MODEL = 'l2d:model';   // 上次是第几个形象
  var K_CDN   = 'l2d:cdn';     // 上次探通的 CDN 下标（下次优先用）
  var K_POS   = 'l2d:pos';     // 上次拖到的位置 {x,y}
  var K_SWAP  = 'l2d:swapped'; // 刚换过形象（只用来弹一次名字）
  var TAP_TOL = 6;             // 手指移动小于这个距离算「点一下」
  var ATTACH_TIMEOUT = 15000;

  /* ---- 预取 ----
     实测：不切换时很快（走浏览器缓存），一按切换就慢 —— 因为新形象的全部资源
     都是第一次下载。所以当前形象画出来之后，趁空闲把**下一个**形象的主纹理
     先下进 HTTP 缓存，切换时就是缓存命中。
     PREFETCH = 0 关掉；1 = 只备下一个；2 = 备下两个（流量翻倍）。 */
  var PREFETCH = 1;
  var PREFETCH_DELAY = 4000;   // 等首屏渲染完再开始，别抢带宽
  var PREFETCH_TEX = 8;        // 每个形象预取几张纹理（shizuku 有 6 张，8 够用）
                               // 想省流量就调到 2：只备 moc + 前两张，切换时仍要现下剩下的
  var PREFETCH_MS = 20000;     // 单个文件的预取上限

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

  /* 组件建完 DOM 后还会整体改写一次 style（cssText），会把 left/top 一起抹掉，
     而且改写时机不固定（有时在模型加载完之后）。所以盯住 style 属性：
     一旦发现 left/top 不是我们写的值，就重新落位；自己写的那次会被值比对跳过，
     不会自激。budget 兜底，避免和组件来回打架。 */
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
    /* 只守前 4 秒：组件改写 style 的时机集中在初始化阶段。之后还盯着，
       它内部一改动画我们就硬推回去，两边互相打架 —— 表现就是人物偶尔抖一下、
       画面上留下挪动的残影。 */
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
      stopLock();                    // 手一碰就接管，别再自动落位
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

    // 必须用捕获阶段：组件会在 canvas 上处理点击动作，冒泡阶段可能被它挡掉
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', function () { active = false; }, true);

    // 老内核没有 PointerEvent 时退回 touch
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

  /* ---------------- 等组件把 DOM 建出来 ---------------- */

  function attach() {
    var t0 = Date.now();
    (function poll() {
      var host = document.getElementById('live2d-widget');
      if (host && host.offsetWidth) {
        global.__l2dBound = true;
        restorePos(host);
        lockPos(host);
        bindDrag(host, next);
        // 转屏/缩放后把位置夹回可视区
        /* 只认宽度变化。手机上点搜索框弹键盘，viewport 高度会变、宽度不变，
           原来那版照样重算位置 —— 她看到的“人物位置突然偏移”就是这么来的。 */
        var rt = 0, lastW = global.innerWidth;
        global.addEventListener('resize', function () {
          if (Math.abs(global.innerWidth - lastW) < 2) return;
          lastW = global.innerWidth;
          clearTimeout(rt);
          rt = setTimeout(function () {
            var r = host.getBoundingClientRect();
            applyPos(host, r.left, r.top);
          }, 150);
        });
        return;
      }
      if (Date.now() - t0 > ATTACH_TIMEOUT) return;   // 组件没起来就算了，别死循环
      setTimeout(poll, 150);
    })();
  }

  /* ---------------- 入口 ---------------- */

  /* ---------------- 加载：先探地址、再预热纹理，最后才 init ---------------- */

  var pendingExtra = null;

  /* 一个形象的资源地址。npm 包和自托管仓库两种来源，前缀不同：
       npm  = <CDN>/<pkg>@<ver>/assets/<file>
       gh   = <GH>/models/<name>/index.json（path 里已带全相对路径） */
  function hostsFor(m) { return m.path ? GH : CDNS; }

  function assetUrl(prefix, m) {
    if (m.path) return prefix + m.path;
    return prefix + m.pkg + '@' + m.ver + '/assets/' + m.file;
  }

  /* 探一次 model.json：拿到 json 说明这家 CDN 通，拿不到就换下一家。
     没有 fetch 的内核返回 'blind'，表示探测不了、直接盲用这家。 */
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

  /* 预热：纹理 + moc 骨架一起先下进 HTTP 缓存，再 init。
     原来只备纹理，可组件 init 之后还要下 moc —— shizuku 的 moc 有 675KB，
     占整包四成，于是照样白屏半天。两个都备上，组件起来直接命中缓存。
     超时/失败都放行——宁可用慢的，也不留一块空画布。 */
  function prewarm(base, json, cb, ms) {
    var urls = [];
    var tex = json && json.textures && json.textures[0];
    if (typeof tex === 'string') urls.push(base + tex);
    var moc = json && json.model;
    if (typeof moc === 'string') urls.push(base + moc);
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

  function bootWidget(url, extra) {
    var opts = {
      model: { jsonPath: url },
      display: { position: 'fixed', width: 120, height: 200, hOffset: 0, vOffset: -14 },
      mobile: { show: true, scale: 0.7 },
      react: { opacityDefault: 0.9, opacityOnHover: 1 },
      dialog: false,
      log: false
    };
    if (extra) for (var k in extra) opts[k] = extra[k];
    global.L2Dwidget.init(opts);
    attach();
  }

  /* 依次试：CDN 内轮换 → 该模型所有 CDN 都不通就换下一个模型
     （并写进 K_MODEL，免得每次刷新都先撞一遍墙）。
     总预算 25s：最坏情况是全网都不通，不能让页面一直转圈。 */
  var TOTAL_MS = 25000;

  /* 上次探通的那一家排最前，其余按原顺序跟上。它这次要是不通，
     第一轮失败就把它忘掉，免得以后每次都先撞一次墙。 */
  function cdnOrder(hosts) {
    var good = parseInt(store(K_CDN), 10);
    var order = [];
    if (isFinite(good) && good >= 0 && good < hosts.length) order.push(good);
    for (var i = 0; i < hosts.length; i++) if (i !== good) order.push(i);
    return order;
  }

  function start(depth, extra, t0) {
    depth = depth || 0;
    t0 = t0 || Date.now();
    if (depth >= 3 || Date.now() - t0 > TOTAL_MS) return;   // 放弃，安静地不要小人
    var idx = readIndex();
    var m = MODELS[idx];
    var hosts = hostsFor(m);
    var order = cdnOrder(hosts);
    var firstTry = true;
    var i = 0;

    (function tryCdn() {
      if (i >= order.length) {
        store(K_MODEL, String((idx + 1) % MODELS.length));
        start(depth + 1, extra, t0);
        return;
      }
      var ci = order[i++];
      var url = assetUrl(hosts[ci], m);
      probe(url, PROBE_MS).then(function (json) {
        if (json === null) {
          if (firstTry) store(K_CDN, null);   // 记住的那家不灵了
          firstTry = false;
          return tryCdn();
        }
        store(K_CDN, String(ci));
        if (json === 'blind') return bootWidget(url, extra);
        var base = url.slice(0, url.lastIndexOf('/') + 1);
        prewarm(base, json, function () { bootWidget(url, extra); }, WARM_MS);
      });
    })();
  }

  function init(extra) {
    global.__l2dInit = true;
    if (typeof global.L2Dwidget === 'undefined') return false;
    var idx = readIndex();
    store(K_MODEL, String(idx));   // 首次随机后就定下来：之后刷新看到的还是这个
    pendingExtra = extra || null;
    toastIfSwapped();
    start(0, pendingExtra);
    schedulePrefetch();
    return true;
  }

  /* 预取「后面第 offset 个」形象。
     11/15 实测各形象的体积构成：moc 骨架往往比纹理还大（shizuku.moc 675KB，
     整包 1.7MB），所以 moc 必须一起预取，只备纹理等于白备。 */
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
        if (json === null) return tryCdn();          // 这家不通，换下一家
        if (json === 'blind') return cb();           // 探不了就别盲下，省流量
        var base = url.slice(0, url.lastIndexOf('/') + 1);
        var jobs = [];
        if (typeof json.model === 'string') jobs.push({ url: base + json.model, bin: true });
        (json.textures || []).slice(0, PREFETCH_TEX).forEach(function (t) {
          if (typeof t === 'string') jobs.push({ url: base + t, bin: false });
        });
        if (!jobs.length) return cb();
        var left = jobs.length;
        jobs.forEach(function (j) {
          var done = function () { if (!--left) cb(); };
          if (j.bin) fetchWarm(j.url, done);          // 骨架走 XHR
          else {                                      // 纹理走 Image，免 CORS
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
    if (conn.saveData) return;                        // 开了省流量模式就不预取
    if (/2g/i.test(conn.effectiveType || '')) return;
    setTimeout(function () {
      if (document.hidden) return;                    // 切后台了就别下载
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

(function () {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const conn = navigator.connection || {};
  if (conn.saveData) return;                       // 开了省流量模式就不拉模型

  const CDNS = [
    'https://fastly.jsdelivr.net/npm/live2d-widget@3.1.4/lib/L2Dwidget.min.js',
    'https://cdn.jsdelivr.net/npm/live2d-widget@3.1.4/lib/L2Dwidget.min.js',
    'https://unpkg.com/live2d-widget@3.1.4/lib/L2Dwidget.min.js'
  ];

  /* 单家 CDN 等这么久还没回，就当它挂了换下一家。
     不设上限的话，弱网下会一直「加载中」，看起来就是小人半天不出来。 */
  const SCRIPT_MS = 8000;

  function drop(node) {
    if (!node) return;
    if (node.remove) node.remove();
    else if (node.parentNode) node.parentNode.removeChild(node);
  }

  function boot() {
    let i = 0;
    (function tryNext() {
      if (i >= CDNS.length) return;                // 全挂就静静地不要它
      const s = document.createElement('script');
      let settled = false;
      const timer = setTimeout(function () {
        if (settled) return; settled = true;
        s.onload = s.onerror = null;
        drop(s);                                    // 别让它回头又 load 一次
        tryNext();
      }, SCRIPT_MS);
      s.src = CDNS[i++];
      s.async = true;
      s.onload = function () {
        if (settled) return; settled = true;
        clearTimeout(timer);
        init();
      };
      s.onerror = function () {
        if (settled) return; settled = true;
        clearTimeout(timer);
        drop(s);
        tryNext();
      };
      document.head.appendChild(s);
    })();
  }

  function init() {
    if (typeof Live2DHand === 'undefined') return;
    Live2DHand.init();      // 形象首次随机，之后记住；点一下换下一个
  }

  // 等首屏画完再拉，别和熊与粒子抢带宽
  if ('requestIdleCallback' in window) requestIdleCallback(boot, { timeout: 3000 });
  else setTimeout(boot, 1500);
})();
