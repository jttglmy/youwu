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

/* 卡片形状 */
var SHAPE_OPTIONS = [
  ['square', '方形（默认）'],
  ['book', '书脊（竖长）'],
  ['garment', '衣服（竖长）'],
  ['tall', '瘦长（瓶罐）']
];

/* 应用版本号：每次发版改这里 */
var APP_VER = '2.10';

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
  loanOnly: false,
  page: 1,
  pageSize: 60,
  form: null,
  current: null,
  ready: false,
  lsMode: false,
  recentLocs: [],
  autoCut: false,
  viewMode: 'grid',
  expanded: {},
  suppressUntil: 0
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
    .then(loadPrefs)
    .then(migrateStructure)
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
  bindLongPress();
  bindDetailSwipe();
  bindFurnitureDrag();
  bindTreeDrag();
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

/* 分类形状：square 方形 / book 书脊 / garment 衣服 / tall 瘦长 */
function catShape(id) {
  var c = S.cats.filter(function (x) { return x.id === id; })[0];
  return (c && c.shape) ? c.shape : 'square';
}

function guessShape(name) {
  var n = String(name || '');
  if (/书|册|杂志|漫画/.test(n)) return 'book';
  if (/衣|裤|裙|外套|衬衫|卫衣|毛衣|围巾|袜|内衣/.test(n)) return 'garment';
  if (/瓶|酒|香水|护肤|化妆|洗发|调料/.test(n)) return 'tall';
  return 'square';
}

function loadPrefs() {
  return DB.get('meta', 'settings').then(function (rec) {
    S.autoCut = !!(rec && rec.autoCut);
    S.viewMode = (rec && rec.viewMode === 'shelf') ? 'shelf' : 'grid';
  }).catch(function () { });
}

function savePrefs() {
  DB.put('meta', { key: 'settings', autoCut: !!S.autoCut, viewMode: S.viewMode }).catch(function () { });
}

/* 老数据没有 shape / parentId 的，补上 */
function migrateStructure() {
  var jobs = [];
  S.cats.forEach(function (c) {
    var dirty = false;
    if (!c.shape) { c.shape = guessShape(c.name); dirty = true; }
    if (c.parentId == null) { c.parentId = ''; dirty = true; }
    if (dirty) jobs.push(DB.put('categories', c));
  });
  S.locs.forEach(function (l) {
    if (l.parentId == null) { l.parentId = ''; jobs.push(DB.put('locations', l)); }
  });
  return jobs.length ? Promise.all(jobs) : null;
}

/* ---- 树结构工具 ---- */

function childrenOf(parentId, mode) {
  var list = mode === 'cat' ? S.cats : S.locs;
  return list.filter(function (x) { return (x.parentId || '') === (parentId || ''); })
    .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
}

function subtreeOf(id, mode) {
  var list = mode === 'cat' ? S.cats : S.locs;
  var out = [id];
  var stack = [id];
  while (stack.length) {
    var cur = stack.pop();
    list.forEach(function (x) {
      if ((x.parentId || '') === cur && out.indexOf(x.id) < 0) { out.push(x.id); stack.push(x.id); }
    });
  }
  return out;
}

function nodeOf(id, mode) {
  var list = mode === 'cat' ? S.cats : S.locs;
  return list.filter(function (x) { return x.id === id; })[0] || null;
}

function pathOf(id, mode) {
  var parts = [];
  var cur = anyNode(id);
  var guard = 0;
  while (cur && guard < 20) {
    parts.unshift(cur.node.name);
    cur = cur.node.parentId ? anyNode(cur.node.parentId) : null;
    guard++;
  }
  return parts.join(' › ');
}

/* ---- 跨类型：分类和位置可以互相嵌套 ---- */

function anyNode(id) {
  var c = S.cats.filter(function (x) { return x.id === id; })[0];
  if (c) return { node: c, kind: 'cat' };
  var l = S.locs.filter(function (x) { return x.id === id; })[0];
  if (l) return { node: l, kind: 'loc' };
  return null;
}

/* 某个节点下面的所有子节点（分类、位置都算） */
function childrenAny(parentId) {
  var out = [];
  S.cats.forEach(function (c) { if ((c.parentId || '') === (parentId || '')) out.push({ node: c, kind: 'cat' }); });
  S.locs.forEach(function (l) { if ((l.parentId || '') === (parentId || '')) out.push({ node: l, kind: 'loc' }); });
  out.sort(function (a, b) { return (a.node.order || 0) - (b.node.order || 0); });
  return out;
}

/* 整棵子树（跨类型），用于防环和删除 */
function subtreeAny(id) {
  var out = [id];
  var stack = [id];
  while (stack.length) {
    var cur = stack.pop();
    childrenAny(cur).forEach(function (x) {
      if (out.indexOf(x.node.id) < 0) { out.push(x.node.id); stack.push(x.node.id); }
    });
  }
  return out;
}

function countItemsUnder(id, mode, counts) {
  var ids = subtreeOf(id, mode);
  var n = 0;
  ids.forEach(function (x) { n += (counts[x] || 0); });
  return n;
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
      else if (subtreeOf(S.cat, 'cat').indexOf(it.categoryId) < 0) return false;
    }
    if (S.loc !== 'all') {
      if (S.loc === 'none') { if (it.locationId) return false; }
      else if (subtreeOf(S.loc, 'loc').indexOf(it.locationId) < 0) return false;
    }
    if (S.loanOnly && !it.loan) return false;
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
  $('#fab').hidden = !(S.tab === 'items' || S.tab === 'cats' || S.tab === 'locs');
  $$('.tab').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === S.tab);
  });

  if (S.tab === 'items') {
    view.innerHTML = itemsHTML();
    hydrateThumbs();
  } else if (S.tab === 'cats') {
    view.innerHTML = treeHTML('cat');
    hydrateThumbs();
  } else if (S.tab === 'locs') {
    view.innerHTML = treeHTML('loc');
    hydrateThumbs();
  } else {
    view.innerHTML = settingsHTML();
    showStorage();
    showVerHint();
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
  S.loanOnly = false;
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
  if (lent) {
    chips.push('<button class="chip' + (S.loanOnly ? ' on' : '') + '" data-act="filter-lent">🤝 借出中 ' + lent + '</button>');
  }

  var locOpts = ['<option value="all">全部位置</option>'].concat(S.locs.map(function (l) {
    return '<option value="' + l.id + '"' + (S.loc === l.id ? ' selected' : '') + '>' + esc(l.name) + '</option>';
  })).concat(['<option value="none"' + (S.loc === 'none' ? ' selected' : '') + '>未记位置</option>']);

  var shown = list.slice(0, S.page * S.pageSize);
  var hasFilter = S.q || S.cat !== 'all' || S.loc !== 'all' || S.tag !== 'all' || S.loanOnly;

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
    '<button class="link small" data-act="toggle-view">' + (S.viewMode === 'shelf' ? '网格' : '书架') + '</button>' +
    '<span class="result-count">' + list.length + ' 条</span>' +
    (hasFilter ? '<button class="link small" data-act="clear-filter">清除</button>' : '') + '</div>';

  if (!list.length) {
    h += '<div class="empty"><p>没有符合条件的东西</p><button class="btn ghost" data-act="clear-filter">清除筛选</button></div>';
    return h;
  }

  if (S.viewMode === 'shelf') {
    return h + shelfHTML(list);
  }

  h += '<div class="grid">' + shown.map(cardHTML).join('') + '</div>';
  if (list.length > shown.length) {
    h += '<button class="btn ghost block" data-act="load-more">加载更多（还有 ' + (list.length - shown.length) + ' 条）</button>';
  }
  return h;
}

/* ---------------- 家具视图（书架 / 衣柜 / 鞋柜 / 置物架） ---------------- */

/* 家具类型：按分类自动判断 */
function furnitureOf(cat) {
  var name = cat ? cat.name : '';
  var shape = cat ? cat.shape : 'square';
  if (/鞋|靴/.test(name)) return 'shoerack';
  if (shape === 'book' || /书|册|杂志|漫画/.test(name)) return 'bookshelf';
  if (shape === 'garment' || /衣|裤|裙|外套|卫衣|毛衣|围巾/.test(name)) return 'wardrobe';
  return 'cabinet';
}

/* 各类家具的目标高度与宽度范围 */
var FUR_H = { bookshelf: 112, wardrobe: 100, shoerack: 52, cabinet: 64 };
var FUR_W_MIN = { bookshelf: 38, wardrobe: 46, shoerack: 46, cabinet: 40 };
var FUR_W_MAX = { bookshelf: 96, wardrobe: 100, shoerack: 112, cabinet: 120 };

/* 按图片真实长宽比算出显示尺寸 */
function furSize(type, it) {
  var h = FUR_H[type] || 64;
  var r = it.ratio || 1;
  var w = Math.round(h * r);
  w = Math.max(FUR_W_MIN[type] || 40, Math.min(FUR_W_MAX[type] || 120, w));
  return { w: w, h: h };
}

function furAvailWidth() {
  var w = window.innerWidth || 390;
  return Math.min(w, 680) - 42;
}

/* 把物品按可用宽度切成若干排 */
function chunkRows(type, items) {
  var rows = [];
  var cur = [];
  var curW = 0;
  var avail = furAvailWidth();

  items.forEach(function (it) {
    var size = furSize(type, it);
    var add = size.w + 4;
    if (cur.length && curW + add > avail) {
      rows.push(cur);
      cur = [];
      curW = 0;
    }
    cur.push({ it: it, size: size });
    curW += add;
  });
  if (cur.length) rows.push(cur);
  return rows;
}

/* 找最顶层「分类」，子分类的东西也归到同一个家具里；上级是位置时停在这里 */
function rootCategoryId(catId) {
  var c = nodeOf(catId, 'cat');
  if (!c) return '';
  var guard = 0;
  while (c.parentId && guard < 20) {
    var p = nodeOf(c.parentId, 'cat');
    if (!p) break;
    c = p;
    guard++;
  }
  return c.id;
}

/* 家具里的物品：先按手工排序，再按当前排序方式 */
function furnitureItems(catId) {
  var list = S.items.filter(function (it) {
    return (rootCategoryId(it.categoryId) || '') === (catId || '');
  });
  list = list.slice().sort(function (a, b) {
    var oa = (a.order == null ? 1e15 : a.order);
    var ob = (b.order == null ? 1e15 : b.order);
    if (oa !== ob) return oa - ob;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  return list;
}

function shelfHTML(list) {
  var present = {};
  list.forEach(function (it) { present[rootCategoryId(it.categoryId) || ''] = true; });

  var order = [];
  S.cats.forEach(function (c) {
    if (!c.parentId && present[c.id]) order.push(c.id);
  });
  if (present['']) order.push('');

  var h = '';
  order.forEach(function (id) { h += furnitureHTML(id, furnitureItems(id)); });
  return h;
}

function furnitureHTML(catId, items) {
  var cat = catId ? nodeOf(catId, 'cat') : null;
  var type = furnitureOf(cat);
  var title = cat ? ((cat.emoji ? cat.emoji + ' ' : '') + cat.name) : '未分类';
  var rows = chunkRows(type, items);

  var h = '<div class="fur fur-' + type + '" data-cat="' + esc(catId) + '">';
  h += '<div class="fur-head"><b>' + esc(title) + '</b>' +
    '<span>' + items.length + ' 件 · 长按可拖动</span></div>';
  h += '<div class="fur-body">';

  rows.forEach(function (row) {
    if (type === 'wardrobe') h += '<div class="fur-rail"></div>';
    h += '<div class="fur-row">';
    row.forEach(function (cell) { h += furItemHTML(cell.it, cell.size); });
    h += '</div>';
    if (type !== 'wardrobe') h += '<div class="fur-board"></div>';
  });

  h += '</div></div>';
  return h;
}

/* ---------------- 家具里拖动排序 ---------------- */

var furDrag = null;
var furPressTimer = null;
var furPressItem = null;
var furPressX = 0;
var furPressY = 0;

function bindFurnitureDrag() {
  document.addEventListener('pointerdown', function (e) {
    if (S.viewMode !== 'shelf') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var el = e.target.closest ? e.target.closest('.fur-item') : null;
    if (!el) return;
    furPressItem = el;
    furPressX = e.clientX;
    furPressY = e.clientY;
    clearTimeout(furPressTimer);
    furPressTimer = setTimeout(function () {
      startFurDrag(furPressX, furPressY);
    }, 300);
  }, { passive: true });

  document.addEventListener('pointermove', function (e) {
    if (!furPressItem) return;
    if (!furDrag) {
      if (Math.abs(e.clientX - furPressX) > 8 || Math.abs(e.clientY - furPressY) > 8) {
        clearTimeout(furPressTimer);
      }
      return;
    }
    if (e.cancelable) e.preventDefault();
    moveFurGhost(e.clientX, e.clientY);
    markFurDrop(e.clientX, e.clientY);
  }, { passive: false });

  document.addEventListener('pointerup', function (e) {
    clearTimeout(furPressTimer);
    furPressItem = null;
    if (furDrag) endFurDrag(e.clientX, e.clientY);
  });

  document.addEventListener('pointercancel', function () {
    clearTimeout(furPressTimer);
    furPressItem = null;
    cancelFurDrag();
  });
}

function startFurDrag(px, py) {
  if (!furPressItem) return;
  var el = furPressItem;
  var rect = el.getBoundingClientRect();
  var ghost = el.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.classList.remove('drag-source');
  ghost.style.width = rect.width + 'px';
  ghost.style.left = (px - rect.width / 2) + 'px';
  ghost.style.top = (py - rect.height / 2) + 'px';
  document.body.appendChild(ghost);
  el.classList.add('drag-source');
  furDrag = { id: el.getAttribute('data-id'), el: el, ghost: ghost, w: rect.width, h: rect.height };
  try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { }
}

function moveFurGhost(px, py) {
  if (!furDrag) return;
  furDrag.ghost.style.left = (px - furDrag.w / 2) + 'px';
  furDrag.ghost.style.top = (py - furDrag.h / 2) + 'px';
}

function clearFurDrop() {
  $$('.fur-item.drop-target').forEach(function (el) { el.classList.remove('drop-target'); });
}

function markFurDrop(px, py) {
  clearFurDrop();
  var over = document.elementFromPoint(px, py);
  var item = over && over.closest ? over.closest('.fur-item') : null;
  if (item && item !== furDrag.el) item.classList.add('drop-target');
}

function cancelFurDrag() {
  if (!furDrag) return;
  furDrag.ghost.remove();
  furDrag.el.classList.remove('drag-source');
  clearFurDrop();
  furDrag = null;
}

function endFurDrag(px, py) {
  var d = furDrag;
  if (!d) return;

  var over = document.elementFromPoint(px, py);
  var targetItem = over && over.closest ? over.closest('.fur-item') : null;
  var targetFur = over && over.closest ? over.closest('.fur') : null;

  d.ghost.remove();
  clearFurDrop();
  furDrag = null;
  S.suppressUntil = Date.now() + 350;

  if (!targetFur) { d.el.classList.remove('drag-source'); return; }

  var targetCat = targetFur.getAttribute('data-cat') || '';
  var dragItem = findItem(d.id);
  if (!dragItem) { d.el.classList.remove('drag-source'); return; }

  var oldRoot = rootCategoryId(dragItem.categoryId) || '';
  var list = furnitureItems(targetCat).filter(function (x) { return x.id !== dragItem.id; });

  var insertIndex = list.length;
  if (targetItem && targetItem !== d.el) {
    var tid = targetItem.getAttribute('data-id');
    var idx = -1;
    list.forEach(function (x, i) { if (x.id === tid) idx = i; });
    if (idx >= 0) {
      var r = targetItem.getBoundingClientRect();
      insertIndex = (px > r.left + r.width / 2) ? idx + 1 : idx;
    }
  }

  list.splice(insertIndex, 0, dragItem);

  var jobs = [];
  list.forEach(function (it, i) {
    it.order = i + 1;
    if (it.id === dragItem.id) it.categoryId = targetCat;
    it.updatedAt = Date.now();
    jobs.push(DB.put('items', it));
  });

  Promise.all(jobs).then(reload).then(function () {
    render();
    if (oldRoot !== targetCat) {
      toast('已移到「' + (targetCat ? catName(targetCat) : '未分类') + '」第 ' + (insertIndex + 1) + ' 位');
    } else {
      toast('已调整到第 ' + (insertIndex + 1) + ' 位');
    }
  }).catch(fatal);
}

/* 按图片重算长宽比（老数据用） */
function recalcRatios() {
  var todo = S.items.filter(function (it) {
    return it.photoIds && it.photoIds.length && !it.ratio;
  });
  if (!todo.length) { toast('长宽比都是最新的'); return; }

  toast('正在按图片重算…');
  var chain = Promise.resolve();
  todo.forEach(function (it) {
    chain = chain.then(function () {
      return DB.get('photos', it.photoIds[0]).then(function (p) {
        if (!p || !p.w || !p.h) return null;
        it.ratio = Math.max(0.35, Math.min(2.4, p.w / p.h));
        return DB.put('items', it);
      }).catch(function () { });
    });
  });
  chain.then(reload).then(function () {
    render();
    toast('已重算 ' + todo.length + ' 件');
  }).catch(fatal);
}

function furItemHTML(it, size) {
  var pid = (it.photoIds || [])[0];
  var s = size || furSize('cabinet', it);
  var h = '<button class="fur-item" data-act="open" data-id="' + it.id + '" style="width:' + s.w + 'px">';
  h += '<span class="fur-photo"' + (pid ? ' data-photo="' + pid + '"' : '') +
    ' style="width:' + s.w + 'px;height:' + s.h + 'px">' +
    (pid ? '' : esc(catEmoji(it.categoryId))) + '</span>';
  h += '<span class="fur-name">' + esc(it.name) + '</span>';
  h += '</button>';
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
  var shape = catShape(it.categoryId);
  var h = '<button class="card" data-act="open" data-id="' + it.id + '">';
  h += '<div class="thumb shape-' + shape + '"' + (pid ? ' data-photo="' + pid + '"' : '') + '>' +
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

/* 统计页已移除：件数/总价值保留在物品页顶部，借出中改为筛选项 */

/* ---------------- 分类 / 位置 ---------------- */

function treeHTML(mode) {
  var catCounts = {};
  var locCounts = {};
  S.items.forEach(function (i) {
    if (i.categoryId) catCounts[i.categoryId] = (catCounts[i.categoryId] || 0) + 1;
    if (i.locationId) locCounts[i.locationId] = (locCounts[i.locationId] || 0) + 1;
  });
  var counts = { cat: catCounts, loc: locCounts };

  var h = '<p class="hint">' +
    (mode === 'cat'
      ? '点一下看这类物品；箭头展开小分类；「＋」在它下面建小分类。长按可改名、换上级。'
      : '位置是骨架：卧室 › 书架 › 第三层。「＋」建子位置，也可以把分类拖进来（卧室 › 书架 › 书）。') +
    '</p>';

  h += '<div class="tag-list">';
  var roots = treeRoots(mode);

  if (!roots.length) h += '<p class="hint">还没有' + (mode === 'cat' ? '分类' : '位置') + '。</p>';
  roots.forEach(function (entry) { h += tagRowHTML(entry, 0, mode, counts); });
  h += '</div>';

  h += '<button class="btn ghost block" data-act="new-tag" data-mode="' + mode + '">＋ 新建' +
    (mode === 'cat' ? '分类' : '位置') + '</button>';
  return h;
}

/* 位置页的根：没有位置上级的位置；分类页的根：没有分类上级的分类 */
function treeRoots(mode) {
  var out;
  if (mode === 'loc') {
    out = S.locs.filter(function (l) { return !l.parentId || !nodeOf(l.parentId, 'loc'); })
      .map(function (l) { return { node: l, kind: 'loc' }; });
  } else {
    out = S.cats.filter(function (c) { return !c.parentId || !nodeOf(c.parentId, 'cat'); })
      .map(function (c) { return { node: c, kind: 'cat' }; });
  }
  out.sort(function (a, b) { return (a.node.order || 0) - (b.node.order || 0); });
  return out;
}

/* 这个位置 / 分类里直接放的物品 */
function nodeItems(kind, id) {
  return S.items.filter(function (it) {
    return (kind === 'cat' ? it.categoryId : it.locationId) === id;
  });
}

function itemsStripHTML(kind, id, depth) {
  var items = nodeItems(kind, id);
  if (!items.length) return '';

  var pad = 8 + (depth || 0) * 22 + 30;
  var h = '<div class="loc-items" style="padding-left:' + pad + 'px">';
  items.forEach(function (it) {
    var pid = (it.photoIds || [])[0];
    h += '<button class="loc-item" data-act="open" data-id="' + it.id + '">' +
      '<span class="loc-thumb"' + (pid ? ' data-photo="' + pid + '"' : '') + '>' +
      (pid ? '' : esc(catEmoji(it.categoryId))) + '</span>' +
      '<span class="loc-name">' + esc(it.name) + '</span></button>';
  });
  h += '<button class="loc-item loc-add" data-act="add-here" data-kind="' + kind + '" data-id="' + id + '">' +
    '<span class="loc-thumb loc-plus">＋</span><span class="loc-name">添加</span></button>';
  h += '</div>';
  return h;
}

/* 位置可以包含位置和分类；分类只包含分类 */
function treeKids(kind, id) {
  if (kind === 'loc') return childrenAny(id);
  return S.cats.filter(function (c) { return (c.parentId || '') === id; })
    .sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
    .map(function (c) { return { node: c, kind: 'cat' }; });
}

/* ---------------- 分类/位置 长按拖动调整顺序 ---------------- */

var treeDrag = null;
var treeTimer = null;
var treePressEl = null;
var treeX = 0;
var treeY = 0;

function bindTreeDrag() {
  document.addEventListener('pointerdown', function (e) {
    if (S.tab !== 'cats' && S.tab !== 'locs') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest && e.target.closest('button')) return;
    var row = e.target.closest ? e.target.closest('.tag-row') : null;
    if (!row) return;
    treePressEl = row;
    treeX = e.clientX;
    treeY = e.clientY;
    clearTimeout(treeTimer);
    treeTimer = setTimeout(function () { startTreeDrag(treeX, treeY); }, 350);
  }, { passive: true });

  document.addEventListener('pointermove', function (e) {
    if (!treePressEl) return;
    if (!treeDrag) {
      if (Math.abs(e.clientX - treeX) > 8 || Math.abs(e.clientY - treeY) > 8) clearTimeout(treeTimer);
      return;
    }
    if (e.cancelable) e.preventDefault();
    moveTreeGhost(e.clientX, e.clientY);
    markTreeDrop(e.clientX, e.clientY);
  }, { passive: false });

  document.addEventListener('pointerup', function (e) {
    clearTimeout(treeTimer);
    treePressEl = null;
    if (treeDrag) endTreeDrag(e.clientX, e.clientY);
  });

  document.addEventListener('pointercancel', function () {
    clearTimeout(treeTimer);
    treePressEl = null;
    cancelTreeDrag();
  });
}

function startTreeDrag(px, py) {
  if (!treePressEl) return;
  var el = treePressEl;
  var rect = el.getBoundingClientRect();
  var ghost = el.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.classList.remove('drag-source');
  ghost.style.width = rect.width + 'px';
  ghost.style.left = (px - rect.width / 2) + 'px';
  ghost.style.top = (py - rect.height / 2) + 'px';
  document.body.appendChild(ghost);
  el.classList.add('drag-source');
  treeDrag = {
    id: el.getAttribute('data-id'),
    kind: el.getAttribute('data-kind'),
    el: el,
    ghost: ghost,
    w: rect.width,
    h: rect.height
  };
  try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { }
}

function moveTreeGhost(px, py) {
  if (!treeDrag) return;
  treeDrag.ghost.style.left = (px - treeDrag.w / 2) + 'px';
  treeDrag.ghost.style.top = (py - treeDrag.h / 2) + 'px';
}

function clearTreeDrop() {
  $$('.tag-row.drop-target').forEach(function (el) { el.classList.remove('drop-target'); });
}

function markTreeDrop(px, py) {
  clearTreeDrop();
  var over = document.elementFromPoint(px, py);
  var row = over && over.closest ? over.closest('.tag-row') : null;
  if (row && row !== treeDrag.el && row.getAttribute('data-kind') === treeDrag.kind) {
    row.classList.add('drop-target');
  }
}

function cancelTreeDrag() {
  if (!treeDrag) return;
  treeDrag.ghost.remove();
  treeDrag.el.classList.remove('drag-source');
  clearTreeDrop();
  treeDrag = null;
}

function endTreeDrag(px, py) {
  var d = treeDrag;
  if (!d) return;

  var over = document.elementFromPoint(px, py);
  var targetRow = over && over.closest ? over.closest('.tag-row') : null;

  d.ghost.remove();
  clearTreeDrop();
  treeDrag = null;
  S.suppressUntil = Date.now() + 350;

  d.el.classList.remove('drag-source');
  if (!targetRow || targetRow === d.el) return;

  var targetKind = targetRow.getAttribute('data-kind');
  var dragged = nodeOf(d.id, d.kind);
  var target = nodeOf(targetRow.getAttribute('data-id'), targetKind);
  if (!dragged || !target) return;

  // 位置只能放进位置；分类可以放进位置，也可以放进分类
  if (d.kind === 'loc' && targetKind === 'cat') {
    toast('位置只能放在位置下面');
    return;
  }

  // 分类拖到位置上 → 直接放进这个位置（卧室 › 书架 › 书）
  if (d.kind === 'cat' && targetKind === 'loc') {
    dragged.parentId = target.id;
    dragged.order = childrenAny(target.id).filter(function (x) { return x.node.id !== dragged.id; }).length;
    DB.put('categories', dragged).then(reload).then(function () {
      S.expanded['loc:' + target.id] = true;
      render();
      toast('已把「' + dragged.name + '」放进「' + target.name + '」');
    }).catch(fatal);
    return;
  }

  var kind = d.kind;
  var store = kind === 'cat' ? 'categories' : 'locations';

  // 不能拖到自己的子孙下面
  if (subtreeOf(dragged.id, kind).indexOf(target.id) >= 0) {
    toast('不能放到它自己的子项下面');
    return;
  }

  var parentId = target.parentId || '';
  var siblings = childrenOf(parentId, kind).filter(function (x) { return x.id !== dragged.id; });

  var idx = -1;
  siblings.forEach(function (x, i) { if (x.id === target.id) idx = i; });
  if (idx < 0) idx = siblings.length;

  var r = targetRow.getBoundingClientRect();
  var after = py > r.top + r.height / 2;
  var insertAt = after ? idx + 1 : idx;

  siblings.splice(insertAt, 0, dragged);
  dragged.parentId = parentId;

  var jobs = [];
  siblings.forEach(function (x, i) {
    if (x.order === i) return;
    x.order = i;
    jobs.push(DB.put(store, x));
  });
  if (!jobs.length) jobs.push(DB.put(store, dragged));

  Promise.all(jobs).then(reload).then(function () {
    S.expanded[kind + ':' + parentId] = true;
    render();
    toast('已移到「' + (parentId ? nodeOf(parentId, kind).name : '最外层') + '」第 ' + (insertAt + 1) + ' 位');
  }).catch(fatal);
}

function tagRowHTML(entry, depth, mode, counts) {
  var t = entry.node;
  var kind = entry.kind;
  var kids = treeKids(kind, t.id);
  var key = kind + ':' + t.id;
  var open = !!S.expanded[key];
  var active = kind === 'cat' ? (S.cat === t.id) : (S.loc === t.id);

  var h = '<div class="tag-row' + (active ? ' active' : '') + '"' +
    ' data-longpress="1" data-kind="' + kind + '" data-id="' + t.id + '"' +
    ' data-act="go-tag" data-tag="' + t.id + '" data-mode="' + kind + '"' +
    ' style="padding-left:' + (8 + depth * 22) + 'px">';

  h += '<span class="tag-caret' + (kids.length ? '' : ' blank') + '"' +
    (kids.length ? ' data-act="toggle-node" data-key="' + key + '"' : '') + '>' +
    (kids.length ? (open ? '▾' : '▸') : '') + '</span>';

  h += '<span class="tag-emoji">' + esc(kind === 'cat' ? (t.emoji || '🏷️') : '📍') + '</span>';
  h += '<span class="tag-name">' + esc(t.name) + '</span>';
  if (kind === 'cat' && t.parentId && !nodeOf(t.parentId, 'cat')) {
    h += '<span class="tag-inloc">📍 ' + esc(pathOf(t.parentId)) + '</span>';
  }
  h += '<span class="tag-count">' + countItemsUnder(t.id, kind, counts[kind] || {}) + '</span>';
  h += '<button class="tag-add" data-act="new-child" data-kind="' + kind + '" data-id="' + t.id + '" aria-label="在这里新建">＋</button>';
  h += '<button class="tag-del" data-act="del-tag" data-id="' + t.id + '" data-kind="' + kind + '">✕</button>';
  h += '</div>';

  if (open) {
    h += itemsStripHTML(kind, t.id, depth);
    kids.forEach(function (k) { h += tagRowHTML(k, depth + 1, mode, counts); });
  }
  return h;
}

function parentOptions(mode, excludeId) {
  var banned = excludeId ? subtreeAny(excludeId) : [];
  var opts = [['', '（顶层）']];
  var all = [];

  if (mode === 'cat') {
    S.cats.forEach(function (c) { all.push({ node: c, kind: 'cat' }); });
    S.locs.forEach(function (l) { all.push({ node: l, kind: 'loc' }); });
  } else {
    S.locs.forEach(function (l) { all.push({ node: l, kind: 'loc' }); });
  }

  all.filter(function (x) { return banned.indexOf(x.node.id) < 0; })
    .sort(function (a, b) { return pathOf(a.node.id).localeCompare(pathOf(b.node.id), 'zh-CN'); })
    .forEach(function (x) {
      opts.push([x.node.id, (x.kind === 'cat' ? '🏷️ ' : '📍 ') + pathOf(x.node.id)]);
    });
  return opts;
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
    '<p><b>有物</b> v' + APP_VER + '</p>' +
    '<p class="hint">把你拥有的每一件东西，都记下来。</p>' +
    '<p class="hint" id="verHint"></p>' +
    '<button class="btn ghost block" data-act="force-update">强制更新到最新版</button>' +
    '<p class="hint">只清网页缓存，不会动你的物品数据。</p>' +
    '<button class="btn ghost block" data-act="recalc-ratio">按图片重算卡片比例</button></div>';
  return h;
}

function showVerHint() {
  var el = $('#verHint');
  if (!el) return;
  var mode = '';
  try { mode = DB.mode() === 'ls' ? '浏览器缓存（容量小）' : '浏览器数据库'; } catch (e) { }
  el.textContent = '版本 ' + APP_VER + (mode ? ' · 数据存储：' + mode : '');
}

/* 清掉网页缓存与旧 Service Worker，然后重载；不碰物品数据 */
function forceUpdate() {
  toast('正在清理缓存…');
  var jobs = [];
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistrations) {
      jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.unregister(); }));
      }).catch(function () { }));
    }
  } catch (e) { }
  try {
    if (window.caches && window.caches.keys) {
      jobs.push(caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }).catch(function () { }));
    }
  } catch (e) { }

  Promise.all(jobs).then(function () {
    setTimeout(function () { location.reload(); }, 400);
  });
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

  var navList = navListFor(it);
  S.navIds = navList.map(function (x) { return x.id; });
  S.navIndex = S.navIds.indexOf(it.id);
  if (S.navIndex < 0) { S.navIds = [it.id]; S.navIndex = 0; }

  var cat = S.cats.filter(function (c) { return c.id === it.categoryId; })[0];
  var loc = S.locs.filter(function (l) { return l.id === it.locationId; })[0];
  var photos = it.photoIds || [];
  var tg = tagsOf(it);

  var h = '';
  h += '<div class="detail-bar">' +
    '<button class="back-btn" data-act="back" aria-label="返回">←</button>' +
    '<span class="detail-title">' + esc(it.name) + '</span>' +
    '<button class="link" data-act="edit" data-id="' + it.id + '">编辑</button>' +
    '</div>';

  h += '<div class="detail-scroll">';

  if (photos.length) {
    h += '<div class="gallery compact shape-' + catShape(it.categoryId) + '">' + photos.map(function (pid) {
      return '<div class="gallery-item" data-gphoto="' + pid + '"></div>';
    }).join('') + '</div>';
  } else {
    h += '<div class="gallery compact empty">' + esc(cat && cat.emoji ? cat.emoji : '📦') + '</div>';
  }

  h += '<div class="detail-head">';
  h += '<h2>' + esc(it.name) + '</h2>';
  h += '<div class="pills">' +
    '<span class="pill">' + esc(cat ? ((cat.emoji ? cat.emoji + ' ' : '') + cat.name) : '未分类') + '</span>';
  tg.forEach(function (t) {
    h += '<button class="pill tag-pill" data-act="filter-tag" data-tag="' + esc(t) + '">#' + esc(t) + '</button>';
  });
  h += '</div>';
  if (loc) h += '<p class="detail-loc">📍 ' + esc(loc.name) + '</p>';
  h += '</div>';

  h += '<div class="detail-actions">' +
    '<div class="qty-mini">' +
    '<button data-act="qty-dec" data-id="' + it.id + '" aria-label="减一件">−</button>' +
    '<span>' + qtyOf(it) + '</span>' +
    '<button data-act="qty-inc" data-id="' + it.id + '" aria-label="加一件">＋</button>' +
    '</div>' +
    '<button class="loan-chip' + (it.loan ? ' lent' : '') + '" data-act="' + (it.loan ? 'return' : 'lend') + '" data-id="' + it.id + '">' +
    (it.loan ? '借出 ' + daysOut(it) + ' 天' : '在库') +
    '</button>' +
    '</div>';

  h += '<button class="more-toggle" data-act="toggle-detail-more">更多信息（价格 / 日期 / 备注 / 借出记录）</button>';

  h += '<div id="detailMore" class="detail-more" hidden>';
  h += '<div class="fields">';
  if (num(it.price) > 0) {
    h += '<div><dt>单价</dt><dd>' + money(it.price) + '</dd></div>';
    h += '<div><dt>合计</dt><dd>' + money(num(it.price) * qtyOf(it)) + '</dd></div>';
  }
  if (it.date) h += '<div><dt>购入日期</dt><dd>' + esc(it.date) + '</dd></div>';
  h += '<div><dt>添加时间</dt><dd>' + fmtDay(it.createdAt) + '</dd></div>';
  h += '</div>';

  if (it.note) h += '<p class="note">' + esc(it.note) + '</p>';

  if (it.loan) {
    h += '<p class="loan-line">已借给 <b>' + esc(it.loan.to) + '</b>，' + esc(it.loan.since || '—') +
      (it.loan.note ? '　备注：' + esc(it.loan.note) : '') + '</p>';
  }

  if (it.history && it.history.length) {
    h += '<h3 class="sec">借出记录</h3><ul class="hist">';
    it.history.forEach(function (x) {
      h += '<li>借给 <b>' + esc(x.to) + '</b> · ' + esc(x.since || '') + ' → ' + esc(x.back || '未还') +
        (x.note ? ' · ' + esc(x.note) : '') + '</li>';
    });
    h += '</ul>';
  }
  h += '</div>';

  h += '</div>';

  h += '<div class="detail-nav">' +
    '<button class="nav-btn" data-act="prev-item"' + (S.navIds.length <= 1 ? ' disabled' : '') + '>‹ 上一件</button>' +
    '<span class="nav-pos">' + (S.navIndex + 1) + ' / ' + S.navIds.length + '</span>' +
    '<button class="nav-btn" data-act="next-item"' + (S.navIds.length <= 1 ? ' disabled' : '') + '>下一件 ›</button>' +
    '</div>';

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

function openEditor(item, preset) {
  var f;
  if (item) {
    f = JSON.parse(JSON.stringify(item));
  } else {
    var defCat = (preset && preset.categoryId) ||
      ((S.cat && S.cat !== 'all' && S.cat !== 'none') ? S.cat : '');
    var defLoc = (preset && preset.locationId) ||
      ((S.loc && S.loc !== 'all' && S.loc !== 'none') ? S.loc : '');
    f = {
      id: '', name: '', categoryId: defCat, locationId: defLoc, qty: 1, price: '',
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
    return Promise.all([getPhotoUrl(pid, 'full'), getPhotoUrl(pid, 'thumb'), DB.get('photos', pid)]).then(function (res) {
      var urls = [res[0], res[1]];
      var rec = res[2] || {};
      if (!urls[0] && !urls[1]) return null;
      return { id: pid, isNew: false, url: urls[0], thumbUrl: urls[1], w: rec.w, h: rec.h };
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

  h += '<label class="cut-toggle"><input type="checkbox" id="autoCut"' + (S.autoCut ? ' checked' : '') + '>' +
    '<span>自动去掉背景（纯色背景效果最好）</span></label>';

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
  } else {
    h += '<button type="button" class="btn ghost danger block" data-act="del-from-editor" data-id="' + f.id + '">删除这件东西</button>';
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
    var parentPath = l.parentId ? pathOf(l.parentId, 'loc') + ' · ' : '';
    return '<button class="loc-tile' + (l.id === cur ? ' on' : '') + '" data-act="pick-loc" data-id="' + l.id + '">' +
      '<b>' + esc(l.name) + '</b>' +
      '<span>' + esc(parentPath) + (counts[l.id] || 0) + ' 件</span>' +
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
  var sorted = S.cats.slice().sort(function (a, b) {
    return pathOf(a.id, 'cat').localeCompare(pathOf(b.id, 'cat'), 'zh-CN');
  });
  var h = sorted.map(function (c) {
    var nested = !!c.parentId;
    return '<button type="button" class="chip' + (f.categoryId === c.id ? ' on' : '') + (nested ? ' nested' : '') + '" data-act="pick-cat" data-id="' + c.id + '">' +
      esc(c.emoji || '') + ' ' + (nested ? '↳ ' : '') + esc(c.name) + '</button>';
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

/* 上一件/下一件 的候选范围：不跨分类 */
function navListFor(it) {
  var list;

  if (S.q.trim() || S.cat !== 'all' || S.loanOnly) {
    list = filteredItems();
  } else {
    list = S.items.filter(function (x) {
      if ((x.categoryId || '') !== (it.categoryId || '')) return false;
      if (S.loc !== 'all') {
        if (S.loc === 'none') { if (x.locationId) return false; }
        else if (subtreeOf(S.loc, 'loc').indexOf(x.locationId) < 0) return false;
      }
      if (S.tag !== 'all' && tagsOf(x).indexOf(S.tag) < 0) return false;
      return true;
    });
    list.sort(sortComparator(S.sort));
  }

  if (!list.length) list = [it];
  return list;
}

/* 上下件切换（首尾循环） */
function navItem(delta) {
  var n = S.navIds ? S.navIds.length : 0;
  if (!n || n <= 1) return;

  var next = (S.navIndex + delta + n) % n;
  openDetail(S.navIds[next]);

  var sc = $('#detail .detail-scroll');
  if (sc) {
    sc.scrollTop = 0;
    sc.classList.remove('slide-left', 'slide-right');
    void sc.offsetWidth;
    sc.classList.add(delta > 0 ? 'slide-left' : 'slide-right');
    setTimeout(function () { sc.classList.remove('slide-left', 'slide-right'); }, 260);
  }
}

/* 详情页左右滑动切换：跟手触发，不需要滑很远 */
function bindDetailSwipe() {
  var el = document.getElementById('detail');
  if (!el) return;
  var startX = 0, startY = 0, tracking = false;

  function galleryScrolls(target) {
    var g = target && target.closest ? target.closest('.gallery') : null;
    if (!g) return false;
    return g.scrollWidth > g.clientWidth + 8;
  }

  el.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { tracking = false; return; }
    if (e.target.closest && e.target.closest('button')) { tracking = false; return; }
    if (galleryScrolls(e.target)) { tracking = false; return; }
    tracking = true;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  el.addEventListener('touchmove', function (e) {
    if (!tracking) return;
    var dx = e.touches[0].clientX - startX;
    var dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.25) {
      tracking = false;
      navItem(dx < 0 ? 1 : -1);
    }
  }, { passive: true });

  el.addEventListener('touchend', function () { tracking = false; }, { passive: true });
  el.addEventListener('touchcancel', function () { tracking = false; }, { passive: true });
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

function canvasToBlob(canvas, quality, type) {
  return new Promise(function (resolve, reject) {
    canvas.toBlob(function (b) {
      if (b) resolve(b);
      else reject(new Error('压缩失败'));
    }, type || 'image/jpeg', quality);
  });
}

function scaleCanvas(src, max) {
  var s = Math.min(1, max / Math.max(src.width, src.height));
  var w = Math.max(1, Math.round(src.width * s));
  var h = Math.max(1, Math.round(src.height * s));
  var c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  return c;
}

/* 简易抠图：取四边中位色当背景，从边缘做区域填充去掉相近颜色 */
function cutoutCanvas(img, max) {
  var w0 = img.naturalWidth || img.width;
  var h0 = img.naturalHeight || img.height;
  var s = Math.min(1, max / Math.max(w0, h0));
  var w = Math.max(1, Math.round(w0 * s));
  var h = Math.max(1, Math.round(h0 * s));

  var canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  var ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);

  var imageData;
  try { imageData = ctx.getImageData(0, 0, w, h); } catch (e) { return null; }
  var data = imageData.data;

  var rs = [], gs = [], bs = [];
  function push(x, y) {
    var i = (y * w + x) * 4;
    rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
  }
  for (var x = 0; x < w; x += 2) { push(x, 0); push(x, h - 1); }
  for (var y = 0; y < h; y += 2) { push(0, y); push(w - 1, y); }
  if (!rs.length) return null;

  function median(arr) {
    arr.sort(function (a, b) { return a - b; });
    return arr[Math.floor(arr.length / 2)];
  }
  var bgR = median(rs), bgG = median(gs), bgB = median(bs);

  var tol = 52 * 52;
  var visited = new Uint8Array(w * h);
  var stack = [];

  function consider(x, y) {
    var p = y * w + x;
    if (visited[p]) return;
    var i = p * 4;
    var dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB;
    if (dr * dr + dg * dg + db * db > tol) return;
    visited[p] = 1;
    stack.push(p);
  }

  for (var x2 = 0; x2 < w; x2++) { consider(x2, 0); consider(x2, h - 1); }
  for (var y2 = 0; y2 < h; y2++) { consider(0, y2); consider(w - 1, y2); }

  while (stack.length) {
    var p = stack.pop();
    var px = p % w;
    var py = (p - px) / w;
    if (px > 0) consider(px - 1, py);
    if (px < w - 1) consider(px + 1, py);
    if (py > 0) consider(px, py - 1);
    if (py < h - 1) consider(px, py + 1);
  }

  var removed = 0;
  for (var q = 0; q < w * h; q++) {
    if (visited[q]) { data[q * 4 + 3] = 0; removed++; }
  }

  // 背景几乎没去掉（说明背景不纯），放弃抠图，避免把整张图毁掉
  if (removed < w * h * 0.03) return null;
  // 去掉太多（超过 92%），说明主体和背景一个颜色，也放弃
  if (removed > w * h * 0.92) return null;

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function processImage(file) {
  return loadBitmap(file).then(function (img) {
    if (S.autoCut) {
      var cut = cutoutCanvas(img, 1600);
      if (cut) {
        var thumbCanvas = scaleCanvas(cut, 480);
        return Promise.all([
          canvasToBlob(cut, 0.85, 'image/webp'),
          canvasToBlob(thumbCanvas, 0.8, 'image/webp')
        ]).then(function (arr) {
          return {
            full: arr[0],
            thumb: arr[1],
            w: cut.width,
            h: cut.height,
            url: URL.createObjectURL(arr[0]),
            thumbUrl: URL.createObjectURL(arr[1]),
            isNew: true
          };
        });
      }
    }
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

  var ratio = 1;
  var firstPhoto = (f.photos && f.photos[0]) || null;
  if (firstPhoto && firstPhoto.w && firstPhoto.h) ratio = firstPhoto.w / firstPhoto.h;
  else if (f.ratio) ratio = f.ratio;
  ratio = Math.max(0.35, Math.min(2.4, ratio));

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
    ratio: ratio,
    order: f.order,
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

function newTag(modeArg, parentArg) {
  var mode = modeArg || S.tagMode;
  var fields = [{
    key: 'name',
    label: '名称',
    required: true,
    placeholder: mode === 'cat' ? '例：外套、厨房小家电' : '例：衣柜、抽屉、书架'
  }, {
    key: 'parentId',
    label: '放在哪个下面',
    type: 'select',
    options: parentOptions(mode, ''),
    value: parentArg || ''
  }];
  if (mode === 'cat') {
    fields.push({ key: 'shape', label: '卡片形状', type: 'select', options: SHAPE_OPTIONS, value: 'square' });
  }

  askForm({
    title: mode === 'cat' ? '新建分类' : '新建位置',
    fields: fields,
    emoji: mode === 'cat',
    emojiValue: '📦',
    okText: '创建'
  }).then(function (r) {
    if (!r) return;
    var rec = {
      id: uid(),
      name: r.name,
      parentId: r.parentId || '',
      order: mode === 'cat' ? S.cats.length : S.locs.length,
      createdAt: Date.now()
    };
    if (mode === 'cat') {
      rec.emoji = r.emoji || '📦';
      rec.shape = r.shape || guessShape(r.name);
    }
    return DB.put(mode === 'cat' ? 'categories' : 'locations', rec).then(reload).then(function () {
      if (rec.parentId) S.expanded[mode + ':' + rec.parentId] = true;
      render();
      toast('已创建');
    });
  }).catch(fatal);
}

function editTag(id, modeArg) {
  var mode = modeArg || S.tagMode;
  var t = nodeOf(id, mode);
  if (!t) return;

  var fields = [
    { key: 'name', label: '名称', value: t.name, required: true },
    { key: 'parentId', label: '上级', type: 'select', options: parentOptions(mode, id), value: t.parentId || '' }
  ];
  if (mode === 'cat') {
    fields.push({ key: 'shape', label: '卡片形状', type: 'select', options: SHAPE_OPTIONS, value: t.shape || 'square' });
  }

  askForm({
    title: '编辑' + (mode === 'cat' ? '分类' : '位置'),
    fields: fields,
    emoji: mode === 'cat',
    emojiValue: t.emoji || '📦',
    okText: '保存'
  }).then(function (r) {
    if (!r) return;
    t.name = r.name;
    t.parentId = r.parentId || '';
    if (mode === 'cat' && r.emoji) t.emoji = r.emoji;
    if (mode === 'cat' && r.shape) t.shape = r.shape;
    return DB.put(mode === 'cat' ? 'categories' : 'locations', t).then(reload).then(function () {
      var placed = (mode === 'cat' && t.parentId && !nodeOf(t.parentId, 'cat'));
      if (placed) S.expanded['loc:' + t.parentId] = true;
      render();
      toast(placed ? '已放进「' + pathOf(t.parentId) + '」，到「位置」页展开就能看到' : '已保存');
    });
  }).catch(fatal);
}

function delTag(id, modeArg) {
  var mode = modeArg || S.tagMode;
  var t = nodeOf(id, mode);
  if (!t) return;
  var kids = childrenOf(id, mode);

  confirmDialog({
    title: '删除「' + t.name + '」？',
    desc: (mode === 'cat'
      ? '这个分类下的物品不会删除，会变成「未分类」。'
      : '用了这个位置的物品不会删除，会变成「未记位置」。') +
      (kids.length ? '它的 ' + kids.length + ' 个子' + (mode === 'cat' ? '分类' : '位置') + '会移到上一层。' : ''),
    okText: '删除',
    danger: true
  }).then(function (ok) {
    if (!ok) return;
    var store = mode === 'cat' ? 'categories' : 'locations';
    var key = mode === 'cat' ? 'categoryId' : 'locationId';
    var chain = Promise.resolve();

    kids.forEach(function (k) {
      k.parentId = t.parentId || '';
      chain = chain.then(function () { return DB.put(store, k); });
    });

    S.items.forEach(function (it) {
      if (it[key] !== id) return;
      it[key] = '';
      it.updatedAt = Date.now();
      chain = chain.then(function () { return DB.put('items', it); });
    });

    chain = chain.then(function () { return DB.del(store, id); });

    return chain.then(reload).then(function () {
      if (mode === 'cat' && S.cat === id) S.cat = 'all';
      if (mode === 'loc' && S.loc === id) S.loc = 'all';
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
        var changed = false;
        if (hit.name !== c.name) { hit.name = c.name; changed = true; }
        if (c.emoji && c.emoji !== hit.emoji) { hit.emoji = c.emoji; changed = true; }
        if (c.shape && c.shape !== hit.shape) { hit.shape = c.shape; changed = true; }
        if ((c.parentId || '') !== (hit.parentId || '')) { hit.parentId = c.parentId || ''; changed = true; }
        if (changed) await DB.put('categories', hit);
      } else {
        var nc = {
          id: c.id,
          name: c.name,
          emoji: c.emoji || '📦',
          shape: c.shape || guessShape(c.name),
          parentId: c.parentId || '',
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
        var lchanged = false;
        if (hitL.name !== l.name) { hitL.name = l.name; lchanged = true; }
        if ((l.parentId || '') !== (hitL.parentId || '')) { hitL.parentId = l.parentId || ''; lchanged = true; }
        if (lchanged) await DB.put('locations', hitL);
      } else {
        var nl = {
          id: l.id,
          name: l.name,
          parentId: l.parentId || '',
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
          ratio: src.ratio,
          order: src.order,
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
          ratio: (src.ratio != null ? src.ratio : local.ratio),
          order: (src.order != null ? src.order : local.order),
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
    } else if (f.type === 'select') {
      h += '<select data-f="' + i + '">';
      (f.options || []).forEach(function (o) {
        h += '<option value="' + esc(o[0]) + '"' + (o[0] === val ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      });
      h += '</select>';
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
  } else if (t.id === 'autoCut') {
    S.autoCut = !!t.checked;
    savePrefs();
    toast(S.autoCut ? '之后拍的照片会自动去掉背景' : '已关闭自动去背景');
  } else if (t.id === 'f-loc' && S.form) {
    S.form.locationId = t.value;
  }
}

/* 长按（手机上）或右键（电脑上）编辑节点 */
function bindLongPress() {
  var timer = null;

  document.addEventListener('touchstart', function (e) {
    var row = e.target.closest('[data-longpress]');
    if (!row) return;
    clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      S.suppressUntil = Date.now() + 350;
      var kind = row.getAttribute('data-kind');
      var id = row.getAttribute('data-id');
      if (kind === 'cat') editTag(id, 'cat'); else editTag(id, 'loc');
    }, 420);
  }, { passive: true });

  document.addEventListener('touchmove', function () {
    clearTimeout(timer);
    timer = null;
  }, { passive: true });

  document.addEventListener('touchend', function () {
    clearTimeout(timer);
    timer = null;
  }, { passive: true });

  document.addEventListener('contextmenu', function (e) {
    var row = e.target.closest('[data-longpress]');
    if (!row) return;
    e.preventDefault();
    var kind = row.getAttribute('data-kind');
    var id = row.getAttribute('data-id');
    if (kind === 'cat') editTag(id, 'cat'); else editTag(id, 'loc');
  });
}

function onDocClick(e) {
  if (Date.now() < (S.suppressUntil || 0)) return;

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
    case 'prev-item': navItem(-1); break;
    case 'next-item': navItem(1); break;
    case 'toggle-detail-more': {
      var dm = $('#detailMore');
      if (!dm) break;
      dm.hidden = !dm.hidden;
      var dmBtn = $('#detail .more-toggle');
      if (dmBtn) {
        dmBtn.textContent = dm.hidden
          ? '更多信息（价格 / 日期 / 备注 / 借出记录）'
          : '收起更多信息';
      }
      break;
    }
    case 'del-from-editor':
      closeSheet();
      deleteItem(el.getAttribute('data-id'));
      break;
    case 'toggle-view':
      S.viewMode = (S.viewMode === 'shelf') ? 'grid' : 'shelf';
      savePrefs();
      render();
      break;
    case 'filter-tag': setTagFilter(el.getAttribute('data-tag')); break;
    case 'quick-tag': appendQuickTag(el.getAttribute('data-tag')); break;
    case 'add-photo': pickPhotos(); break;
    case 'rm-photo': removePhoto(parseInt(el.getAttribute('data-i'), 10)); break;
    case 'pick-cat': pickCat(id); break;
    case 'new-cat-inline': newCatInline(); break;
    case 'new-loc-inline': newLocInline(); break;
    case 'filter-cat': setCatFilter(id); break;
    case 'filter-lent':
      S.loanOnly = !S.loanOnly;
      S.page = 1;
      $('#view').innerHTML = itemsHTML();
      hydrateThumbs();
      break;
    case 'clear-filter': clearFilter(); break;
    case 'load-more': S.page++; $('#view').innerHTML = itemsHTML(); hydrateThumbs(); break;
    case 'go-tag': {
      var kind = el.getAttribute('data-mode');
      var nodeId = el.getAttribute('data-tag');
      if (kind === 'cat') { S.cat = nodeId; S.loc = 'all'; S.tag = 'all'; }
      else { S.loc = nodeId; S.cat = 'all'; S.tag = 'all'; }
      S.tab = 'items';
      S.page = 1;
      render();
      break;
    }
    case 'toggle-node': {
      var k = el.getAttribute('data-key');
      S.expanded[k] = !S.expanded[k];
      render();
      break;
    }
    case 'tag-mode': S.tagMode = el.getAttribute('data-mode'); render(); break;
    case 'new-tag': newTag(el.getAttribute('data-mode') || S.tagMode); break;
    case 'new-child': newTag(el.getAttribute('data-kind') || S.tagMode, el.getAttribute('data-id')); break;
    case 'add-here': {
      var hk = el.getAttribute('data-kind');
      var hid = el.getAttribute('data-id');
      openEditor(null, hk === 'cat' ? { categoryId: hid } : { locationId: hid });
      break;
    }
    case 'edit-tag': editTag(id); break;
    case 'del-tag': delTag(id, el.getAttribute('data-kind')); break;
    case 'how-install': showInstallHelp(); break;
    case 'export-json': exportJSON(false); break;
    case 'export-json-photos': exportJSON(true); break;
    case 'export-csv': exportCSV(); break;
    case 'csv-template': downloadCSVTemplate(); break;
    case 'import-merge': pickImport('merge'); break;
    case 'import-replace': pickImport('replace'); break;
    case 'import-csv': pickImport('csv'); break;
    case 'wipe': wipeAll(); break;
    case 'force-update': forceUpdate(); break;
    case 'recalc-ratio': recalcRatios(); break;
    case 'demo': loadDemo(); break;
    case 'dlg-ok': dialogOk(); break;
    case 'dlg-cancel': dialogCancel(); break;
  }
}

function newCatInline() {
  var current = S.form ? S.form.categoryId : '';
  askForm({
    title: '新建分类',
    fields: [
      { key: 'name', label: '名称', required: true, placeholder: '例：围巾、厨房小家电' },
      { key: 'parentId', label: '放在哪个下面', type: 'select', options: parentOptions('cat', ''), value: current || '' }
    ],
    emoji: true,
    emojiValue: '📦',
    okText: '创建'
  }).then(function (r) {
    if (!r) return;
    var cat = {
      id: uid(), name: r.name, emoji: r.emoji || '📦', parentId: r.parentId || '',
      shape: guessShape(r.name), order: S.cats.length, createdAt: Date.now()
    };
    return DB.put('categories', cat).then(function () {
      S.cats.push(cat);
      if (S.form) S.form.categoryId = cat.id;
      if (cat.parentId) S.expanded['cat:' + cat.parentId] = true;
      renderCatChips();
      toast(cat.parentId ? '已新建分类，挂在上级下面' : '已新建分类');
    });
  }).catch(fatal);
}

function newLocInline() {
  var current = S.form ? S.form.locationId : '';
  askForm({
    title: '新建位置',
    fields: [
      { key: 'name', label: '名称', required: true, placeholder: '例：衣柜、第三层' },
      { key: 'parentId', label: '放在哪个下面', type: 'select', options: parentOptions('loc', ''), value: current || '' }
    ],
    okText: '创建'
  }).then(function (r) {
    if (!r) return;
    var loc = { id: uid(), name: r.name, parentId: r.parentId || '', order: S.locs.length, createdAt: Date.now() };
    return DB.put('locations', loc).then(function () {
      S.locs.push(loc);
      if (S.form) S.form.locationId = loc.id;
      if (loc.parentId) S.expanded['loc:' + loc.parentId] = true;
      updateLocBtn();
      if (!$('#picker').hidden) $('#picker').innerHTML = pickerHTML();
      toast(loc.parentId ? '已新建位置，挂在上级下面' : '已新建位置');
    });
  }).catch(fatal);
}
