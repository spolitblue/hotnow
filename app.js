/* ============================================================================
 * HotNow · 全网热榜 — 应用逻辑
 * ----------------------------------------------------------------------------
 * 经典脚本（非 ES module）：双击 index.html 也能直接运行。
 * 后端可选：若同源存在 /api/health（即用 server.mjs 启动），则走本地缓存代理；
 * 否则直连 60s API（该接口允许跨域，CORS: *）。
 * ==========================================================================*/
(function () {
  'use strict';

  /* ======================== 常量 & 状态 ======================== */

  var ALL_SOURCES = window.HOT_SOURCES || [];
  var SOURCES = ALL_SOURCES.slice();       // 按设置过滤后的启用源（可选源默认关闭）
  var CATS = window.HOT_CATEGORIES || [];
  var UPSTREAM = window.HOT_UPSTREAM || 'https://60s-api.viki.moe';
  var FLAKY = window.HOT_FLAKY || [];

  var LS_CACHE = 'hotnow:cache:v2';
  var LS_SETTINGS = 'hotnow:settings:v2';
  var TTL = 5 * 60 * 1000;          // 5 分钟内视为新鲜
  var CONCURRENCY = 1;               // 上游对突发很敏感：严格串行
  var MIN_GAP = 1500;                // 每次请求之间的最小间隔（实测 1.5s 可全量成功）
  var FETCH_TIMEOUT = 16000;

  var DEFAULTS = {
    count: 10,
    auto: 600,
    theme: 'auto',
    compact: false,
    hideFailed: true,
    open: 'modal',
    view: 'cards',
    tryFlaky: false,
  };

  var API_BASE = UPSTREAM;
  var USING_PROXY = false;

  var state = {
    category: 'all',
    query: '',
    settings: Object.assign({}, DEFAULTS),
    data: {},           // id -> { status, items, error, fetchedAt, note }
    expanded: {},       // id -> true
    showFailed: false,  // 临时显示失败源
    lastUpdated: 0,
    online: navigator.onLine,
    booted: false,
    allLoaded: false,
  };

  var cardNodes = {};      // id -> element
  var rendered = {};       // id -> array of items currently rendered
  var clustersCache = { version: -1, list: [] };
  var dataVersion = 0;
  var lastVisibleIds = '';
  var topicCount = 0;
  var MAX_PAIRS = 250000;  // 聚类候选对上限，防止长尾爆炸
  var timers = { auto: null, clock: null, save: null, search: null, heal: null, rest: null };

  /* ======================== 工具函数 ======================== */

  var $ = function (sel) { return document.querySelector(sel); };

  function esc(str) {
    return String(str === undefined || str === null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function escRe(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* 先转义再高亮，避免 XSS */
  function hl(text, query) {
    var t = String(text === undefined || text === null ? '' : text);
    if (!query) return esc(t);
    var idx = t.toLowerCase().indexOf(String(query).toLowerCase());
    if (idx < 0) return esc(t);
    return esc(t.slice(0, idx)) + '<mark>' + esc(t.slice(idx, idx + query.length)) + '</mark>' +
      esc(t.slice(idx + query.length));
  }

  function fmtCount(n) {
    n = Number(n);
    if (!Number.isFinite(n)) return '';
    if (n >= 100000000) return (n / 100000000).toFixed(2).replace(/\.?0+$/, '') + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return String(n);
  }

  function fmtHeat(item) {
    if (item.heatText) return String(item.heatText);
    if (item.heat === undefined || item.heat === null) return '';
    var n = Number(item.heat);
    if (!Number.isFinite(n)) return '';
    if (n >= 10000) return fmtCount(n);
    return String(n);
  }

  function fmtTime(ts) {
    if (!ts) return '–';
    var d = new Date(ts);
    var p = function (v) { return String(v).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtAgo(ts) {
    if (!ts) return '从未更新';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 10) return '刚刚更新';
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }
  function load(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function toast(msg) {
    var wrap = $('#toasts');
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(function () { el.remove(); }, 320);
    }, 1900);
  }

  function copyText(text, msg) {
    var done = function () { toast(msg || '已复制'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else { fallback(); }
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch (e) { toast('复制失败，请手动选择'); }
    }
  }

  function openLink(url) {
    if (!url) { toast('该条目没有原文链接'); return; }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function srcById(id) {
    for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].id === id) return SOURCES[i];
    return null;
  }

  /* ======================== 设置 ======================== */

  function loadSettings() {
    var saved = load(LS_SETTINGS);
    if (saved && typeof saved === 'object') {
      state.settings = Object.assign({}, DEFAULTS, saved);
    }
  }

  function saveSettings() { store(LS_SETTINGS, state.settings); }

  /* 可选源（B 站 / 小红书 / 懂车帝 / 猫眼实时等上游常年 500 的接口）默认关闭 */
  function applySourceFilter() {
    var on = !!state.settings.tryFlaky;
    SOURCES = ALL_SOURCES.filter(function (s) { return on || !s.optional; });
  }

  function applyTheme() {
    var t = state.settings.theme;
    if (t === 'auto') {
      var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      t = dark ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', t);
    $('#themeIcon').innerHTML = '<use href="' + (t === 'dark' ? '#i-sun' : '#i-moon') + '"></use>';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0c0f15' : '#ff3b30');
  }

  function cycleTheme() {
    var cur = state.settings.theme;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    state.settings.theme = dark ? 'light' : 'dark';
    if (cur === 'auto' && dark) state.settings.theme = 'light';
    applyTheme();
    saveSettings();
    syncSettingsUI();
  }

  function syncSettingsUI() {
    $('#setCount').value = String(state.settings.count);
    $('#setAuto').value = String(state.settings.auto);
    $('#setCompact').checked = !!state.settings.compact;
    $('#setHideFailed').checked = !!state.settings.hideFailed;
    $('#setOpen').value = state.settings.open;
    var flaky = $('#setTryFlaky');
    if (flaky) flaky.checked = !!state.settings.tryFlaky;
    var seg = $('#seg');
    if (seg) {
      Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) {
        b.classList.toggle('active', b.dataset.view === state.settings.view);
      });
    }
  }

  /* ======================== 缓存 ======================== */

  function loadCache() {
    var c = load(LS_CACHE);
    if (!c || !c.sources) return false;
    var n = 0;
    Object.keys(c.sources).forEach(function (id) {
      if (!srcById(id)) return;
      var entry = c.sources[id];
      if (!entry || !Array.isArray(entry.items) || !entry.items.length) return;
      state.data[id] = {
        status: 'cached',
        items: entry.items,
        note: entry.note || '',
        fetchedAt: entry.fetchedAt || 0,
        error: '',
      };
      n++;
    });
    return n > 0;
  }

  var saveCache = debounce(function () {
    var out = { v: 2, savedAt: Date.now(), sources: {} };
    Object.keys(state.data).forEach(function (id) {
      var d = state.data[id];
      if (d && d.items && d.items.length) {
        out.sources[id] = { items: d.items, note: d.note || '', fetchedAt: d.fetchedAt };
      }
    });
    if (!store(LS_CACHE, out)) {
      // 超出配额：退化为只缓存标题与链接
      Object.keys(out.sources).forEach(function (id) {
        out.sources[id].items = out.sources[id].items.map(function (it) {
          return { title: it.title, heat: it.heat, heatText: it.heatText, link: it.link, rank: it.rank };
        });
      });
      store(LS_CACHE, out);
    }
  }, 1200);

  /* ======================== 网络：并发队列 + 重试 ======================== */

  var queue = [];
  var active = 0;
  var lastStart = 0;
  var pumpTimer = null;

  function enqueue(task) {
    return new Promise(function (resolve) {
      queue.push({ task: task, resolve: resolve });
      pump();
    });
  }

  function pump() {
    while (active < CONCURRENCY && queue.length) {
      var gap = Date.now() - lastStart;
      if (gap < MIN_GAP) {
        // 错峰发起，避免瞬时突发被上游限流（429）
        if (!pumpTimer) {
          pumpTimer = setTimeout(function () { pumpTimer = null; pump(); }, MIN_GAP - gap);
        }
        return;
      }
      var job = queue.shift();
      active++;
      lastStart = Date.now();
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.resolve)
        .then(function () { active--; pump(); });
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function fetchOnce(path) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT);
    return fetch(API_BASE + path, {
      signal: ctl.signal,
      headers: { accept: 'application/json' },
      cache: USING_PROXY ? 'default' : 'no-store',
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) {
        var e = new Error('HTTP ' + res.status);
        e.status = res.status;
        throw e;
      }
      return res.json();
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function fetchSource(src, tries) {
    tries = tries || 0;
    return fetchOnce(src.path).then(function (json) {
      if (json && json.code && json.code !== 200) {
        var e = new Error(json.message || ('code ' + json.code));
        e.status = json.code;
        throw e;
      }
      var items = src.adapt ? src.adapt(json) : [];
      if (!items || !items.length) throw new Error('返回数据为空');
      if (src.max) items = items.slice(0, src.max);
      if (src.note) {
        try { src.noteText = src.note(json) || ''; } catch (e) { src.noteText = ''; }
      }
      return { items: items, note: src.noteText || '' };
    }).catch(function (err) {
      var retriable = !err.status || err.status === 429 || err.status >= 500;
      // 429 是配额问题，重试只会雪上加霜：只等一次，且等久一点
      if (err.status === 429) {
        if (tries < 1) {
          return sleep(4000).then(function () { return fetchSource(src, tries + 1); });
        }
        throw new Error('上游限流（429）· 稍后自动恢复');
      }
      if (retriable && tries < 2) {
        return sleep(900 * Math.pow(2, tries) + Math.random() * 400).then(function () {
          return fetchSource(src, tries + 1);
        });
      }
      throw new Error(err.message || '请求失败');
    });
  }

  /* 稳定的源优先加载，长期不稳定的源排在最后，不占用前排带宽 */
  function orderedSources() {
    var good = [], flaky = [];
    SOURCES.forEach(function (s) { (s.optional ? flaky : good).push(s); });
    return good.concat(flaky);
  }

  function loadSource(src, force) {
    var cur = state.data[src.id] || {};
    // 5 分钟内且已有数据 → 直接用缓存，别打上游（避免限流）
    if (!force && cur.items && cur.items.length && cur.fetchedAt && Date.now() - cur.fetchedAt < TTL) {
      return Promise.resolve();
    }

    if (!cur.items || !cur.items.length) {
      state.data[src.id] = { status: 'loading', items: [], error: '', fetchedAt: 0, note: '' };
      updateCard(src.id);
    } else {
      state.data[src.id].status = 'loading';
    }

    return enqueue(function () {
      return fetchSource(src).then(function (out) {
        state.data[src.id] = {
          status: 'ok', items: out.items, note: out.note,
          fetchedAt: Date.now(), error: '',
        };
        dataVersion++;
        saveCache();
        updateCard(src.id);
        renderOverview();
      }).catch(function (err) {
        var prev = state.data[src.id];
        state.data[src.id] = {
          status: 'error',
          items: prev && prev.items ? prev.items : [],
          note: prev && prev.note ? prev.note : '',
          fetchedAt: prev && prev.fetchedAt ? prev.fetchedAt : 0,
          error: err.message || '加载失败',
        };
        updateCard(src.id);
        renderOverview();
      });
    });
  }

  function loadAll(force, onlyVisible) {
    var list = onlyVisible ? visibleSources() : orderedSources();
    if (!onlyVisible) state.allLoaded = true;
    var tasks = list.map(function (s) { return loadSource(s, force); });
    progress(true);
    return Promise.all(tasks).then(function () {
      state.lastUpdated = Date.now();
      progress(false);
      renderTabs();
      renderOverview();
      renderKeywords();
      saveCache();
      syncCards();
      checkNotice();
    });
  }

  /* ---------- 懒加载：卡片进入视口才去取数据，避免一上来就打 26 次上游 ---------- */
  var io = null;
  var lazyStarted = false;

  function startLazyLoad() {
    lazyStarted = true;
    observeCards();                    // 视口内的卡片先取，保证首屏最快有内容
    timers.rest = setTimeout(function () {   // 其余数据源随后补齐，避免下方一直空着
      if (!state.allLoaded) loadAll(false);
    }, 4000);
  }

  function observeCards() {
    if (!lazyStarted) return;
    var pending = orderedSources().filter(function (s) {
      var d = state.data[s.id];
      return !(d && d.items && d.items.length);
    });
    if (!pending.length) return;

    if (!('IntersectionObserver' in window)) {
      pending.forEach(function (s) { loadSource(s, false); });
      return;
    }
    if (!io) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          var src = srcById(en.target.dataset.source);
          io.unobserve(en.target);
          if (src) loadSource(src, false);
        });
      }, { rootMargin: '600px 0px' });
    }
    pending.forEach(function (s) {
      var node = cardNodes[s.id];
      if (node && node.dataset) { node.dataset.source = s.id; io.observe(node); }
    });
  }

  /* ======================== 筛选 ======================== */

  function visibleSources() {
    return SOURCES.filter(function (s) {
      if (state.category !== 'all' && s.category !== state.category) return false;
      var d = state.data[s.id] || {};
      var st = d.status || 'idle';      // 尚未加载的源也要先摆出骨架屏
      if (st === 'idle' || st === 'loading') return true;
      if (d.items && d.items.length) return true;
      // 到这里说明是空的 / 失败的
      return !(state.settings.hideFailed && !state.showFailed);
    });
  }

  /* 可见卡片集合变化时才整体重绘，避免无谓的闪烁与图片重载 */
  function syncCards() {
    if (state.settings.view !== 'cards') { lastVisibleIds = ''; return; }
    var ids = visibleSources().map(function (s) { return s.id; }).join(',');
    if (ids !== lastVisibleIds) {
      lastVisibleIds = ids;
      renderContent();
    }
  }

  function matchItem(item, q) {
    if (!q) return true;
    var hay = [item.title, item.desc, item.chip, (item.meta || []).join(' ')].join(' ').toLowerCase();
    return hay.indexOf(q.toLowerCase()) >= 0;
  }

  function cardItems(src) {
    var d = state.data[src.id];
    if (!d || !d.items) return [];
    var q = state.query;
    if (!q) return d.items;
    return d.items.filter(function (it) { return matchItem(it, q); });
  }

  function allItems() {
    var out = [];
    SOURCES.forEach(function (src) {
      var d = state.data[src.id];
      if (!d || !d.items) return;
      d.items.forEach(function (it, i) {
        out.push({
          title: it.title, desc: it.desc, link: it.link, heat: it.heat,
          heatText: it.heatText, cover: it.cover, meta: it.meta, chip: it.chip,
          sourceId: src.id, sourceName: src.name, short: src.short, color: src.color,
          rank: it.rank || i + 1,
        });
      });
    });
    return out;
  }

  function stats() {
    var items = 0, ok = 0, failed = 0, pending = 0;
    SOURCES.forEach(function (s) {
      var d = state.data[s.id];
      if (!d || d.status === 'loading' || d.status === 'idle') { pending++; return; }
      if (d.status === 'error' || !d.items || !d.items.length) { failed++; return; }
      ok++;
      items += d.items.length;
    });
    return { items: items, ok: ok, failed: failed, pending: pending, total: SOURCES.length };
  }

  /* ======================== 渲染：概览 / 提示 ======================== */

  function progress(on) {
    var el = $('#progress');
    if (on) {
      el.style.opacity = '1';
      el.style.width = '30%';
      setTimeout(function () { if (el.style.opacity === '1') el.style.width = '72%'; }, 400);
    } else {
      el.style.width = '100%';
      setTimeout(function () { el.style.opacity = '0'; el.style.width = '0'; }, 320);
    }
  }

  var scheduleTopics = debounce(function () {
    var n = buildClusters().length;
    if (n !== topicCount) {
      topicCount = n;
      var el = $('#statTopics');
      if (el) el.textContent = n ? String(n) : '–';
    }
  }, 600);

  function renderOverview() {
    var st = stats();
    $('#statSources').textContent = st.ok + (st.failed ? ' / ' + st.total : '');
    $('#statItems').textContent = st.items ? fmtCount(st.items) : '0';
    $('#statTopics').textContent = topicCount ? String(topicCount) : '–';
    $('#statTime').textContent = state.lastUpdated ? fmtTime(state.lastUpdated) : '–';
    scheduleTopics();

    var health = $('#health');
    var dot = 'ok', text;
    if (!state.online) { dot = 'err'; text = '网络已断开'; }
    else if (st.pending) { dot = 'warn'; text = '正在加载 ' + st.pending + ' 个数据源…'; }
    else if (st.failed) { dot = 'warn'; text = st.ok + ' 个源正常 · ' + st.failed + ' 个源异常'; }
    else { dot = 'ok'; text = st.ok + ' 个数据源全部正常'; }
    health.innerHTML = '<span class="dot ' + dot + '"></span><span>' + esc(text) + ' · ' + esc(fmtAgo(state.lastUpdated)) + '</span>';
  }

  function setNotice(html, kind) {
    var el = $('#notice');
    if (!html) { el.className = 'notice'; el.innerHTML = ''; return; }
    el.className = 'notice show' + (kind ? ' ' + kind : '');
    el.innerHTML = html;
  }

  function checkNotice() {
    var st = stats();
    var parts = [];

    if (!state.online) {
      parts.push('⚠️ <b>当前处于离线状态</b>，展示的是本地缓存数据。');
    }
    if (!USING_PROXY && location.protocol === 'file:') {
      parts.push('当前以本地文件方式打开（直连上游 API）。若数据加载失败，可运行 <b>启动.bat</b> 通过本地服务访问，速度更快更稳定。');
    }
    var failedIds = SOURCES.filter(function (s) {
      var d = state.data[s.id];
      return d && (d.status === 'error' || (!d.items || !d.items.length)) && d.status !== 'loading';
    }).map(function (s) { return s.name; });

    if (failedIds.length && !state.showFailed && state.settings.hideFailed) {
      parts.push('ℹ️ <b>' + failedIds.length + ' 个源暂时不可用</b>（' + esc(failedIds.slice(0, 4).join('、')) +
        (failedIds.length > 4 ? ' 等' : '') + '）<span class="link" id="showFailed">显示它们</span>');
    } else if (failedIds.length && state.showFailed) {
      parts.push('ℹ️ 正在显示 <b>' + failedIds.length + ' 个异常源</b><span class="link" id="hideFailed">隐藏它们</span>');
    }

    if (st.ok && !st.failed && st.pending === 0) parts.length = Math.min(parts.length, 1);

    if (state.query) {
      var n = 0;
      visibleSources().forEach(function (s) { n += cardItems(s).length; });
      parts.unshift('🔍 关键词 <b>' + esc(state.query) + '</b> 命中 <b>' + n + '</b> 条' +
        '<span class="link" id="clearQuery">清除搜索</span>');
    }

    setNotice(parts.length ? parts.join('') : '', parts.length > 1 ? '' : '');
  }

  /* ======================== 渲染：分类标签 ======================== */

  function renderTabs() {
    var wrap = $('#tabs');
    var counts = {};
    SOURCES.forEach(function (s) {
      var d = state.data[s.id];
      if (d && d.items && d.items.length && d.status !== 'error') {
        counts[s.category] = (counts[s.category] || 0) + 1;
      }
    });
    var html = CATS.map(function (c) {
      var n = c.id === 'all'
        ? SOURCES.filter(function (s) { var d = state.data[s.id]; return d && d.items && d.items.length; }).length
        : (counts[c.id] || 0);
      if (!n && c.id !== 'all') return '';
      return '<button class="tab" role="tab" data-cat="' + c.id + '" aria-selected="' +
        (state.category === c.id ? 'true' : 'false') + '">' +
        '<span>' + c.icon + '</span><span>' + esc(c.name) + '</span>' +
        (n ? '<span class="count">' + n + '</span>' : '') + '</button>';
    }).join('');
    wrap.innerHTML = html;
  }

  /* ======================== 渲染：卡片 ======================== */

  var THUMB_CATS = { movie: 1, music: 1, game: 1 };

  function itemHTML(src, it, i, q) {
    var rank = it.rank || i + 1;
    var rankCls = rank <= 3 ? ' r' + rank : '';
    var heat = fmtHeat(it);
    var isHot = rank <= 3 || (it.heat && it.heat > 1000000);
    var thumb = (THUMB_CATS[src.category] && it.cover)
      ? '<img class="item-thumb" src="' + esc(it.cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : '';
    var sub = '';
    // 卡片里只留一行辅助信息（优先结构化元信息，其次摘要），完整内容在详情弹窗里看
    if (!state.settings.compact) {
      if (it.meta && it.meta.length) {
        sub = '<div class="item-sub"><span>' + hl(it.meta.join(' · '), q) + '</span></div>';
      } else if (it.desc) {
        sub = '<div class="item-sub"><span>' + hl(it.desc, q) + '</span></div>';
      }
    }

    return '<li class="item" data-s="' + src.id + '" data-i="' + i + '" title="' + esc(it.title) + '">' +
      '<span class="rank' + rankCls + '">' + rank + '</span>' +
      thumb +
      '<div class="item-main">' +
        '<div class="item-title">' + hl(it.title, q) + '</div>' +
        sub +
      '</div>' +
      '<div class="item-side">' +
        (it.chip ? '<span class="chip' + (/限时免费|一言|倒计时/.test(it.chip) ? ' green' : '') + '">' + esc(it.chip) + '</span>' : '') +
        (heat ? '<span class="heat' + (isHot ? ' hot' : '') + '">' +
          (isHot ? '<svg class="flame"><use href="#i-flame"></use></svg>' : '') + esc(heat) + '</span>' : '') +
      '</div>' +
    '</li>';
  }

  function skeletonHTML() {
    var rows = '';
    for (var i = 0; i < 6; i++) {
      rows += '<div class="sk-row"><div class="sk-bar sq"></div>' +
        '<div class="sk-bar" style="width:' + (52 + Math.round(Math.random() * 40)) + '%"></div></div>';
    }
    return '<div class="sk">' + rows + '</div>';
  }

  function cardHTML(src, st) {
    var d = state.data[src.id] || { status: 'idle', items: [] };
    var q = state.query;
    var items = cardItems(src);
    var total = d.items ? d.items.length : 0;
    var failed = d.status === 'error' || (d.status !== 'loading' && d.status !== 'idle' && !total);
    var limit = q ? items.length : (state.expanded[src.id] ? items.length : state.settings.count);
    var shown = items.slice(0, limit);
    rendered[src.id] = items;

    var body;
    if (d.status === 'loading' && !total) body = skeletonHTML();
    else if (d.status === 'idle') body = skeletonHTML();
    else if (failed && !total) {
      body = '<div class="card-error"><div class="big">🛰️</div>' +
        '<div>该数据源暂时不可用</div>' +
        '<code>' + esc(d.error || '无数据') + '</code>' +
        '<button class="btn" data-act="retry" data-s="' + src.id + '">重试</button></div>';
    } else if (!items.length) {
      body = '<div class="card-error"><div class="big">🔍</div><div>没有匹配的条目</div></div>';
    } else {
      body = '<ul class="list">' + shown.map(function (it, i) { return itemHTML(src, it, i, q); }).join('') + '</ul>';
    }

    var foot = '';
    if (total) {
      var expandable = !q && total > state.settings.count;
      foot = '<div class="card-foot">' +
        '<span>' + (q ? '命中 ' + items.length + ' / ' + total : '共 ' + total + ' 条') +
        (d.fetchedAt ? ' · ' + esc(fmtAgo(d.fetchedAt)) : '') + '</span>' +
        (expandable
          ? '<button data-act="toggle" data-s="' + src.id + '">' +
            (state.expanded[src.id] ? '收起' : '查看全部 ' + total + ' 条') + '</button>'
          : '') +
        '</div>';
    }

    return '<div class="card-head">' +
        '<div class="card-badge" style="background:' + esc(src.color) + '">' + esc(src.short) + '</div>' +
        '<div class="card-title">' +
          '<div class="card-name"><span>' + esc(src.name) + '</span>' +
            (failed && total ? '<span class="chip neutral">缓存</span>' : '') +
          '</div>' +
          '<div class="card-note">' + esc(d.note || src.desc || '') + '</div>' +
        '</div>' +
        '<div class="card-tools">' +
          '<button class="iconbtn" data-act="copycard" data-s="' + src.id + '" title="复制本榜"><svg><use href="#i-copy"></use></svg></button>' +
          '<button class="iconbtn" data-act="refresh" data-s="' + src.id + '" title="刷新本榜"><svg><use href="#i-refresh"></use></svg></button>' +
          (src.site ? '<a class="card-more" href="' + esc(src.site) + '" target="_blank" rel="noopener" title="前往 ' + esc(src.name) + '">更多<svg><use href="#i-external"></use></svg></a>' : '') +
        '</div>' +
      '</div>' + body + foot;
  }

  function updateCard(id) {
    var node = cardNodes[id];
    if (!node) return;
    var src = srcById(id);
    if (!src) return;
    node.className = 'card' + (state.settings.compact ? ' compact' : '') +
      (state.data[id] && state.data[id].status === 'error' && !(state.data[id].items || []).length ? ' is-failed' : '');
    node.innerHTML = cardHTML(src, state.data[id]);
  }

  /* ======================== 渲染：全网热议（跨平台聚类） ======================== */

  var STOP = ['的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说',
    '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '他', '她', '它', '们', '为', '与', '对', '被',
    '从', '而', '及', '等', '并', '或', '但', '让', '把', '给', '还', '又', '才', '已经', '可以', '什么', '怎么', '为什么',
    '如何', '哪些', '多少', '是否', '回应', '曝光', '网友', '官方', '通报', '最高', '中国', '美国', '日本', '首次', '宣布'];

  function normalizeTitle(t) {
    return String(t || '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[·\-—–_|｜、，。！？：；""''（）()《》【】\[\]…~!?,.:;"']/g, '')
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  }

  function tokens(title) {
    var t = normalizeTitle(title);
    var out = [];
    // 中文二元组
    var cjk = t.match(/[\u4e00-\u9fa5]+/g) || [];
    cjk.forEach(function (run) {
      for (var i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
      if (run.length <= 2) out.push(run);
    });
    // 英文单词
    (t.match(/[a-zA-Z]{3,}/g) || []).forEach(function (w) { out.push(w.toLowerCase()); });
    // 过滤停用词
    out = out.filter(function (w) { return STOP.indexOf(w) < 0; });
    return out.length ? out : [t.slice(0, 6)];
  }

  function unionFind(n) {
    var p = []; for (var i = 0; i < n; i++) p.push(i);
    function find(x) { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; }
    return {
      find: find,
      union: function (a, b) { var ra = find(a), rb = find(b); if (ra !== rb) p[ra] = rb; },
    };
  }

  function buildClusters() {
    if (clustersCache.version === dataVersion) return clustersCache.list;

    var items = allItems();
    var n = items.length;
    if (!n) { clustersCache = { version: dataVersion, list: [] }; return []; }

    var toks = new Array(n);
    var index = {};
    for (var i = 0; i < n; i++) {
      var set = {};
      var tk = tokens(items[i].title);
      for (var k = 0; k < tk.length; k++) set[tk[k]] = 1;
      toks[i] = set;
      var keys = Object.keys(set);
      for (var j = 0; j < keys.length; j++) {
        (index[keys[j]] || (index[keys[j]] = [])).push(i);
      }
    }

    // 候选对：共享关键 token（限制倒排长度，避免长尾爆炸）
    var uf = unionFind(n);
    var pairs = {};
    var pairCount = 0;
    var full = false;
    Object.keys(index).forEach(function (key) {
      if (full) return;
      var bucket = index[key];
      if (bucket.length < 2 || bucket.length > 45) return;
      for (var a = 0; a < bucket.length; a++) {
        for (var b = a + 1; b < bucket.length; b++) {
          var i = bucket[a], j = bucket[b];
          if (items[i].sourceId === items[j].sourceId) continue;   // 同源不合并
          var pk = i < j ? i + ':' + j : j + ':' + i;
          if (pairs[pk]) continue;
          if (++pairCount > MAX_PAIRS) { full = true; break; }
          pairs[pk] = 1;
          var A = toks[i], B = toks[j];
          var inter = 0, ka;
          for (ka in A) if (B[ka]) inter++;
          var minLen = Math.min(Object.keys(A).length, Object.keys(B).length);
          if (inter >= 3 && inter / minLen >= 0.5) uf.union(i, j);
        }
        if (full) break;
      }
    });

    // 归组
    var groups = {};
    for (var m = 0; m < n; m++) {
      var root = uf.find(m);
      (groups[root] || (groups[root] = [])).push(m);
    }

    var list = [];
    Object.keys(groups).forEach(function (root) {
      var idxs = groups[root];
      var srcSet = {};
      idxs.forEach(function (x) { srcSet[items[x].sourceId] = 1; });
      var distinct = Object.keys(srcSet).length;
      if (distinct < 2) return;      // 只有跨平台才算「全网热议」

      // 代表标题：与组内其它标题平均重合度最高者
      var best = idxs[0], bestScore = -1;
      idxs.forEach(function (x) {
        var totalOverlap = 0;
        idxs.forEach(function (y) {
          if (x === y) return;
          var A = toks[x], B = toks[y], inter = 0, kk;
          for (kk in A) if (B[kk]) inter++;
          totalOverlap += Object.keys(A).length ? inter / Object.keys(A).length : 0;
        });
        var score = totalOverlap / Math.max(1, idxs.length - 1);
        if (score > bestScore || (score === bestScore && items[x].title.length < items[best].title.length)) {
          bestScore = score; best = x;
        }
      });

      var heat = 0;
      idxs.forEach(function (x) { heat += Number(items[x].heat) || 0; });

      var members = idxs.map(function (x) { return items[x]; })
        .sort(function (a, b) { return (Number(b.heat) || 0) - (Number(a.heat) || 0); });

      list.push({
        key: root,
        title: items[best].title,
        items: members,
        sources: Object.keys(srcSet),
        sourceNames: members.map(function (x) { return x.sourceName; }),
        heat: heat,
        desc: members.find(function (x) { return x.desc; }) ? members.find(function (x) { return x.desc; }).desc : '',
        cover: members.find(function (x) { return x.cover; }) ? members.find(function (x) { return x.cover; }).cover : '',
      });
    });

    list.sort(function (a, b) {
      if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
      return b.heat - a.heat;
    });

    clustersCache = { version: dataVersion, list: list.slice(0, 60) };
    return clustersCache.list;
  }

  function clusters() { return buildClusters(); }

  function clusterHTML(c, i, q) {
    var rankCls = i < 3 ? ' r' + (i + 1) : '';
    var pills = c.items.map(function (it, ci) {
      var src = srcById(it.sourceId) || { color: '#888', short: '?', name: it.sourceName };
      return '<span class="src-pill" data-c="' + i + '" data-ci="' + ci + '" title="' + esc(it.title) + '">' +
        '<span class="card-badge" style="background:' + esc(src.color) + '">' + esc(src.short) + '</span>' +
        esc(src.name) +
        (fmtHeat(it) ? '<span style="opacity:.6">' + esc(fmtHeat(it)) + '</span>' : '') +
      '</span>';
    }).join('');

    var extra = [];
    if (c.heat) extra.push('累计热度 ' + fmtCount(c.heat));
    extra.push(c.items.length + ' 条相关');

    return '<article class="cluster">' +
      '<div class="cluster-rank' + rankCls + '">' + (i + 1) + '</div>' +
      '<div class="cluster-main">' +
        '<div class="cluster-title">' + hl(c.title, q) + '</div>' +
        '<div class="cluster-srcs">' + pills + '</div>' +
        '<div class="cluster-meta"><span>' + esc(extra.join(' · ')) + '</span>' +
          (c.desc ? '<span>' + esc(String(c.desc).slice(0, 90)) + '</span>' : '') +
        '</div>' +
      '</div>' +
    '</article>';
  }

  /* ======================== 渲染：主内容 ======================== */

  function renderContent() {
    var content = $('#content');
    var q = state.query;
    cardNodes = {};

    if (state.settings.view === 'clusters') {
      var list = clusters();
      if (!list.length) {
        content.innerHTML = '<div class="empty"><div class="big">🌐</div><h2>还没有跨平台热点</h2>' +
          '<p>当一个话题同时出现在两个以上平台时，就会在这里聚合成「全网热议」。多刷新几次或稍等片刻。</p>' +
          '<button class="btn primary" data-act="refreshAll">立即刷新</button></div>';
        return;
      }
      var filtered = q
        ? list.filter(function (c) {
            return matchItem({ title: c.title, desc: c.desc, meta: c.sourceNames }, q);
          })
        : list;
      var html = '<div class="clusters">' + filtered.map(function (c, i) { return clusterHTML(c, i, q); }).join('') + '</div>';
      if (!filtered.length) {
        html = '<div class="empty"><div class="big">🔍</div><h2>没有匹配的话题</h2><p>换个关键词试试。</p></div>';
      }
      content.innerHTML = html;
      return;
    }

    var list2 = visibleSources();
    lastVisibleIds = list2.map(function (s) { return s.id; }).join(',');
    var st = stats();
    if (!list2.length) {
      if (st.pending) {
        content.innerHTML = '<div class="grid">' + skeletonCard() + skeletonCard() + skeletonCard() + '</div>';
        return;
      }
      content.innerHTML = '<div class="empty"><div class="big">📡</div><h2>没有可显示的数据源</h2>' +
        '<p>' + (q ? '没有条目匹配「' + esc(q) + '」，换个关键词试试。'
          : '所有数据源都不可用。请检查网络，或用 <b>启动.bat</b> 通过本地服务打开。') + '</p>' +
        '<button class="btn primary" data-act="refreshAll">重新加载</button></div>';
      return;
    }

    var frag = document.createDocumentFragment();
    var grid = document.createElement('div');
    grid.className = 'grid';
    list2.forEach(function (src) {
      var card = document.createElement('section');
      card.className = 'card' + (state.settings.compact ? ' compact' : '');
      card.id = 'card-' + src.id;
      card.innerHTML = cardHTML(src, state.data[src.id]);
      grid.appendChild(card);
      cardNodes[src.id] = card;
    });
    frag.appendChild(grid);
    content.innerHTML = '';
    content.appendChild(frag);
    observeCards();
  }

  function skeletonCard() {
    return '<section class="card"><div class="card-head">' +
      '<div class="card-badge" style="background:var(--surface-3)"></div>' +
      '<div class="card-title"><div class="sk-bar" style="width:90px"></div>' +
      '<div class="sk-bar" style="width:140px;height:9px;margin-top:5px"></div></div></div>' +
      skeletonHTML() + '</section>';
  }

  /* ======================== 渲染：热词条 ======================== */

  function renderKeywords() {
    var wrap = $('#keywords');
    var counts = {};
    allItems().forEach(function (it, i) {
      var tk = tokens(it.title);
      var weight = it.rank <= 5 ? 3 : it.rank <= 15 ? 2 : 1;
      for (var k = 0; k < tk.length; k++) {
        var w = tk[k];
        if (w.length < 2) continue;
        counts[w] = (counts[w] || 0) + weight;
      }
    });
    var arr = Object.keys(counts).map(function (w) { return { w: w, n: counts[w] }; })
      .filter(function (x) { return x.n >= 3; })
      .sort(function (a, b) { return b.n - a.n || a.w.localeCompare(b.w); });

    // 去掉被更长词包含的短词
    var picked = [];
    for (var i = 0; i < arr.length && picked.length < 18; i++) {
      var w = arr[i].w;
      var contained = picked.some(function (p) { return p.w.indexOf(w) >= 0; });
      if (contained) continue;
      picked.push(arr[i]);
    }
    if (!picked.length) { wrap.style.display = 'none'; return; }

    wrap.style.display = '';
    wrap.innerHTML = '<span class="keywords-label">🔥 今日热词</span>' +
      picked.map(function (x) {
        return '<button class="kw" data-kw="' + esc(x.w) + '">' + esc(x.w) +
          '<span class="n">' + x.n + '</span></button>';
      }).join('');
  }

  /* ======================== 详情模态框 ======================== */

  var modalItem = null;

  function openModal(item) {
    modalItem = item;
    var src = srcById(item.sourceId);
    $('#modalBadge').style.background = src ? src.color : '#888';
    $('#modalBadge').textContent = src ? src.short : '?';
    $('#modalSource').textContent = (src ? src.name : '') + (item.rank ? ' · 第 ' + item.rank + ' 位' : '');

    var related = '';
    var cl = clusters().filter(function (c) {
      return c.items.some(function (x) { return x.sourceId === item.sourceId && x.title === item.title; });
    })[0];
    if (cl && cl.items.length > 1) {
      related = '<div class="modal-meta"><b>该话题还出现在：</b>' +
        cl.items.filter(function (x) { return !(x.sourceId === item.sourceId && x.title === item.title); })
          .map(function (x) {
            var s2 = srcById(x.sourceId) || { name: x.sourceName };
            return '<a href="#" data-related="' + esc(x.link || '') + '">' + esc(s2.name) + '</a>';
          }).join('、') + '</div>';
    }

    $('#modalBody').innerHTML =
      (item.cover ? '<img class="modal-cover" src="' + esc(item.cover) + '" alt="" referrerpolicy="no-referrer">' : '') +
      '<h2 class="modal-h1">' + esc(item.title) + '</h2>' +
      (item.desc ? '<div class="modal-desc">' + esc(item.desc) + '</div>' : '') +
      '<div class="modal-meta">' +
        (fmtHeat(item) ? '<span><b>热度</b> ' + esc(fmtHeat(item)) + '</span>' : '') +
        (item.chip ? '<span><b>标签</b> ' + esc(item.chip) + '</span>' : '') +
        (item.meta && item.meta.length ? '<span><b>信息</b> ' + esc(item.meta.join(' · ')) + '</span>' : '') +
        '<span><b>榜单</b> ' + esc(src ? src.name : '') + '</span>' +
      '</div>' +
      related +
      '<div class="modal-actions">' +
        '<button class="btn primary" data-mact="link"><svg><use href="#i-external"></use></svg>打开原文</button>' +
        '<button class="btn" data-mact="copytitle"><svg><use href="#i-copy"></use></svg>复制标题</button>' +
        '<button class="btn" data-mact="copylink"><svg><use href="#i-copy"></use></svg>复制链接</button>' +
      '</div>';

    $('#modalBackdrop').classList.add('show');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    $('#modalBackdrop').classList.remove('show');
    document.body.style.overflow = '';
    modalItem = null;
  }

  /* ======================== 事件绑定 ======================== */

  function bind() {
    /* 分类切换 */
    $('#tabs').addEventListener('click', function (e) {
      var btn = e.target.closest('.tab');
      if (!btn) return;
      state.category = btn.dataset.cat;
      renderTabs();
      renderContent();
      loadAll(false, true);
      checkNotice();
    });

    /* 视图切换（注入到概览条右侧） */
    var seg = document.createElement('div');
    seg.className = 'seg';
    seg.id = 'seg';
    seg.innerHTML = '<button data-view="cards">📋 榜单</button><button data-view="clusters">🌐 全网热议</button>';
    $('#health').parentNode.insertBefore(seg, $('#health'));
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      state.settings.view = b.dataset.view;
      saveSettings();
      syncSettingsUI();
      renderContent();
      renderOverview();
      // 「全网热议」需要全部平台的数据才有意义
      if (state.settings.view === 'clusters' && !state.allLoaded) {
        toast('正在汇总全部平台数据…');
        loadAll(false).then(function () { renderContent(); renderOverview(); });
      }
    });

    /* 卡片 / 聚类 交互 */
    $('#content').addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (act) {
        var a = act.dataset.act;
        var id = act.dataset.s;
        if (a === 'toggle') {
          state.expanded[id] = !state.expanded[id];
          updateCard(id);
        } else if (a === 'refresh' || a === 'retry') {
          var src = srcById(id);
          if (src) {
            loadSource(src, true).then(function () {
              renderKeywords();
              renderOverview();
              checkNotice();
              toast(a === 'retry' ? '已重试 ' + src.name : '已刷新 ' + src.name);
            });
          }
        } else if (a === 'copycard') {
          var arr = (state.data[id] && state.data[id].items) || [];
          var src2 = srcById(id);
          var text = (src2 ? src2.name : id) + '\n' + arr.map(function (it, i) {
            return (i + 1) + '. ' + it.title + (fmtHeat(it) ? '  [' + fmtHeat(it) + ']' : '') + (it.link ? '  ' + it.link : '');
          }).join('\n');
          if (!arr.length) { toast('本榜暂无数据'); return; }
          copyText(text, '已复制「' + (src2 ? src2.name : '') + '」' + arr.length + ' 条');
        } else if (a === 'refreshAll') {
          loadAll(true);
        }
        return;
      }

      /* 聚类里的来源标签 */
      var pill = e.target.closest('.src-pill');
      if (pill) {
        var list = clusters();
        var c = list[Number(pill.dataset.c)];
        if (c) {
          var it = c.items[Number(pill.dataset.ci)];
          if (it) handleOpen(it);
        }
        return;
      }

      /* 普通条目 */
      var row = e.target.closest('.item');
      if (row) {
        var sid = row.dataset.s;
        var arr2 = rendered[sid] || [];
        var item = arr2[Number(row.dataset.i)];
        if (item) handleOpen(Object.assign({}, item, { sourceId: sid, rank: item.rank || Number(row.dataset.i) + 1 }));
      }
    });

    function handleOpen(item) {
      if (state.settings.open === 'link') openLink(item.link);
      else openModal(item);
    }

    /* 热词点击 → 搜索 */
    $('#keywords').addEventListener('click', function (e) {
      var b = e.target.closest('.kw');
      if (!b) return;
      $('#search').value = b.dataset.kw;
      onSearch(b.dataset.kw);
    });

    /* 提示条里的动作 */
    $('#notice').addEventListener('click', function (e) {
      if (e.target.id === 'showFailed') { state.showFailed = true; renderContent(); checkNotice(); }
      else if (e.target.id === 'hideFailed') { state.showFailed = false; renderContent(); checkNotice(); }
      else if (e.target.id === 'clearQuery') { $('#search').value = ''; onSearch(''); }
    });

    /* 搜索 */
    var searchInput = $('#search');
    var debouncedSearch = debounce(function (v) { onSearch(v); }, 130);
    searchInput.addEventListener('input', function () {
      var v = searchInput.value.trim();
      $('#searchWrap').classList.toggle('has-value', !!v);
      debouncedSearch(v);
    });
    $('#searchClear').addEventListener('click', function () {
      searchInput.value = '';
      $('#searchWrap').classList.remove('has-value');
      onSearch('');
      searchInput.focus();
    });

    function onSearch(v) {
      state.query = v;
      $('#searchWrap').classList.toggle('has-value', !!v);
      renderContent();
      renderOverview();
      checkNotice();
      // 搜索要覆盖全部平台，没加载完就补上
      if (v && !state.allLoaded) loadAll(false).then(function () { renderContent(); checkNotice(); });
    }

    /* 刷新全部 */
    $('#refreshBtn').addEventListener('click', function () {
      var icon = $('#refreshIcon');
      icon.classList.add('spin');
      loadAll(true).then(function () {
        icon.classList.remove('spin');
        toast('已刷新全部数据源');
      });
    });

    /* 主题 */
    $('#themeBtn').addEventListener('click', cycleTheme);

    /* 设置面板 */
    $('#settingsBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      var sheet = $('#sheet');
      var open = sheet.classList.toggle('show');
      $('#settingsBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      var sheet = $('#sheet');
      if (!sheet.classList.contains('show')) return;
      if (sheet.contains(e.target) || e.target.closest('#settingsBtn')) return;
      sheet.classList.remove('show');
      $('#settingsBtn').setAttribute('aria-expanded', 'false');
    });

    $('#setCount').addEventListener('change', function () {
      state.settings.count = Number(this.value); saveSettings(); renderContent();
    });
    $('#setAuto').addEventListener('change', function () {
      state.settings.auto = Number(this.value); saveSettings(); setupAuto();
      toast(state.settings.auto ? '自动刷新已设为每 ' + (state.settings.auto / 60) + ' 分钟' : '已关闭自动刷新');
    });
    $('#setCompact').addEventListener('change', function () {
      state.settings.compact = this.checked; saveSettings(); renderContent();
    });
    $('#setHideFailed').addEventListener('change', function () {
      state.settings.hideFailed = this.checked; saveSettings(); renderContent(); checkNotice();
    });
    $('#setOpen').addEventListener('change', function () {
      state.settings.open = this.value; saveSettings();
    });

    $('#setTryFlaky').addEventListener('change', function () {
      state.settings.tryFlaky = this.checked;
      saveSettings();
      applySourceFilter();
      renderBrandSub();
      renderTabs();
      renderContent();
      if (this.checked) loadAll(false);
      checkNotice();
      toast(this.checked ? '已启用不稳定的数据源（可能加载失败）' : '已隐藏不稳定的数据源');
    });

    /* 模态框 */
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalBackdrop').addEventListener('click', function (e) {
      if (e.target === this) closeModal();
    });
    $('#modalBackdrop').addEventListener('click', function (e) {
      var t = e.target;
      if (t.dataset && t.dataset.related) {
        e.preventDefault();
        if (t.dataset.related) openLink(t.dataset.related);
      }
    });
    $('#modalBody').addEventListener('click', function (e) {
      var b = e.target.closest('[data-mact]');
      if (!b || !modalItem) return;
      var act = b.dataset.mact;
      if (act === 'link') openLink(modalItem.link);
      else if (act === 'copytitle') copyText(modalItem.title, '标题已复制');
      else if (act === 'copylink') copyText(modalItem.link || '', '链接已复制');
    });

    /* 复制全部 Markdown */
    $('#copyAll').addEventListener('click', function (e) {
      e.preventDefault();
      var md = '# 全网热榜 ' + new Date().toLocaleString('zh-CN') + '\n\n';
      SOURCES.forEach(function (src) {
        var d = state.data[src.id];
        if (!d || !d.items || !d.items.length) return;
        md += '## ' + src.name + '\n\n';
        d.items.slice(0, state.settings.count).forEach(function (it, i) {
          md += (i + 1) + '. [' + it.title + '](' + (it.link || src.site || '') + ')' +
            (fmtHeat(it) ? ' — ' + fmtHeat(it) : '') + '\n';
        });
        md += '\n';
      });
      copyText(md, '已复制全部榜单为 Markdown');
    });

    /* 键盘快捷键 */
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (e.key === 'Escape') {
        if ($('#modalBackdrop').classList.contains('show')) closeModal();
        else if ($('#sheet').classList.contains('show')) $('#sheet').classList.remove('show');
        else if (state.query) { $('#search').value = ''; onSearch(''); }
        return;
      }
      if (e.key === '/' && !typing) { e.preventDefault(); searchInput.focus(); searchInput.select(); return; }
      if ((e.key === 'r' || e.key === 'R') && !typing && !e.ctrlKey && !e.metaKey) {
        $('#refreshBtn').click();
      }
    });

    /* 网络 & 可见性 */
    window.addEventListener('online', function () { state.online = true; toast('网络已恢复，正在刷新…'); loadAll(true); });
    window.addEventListener('offline', function () { state.online = false; renderOverview(); checkNotice(); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() - state.lastUpdated > TTL) loadAll(false);
    });

    /* 主题跟随系统 */
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onMq = function () { if (state.settings.theme === 'auto') applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onMq);
      else if (mq.addListener) mq.addListener(onMq);
    }
  }

  function setupAuto() {
    clearInterval(timers.auto);
    if (state.settings.auto > 0) {
      timers.auto = setInterval(function () {
        if (document.hidden) return;
        loadAll(true);
      }, state.settings.auto * 1000);
    }
  }

  /* 自愈：上游限流 / 偶发失败时，稍后自动把缺失的源补回来 */
  function setupSelfHeal() {
    clearInterval(timers.heal);
    timers.heal = setInterval(function () {
      if (document.hidden || !state.online) return;
      var missing = orderedSources().filter(function (s) {
        var d = state.data[s.id];
        if (!d) return true;
        if (d.status === 'loading') return false;
        return !(d.items && d.items.length);
      });
      if (!missing.length) return;
      missing.slice(0, 6).forEach(function (s) { loadSource(s, true); });
    }, 90000);
  }

  /* ======================== 启动 ======================== */

  function renderBrandSub() {
    var d = new Date();
    var week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()];
    $('#brandSub').textContent = d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · ' + week +
      ' · ' + SOURCES.length + ' 个平台';
  }

  function detectProxy() {
    if (location.protocol === 'file:') return Promise.resolve(false);
    return fetch(location.origin + '/api/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return !!(j && j.ok); })
      .catch(function () { return false; });
  }

  function boot() {
    loadSettings();
    applySourceFilter();
    applyTheme();
    syncSettingsUI();
    renderBrandSub();
    $('#year').textContent = String(new Date().getFullYear());

    var hadCache = loadCache();
    bind();
    renderTabs();
    renderOverview();
    lastVisibleIds = '';
    renderContent();
    renderKeywords();
    checkNotice();
    if (hadCache) {
      state.lastUpdated = Math.max.apply(null, Object.keys(state.data).map(function (id) {
        return state.data[id].fetchedAt || 0;
      }).concat([0]));
    }

    detectProxy().then(function (yes) {
      USING_PROXY = yes;
      API_BASE = yes ? location.origin : UPSTREAM;
      if (yes) {
        var sub = $('#brandSub');
        sub.textContent = sub.textContent + ' · 本地代理已启用';
      }
      startLazyLoad();
      return null;
    }).then(function () {
      state.booted = true;
      setupAuto();
      setupSelfHeal();
      syncCards();
      renderTabs();
      checkNotice();
      if (!state.online) toast('当前离线，展示缓存数据');
    });

    // 每分钟刷新“x 分钟前”等相对时间
    timers.clock = setInterval(function () {
      renderOverview();
    }, 60000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
