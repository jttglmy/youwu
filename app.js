'use strict';

/* =========================================================
   有物 · 我的物品清单
   数据全部保存在本机 IndexedDB，不上传任何服务器
   ========================================================= */

/* ---------------- 工具 ---------------- */

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

function qtyOf(it) { var q = parseInt(it.qty, 10); return q > 0 ? q : 1; }

function money(n) {
  var v = Math.round(num(n) * 100) / 100;
  return '¥' + v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function fmtDay(ts) {
  if (!ts) return '—';
  var d = new Date(ts);
  return d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate());
}

function fmtBytes(n) {
  if (!n) return '0 MB';
  var mb = n / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}

/* ---------------- 常量与状态 ---------------- */

var EMOJIS = ['👕', '👟', '📚', '💍', '🍳', '📱', '🧴', '🎒', '🧸', '🪑', '💡', '🧰', '📦', '🎁', '🎮', '🎧',
  '⌚', '👜', '🧥', '👖', '🧣', '🕶️', '☂️', '🪥', '🧹', '🔧', '🍽️', '🥄', '🛏️', '🛋️', '🚪', '🗄️',
  '🧺', '🏺', '🖼️', '💄', '💊', '🔑', '✂️', '🧳'];

var DEFAULT_CATS = [
  ['衣服', '👕'], ['鞋', '👟'], ['书', '📚'], ['首饰', '💍'], ['厨具', '🍳'], ['电子', '📱'], ['其他', '📦']
];

var DEFAULT_LOCS = ['卧室', '客厅', '厨房', '书房', '储物间', '玄关'];

var S = {
  tab: 'items',
  tagMode: 'cat',
  items: [],
  cats: [],
  locs: [],
  q: '',
  cat: 'all',
  loc: 'all',
  sort: 'recent',
  tag: 'all',
  page: 1,
  pageSize: 60,
  form: null,
  current: null,
  ready: false,
  lsMode: false,
  recentLocs: []
};

var urlCache = {};
var inflight = {};
var dlgState = null;
var searchTimer = null;
var toastTimer = null;

/* ---------------- 启动 ---------------- */

function boot() {
  bind();
  initDB()
    .then(seedIfEmpty)
    .then(reload)
    .then(loadRecentLocs)
    .then(function () {
      S.ready = true;
      S.lsMode = DB.mode() === 'ls';
      render();
      if (S.lsMode) {
        setTimeout(function () {
          toast('本地文件模式：数据存在浏览器缓存里，仅够少量试用');
        }, 800);
      }
    })
    .catch(fatal);

  try {
    var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if ('serviceWorker' in navigator && secure) {
      navigator.serviceWorker.register('./sw.js').catch(function () { });
    }
  } catch (e) { /* 忽略 */ }
}

function bind() {
  document.addEventListener('click', onDocClick);
  document.addEventListener('change', onDocChange);
  var q = $('#q');
  if (q) q.addEventListener('input', onSearch);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('#dialog').hidden) { dialogCancel(); return; }
    if (!$('#sheet').hidden) { closeSheet(); return; }
    if (!$('#detail').hidden) { closeDetail(); }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

/* ---------------- 数据读取 ---------------- */

function seedIfEmpty() {
  return DB.all('categories').then(function (cats) {
    if (cats.length) return null;
    var chain = Promise.resolve();
    DEFAULT_CATS.forEach(function (x, i) {
      chain = chain.then(function () {
        return DB.put('categories', { id: uid(), name: x[0], emoji: x[1], order: i, createdAt: Date.now() });
      });
    });
    return chain.then(function () { return DB.all('locations'); }).then(function (locs) {
      if (locs.length) return null;
      var c2 = Promise.resolve();
      DEFAULT_LOCS.forEach(function (name, i) {
        c2 = c2.then(function () {
          return DB.put('locations', { id: uid(), name: name, order: i, createdAt: Date.now() });
        });
      });
      return c2;
    });
  });
}

function reload() {
  return Promise.all([DB.all('items'), DB.all('categories'), DB.all('locations')]).then(function (res) {
    S.items = res[0].sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    S.cats = res[1].sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    S.locs = res[2].sort(function (a, b) { return (a.order || 0) - (b.order || 0); });

    var catOk = S.cat === 'all' || S.cat === 'none' || S.cats.some(function (c) { return c.id === S.cat; });
    if (!catOk) S.cat = 'all';
    var locOk = S.loc === 'all' || S.loc === 'none' || S.locs.some(function (l) { return l.id === S.loc; });
    if (!locOk) S.loc = 'all';
  });
}

function findItem(id) {
  var key = id || S.current;
  var list = S.items.filter(function (x) { return x.id === key; });
  return list.length ? list[0] : null;
}

function catName(id) {
  var c = S.cats.filter(function (x) { return x.id === id; })[0];
  return c ? c.name : '未分类';
}

function catEmoji(id) {
  var c = S.cats.filter(function (x) { return x.id === id; })[0];
  return (c && c.emoji) ? c.emoji : '📦';
}

function locName(id) {
  var l = S.locs.filter(function (x) { return x.id === id; })[0];
  return l ? l.name : '未记位置';
}

function qtyTotal() {
  return S.items.reduce(function (s, i) { return s + qtyOf(i); }, 0);
}

function sumValue(items) {
  return items.reduce(function (s, i) { return s + num(i.price) * qtyOf(i); }, 0);
}

/* 借出天数，未借出返回 0 */
function daysOut(it) {
  if (!it || !it.loan || !it.loan.since) return 0;
  var t = Date.parse(it.loan.since);
  if (!t) return 0;
  var d = Math.floor((Date.now() - t) / 86400000);
  return d > 0 ? d : 0;
}

function tagsOf(it) {
  return (it && it.tags && it.tags.length) ? it.tags : [];
}

/* 收集所有用过的标签 */
function collectTags() {
  var seen = {};
  var out = [];
  S.items.forEach(function (it) {
    tagsOf(it).forEach(function (t) {
      if (!seen[t]) { seen[t] = 1; out.push(t); }
    });
  });
  out.sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
  return out;
}

function sortComparator(mode) {
  if (mode === 'name') {
    return function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh-CN'); };
  }
  if (mode === 'price') {
    return function (a, b) { return num(b.price) * qtyOf(b) - num(a.price) * qtyOf(a); };
  }
  if (mode === 'qty') {
    return function (a, b) { return qtyOf(b) - qtyOf(a); };
  }
  return function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); };
}

function filteredItems() {
  var q = S.q.trim().toLowerCase();
  var list = S.items.filter(function (it) {
    if (S.cat !== 'all') {
      if (S.cat === 'none') { if (it.categoryId) return false; }
      else if (it.categoryId !== S.cat) return false;
    }
    if (S.loc !== 'all') {
      if (S.loc === 'none') { if (it.locationId) return false; }
      else if (it.locationId !== S.loc) return false;
    }
    if (S.tag !== 'all') {
      if (tagsOf(it).indexOf(S.tag) < 0) return false;
    }
    if (!q) return true;
    var hay = [it.name, it.note, catName(it.categoryId), locName(it.locationId),
      it.loan ? it.loan.to : '', tagsOf(it).join(' ')]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  });
  list.sort(sortComparator(S.sort));
  return list;
}

/* ---------------- 渲染 ---------------- */

function render() {
  if (!S.ready) return;
  var view = $('#view');
  $('#searchWrap').hidden = S.tab !== 'items';
  $('#fab').hidden = S.tab !== 'items';
  $$('.tab').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === S.tab);
  });

  if (S.tab === 'items') {
    view.innerHTML = itemsHTML();
    hydrateThumbs();
  } else if (S.tab === 'stats') {
    view.innerHTML = statsHTML();
    hydrateThumbs();
  } else if (S.tab === 'tags') {
    view.innerHTML = tagsHTML();
  } else {
    view.innerHTML = settingsHTML();
    showStorage();
  }
  window.scrollTo(0, 0);
  updateBrand();
}

function updateBrand() {
  var sub = $('#brandSub');
  if (!sub) return;
  if (!S.items.length) { sub.textContent = '记下你拥有的东西'; return; }
  var lent = S.items.filter(function (i) { return i.loan; }).length;
  sub.textContent = S.items.length + ' 条记录 · ' + qtyTotal() + ' 件' + (lent ? ' · ' + lent + ' 件借出' : '');
}

function switchTab(tab) {
  S.tab = tab;
  S.page = 1;
  render();
}

function onSearch(e) {
  var v = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function () {
    S.q = v;
    S.page = 1;
    if (S.tab === 'items') {
      $('#view').innerHTML = itemsHTML();
      hydrateThumbs();
    }
  }, 120);
}

function setCatFilter(id) {
  S.cat = id;
  S.page = 1;
  $('#view').innerHTML = itemsHTML();
  hydrateThumbs();
}

function changeQty(id, delta) {
  var it = findItem(id);
  if (!it) return;
  var q = qtyOf(it) + delta;
  if (q < 1) { toast('已经只剩 1 件了'); return; }
  it.qty = q;
  it.updatedAt = Date.now();
  DB.put('items', it).then(reload).then(function () {
    if (S.current === it.id && !$('#detail').hidden) openDetail(it.id);
    render();
    toast(delta > 0 ? '加到 ' + q + ' 件' : '还剩 ' + q + ' 件');
  }).catch(fatal);
}

function setTagFilter(tag) {
  S.tag = tag || 'all';
  S.page = 1;
  if (S.tab !== 'items') { S.tab = 'items'; render(); return; }
  $('#view').innerHTML = itemsHTML();
  hydrateThumbs();
}

function appendQuickTag(tag) {
  var input = $('#f-tags');
  if (!input) return;
  var cur = parseTags(input.value);
  if (cur.indexOf(tag) < 0) cur.push(tag);
  input.value = cur.join(', ');
}

function clearFilter() {
  S.q = '';
  S.cat = 'all';
  S.loc = 'all';
  S.tag = 'all';
  S.page = 1;
  var q = $('#q');
  if (q) q.value = '';
  render();
}

/* ---------------- 物品列表 ---------------- */

function itemsHTML() {
  if (!S.items.length) return onboardHTML();

  var list = filteredItems();
  var lent = S.items.filter(function (i) { return i.loan; }).length;

  var chips = ['<button class="chip' + (S.cat === 'all' ? ' on' : '') + '" data-act="filter-cat" data-id="all">全部</button>'];
  S.cats.forEach(function (c) {
    var n = S.items.filter(function (i) { return i.categoryId === c.id; }).length;
    chips.push('<button class="chip' + (S.cat === c.id ? ' on' : '') + '" data-act="filter-cat" data-id="' + c.id + '">' +
      esc(c.emoji || '') + ' ' + esc(c.name) + (n ? ' <i>' + n + '</i>' : '') + '</button>');
  });
  if (S.items.some(function (i) { return !i.categoryId; })) {
    chips.push('<button class="chip' + (S.cat === 'none' ? ' on' : '') + '" data-act="filter-cat" data-id="none">未分类</button>');
  }

  var locOpts = ['<option value="all">全部位置</option>'].concat(S.locs.map(function (l) {
    return '<option value="' + l.id + '"' + (S.loc === l.id ? ' selected' : '') + '>' + esc(l.name) + '</option>';
  })).concat(['<option value="none"' + (S.loc === 'none' ? ' selected' : '') + '>未记位置</option>']);

  var shown = list.slice(0, S.page * S.pageSize);
  var hasFilter = S.q || S.cat !== 'all' || S.loc !== 'all' || S.tag !== 'all';

  var h = '';
  h += '<section class="stat-strip">' +
    '<div><b>' + qtyTotal() + '</b><span>件物品</span></div>' +
    '<div><b>' + S.items.length + '</b><span>条记录</span></div>' +
    '<div><b>' + lent + '</b><span>借出中</span></div>' +
    '<div><b>' + money(sumValue(S.items)) + '</b><span>总价值</span></div>' +
    '</section>';

  h += '<div class="chip-row">' + chips.join('') + '</div>';

  var tagList = collectTags();
  if (tagList.length) {
    var tagChips = ['<button class="chip mini' + (S.tag === 'all' ? ' on' : '') + '" data-act="filter-tag" data-tag="all">全部标签</button>'];
    tagList.forEach(function (t) {
      tagChips.push('<button class="chip mini' + (S.tag === t ? ' on' : '') + '" data-act="filter-tag" data-tag="' + esc(t) + '">#' + esc(t) + '</button>');
    });
    h += '<div class="chip-row tag-chips">' + tagChips.join('') + '</div>';
  }

  var sortOpts = [
    ['recent', '最近添加'],
    ['name', '按名称'],
    ['price', '按价值'],
    ['qty', '按数量']
  ].map(function (o) {
    return '<option value="' + o[0] + '"' + (S.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
  }).join('');

  h += '<div class="filter-row"><select id="locFilter">' + locOpts.join('') + '</select>' +
    '<select id="sortSel" aria-label="排序">' + sortOpts + '</select>' +
    '<span class="result-count">' + list.length + ' 条</span>' +
    (hasFilter ? '<button class="link small" data-act="clear-filter">清除</button>' : '') + '</div>';

  if (!list.length) {
    h += '<div class="empty"><p>没有符合条件的东西</p><button class="btn ghost" data-act="clear-filter">清除筛选</button></div>';
    return h;
  }

  h += '<div class="grid">' + shown.map(cardHTML).join('') + '</div>';
  if (list.length > shown.length) {
    h += '<button class="btn ghost block" data-act="load-more">加载更多（还有 ' + (list.length - shown.length) + ' 条）</button>';
  }
  return h;
}

function onboardHTML() {
  return '<div class="onboard">' +
    '<div class="onboard-emoji">📦</div>' +
    '<h2>先记下第一件东西</h2>' +
    '<p>衣服、鞋、书、首饰、厨具……<br>拍张照，写个名字，选个位置。<br>以后想不起自己有什么，搜一下就知道了。</p>' +
    '<button class="btn solid" data-act="add-item">＋ 添加第一件</button>' +
    '<div class="onboard-tips">' +
    '<div><b>拍</b><span>先拍照，再补信息</span></div>' +
    '<div><b>选</b><span>点一下分类和位置</span></div>' +
    '<div><b>搜</b><span>按名字位置找</span></div>' +
    '</div>' +
    '</div>';
}

function cardHTML(it) {
  var pid = (it.photoIds || [])[0];
  var qty = qtyOf(it);
  var h = '<button class="card" data-act="open" data-id="' + it.id + '">';
  h += '<div class="thumb"' + (pid ? ' data-photo="' + pid + '"' : '') + '>' +
    (pid ? '' : '<span class="ph-emoji">' + esc(catEmoji(it.categoryId)) + '</span>') + '</div>';
  h += '<div class="card-body">' +
    '<div class="card-name">' + esc(it.name) + '</div>' +
    '<div class="card-meta">' + esc(locName(it.locationId)) + (qty > 1 ? ' · ' + qty + '件' : '') + '</div>' +
    '</div>';
  if (it.loan) {
    var d = daysOut(it);
    h += '<span class="badge-lent' + (d >= 30 ? ' over' : '') + '">借出' + (d > 0 ? d + '天' : '') + '</span>';
  }
  h += '</button>';
  return h;
}

function hydrateThumbs() {
  $$('[data-photo]').forEach(function (el) {
    var pid = el.getAttribute('data-photo');
    getPhotoUrl(pid, 'thumb').then(function (url) {
      if (url) el.style.backgroundImage = 'url("' + url + '")';
    });
  });
}

function getPhotoUrl(pid, kind) {
  var key = pid + '|' + kind;
  if (urlCache[key]) return Promise.resolve(urlCache[key]);
  if (inflight[key]) return inflight[key];

  inflight[key] = DB.get('photos', pid).then(function (p) {
    if (!p) return null;
    var blob = kind === 'thumb' ? (p.thumb || p.full) : (p.full || p.thumb);
    if (!blob) return null;
    var url = URL.createObjectURL(blob);
    urlCache[key] = url;
    return url;
  }).catch(function () {
    return null;
  }).then(function (u) {
    delete inflight[key];
    return u;
  });

  return inflight[key];
}

/* ---------------- 统计 ---------------- */

function statsHTML() {
  if (!S.items.length) {
    return '<div class="empty"><p>还没有数据，先去添加几件东西吧</p><button class="btn solid" data-act="add-item">＋ 添加物品</button></div>';
  }

  var lent = S.items.filter(function (i) { return i.loan; }).length;

  var groups = [];
  S.cats.forEach(function (c) {
    var items = S.items.filter(function (i) { return i.categoryId === c.id; });
    if (items.length) {
      groups.push({ name: (c.emoji ? c.emoji + ' ' : '') + c.name, n: items.length, v: sumValue(items) });
    }
  });
  var unc = S.items.filter(function (i) { return !i.categoryId; });
  if (unc.length) groups.push({ name: '未分类', n: unc.length, v: sumValue(unc) });
  groups.sort(function (a, b) { return b.n - a.n; });
  var maxN = 1;
  groups.forEach(function (g) { if (g.n > maxN) maxN = g.n; });

  var locGroups = [];
  S.locs.forEach(function (l) {
    var n = S.items.filter(function (i) { return i.locationId === l.id; }).length;
    if (n) locGroups.push({ name: l.name, n: n });
  });
  var noLoc = S.items.filter(function (i) { return !i.locationId; }).length;
  if (noLoc) locGroups.push({ name: '未记位置', n: noLoc });
  locGroups.sort(function (a, b) { return b.n - a.n; });
  var maxL = 1;
  locGroups.forEach(function (g) { if (g.n > maxL) maxL = g.n; });

  var h = '';
  h += '<section class="stat-strip">' +
    '<div><b>' + qtyTotal() + '</b><span>件物品</span></div>' +
    '<div><b>' + S.items.length + '</b><span>条记录</span></div>' +
    '<div><b>' + lent + '</b><span>借出中</span></div>' +
    '<div><b>' + money(sumValue(S.items)) + '</b><span>总价值</span></div>' +
    '</section>';

  h += '<div class="block"><h3>按分类</h3><div class="bars">';
  groups.forEach(function (g) {
    var pct = Math.max(4, Math.round(g.n / maxN * 100));
    h += '<div class="bar-row"><div class="bar-top"><b>' + esc(g.name) + '</b><span>' + g.n + ' 件 · ' + money(g.v) + '</span></div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div></div>';
  });
  h += '</div></div>';

  h += '<div class="block"><h3>按位置</h3><div class="bars">';
  locGroups.forEach(function (g) {
    var pct = Math.max(4, Math.round(g.n / maxL * 100));
    h += '<div class="bar-row"><div class="bar-top"><b>' + esc(g.name) + '</b><span>' + g.n + ' 件</span></div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div></div>';
  });
  h += '</div></div>';

  var lentItems = S.items.filter(function (i) { return i.loan; });
  if (lentItems.length) {
    lentItems.sort(function (a, b) { return daysOut(b) - daysOut(a); });
    h += '<div class="block"><h3>借出中（' + lentItems.length + '）</h3><div class="recent">';
    lentItems.forEach(function (it) {
      var d = daysOut(it);
      h += '<button class="recent-item" data-act="open" data-id="' + it.id + '">' +
        '<span class="recent-thumb">🤝</span>' +
        '<span class="recent-text"><b>' + esc(it.name) + '</b><span>' + esc(it.loan.to) + ' · ' +
        (d > 0 ? d + ' 天' : '今天') + '</span></span>' +
        (d >= 30 ? '<span class="pill warn">超期</span>' : '') +
        '</button>';
    });
    h += '</div></div>';
  }

  h += '<div class="block"><h3>最近添加</h3><div class="recent">' +
    S.items.slice(0, 5).map(recentHTML).join('') + '</div></div>';

  return h;
}

function recentHTML(it) {
  var pid = (it.photoIds || [])[0];
  return '<button class="recent-item" data-act="open" data-id="' + it.id + '">' +
    '<span class="recent-thumb"' + (pid ? ' data-photo="' + pid + '"' : '') + '>' +
    (pid ? '' : esc(catEmoji(it.categoryId))) + '</span>' +
    '<span class="recent-text"><b>' + esc(it.name) + '</b><span>' + esc(locName(it.locationId)) + ' · ' + fmtDay(it.createdAt) + '</span></span>' +
    '</button>';
}

/* ---------------- 分类 / 位置 ---------------- */

function tagsHTML() {
  var mode = S.tagMode;
  var list = mode === 'cat' ? S.cats : S.locs;
  var counts = {};
  S.items.forEach(function (i) {
    var k = mode === 'cat' ? i.categoryId : i.locationId;
    counts[k] = (counts[k] || 0) + 1;
  });

  var h = '<div class="seg">' +
    '<button class="seg-btn' + (mode === 'cat' ? ' on' : '') + '" data-act="tag-mode" data-mode="cat">分类</button>' +
    '<button class="seg-btn' + (mode === 'loc' ? ' on' : '') + '" data-act="tag-mode" data-mode="loc">位置</button>' +
    '</div>';

  h += '<div class="tag-list">';
  list.forEach(function (t) {
    h += '<div class="tag-row" data-act="edit-tag" data-id="' + t.id + '">' +
      '<span class="tag-emoji">' + esc(t.emoji || (mode === 'cat' ? '🏷️' : '📍')) + '</span>' +
      '<span class="tag-name">' + esc(t.name) + '</span>' +
      '<span class="tag-count">' + (counts[t.id] || 0) + '</span>' +
      '<button class="tag-del" data-act="del-tag" data-id="' + t.id + '" aria-label="删除">✕</button>' +
      '</div>';
  });
  if (!list.length) h += '<p class="hint">还没有' + (mode === 'cat' ? '分类' : '位置') + '，点下面新建一个。</p>';
  h += '</div>';

  h += '<button class="btn ghost block" data-act="new-tag">＋ 新建' + (mode === 'cat' ? '分类' : '位置') + '</button>';
  return h;
}

/* ---------------- 设置 ---------------- */

function settingsHTML() {
  var installed = !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  var h = '';

  if (S.lsMode) {
    h += '<div class="block"><h3>⚠️ 当前是「本地文件模式」</h3>' +
      '<p class="hint">你是双击打开的文件，浏览器不允许用数据库，只能用约 5MB 的本地缓存。' +
      '适合试十几件东西、看看界面，不适合正式记录几百件。' +
      '把整个 youwu 文件夹传到网址后，就能正常用（见本页最上面的安装说明）。</p></div>';
  }

  h += '<div class="block"><h3>装到手机桌面</h3>' +
    '<p class="hint">用 Chrome 打开本页 → 右上角 ⋮ → 「添加到主屏幕」。装好后从桌面图标打开，全屏、断网也能用。</p>' +
    '<button class="btn ghost block" data-act="how-install">' + (installed ? '已安装 · 再看一遍说明' : '看安装步骤') + '</button></div>';

  h += '<div class="block"><h3>备份与导出</h3>' +
    '<p class="hint">数据只在这台手机里，不上传任何服务器。换手机、清理浏览器数据之前，务必先导出备份。' +
    '两台设备互传用「合并导入」，换手机恢复用「覆盖导入」。</p>' +
    '<button class="btn ghost block" data-act="export-json">导出备份（JSON）</button>' +
    '<button class="btn ghost block" data-act="export-json-photos">导出备份（含照片，文件较大）</button>' +
    '<button class="btn ghost block" data-act="export-csv">导出表格（CSV，Excel 可打开）</button>' +
    '<button class="btn ghost block" data-act="import-merge">合并导入（推荐，两端互传）</button>' +
    '<button class="btn ghost block" data-act="import-replace">覆盖导入（换手机用）</button>' +
    '<button class="btn ghost block" data-act="import-csv">CSV 批量导入</button>' +
    '<button class="btn ghost block" data-act="csv-template">下载 CSV 模板</button>' +
    '<p class="hint" id="storageLine"></p></div>';

  h += '<div class="block"><h3>先试玩一下</h3>' +
    '<p class="hint">不确定怎么用？先载入 10 件示例物品看看效果，随时可以清空。</p>' +
    '<button class="btn ghost block" data-act="demo">载入 10 件示例数据</button></div>';

  h += '<div class="block"><h3>清空数据</h3>' +
    '<p class="hint">删除全部物品、照片、分类和位置，不可恢复。</p>' +
    '<button class="btn ghost danger block" data-act="wipe">清空所有数据</button></div>';

  h += '<div class="block about"><div class="about-logo">物</div>' +
    '<p><b>有物</b> v1.0</p><p class="hint">把你拥有的每一件东西，都记下来。</p></div>';
  return h;
}

function showStorage() {
  var el = $('#storageLine');
  if (!el) return;
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(function (est) {
      if (!el.isConnected) return;
      el.textContent = '当前占用 ' + fmtBytes(est.usage) + '，浏览器可用空间约 ' + fmtBytes(est.quota);
    }).catch(function () { });
  }
}

/* ---------------- 详情 ---------------- */

function openDetail(id) {
  var it = findItem(id);
  if (!it) { toast('这件东西已经不在了'); return; }
  S.current = it.id;

  var cat = S.cats.filter(function (c) { return c.id === it.categoryId; })[0];
  var loc = S.locs.filter(function (l) { return l.id === it.locationId; })[0];
  var photos = it.photoIds || [];

  var h = '';
  h += '<div class="detail-bar">' +
    '<button class="back-btn" data-act="back" aria-label="返回">←</button>' +
    '<span class="detail-title">' + esc(it.name) + '</span>' +
    '<button class="link" data-act="edit" data-id="' + it.id + '">编辑</button>' +
    '</div>';

  h += '<div class="detail-scroll">';

  if (photos.length) {
    h += '<div class="gallery">' + photos.map(function (pid) {
      return '<div class="gallery-item" data-gphoto="' + pid + '"></div>';
    }).join('') + '</div>';
  } else {
    h += '<div class="gallery empty">' + esc(cat && cat.emoji ? cat.emoji : '📦') + '</div>';
  }

  h += '<div class="detail-main">';
  h += '<h2>' + esc(it.name) + '</h2>';
  h += '<div class="pills">' +
    '<span class="pill">' + esc(cat ? ((cat.emoji ? cat.emoji + ' ' : '') + cat.name) : '未分类') + '</span>' +
    '<span class="pill">' + esc(loc ? loc.name : '未记位置') + '</span>' +
    (it.loan ? '<span class="pill warn">借出中</span>' : '') +
    '</div>';

  h += '<div class="qty-row">' +
    '<button class="qbtn" data-act="qty-dec" data-id="' + it.id + '" aria-label="减一件">−</button>' +
    '<span class="qnum">' + qtyOf(it) + ' 件</span>' +
    '<button class="qbtn" data-act="qty-inc" data-id="' + it.id + '" aria-label="加一件">＋</button>' +
    '</div>';

  var tg = tagsOf(it);
  if (tg.length) {
    h += '<div class="pills">';
    tg.forEach(function (t) {
      h += '<button class="pill tag-pill" data-act="filter-tag" data-tag="' + esc(t) + '">#' + esc(t) + '</button>';
    });
    h += '</div>';
  }

  h += '<div class="fields">';
  if (num(it.price) > 0) {
    h += '<div><dt>单价</dt><dd>' + money(it.price) + '</dd></div>';
    h += '<div><dt>合计</dt><dd>' + money(num(it.price) * qtyOf(it)) + '</dd></div>';
  }
  if (it.date) h += '<div><dt>购入日期</dt><dd>' + esc(it.date) + '</dd></div>';
  h += '<div><dt>添加时间</dt><dd>' + fmtDay(it.createdAt) + '</dd></div>';
  h += '</div>';

  if (it.note) h += '<p class="note">' + esc(it.note) + '</p>';

  h += '<div class="loan-card">';
  if (it.loan) {
    var dOut = daysOut(it);
    h += '<div class="loan-head"><b>已借给 ' + esc(it.loan.to) + '</b>' +
      (dOut >= 30 ? '<span class="pill warn">' + dOut + ' 天未还</span>' : '') + '</div>';
    h += '<div class="loan-body">借出日期：' + esc(it.loan.since || '—') +
      (dOut > 0 ? '（' + dOut + ' 天）' : '') +
      (it.loan.note ? '<br>备注：' + esc(it.loan.note) : '') + '</div>';
    h += '<button class="btn solid block" data-act="return" data-id="' + it.id + '">记一笔归还</button>';
  } else {
    h += '<div class="loan-head"><b>在库</b></div>';
    h += '<button class="btn ghost block" data-act="lend" data-id="' + it.id + '">借出去了？记一笔</button>';
  }
  h += '</div>';

  if (it.history && it.history.length) {
    h += '<h3 class="sec">借出记录</h3><ul class="hist">';
    it.history.forEach(function (x) {
      h += '<li>借给 <b>' + esc(x.to) + '</b> · ' + esc(x.since || '') + ' → ' + esc(x.back || '未还') +
        (x.note ? ' · ' + esc(x.note) : '') + '</li>';
    });
    h += '</ul>';
  }

  h += '<button class="btn ghost danger block" data-act="del" data-id="' + it.id + '">删除这件东西</button>';
  h += '</div></div>';

  var box = $('#detail');
  box.innerHTML = h;
  box.hidden = false;
  syncLock();
  fillGallery(photos);
}

function fillGallery(photos) {
  if (!photos || !photos.length) return;
  $$('#detail [data-gphoto]').forEach(function (el) {
    var pid = el.getAttribute('data-gphoto');
    getPhotoUrl(pid, 'full').then(function (url) {
      if (url) el.style.backgroundImage = 'url("' + url + '")';
    });
  });
}

function closeDetail() {
  $('#detail').hidden = true;
  S.current = null;
  syncLock();
}

/* ---------------- 编辑面板 ---------------- */

function openEditor(item) {
  var f;
  if (item) {
    f = JSON.parse(JSON.stringify(item));
  } else {
    f = {
      id: '', name: '', categoryId: '', locationId: '', qty: 1, price: '',
      date: '', note: '', photoIds: [], loan: null, history: [], createdAt: 0, updatedAt: 0,
      tags: []
    };
  }
  f.photos = [];
  f.oldPhotoIds = (item && item.photoIds) ? item.photoIds.slice() : [];
  S.form = f;

  $('#sheetTitle').textContent = item ? '编辑物品' : '添加物品';
  $('#sheetBody').innerHTML = editorHTML(f);
  $('#sheet').hidden = false;

  if (item && (num(item.price) > 0 || item.date || (item.tags && item.tags.length) || item.note)) {
    var box = $('#moreBox');
    if (box) box.hidden = false;
    var tg = document.querySelector('.more-toggle');
    if (tg) tg.textContent = '收起更多信息';
  }

  syncLock();

  loadEditorPhotos(f, function () { renderPhotoStrip(); });
}

function loadEditorPhotos(f, done) {
  var list = f.oldPhotoIds || [];
  if (!list.length) { done(); return; }
  Promise.all(list.map(function (pid) {
    return Promise.all([getPhotoUrl(pid, 'full'), getPhotoUrl(pid, 'thumb')]).then(function (urls) {
      if (!urls[0] && !urls[1]) return null;
      return { id: pid, isNew: false, url: urls[0], thumbUrl: urls[1] };
    }).catch(function () { return null; });
  })).then(function (arr) {
    arr.forEach(function (x) { if (x) f.photos.push(x); });
    done();
  });
}

function loadRecentLocs() {
  return DB.get('meta', 'recentLocs').then(function (rec) {
    S.recentLocs = (rec && rec.list) ? rec.list.slice(0, 10) : [];
  }).catch(function () { S.recentLocs = []; });
}

function rememberLoc(id) {
  if (!id) return;
  var arr = (S.recentLocs || []).filter(function (x) { return x !== id; });
  arr.unshift(id);
  S.recentLocs = arr.slice(0, 10);
  DB.put('meta', { key: 'recentLocs', list: S.recentLocs }).catch(function () { });
}

function editorHTML(f) {
  var loc = f.locationId ? locName(f.locationId) : '';

  var h = '';
  h += '<div class="form-photos" id="photoStrip">' + photoStripHTML(f) + '</div>';

  h += '<button type="button" class="loc-big' + (loc ? '' : ' empty') + '" id="locBtn" data-act="open-picker">' +
    '<span class="loc-mark">📍</span>' +
    '<span class="loc-body">' +
    '<span class="loc-label">存放位置</span>' +
    '<span class="loc-name">' + esc(loc || '点这里选择') + '</span>' +
    '</span>' +
    '<span class="loc-arrow">›</span>' +
    '</button>';

  h += '<label class="field tight"><span>名称</span><input id="f-name" maxlength="60" placeholder="例：米白色羊毛大衣" value="' + esc(f.name) + '"></label>';

  h += '<div class="field tight"><span>分类</span><div class="chip-row" id="catChips">' + catChipsHTML(f) + '</div></div>';

  h += '<div class="more-wrap">' +
    '<button type="button" class="more-toggle" data-act="toggle-more">更多信息（数量 / 价格 / 日期 / 标签 / 备注）</button>' +
    '<div id="moreBox" hidden>' +
    '<div class="field-row">' +
    '<label class="field"><span>数量</span><input id="f-qty" type="number" inputmode="numeric" min="1" step="1" value="' + qtyOf(f) + '"></label>' +
    '<label class="field"><span>单价（元）</span><input id="f-price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="选填" value="' + (num(f.price) ? esc(f.price) : '') + '"></label>' +
    '</div>' +
    '<label class="field"><span>购入日期</span><input id="f-date" type="date" value="' + esc(f.date || '') + '"></label>' +
    '<label class="field"><span>标签（逗号分隔，选填）</span><input id="f-tags" maxlength="90" placeholder="例：冬季, 常穿" value="' + esc((f.tags || []).join(', ')) + '"></label>' +
    tagQuickHTML(f) +
    '<label class="field"><span>备注</span><textarea id="f-note" rows="2" placeholder="颜色、尺码、放哪一格、谁送的……">' + esc(f.note || '') + '</textarea></label>' +
    '</div>' +
    '</div>';

  if (!f.id) {
    h += '<button type="button" class="btn solid block" data-act="save-continue">保存，继续添加下一件</button>';
  }
  h += '<p class="hint">照片会自动压缩，最多 9 张。</p>';
  return h;
}

/* ---------------- 位置选择器（格子视图） ---------------- */

function openPicker() {
  if (!S.form) return;
  $('#picker').innerHTML = pickerHTML();
  $('#picker').hidden = false;
  syncLock();
}

function closePicker() {
  $('#picker').hidden = true;
  syncLock();
}

function pickerHTML() {
  var cur = S.form ? S.form.locationId : '';
  var counts = {};
  S.items.forEach(function (it) {
    if (it.locationId) counts[it.locationId] = (counts[it.locationId] || 0) + 1;
  });

  function tile(l) {
    if (!l) return '';
    return '<button class="loc-tile' + (l.id === cur ? ' on' : '') + '" data-act="pick-loc" data-id="' + l.id + '">' +
      '<b>' + esc(l.name) + '</b>' +
      '<span>' + (counts[l.id] || 0) + ' 件</span>' +
      (l.id === cur ? '<i>✓</i>' : '') +
      '</button>';
  }

  var recent = (S.recentLocs || []).map(function (id) {
    return S.locs.filter(function (l) { return l.id === id; })[0];
  }).filter(Boolean).slice(0, 4);

  var h = '';
  h += '<div class="picker-bar">' +
    '<button class="link" data-act="close-picker">取消</button>' +
    '<strong>选择存放位置</strong>' +
    '<button class="link primary" data-act="new-loc-picker">＋ 新建</button>' +
    '</div>';

  h += '<div class="picker-body">';
  if (recent.length) {
    h += '<h4>最近用过</h4><div class="loc-grid">' + recent.map(tile).join('') + '</div>';
  }
  if (!S.locs.length) {
    h += '<p class="hint">还没有位置。点右上角「＋ 新建」，比如「卧室-衣柜-第三层」。</p>';
  } else {
    h += '<h4>全部位置（' + S.locs.length + '）</h4><div class="loc-grid">' + S.locs.map(tile).join('') + '</div>';
  }
  h += '</div>';
  return h;
}

function updateLocBtn() {
  var btn = $('#locBtn');
  if (!btn || !S.form) return;
  var name = S.form.locationId ? locName(S.form.locationId) : '';
  btn.classList.toggle('empty', !name);
  var el = btn.querySelector('.loc-name');
  if (el) el.textContent = name || '点这里选择';
}

function pickLoc(id) {
  if (!S.form) return;
  S.form.locationId = id;
  rememberLoc(id);
  updateLocBtn();
  closePicker();
}

function toggleMore() {
  var box = $('#moreBox');
  if (!box) return;
  box.hidden = !box.hidden;
  var btn = document.querySelector('.more-toggle');
  if (btn) {
    btn.textContent = box.hidden
      ? '更多信息（数量 / 价格 / 日期 / 标签 / 备注）'
      : '收起更多信息';
  }
}

function tagQuickHTML(f) {
  var cur = f.tags || [];
  var pool = collectTags().filter(function (t) { return cur.indexOf(t) < 0; }).slice(0, 12);
  if (!pool.length) return '';
  var h = '<div class="field"><span>常用标签</span><div class="chip-row">';
  pool.forEach(function (t) {
    h += '<button type="button" class="chip mini" data-act="quick-tag" data-tag="' + esc(t) + '">#' + esc(t) + '</button>';
  });
  h += '</div></div>';
  return h;
}

function catChipsHTML(f) {
  var h = S.cats.map(function (c) {
    return '<button type="button" class="chip' + (f.categoryId === c.id ? ' on' : '') + '" data-act="pick-cat" data-id="' + c.id + '">' +
      esc(c.emoji || '') + ' ' + esc(c.name) + '</button>';
  }).join('');
  h += '<button type="button" class="chip dashed" data-act="new-cat-inline">＋ 新建</button>';
  return h;
}

function locOptionsHTML(sel) {
  return ['<option value="">未记位置</option>'].concat(S.locs.map(function (l) {
    return '<option value="' + l.id + '"' + (l.id === sel ? ' selected' : '') + '>' + esc(l.name) + '</option>';
  })).join('');
}

function photoStripHTML(f) {
  var h = '';
  f.photos.forEach(function (p, i) {
    var src = p.thumbUrl || p.url || '';
    h += '<div class="ph"><img src="' + src + '" alt="">' +
      '<button type="button" class="ph-x" data-act="rm-photo" data-i="' + i + '">✕</button></div>';
  });
  if (f.photos.length < 9) {
    h += '<button type="button" class="ph-add" data-act="add-photo"><span>📷</span>拍照/选图</button>';
  }
  return h;
}

function renderPhotoStrip() {
  var box = $('#photoStrip');
  if (box && S.form) box.innerHTML = photoStripHTML(S.form);
}

function renderCatChips() {
  var box = $('#catChips');
  if (box && S.form) box.innerHTML = catChipsHTML(S.form);
}

function renderLocSelect() {
  var box = $('#f-loc');
  if (box && S.form) box.innerHTML = locOptionsHTML(S.form.locationId);
}

function pickCat(id) {
  if (!S.form) return;
  S.form.categoryId = id;
  renderCatChips();
}

function closeSheet() {
  $('#sheet').hidden = true;
  $('#picker').hidden = true;
  S.form = null;
  syncLock();
}

function syncLock() {
  var locked = !$('#sheet').hidden || !$('#detail').hidden || !$('#dialog').hidden || !$('#picker').hidden;
  document.body.classList.toggle('locked', locked);
}

/* ---------------- 照片处理 ---------------- */

function pickPhotos() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', function () {
    addPhotos(input.files);
    setTimeout(function () {
      if (input.parentNode) input.parentNode.removeChild(input);
    }, 0);
  });
  input.click();
}

function addPhotos(files) {
  if (!S.form || !files || !files.length) return;
  var f = S.form;
  var room = 9 - f.photos.length;
  if (room <= 0) { toast('最多 9 张照片'); return; }
  var list = Array.prototype.slice.call(files, 0, room);
  if (files.length > room) toast('最多 9 张，多出的已忽略');

  var i = 0;
  function next() {
    if (i >= list.length) { renderPhotoStrip(); return; }
    var file = list[i++];
    if (!file || !file.type || file.type.indexOf('image/') !== 0) { next(); return; }
    processImage(file).then(function (rec) {
      rec.id = uid();
      f.photos.push(rec);
      renderPhotoStrip();
      next();
    }).catch(function () {
      toast('有张照片读不出来，换一张试试');
      next();
    });
  }
  next();
}

function loadBitmap(file) {
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      reject(new Error('图片无法读取'));
    };
    img.src = url;
  });
}

function canvasBlob(img, max, quality) {
  var w0 = img.naturalWidth || img.width;
  var h0 = img.naturalHeight || img.height;
  var scale = Math.min(1, max / Math.max(w0, h0));
  var w = Math.max(1, Math.round(w0 * scale));
  var h = Math.max(1, Math.round(h0 * scale));

  var canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  return new Promise(function (resolve, reject) {
    canvas.toBlob(function (blob) {
      if (blob) resolve(blob);
      else reject(new Error('压缩失败'));
    }, 'image/jpeg', quality);
  });
}

function processImage(file) {
  return loadBitmap(file).then(function (img) {
    return Promise.all([canvasBlob(img, 1600, 0.82), canvasBlob(img, 480, 0.7)]).then(function (arr) {
      return {
        full: arr[0],
        thumb: arr[1],
        w: img.naturalWidth || img.width,
        h: img.naturalHeight || img.height,
        url: URL.createObjectURL(arr[0]),
        thumbUrl: URL.createObjectURL(arr[1]),
        isNew: true
      };
    });
  });
}

function removePhoto(i) {
  if (!S.form) return;
  var p = S.form.photos[i];
  if (!p) return;
  if (p.isNew) {
    try { URL.revokeObjectURL(p.url); } catch (e) { }
    try { URL.revokeObjectURL(p.thumbUrl); } catch (e) { }
  }
  S.form.photos.splice(i, 1);
  renderPhotoStrip();
}

/* ---------------- 保存 ---------------- */

function parseTags(v) {
  var out = [];
  String(v || '').split(/[,，、;；\s]+/).forEach(function (t) {
    t = t.trim().replace(/^#/, '');
    if (!t || t.length > 12) return;
    if (out.indexOf(t) >= 0) return;
    if (out.length >= 10) return;
    out.push(t);
  });
  return out;
}

function saveForm(keepOpen) {
  var f = S.form;
  if (!f) return;

  var nameEl = $('#f-name');
  var name = nameEl ? nameEl.value.trim() : '';
  if (!name) {
    toast('给这件东西起个名字吧');
    if (nameEl) nameEl.focus();
    return;
  }

  var qtyEl = $('#f-qty');
  var priceEl = $('#f-price');
  var dateEl = $('#f-date');
  var noteEl = $('#f-note');
  var tagsEl = $('#f-tags');

  var item = {
    id: f.id || uid(),
    name: name,
    categoryId: f.categoryId || '',
    locationId: f.locationId || '',
    qty: Math.max(1, Math.round(num(qtyEl ? qtyEl.value : 1) || 1)),
    price: num(priceEl ? priceEl.value : 0),
    date: dateEl ? dateEl.value : '',
    note: noteEl ? noteEl.value.trim() : '',
    tags: parseTags(tagsEl ? tagsEl.value : ''),
    photoIds: [],
    loan: f.loan || null,
    history: f.history || [],
    createdAt: f.createdAt || Date.now(),
    updatedAt: Date.now()
  };

  var keep = {};
  f.photos.forEach(function (p) { keep[p.id] = true; });

  var jobs = [];
  (f.oldPhotoIds || []).forEach(function (pid) {
    if (keep[pid]) return;
    jobs.push(DB.del('photos', pid).then(function () {
      ['full', 'thumb'].forEach(function (kind) {
        var k = pid + '|' + kind;
        if (urlCache[k]) {
          try { URL.revokeObjectURL(urlCache[k]); } catch (e) { }
          delete urlCache[k];
        }
      });
    }));
  });

  f.photos.forEach(function (p) {
    item.photoIds.push(p.id);
    if (p.isNew) {
      jobs.push(DB.put('photos', {
        id: p.id, itemId: item.id, full: p.full, thumb: p.thumb,
        w: p.w, h: p.h, createdAt: Date.now()
      }).then(function () {
        if (p.url) urlCache[p.id + '|full'] = p.url;
        if (p.thumbUrl) urlCache[p.id + '|thumb'] = p.thumbUrl;
      }));
    }
  });

  var keepCat = item.categoryId;
  var keepLoc = item.locationId;
  var keepTags = item.tags.slice();

  jobs.push(DB.put('items', item));

  Promise.all(jobs).then(function () {
    var wasNew = !f.id;
    rememberLoc(keepLoc);
    return reload().then(function () {
      if (keepOpen && wasNew) {
        var draft = {
          id: '', name: '', categoryId: keepCat, locationId: keepLoc,
          qty: 1, price: '', date: '', note: '', photoIds: [],
          loan: null, history: [], createdAt: 0, updatedAt: 0,
          tags: keepTags, photos: [], oldPhotoIds: []
        };
        S.form = draft;
        $('#sheetBody').innerHTML = editorHTML(draft);
        render();
        var n = $('#f-name');
        if (n) { try { n.focus(); } catch (e) { } }
        toast('已收下「' + item.name + '」，继续下一件');
        return;
      }
      closeSheet();
      if (!wasNew && S.current === item.id && !$('#detail').hidden) openDetail(item.id);
      render();
      toast(wasNew ? '已收下「' + item.name + '」' : '已保存');
    });
  }).catch(fatal);
}

/* ---------------- 借出 / 归还 / 删除 ---------------- */

function lendItem(id) {
  var it = findItem(id);
  if (!it) return;
  askForm({
    title: '借出「' + it.name + '」',
    fields: [
      { key: 'to', label: '借给谁', required: true, placeholder: '姓名或称呼' },
      { key: 'since', label: '借出日期', type: 'date', value: todayStr() },
      { key: 'note', label: '备注', placeholder: '说好什么时候还' }
    ],
    okText: '记下'
  }).then(function (r) {
    if (!r) return;
    it.loan = { to: r.to, since: r.since || todayStr(), note: r.note || '' };
    it.updatedAt = Date.now();
    return DB.put('items', it).then(reload).then(function () {
      if (S.current === it.id) openDetail(it.id);
      render();
      toast('已记为一笔借出');
    });
  }).catch(fatal);
}

function returnItem(id) {
  var it = findItem(id);
  if (!it || !it.loan) return;
  confirmDialog({
    title: '确认归还？',
    desc: '「' + it.name + '」会重新记为在库，并留下一条借出记录。',
    okText: '归还'
  }).then(function (ok) {
    if (!ok) return;
    it.history = it.history || [];
    it.history.unshift({
      to: it.loan.to,
      since: it.loan.since,
      back: todayStr(),
      note: it.loan.note || ''
    });
    it.loan = null;
    it.updatedAt = Date.now();
    return DB.put('items', it).then(reload).then(function () {
      if (S.current === it.id) openDetail(it.id);
      render();
      toast('已记为一笔归还');
    });
  }).catch(fatal);
}

/* ---------------- 删除标记（让删除也能同步） ---------------- */

async function getTombstones() {
  try {
    var rec = await DB.get('meta', 'tombstones');
    return (rec && rec.map) ? rec.map : {};
  } catch (e) {
    return {};
  }
}

async function setTombstones(map) {
  await DB.put('meta', { key: 'tombstones', map: map });
}

async function addTombstone(id) {
  var map = await getTombstones();
  map[id] = Date.now();
  await setTombstones(map);
}

function deleteItem(id) {
  var it = findItem(id);
  if (!it) return;
  confirmDialog({
    title: '删除这件东西？',
    desc: '「' + it.name + '」和它的照片会被删除，无法恢复。',
    okText: '删除',
    danger: true
  }).then(function (ok) {
    if (!ok) return;
    return DB.byItem(it.id).then(function (photos) {
      var chain = Promise.resolve();
      photos.forEach(function (p) {
        chain = chain.then(function () {
          ['full', 'thumb'].forEach(function (kind) {
            var k = p.id + '|' + kind;
            if (urlCache[k]) {
              try { URL.revokeObjectURL(urlCache[k]); } catch (e) { }
              delete urlCache[k];
            }
          });
          return DB.del('photos', p.id);
        });
      });
      return chain;
    }).then(function () {
      return DB.del('items', it.id);
    }).then(function () {
      return addTombstone(it.id);
    }).then(function () {
      closeDetail();
      return reload();
    }).then(function () {
      render();
      toast('已删除');
    });
  }).catch(fatal);
}

/* ---------------- 分类 / 位置维护 ---------------- */

function newTag() {
  var mode = S.tagMode;
  askForm({
    title: mode === 'cat' ? '新建分类' : '新建位置',
    fields: [{
      key: 'name',
      label: '名称',
      required: true,
      placeholder: mode === 'cat' ? '例：围巾、厨房小家电' : '例：卧室-衣柜-第三层'
    }],
    emoji: mode === 'cat',
    emojiValue: '📦',
    okText: '创建'
  }).then(function (r) {
    if (!r) return;
    var rec = { id: uid(), name: r.name, order: mode === 'cat' ? S.cats.length : S.locs.length, createdAt: Date.now() };
    if (mode === 'cat') rec.emoji = r.emoji || '📦';
    return DB.put(mode === 'cat' ? 'categories' : 'locations', rec).then(reload).then(function () {
      render();
      toast('已创建');
    });
  }).catch(fatal);
}

function editTag(id) {
  var mode = S.tagMode;
  var list = mode === 'cat' ? S.cats : S.locs;
  var t = list.filter(function (x) { return x.id === id; })[0];
  if (!t) return;

  askForm({
    title: '编辑' + (mode === 'cat' ? '分类' : '位置'),
    fields: [{ key: 'name', label: '名称', value: t.name, required: true }],
    emoji: mode === 'cat',
    emojiValue: t.emoji || '📦',
    okText: '保存'
  }).then(function (r) {
    if (!r) return;
    t.name = r.name;
    if (mode === 'cat' && r.emoji) t.emoji = r.emoji;
    return DB.put(mode === 'cat' ? 'categories' : 'locations', t).then(reload).then(function () {
      render();
      toast('已保存');
    });
  }).catch(fatal);
}

function delTag(id) {
  var mode = S.tagMode;
  var list = mode === 'cat' ? S.cats : S.locs;
  var t = list.filter(function (x) { return x.id === id; })[0];
  if (!t) return;

  confirmDialog({
    title: '删除「' + t.name + '」？',
    desc: mode === 'cat'
      ? '这个分类下的物品不会删除，会变成「未分类」。'
      : '用了这个位置的物品不会删除，会变成「未记位置」。',
    okText: '删除',
    danger: true
  }).then(function (ok) {
    if (!ok) return;
    var chain = Promise.resolve();
    S.items.forEach(function (it) {
      var key = mode === 'cat' ? 'categoryId' : 'locationId';
      if (it[key] !== id) return;
      it[key] = '';
      it.updatedAt = Date.now();
      chain = chain.then(function () { return DB.put('items', it); });
    });
    chain = chain.then(function () { return DB.del(mode === 'cat' ? 'categories' : 'locations', id); });
    return chain.then(reload).then(function () {
      render();
      toast('已删除');
    });
  }).catch(fatal);
}

/* ---------------- 导入导出 ---------------- */

function csvCell(v) {
  var s = String(v == null ? '' : v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function downloadFile(name, blob) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    URL.revokeObjectURL(url);
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 2000);
}

function exportCSV() {
  try {
    var head = ['名称', '分类', '位置', '数量', '单价', '购入日期', '状态', '借出人', '借出日期', '备注'];
    var rows = S.items.map(function (it) {
      return [
        it.name,
        catName(it.categoryId),
        locName(it.locationId),
        qtyOf(it),
        num(it.price) || '',
        it.date || '',
        it.loan ? '借出' : '在库',
        it.loan ? it.loan.to : '',
        it.loan ? it.loan.since : '',
        it.note || ''
      ];
    });
    var lines = [head].concat(rows).map(function (r) {
      return r.map(csvCell).join(',');
    });
    var text = '\ufeff' + lines.join('\r\n');
    downloadFile('有物清单-' + todayStr() + '.csv', new Blob([text], { type: 'text/csv;charset=utf-8' }));
    toast('CSV 已导出');
  } catch (e) {
    fatal(e);
  }
}

function downloadCSVTemplate() {
  var head = ['名称', '分类', '位置', '数量', '单价', '购入日期', '备注'];
  var sample = [
    ['米白色羊毛大衣', '衣服', '卧室-衣柜-第一层', '1', '899', '2024-11-03', '干洗，别机洗'],
    ['白色帆布鞋', '鞋', '玄关-鞋柜', '1', '299', '2025-03-10', '尺码 40']
  ];
  var text = '\ufeff' + [head].concat(sample).map(function (r) {
    return r.map(csvCell).join(',');
  }).join('\r\n');
  downloadFile('有物导入模板.csv', new Blob([text], { type: 'text/csv;charset=utf-8' }));
  toast('模板已下载');
}

function blobToDataURL(blob) {
  return new Promise(function (resolve, reject) {
    if (!blob) { resolve(''); return; }
    var r = new FileReader();
    r.onload = function () { resolve(String(r.result)); };
    r.onerror = function () { reject(r.error); };
    r.readAsDataURL(blob);
  });
}

function dataURLToBlob(u) {
  if (!u) return null;
  var parts = String(u).split(',');
  if (parts.length < 2) return null;
  var m = /data:([^;]+)/.exec(parts[0]);
  var mime = m ? m[1] : 'image/jpeg';
  var bin = atob(parts[1]);
  var arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function exportJSON(withPhotos) {
  try {
    toast(withPhotos ? '正在打包照片，请稍候…' : '正在导出…');
    var items = await DB.all('items');
    var cats = await DB.all('categories');
    var locs = await DB.all('locations');
    var data = {
      app: 'youwu',
      version: 1,
      exportedAt: new Date().toISOString(),
      categories: cats,
      locations: locs,
      items: items,
      deleted: await getTombstones(),
      photos: []
    };
    if (withPhotos) {
      var photos = await DB.all('photos');
      for (var i = 0; i < photos.length; i++) {
        var p = photos[i];
        data.photos.push({
          id: p.id,
          itemId: p.itemId,
          createdAt: p.createdAt,
          full: await blobToDataURL(p.full),
          thumb: await blobToDataURL(p.thumb || p.full)
        });
      }
    }
    var blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    downloadFile('有物备份-' + todayStr() + (withPhotos ? '-含照片' : '') + '.json', blob);
    toast('备份已导出');
  } catch (e) {
    fatal(e);
  }
}

function pickImport(kind) {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = kind === 'csv' ? '.csv,text/csv' : '.json,application/json';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      if (kind === 'csv') { importCSV(text); return; }
      importJSON(text, kind);
    };
    reader.onerror = function () { toast('文件读不出来'); };
    reader.readAsText(file);
  });
  input.click();
}

function importJSON(text, mode) {
  var data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    toast('这个文件不是有效的 JSON');
    return;
  }
  if (!data || !Array.isArray(data.items)) {
    toast('这不是「有物」的备份文件');
    return;
  }

  if (mode === 'replace') {
    confirmDialog({
      title: '覆盖导入？',
      desc: '会用备份里的 ' + data.items.length + ' 件物品替换本机现有数据，原有内容会丢失。' +
        '如果是两台设备互传，请改用「合并导入」。',
      okText: '覆盖'
    }).then(function (ok) {
      if (!ok) return;
      return restoreJSON(data);
    }).catch(fatal);
    return;
  }

  confirmDialog({
    title: '合并 ' + data.items.length + ' 件？',
    desc: '本机没有的会新增，本机已有的按「修改时间较新」为准更新；本机独有的东西不会被删除。' +
      '分类和位置按名称自动对应，不会重复创建。',
    okText: '合并'
  }).then(function (ok) {
    if (!ok) return;
    return mergeJSON(data);
  }).catch(fatal);
}

/* 合并导入：只增不删，同名分类/位置自动归并，物品按 id + 修改时间取较新 */
async function mergeJSON(data) {
  try {
    var hasPhotos = (data.photos || []).length > 0;
    var catMap = {};
    var locMap = {};

    var cats = data.categories || [];
    for (var i = 0; i < cats.length; i++) {
      var c = cats[i];
      if (!c || !c.id) continue;
      var hit = null;
      for (var a = 0; a < S.cats.length; a++) {
        if (S.cats[a].id === c.id) { hit = S.cats[a]; break; }
      }
      if (!hit) {
        for (var b = 0; b < S.cats.length; b++) {
          if (S.cats[b].name === c.name) { hit = S.cats[b]; break; }
        }
      }
      if (hit) {
        catMap[c.id] = hit.id;
        if (hit.name !== c.name || (c.emoji && c.emoji !== hit.emoji)) {
          hit.name = c.name;
          if (c.emoji) hit.emoji = c.emoji;
          await DB.put('categories', hit);
        }
      } else {
        var nc = {
          id: c.id,
          name: c.name,
          emoji: c.emoji || '📦',
          order: c.order == null ? S.cats.length : c.order,
          createdAt: c.createdAt || Date.now()
        };
        await DB.put('categories', nc);
        S.cats.push(nc);
        catMap[c.id] = c.id;
      }
    }

    var locs = data.locations || [];
    for (var j = 0; j < locs.length; j++) {
      var l = locs[j];
      if (!l || !l.id) continue;
      var hitL = null;
      for (var x = 0; x < S.locs.length; x++) {
        if (S.locs[x].id === l.id) { hitL = S.locs[x]; break; }
      }
      if (!hitL) {
        for (var y = 0; y < S.locs.length; y++) {
          if (S.locs[y].name === l.name) { hitL = S.locs[y]; break; }
        }
      }
      if (hitL) {
        locMap[l.id] = hitL.id;
        if (hitL.name !== l.name) {
          hitL.name = l.name;
          await DB.put('locations', hitL);
        }
      } else {
        var nl = {
          id: l.id,
          name: l.name,
          order: l.order == null ? S.locs.length : l.order,
          createdAt: l.createdAt || Date.now()
        };
        await DB.put('locations', nl);
        S.locs.push(nl);
        locMap[l.id] = l.id;
      }
    }

    if (hasPhotos) {
      for (var p = 0; p < data.photos.length; p++) {
        var ph = data.photos[p];
        if (!ph || !ph.id) continue;
        var exist = await DB.get('photos', ph.id);
        if (exist) continue;
        var full = dataURLToBlob(ph.full);
        if (!full) continue;
        await DB.put('photos', {
          id: ph.id,
          itemId: ph.itemId,
          createdAt: ph.createdAt || Date.now(),
          full: full,
          thumb: dataURLToBlob(ph.thumb || ph.full) || full
        });
      }
    }

    var tombs = await getTombstones();
    var importedTombs = (data.deleted && typeof data.deleted === 'object') ? data.deleted : {};
    var tombIds = Object.keys(importedTombs);
    var removed = 0;

    for (var t = 0; t < tombIds.length; t++) {
      var tid = tombIds[t];
      var tAt = num(importedTombs[tid]) || Date.now();
      var hitIt = null;
      for (var q = 0; q < S.items.length; q++) {
        if (S.items[q].id === tid) { hitIt = S.items[q]; break; }
      }
      if (hitIt && (num(hitIt.updatedAt) || 0) <= tAt) {
        var oldPhotos = await DB.byItem(tid);
        for (var pp = 0; pp < oldPhotos.length; pp++) {
          await DB.del('photos', oldPhotos[pp].id);
          var ka = oldPhotos[pp].id + '|full';
          var kb = oldPhotos[pp].id + '|thumb';
          if (urlCache[ka]) { try { URL.revokeObjectURL(urlCache[ka]); } catch (e) { } delete urlCache[ka]; }
          if (urlCache[kb]) { try { URL.revokeObjectURL(urlCache[kb]); } catch (e) { } delete urlCache[kb]; }
        }
        await DB.del('items', tid);
        removed++;
      }
      if (!tombs[tid] || num(tombs[tid]) < tAt) tombs[tid] = tAt;
    }

    if (tombIds.length) {
      await setTombstones(tombs);
      await reload();
    }

    var byId = {};
    S.items.forEach(function (it) { byId[it.id] = it; });

    var added = 0;
    var updated = 0;
    var kept = 0;
    var skipped = 0;

    for (var k = 0; k < data.items.length; k++) {
      var src = data.items[k];
      if (!src || !src.name) continue;

      var id = src.id || uid();
      if (tombs[id] && (num(src.updatedAt) || 0) <= num(tombs[id])) { skipped++; continue; }
      var local = byId[id];

      var catId = catMap[src.categoryId];
      if (catId == null) catId = src.categoryId || '';

      var locId = locMap[src.locationId];
      if (locId == null) locId = src.locationId || '';

      if (!local) {
        await DB.put('items', {
          id: id,
          name: src.name,
          categoryId: catId,
          locationId: locId,
          qty: Math.max(1, Math.round(num(src.qty) || 1)),
          price: num(src.price),
          date: src.date || '',
          note: src.note || '',
          photoIds: hasPhotos ? (src.photoIds || []) : [],
          loan: src.loan || null,
          history: src.history || [],
          createdAt: src.createdAt || Date.now(),
          updatedAt: src.updatedAt || Date.now()
        });
        added++;
        continue;
      }

      if ((num(src.updatedAt) || 0) > (num(local.updatedAt) || 0)) {
        await DB.put('items', {
          id: id,
          name: src.name,
          categoryId: catId,
          locationId: locId,
          qty: Math.max(1, Math.round(num(src.qty) || 1)),
          price: num(src.price),
          date: src.date || '',
          note: src.note || '',
          photoIds: hasPhotos ? (src.photoIds || []) : (local.photoIds || []),
          loan: src.loan || null,
          history: src.history || [],
          createdAt: local.createdAt || src.createdAt || Date.now(),
          updatedAt: src.updatedAt || Date.now()
        });
        updated++;
      } else {
        kept++;
      }
    }

    await reload();
    render();
    toast('导入完成：新增 ' + added + ' 件，更新 ' + updated + ' 件' +
      (removed ? '，删除 ' + removed + ' 件' : '') +
      (skipped ? '，跳过 ' + skipped + ' 件已删除' : ''));
  } catch (e) {
    fatal(e);
  }
}

async function restoreJSON(data) {
  try {
    await DB.clear('items');
    await DB.clear('photos');
    await DB.clear('categories');
    await DB.clear('locations');
    for (var i = 0; i < (data.categories || []).length; i++) await DB.put('categories', data.categories[i]);
    for (var j = 0; j < (data.locations || []).length; j++) await DB.put('locations', data.locations[j]);
    if (!(data.categories || []).length) await seedIfEmpty();
    await setTombstones((data.deleted && typeof data.deleted === 'object') ? data.deleted : {});
    for (var k = 0; k < data.items.length; k++) await DB.put('items', data.items[k]);
    for (var n = 0; n < (data.photos || []).length; n++) {
      var p = data.photos[n];
      try {
        var full = dataURLToBlob(p.full);
        if (!full) continue;
        await DB.put('photos', {
          id: p.id,
          itemId: p.itemId,
          createdAt: p.createdAt || Date.now(),
          full: full,
          thumb: dataURLToBlob(p.thumb || p.full) || full
        });
      } catch (e) { /* 跳过坏照片 */ }
    }
    Object.keys(urlCache).forEach(function (key) {
      try { URL.revokeObjectURL(urlCache[key]); } catch (e) { }
    });
    urlCache = {};
    await reload();
    render();
    toast('导入完成');
  } catch (e) {
    fatal(e);
  }
}

function parseCSV(text) {
  var s = String(text).replace(/^\ufeff/, '');
  var rows = [];
  var row = [];
  var cell = '';
  var quoted = false;

  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (s.charAt(i + 1) === '"') { cell += '"'; i++; }
        else quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') {
      cell += c;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter(function (r) {
    return r.some(function (x) { return String(x).trim() !== ''; });
  });
}

function importCSV(text) {
  var rows = parseCSV(text);
  if (!rows.length) { toast('文件是空的'); return; }

  var head = rows[0].map(function (h) { return String(h).trim(); });
  if (head.indexOf('名称') < 0) {
    toast('第一行要有「名称」这一列');
    return;
  }

  confirmDialog({
    title: '导入 ' + (rows.length - 1) + ' 行？',
    desc: '会追加到现有数据里，不会覆盖。分类和位置按名称自动匹配，没有的会自动新建。',
    okText: '导入'
  }).then(function (ok) {
    if (!ok) return;
    return runCSVImport(rows, head);
  }).catch(fatal);
}

async function runCSVImport(rows, head) {
  var idx = {};
  head.forEach(function (h, i) { if (idx[h] == null) idx[h] = i; });

  function cell(row, name) {
    var i = idx[name];
    if (i == null) return '';
    return String(row[i] == null ? '' : row[i]).trim();
  }

  var added = 0;
  try {
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      var name = cell(row, '名称');
      if (!name) continue;

      var catId = '';
      var cn = cell(row, '分类');
      if (cn) {
        var cat = S.cats.filter(function (x) { return x.name === cn; })[0];
        if (!cat) {
          cat = { id: uid(), name: cn, emoji: '📦', order: S.cats.length, createdAt: Date.now() };
          await DB.put('categories', cat);
          S.cats.push(cat);
        }
        catId = cat.id;
      }

      var locId = '';
      var ln = cell(row, '位置');
      if (ln) {
        var loc = S.locs.filter(function (x) { return x.name === ln; })[0];
        if (!loc) {
          loc = { id: uid(), name: ln, order: S.locs.length, createdAt: Date.now() };
          await DB.put('locations', loc);
          S.locs.push(loc);
        }
        locId = loc.id;
      }

      await DB.put('items', {
        id: uid(),
        name: name,
        categoryId: catId,
        locationId: locId,
        qty: Math.max(1, Math.round(num(cell(row, '数量')) || 1)),
        price: num(cell(row, '单价')),
        date: cell(row, '购入日期'),
        note: cell(row, '备注'),
        photoIds: [],
        loan: null,
        history: [],
        createdAt: Date.now() + r,
        updatedAt: Date.now()
      });
      added++;
    }
    await reload();
    render();
    toast('导入了 ' + added + ' 件');
  } catch (e) {
    fatal(e);
  }
}

function loadDemo() {
  confirmDialog({
    title: '载入示例数据？',
    desc: '会添加 10 件示例物品（不含照片），随时可以在设置里清空。',
    okText: '载入'
  }).then(function (ok) {
    if (!ok) return;
    var rows = [
      ['米白色羊毛大衣', '衣服', '卧室', 1, 899, '干洗，别机洗'],
      ['黑色羽绒服', '衣服', '卧室', 1, 1299, ''],
      ['白色帆布鞋', '鞋', '玄关', 2, 299, '41 码'],
      ['《史记》', '书', '书房', 1, 128, '中华书局版'],
      ['银项链', '首饰', '卧室', 1, 560, '妈妈送的'],
      ['铸铁炒锅', '厨具', '厨房', 1, 320, '已经开锅'],
      ['旧手机', '电子', '储物间', 1, 0, '备用机'],
      ['保温杯', '其他', '客厅', 3, 89, ''],
      ['折叠雨伞', '其他', '玄关', 1, 45, ''],
      ['四件套', '其他', '储物间', 2, 399, '灰色']
    ];

    var chain = Promise.resolve();
    rows.forEach(function (p, i) {
      chain = chain.then(function () {
        var cat = S.cats.filter(function (c) { return c.name === p[1]; })[0];
        var loc = S.locs.filter(function (l) { return l.name === p[2]; })[0];
        return DB.put('items', {
          id: uid(),
          name: p[0],
          categoryId: cat ? cat.id : '',
          locationId: loc ? loc.id : '',
          qty: p[3],
          price: p[4],
          date: '',
          note: p[5],
          photoIds: [],
          loan: null,
          history: [],
          createdAt: Date.now() - i * 60000,
          updatedAt: Date.now()
        });
      });
    });

    chain.then(reload).then(function () {
      render();
      toast('示例数据已载入');
    }).catch(fatal);
  }).catch(fatal);
}

function wipeAll() {
  confirmDialog({
    title: '清空所有数据？',
    desc: '会删除全部 ' + S.items.length + ' 件物品、照片、分类和位置，无法恢复。建议先导出备份。',
    okText: '清空',
    danger: true
  }).then(function (ok) {
    if (!ok) return;
    return Promise.all([
      DB.clear('items'), DB.clear('photos'), DB.clear('categories'), DB.clear('locations'), DB.clear('meta')
    ]).then(function () {
      Object.keys(urlCache).forEach(function (k) {
        try { URL.revokeObjectURL(urlCache[k]); } catch (e) { }
      });
      urlCache = {};
      return seedIfEmpty();
    }).then(reload).then(function () {
      render();
      toast('已清空');
    });
  }).catch(fatal);
}

/* ---------------- 对话框 ---------------- */

function askForm(opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    dlgState = { resolve: resolve, fields: opts.fields || [], emojiValue: opts.emojiValue || '' };

    $('#dlgTitle').textContent = opts.title || '';
    var desc = $('#dlgDesc');
    desc.textContent = opts.desc || '';
    desc.hidden = !opts.desc;

    $('#dlgBody').innerHTML = dialogBodyHTML(opts);
    $('#dlgOk').textContent = opts.okText || '确定';
    $('#dlgOk').className = 'btn solid' + (opts.danger ? ' danger' : '');
    $('#dlgCancel').hidden = !!opts.hideCancel;
    $('#dialog').hidden = false;
    syncLock();

    if ((opts.fields || []).length) {
      setTimeout(function () {
        var first = $('#dlgBody input, #dlgBody textarea');
        if (first) { try { first.focus(); } catch (e) { } }
      }, 80);
    }
  });
}

function dialogBodyHTML(opts) {
  var h = '';
  (opts.fields || []).forEach(function (f, i) {
    var val = f.value != null ? f.value : (f.type === 'date' ? todayStr() : '');
    h += '<label class="dlg-field"><span>' + esc(f.label) + '</span>';
    if (f.type === 'textarea') {
      h += '<textarea data-f="' + i + '" rows="2" placeholder="' + esc(f.placeholder || '') + '">' + esc(val) + '</textarea>';
    } else {
      h += '<input data-f="' + i + '" type="' + (f.type || 'text') + '" value="' + esc(val) + '" placeholder="' + esc(f.placeholder || '') + '">';
    }
    h += '</label>';
  });

  if (opts.emoji) {
    h += '<div class="dlg-field"><span>图标</span><div class="emoji-grid">';
    EMOJIS.forEach(function (e) {
      h += '<button type="button" class="emoji-opt' + (e === dlgState.emojiValue ? ' on' : '') + '" data-emoji="' + e + '">' + e + '</button>';
    });
    h += '</div></div>';
  }
  return h;
}

function pickEmoji(btn) {
  if (!dlgState) return;
  dlgState.emojiValue = btn.getAttribute('data-emoji');
  $$('.emoji-opt').forEach(function (b) {
    b.classList.toggle('on', b === btn);
  });
}

function dialogOk() {
  if (!dlgState) return;
  var fields = dlgState.fields;
  var out = {};

  for (var i = 0; i < fields.length; i++) {
    var el = $('#dlgBody [data-f="' + i + '"]');
    var v = el ? String(el.value || '').trim() : '';
    if (fields[i].required && !v) {
      toast('请填写「' + fields[i].label + '」');
      if (el) { try { el.focus(); } catch (e) { } }
      return;
    }
    out[fields[i].key] = v;
  }
  out.emoji = dlgState.emojiValue || '';

  var resolve = dlgState.resolve;
  dlgState = null;
  $('#dialog').hidden = true;
  syncLock();
  resolve(out);
}

function dialogCancel() {
  if (!dlgState) return;
  var resolve = dlgState.resolve;
  dlgState = null;
  $('#dialog').hidden = true;
  syncLock();
  resolve(null);
}

function confirmDialog(opts) {
  return askForm({
    title: opts.title,
    desc: opts.desc,
    okText: opts.okText,
    danger: opts.danger
  }).then(function (r) { return !!r; });
}

function showInstallHelp() {
  askForm({
    title: '怎么装到手机桌面',
    desc: '① 用手机 Chrome 打开这个网址\n② 点右上角 ⋮\n③ 选「添加到主屏幕」\n\n以后从桌面图标打开：全屏、无地址栏、断网也能看。\n\n数据只存在这台手机里。换手机、或者清理浏览器数据之前，请先到「设置 → 导出备份」。',
    okText: '知道了',
    hideCancel: true
  });
}

/* ---------------- 提示 ---------------- */

function toast(msg) {
  var t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    t.classList.remove('show');
  }, 2400);
}

function fatal(err) {
  if (window.console) console.error(err);
  var bar = $('#errbar');
  if (!bar) return;
  bar.hidden = false;
  bar.textContent = '出错了：' + (err && err.message ? err.message : String(err));
}

/* ---------------- 事件分发 ---------------- */

function onDocChange(e) {
  var t = e.target;
  if (!t || !t.id) return;
  if (t.id === 'locFilter') {
    S.loc = t.value;
    S.page = 1;
    $('#view').innerHTML = itemsHTML();
    hydrateThumbs();
  } else if (t.id === 'sortSel') {
    S.sort = t.value;
    $('#view').innerHTML = itemsHTML();
    hydrateThumbs();
  } else if (t.id === 'f-loc' && S.form) {
    S.form.locationId = t.value;
  }
}

function onDocClick(e) {
  var emojiBtn = e.target.closest('[data-emoji]');
  if (emojiBtn) { pickEmoji(emojiBtn); return; }

  var tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { switchTab(tabBtn.getAttribute('data-tab')); return; }

  var el = e.target.closest('[data-act]');
  if (!el) return;

  var act = el.getAttribute('data-act');
  var id = el.getAttribute('data-id');

  switch (act) {
    case 'add-item': openEditor(null); break;
    case 'open': openDetail(id); break;
    case 'back': closeDetail(); break;
    case 'edit': openEditor(findItem(id)); break;
    case 'del': deleteItem(id); break;
    case 'lend': lendItem(id); break;
    case 'return': returnItem(id); break;
    case 'close-sheet': closeSheet(); break;
    case 'save-item': saveForm(false); break;
    case 'save-continue': saveForm(true); break;
    case 'open-picker': openPicker(); break;
    case 'close-picker': closePicker(); break;
    case 'pick-loc': pickLoc(id); break;
    case 'toggle-more': toggleMore(); break;
    case 'new-loc-picker': newLocInline(); break;
    case 'qty-inc': changeQty(id, 1); break;
    case 'qty-dec': changeQty(id, -1); break;
    case 'filter-tag': setTagFilter(el.getAttribute('data-tag')); break;
    case 'quick-tag': appendQuickTag(el.getAttribute('data-tag')); break;
    case 'add-photo': pickPhotos(); break;
    case 'rm-photo': removePhoto(parseInt(el.getAttribute('data-i'), 10)); break;
    case 'pick-cat': pickCat(id); break;
    case 'new-cat-inline': newCatInline(); break;
    case 'new-loc-inline': newLocInline(); break;
    case 'filter-cat': setCatFilter(id); break;
    case 'clear-filter': clearFilter(); break;
    case 'load-more': S.page++; $('#view').innerHTML = itemsHTML(); hydrateThumbs(); break;
    case 'tag-mode': S.tagMode = el.getAttribute('data-mode'); render(); break;
    case 'new-tag': newTag(); break;
    case 'edit-tag': editTag(id); break;
    case 'del-tag': delTag(id); break;
    case 'how-install': showInstallHelp(); break;
    case 'export-json': exportJSON(false); break;
    case 'export-json-photos': exportJSON(true); break;
    case 'export-csv': exportCSV(); break;
    case 'csv-template': downloadCSVTemplate(); break;
    case 'import-merge': pickImport('merge'); break;
    case 'import-replace': pickImport('replace'); break;
    case 'import-csv': pickImport('csv'); break;
    case 'wipe': wipeAll(); break;
    case 'demo': loadDemo(); break;
    case 'dlg-ok': dialogOk(); break;
    case 'dlg-cancel': dialogCancel(); break;
  }
}

function newCatInline() {
  askForm({
    title: '新建分类',
    fields: [{ key: 'name', label: '名称', required: true, placeholder: '例：围巾、厨房小家电' }],
    emoji: true,
    emojiValue: '📦',
    okText: '创建'
  }).then(function (r) {
    if (!r) return;
    var cat = { id: uid(), name: r.name, emoji: r.emoji || '📦', order: S.cats.length, createdAt: Date.now() };
    return DB.put('categories', cat).then(function () {
      S.cats.push(cat);
      if (S.form) S.form.categoryId = cat.id;
      renderCatChips();
      toast('已新建分类');
    });
  }).catch(fatal);
}

function newLocInline() {
  askForm({
    title: '新建位置',
    fields: [{ key: 'name', label: '名称', required: true, placeholder: '例：卧室-衣柜-第三层' }],
    okText: '创建'
  }).then(function (r) {
    if (!r) return;
    var loc = { id: uid(), name: r.name, order: S.locs.length, createdAt: Date.now() };
    return DB.put('locations', loc).then(function () {
      S.locs.push(loc);
      if (S.form) S.form.locationId = loc.id;
      updateLocBtn();
      if (!$('#picker').hidden) $('#picker').innerHTML = pickerHTML();
      toast('已新建位置');
    });
  }).catch(fatal);
}
