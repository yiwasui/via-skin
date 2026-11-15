// ==UserScript==
// @name         GitHub README 中文对照
// @namespace    local.ghzh
// @version      1.0.0
// @description  在 GitHub README / Issue 正文每段下方插入中文译文，原文保持不动。点右下角「译」按钮开启，再点收起。
// @author       local
// @match        https://github.com/*
// @match        https://gist.github.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      cn.bing.com
// @connect      api.mymemory.translated.net
// ==/UserScript==

/*
  设计要点（改之前先读）
  ─────────────────────────────────────────────
  1. 只插译文、不改原文。原文的链接、行内代码、图片全部原样保留，
     坏了也能一键收起，不会像「替换式翻译」那样把页面搞散。
  2. 主源 = 必应（无字数限额、质量最好，靠 GM_xmlhttpRequest 走跨域）；
     备源 = MyMemory（CORS 开放，直接 fetch）。必应挂了自动降级。
  3. 必应单批可带多条 text，所以按 8 条一批发送，请求数砍掉 8 倍。
  4. MyMemory 单次 query 硬上限 500 字节 → 文本先按 450 字符切句。
  5. 译文缓存在 localStorage，同一段第二次打开不再发请求。
  6. 只认「最内层块」：li 里套 p 时跳过 li，避免同一句话被翻两遍。
*/

(function () {
  'use strict';

  var BTN_ID = 'ghzh-toggle';
  var CLS = 'ghzh';
  var CACHE_KEY = 'ghzh-cache-v1';
  var MAXQ = 450;      // 单条送翻长度上限（MyMemory 限制 500）
  var MAXBATCH = 12;   // 必应单批最多合并条数
  var MAXLEN = 2400;   // 必应单批最多字符数
  var GAP = 90;        // 批次间隔，防限流

  var BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,dd,summary,figcaption';
  var DROP_SEL = 'pre,svg,canvas,img,script,style,.' + CLS;

  /* ---------- 缓存 ---------- */
  var cache = {};
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (e) { cache = {}; }
  function saveCache() {
    try {
      var ks = Object.keys(cache);
      if (ks.length > 1200) ks.slice(0, ks.length - 1200).forEach(function (k) { delete cache[k]; });
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (e) { /* 配额满了就算了 */ }
  }

  /* ---------- 工具 ---------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function gm(opts) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('no GM_xmlhttpRequest')); return; }
      try {
        GM_xmlhttpRequest({
          method: opts.method || 'GET',
          url: opts.url,
          data: opts.data,
          headers: opts.headers || {},
          timeout: 20000,
          onload: function (r) { resolve(r); },
          onerror: function () { reject(new Error('net error')); },
          ontimeout: function () { reject(new Error('timeout')); }
        });
      } catch (e) { reject(e); }
    });
  }

  function safeJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }

  function decodeEnt(s) {
    return String(s)
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); })
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }

  /* ---------- 取文本 / 判断是否要翻 ---------- */
  function textOf(el) {
    var c = el.cloneNode(true);
    var junk = c.querySelectorAll(DROP_SEL);
    for (var i = 0; i < junk.length; i++) junk[i].parentNode.removeChild(junk[i]);
    return (c.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function needTrans(t) {
    if (!t || t.length < 4) return false;
    if (/^[\s\d\W_]+$/.test(t)) return false;                 // 纯数字/符号
    var cn = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
    if (cn / t.length > 0.12) return false;                   // 本来就是中文
    var en = (t.match(/[a-zA-Z]/g) || []).length;
    if (en < 3) return false;
    if (/^(https?:|www\.)\S+$/i.test(t)) return false;        // 纯链接
    return true;
  }

  /* ---------- 切句 ---------- */
  function chunk(text, max) {
    if (text.length <= max) return [text];
    var out = [], rest = text;
    while (rest.length > max) {
      var cut = rest.lastIndexOf('. ', max);
      if (cut < max * 0.4) cut = rest.lastIndexOf('; ', max);
      if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
      if (cut < max * 0.4) cut = max;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
    return out;
  }

  /* ---------- 必应 ---------- */
  var bing = { token: null, key: null, at: 0 };

  async function bingEnsure() {
    if (bing.token && Date.now() - bing.at < 30 * 60e3) return;
    var r = await gm({ url: 'https://cn.bing.com/translator', headers: { Accept: 'text/html' } });
    var h = (r && r.responseText) || '';
    var m = h.match(/params_AbusePreventionHelper\s*=\s*\[(\d+)\s*,\s*"([^"]+)"/);
    if (!m) throw new Error('bing token not found');
    bing.key = m[1];
    bing.token = m[2];
    bing.at = Date.now();
  }

  async function bingOnce(text) {
    await bingEnsure();
    var body = 'fromLang=en&to=zh-Hans&text=' + encodeURIComponent(text)
      + '&token=' + encodeURIComponent(bing.token) + '&key=' + bing.key;
    var ig = String(10000 + Math.floor(Math.random() * 89000));
    var r = await gm({
      method: 'POST',
      url: 'https://cn.bing.com/ttranslatev3?isVertical=1&IG=' + ig + '&IID=translator.5028.1',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: body
    });
    var j = safeJson(r && r.responseText);
    if (!j) throw new Error('bing bad response');
    if (j.ShowCaptcha || j.statusCode || j.errorMessage) throw new Error('bing blocked');
    if (!Array.isArray(j)) j = [j];
    var tr = j[0] && j[0].translations && j[0].translations[0] && j[0].translations[0].text;
    if (!tr) throw new Error('bing empty');
    return tr;
  }

  // 必应一次只认一条 text，但换行拼接后返回行数与顺序严格对应 → 合并批量
  async function bingTranslate(items) {
    try {
      var joined = await bingOnce(items.join('\n'));
      var lines = joined.split('\n').map(function (s) { return s.trim(); });
      if (lines.length === items.length && lines.every(Boolean)) return lines;
    } catch (e) {
      bing.token = null;   // token 可能过期，下次重取
      if (items.length === 1) throw e;
    }
    // 行数对不上 → 退回逐条
    var out = [];
    for (var i = 0; i < items.length; i++) {
      try { out.push((await bingOnce(items[i])).trim()); }
      catch (e2) { out.push(''); }
      await sleep(90);
    }
    if (out.some(function (x) { return !x; })) throw new Error('bing partial');
    return out;
  }

  /* ---------- MyMemory 兜底 ---------- */
  async function mmTranslate(text) {
    if (cache[text]) return cache[text];
    var u = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en|zh-CN';
    var res = await fetch(u);
    var j = await res.json();
    var s = j && j.responseData && j.responseData.translatedText;
    if (!s || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(s)) throw new Error('mymemory limit');
    s = decodeEnt(s);
    cache[text] = s;
    return s;
  }

  /* ---------- 采集 ---------- */
  function findRoot() {
    return document.querySelector('article.markdown-body')
      || document.querySelector('#readme .markdown-body')
      || document.querySelector('.markdown-body');
  }

  function collect() {
    var root = findRoot();
    if (!root) return null;
    var els = root.querySelectorAll(BLOCK_SEL);
    var blocks = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest('.' + CLS)) continue;
      if (el.querySelector(BLOCK_SEL)) continue;   // 只取最内层块
      var t = textOf(el);
      if (!needTrans(t)) continue;
      blocks.push({ el: el, text: t });
    }
    return blocks;
  }

  /* ---------- 翻译调度 ---------- */
  async function translateAll(blocks, onProgress) {
    var jobs = [];
    blocks.forEach(function (b, bi) {
      chunk(b.text, MAXQ).forEach(function (s) { jobs.push({ bi: bi, text: s, out: '' }); });
    });

    var batches = [], cur = [], curLen = 0;
    jobs.forEach(function (j) {
      if (cur.length && (cur.length >= MAXBATCH || curLen + j.text.length > MAXLEN)) {
        batches.push(cur); cur = []; curLen = 0;
      }
      cur.push(j); curLen += j.text.length + 1;
    });
    if (cur.length) batches.push(cur);

    var done = 0;
    for (var bi = 0; bi < batches.length; bi++) {
      var batch = batches[bi];
      var texts = batch.map(function (j) { return j.text; });
      var outs = null;

      try { outs = await bingTranslate(texts); } catch (e) { outs = null; }

      if (!outs) {
        outs = [];
        for (var k = 0; k < texts.length; k++) {
          try { outs.push(await mmTranslate(texts[k])); }
          catch (e2) { outs.push(''); }
        }
        saveCache();
      }

      batch.forEach(function (j, idx) { j.out = outs[idx] || ''; });
      done += batch.length;
      if (onProgress) onProgress(done, jobs.length);
      await sleep(GAP);
    }

    var res = blocks.map(function () { return []; });
    jobs.forEach(function (j) { if (j.out) res[j.bi].push(j.out); });
    return res.map(function (a) { return a.join(''); });
  }

  /* ---------- 渲染 ---------- */
  function attach(el, node) {
    var tag = el.tagName;
    if (tag === 'LI' || tag === 'TD' || tag === 'TH' || tag === 'DD' || tag === 'SUMMARY' || tag === 'FIGCAPTION') {
      var sub = el.querySelector(':scope > ul, :scope > ol');
      if (sub) el.insertBefore(node, sub); else el.appendChild(node);
    } else if (el.parentNode) {
      el.parentNode.insertBefore(node, el.nextSibling);
    }
  }

  function render(blocks, texts) {
    var n = 0;
    blocks.forEach(function (b, i) {
      var t = (texts[i] || '').trim();
      if (!t) return;
      var d = document.createElement('div');
      d.className = CLS;
      d.setAttribute('data-ghzh', '1');
      d.textContent = t;
      attach(b.el, d);
      n++;
    });
    return n;
  }

  /* ---------- 样式 ---------- */
  function injectCss() {
    if (document.getElementById('ghzh-style')) return;
    var s = document.createElement('style');
    s.id = 'ghzh-style';
    s.textContent = [
      '.' + CLS + '{margin:6px 0 14px;padding:7px 11px;border-left:3px solid #4c8bf5;',
      'background:rgba(76,139,245,.07);color:#3f4a5a;font-size:14px;line-height:1.75;',
      'border-radius:0 5px 5px 0;word-break:break-word;',
      'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}',
      'li>.' + CLS + '{margin:4px 0 8px}',
      '@media (prefers-color-scheme:dark){.' + CLS + '{background:rgba(76,139,245,.15);color:#adbac7}}',
      '#ghzh-toggle{position:fixed;right:10px;bottom:96px;z-index:2147483000;width:42px;height:42px;',
      'border-radius:21px;border:1px solid rgba(128,128,128,.35);background:#fff;color:#1f2328;',
      'font:600 15px/1 -apple-system,"PingFang SC",sans-serif;box-shadow:0 3px 12px rgba(0,0,0,.2);',
      'display:flex;align-items:center;justify-content:center;user-select:none;',
      '-webkit-tap-highlight-color:transparent;cursor:pointer}',
      '#ghzh-toggle.busy{opacity:.65}',
      '@media (prefers-color-scheme:dark){#ghzh-toggle{background:#22272e;color:#dadde1;border-color:rgba(255,255,255,.2)}}'
    ].join('');
    document.head.appendChild(s);
  }

  /* ---------- 按钮 ---------- */
  var btn, state = 'idle';

  function toast(msg) {
    var d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;left:50%;bottom:150px;transform:translateX(-50%);z-index:2147483001;' +
      'background:rgba(0,0,0,.82);color:#fff;padding:8px 14px;border-radius:6px;font-size:13px;' +
      'max-width:78vw;text-align:center;line-height:1.5';
    document.body.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2600);
  }

  async function onClick() {
    if (state === 'busy') return;

    var made = document.querySelectorAll('.' + CLS);
    if (made.length) {
      var hidden = made[0].style.display === 'none';
      for (var i = 0; i < made.length; i++) made[i].style.display = hidden ? '' : 'none';
      btn.textContent = hidden ? '译' : '藏';
      return;
    }

    var blocks = collect();
    if (!blocks || !blocks.length) { toast('这一页没有找到可翻译的正文'); return; }

    state = 'busy';
    btn.classList.add('busy');
    try {
      var texts = await translateAll(blocks, function (d, t) {
        btn.textContent = Math.round(d / t * 100) + '%';
      });
      var n = render(blocks, texts);
      var miss = blocks.length - n;
      btn.textContent = '译';
      if (!n) {
        toast('一段都没翻成。多半是接口临时限流，过几分钟再点一次。');
      } else if (miss > 0) {
        toast('翻好 ' + n + ' 段，' + miss + ' 段没翻成（接口限流），过会儿再点一次补齐');
      }
    } catch (e) {
      btn.textContent = '译';
      toast('翻译失败：' + (e && e.message ? e.message : e));
    } finally {
      btn.classList.remove('busy');
      state = 'idle';
    }
  }

  function mount() {
    if (document.getElementById(BTN_ID)) return;
    injectCss();
    btn = document.createElement('div');
    btn.id = BTN_ID;
    btn.textContent = '译';
    btn.addEventListener('click', onClick, false);
    document.body.appendChild(btn);
  }

  /* ---------- 启动 ---------- */
  mount();
  // GitHub 是 Turbo 导航，切页面不重载 body，按钮可能被清掉，这里兜一下
  setTimeout(mount, 1500);
  setTimeout(mount, 4000);
})();
