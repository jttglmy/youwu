'use strict';

/* 有物 · 本地存储层
   优先用 IndexedDB（几百上千件、照片都能装）；
   如果是双击 file:// 打开、浏览器禁用了 IndexedDB，
   自动降级到 localStorage（约 5MB，只够少量试用）。
   两种模式对上层提供完全相同的接口。 */

var DB_NAME = 'youwu-db';
var DB_VER = 1;
var LS_PREFIX = 'youwu-ls:';

var _mode = null;
var _db = null;
var _ready = null;

/* ---------------- 初始化与探测 ---------------- */

function initDB() {
  if (_ready) return _ready;

  _ready = new Promise(function (resolve) {
    var settled = false;

    function finish(mode) {
      if (_mode) return;
      _mode = mode;
      resolve(mode);
    }

    if (typeof indexedDB === 'undefined' || !indexedDB) {
      finish('ls');
      return;
    }

    var req;
    try {
      req = indexedDB.open(DB_NAME, DB_VER);
    } catch (e) {
      finish('ls');
      return;
    }

    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains('items')) {
        var s = db.createObjectStore('items', { keyPath: 'id' });
        s.createIndex('categoryId', 'categoryId');
        s.createIndex('locationId', 'locationId');
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('categories')) {
        db.createObjectStore('categories', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('locations')) {
        db.createObjectStore('locations', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('photos')) {
        var p = db.createObjectStore('photos', { keyPath: 'id' });
        p.createIndex('itemId', 'itemId');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    req.onsuccess = function () {
      if (settled) return;
      settled = true;
      _db = req.result;
      finish('idb');
    };

    req.onerror = function () {
      if (settled) return;
      settled = true;
      finish('ls');
    };

    req.onblocked = function () {
      if (settled) return;
      settled = true;
      finish('ls');
    };

    // 兜底：极端情况下（例如被别的标签页占住）避免一直卡在打开中
    setTimeout(function () {
      if (settled) return;
      settled = true;
      finish('ls');
    }, 8000);
  });

  return _ready;
}

/* ---------------- IndexedDB 驱动 ---------------- */

function idbStore(store, mode) {
  return _db.transaction(store, mode || 'readonly').objectStore(store);
}

function idbReq(req) {
  return new Promise(function (resolve, reject) {
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

/* ---------------- localStorage 驱动 ---------------- */

function lsKey(store, id) { return LS_PREFIX + store + ':' + id; }

function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    throw new Error('浏览器缓存空间不够了（双击文件模式约 5MB），请少放几张照片，或部署到网址后再用');
  }
}

function lsRead(store) {
  var out = [];
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf(LS_PREFIX + store + ':') !== 0) continue;
      var raw = localStorage.getItem(k);
      if (!raw) continue;
      try { out.push(JSON.parse(raw)); } catch (e) { /* 跳过坏数据 */ }
    }
  } catch (e) { /* 隐私模式等 */ }
  return out;
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
  if (!u || typeof u !== 'string') return null;
  var cut = u.indexOf(',');
  if (cut < 0) return null;
  var meta = u.slice(0, cut);
  var body = u.slice(cut + 1);
  var m = /data:([^;]+)/.exec(meta);
  var mime = m ? m[1] : 'image/jpeg';
  var bin;
  try { bin = atob(body); } catch (e) { return null; }
  var arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  try { return new Blob([arr], { type: mime }); } catch (e) { return null; }
}

function photoFromLS(rec) {
  if (!rec) return rec;
  return {
    id: rec.id,
    itemId: rec.itemId,
    createdAt: rec.createdAt,
    w: rec.w,
    h: rec.h,
    full: dataURLToBlob(rec.full),
    thumb: dataURLToBlob(rec.thumb || rec.full)
  };
}

/* ---------------- 驱动集合 ---------------- */

var DRIVERS = {
  idb: {
    all: function (store) { return idbReq(idbStore(store).getAll()); },
    get: function (store, key) { return idbReq(idbStore(store).get(key)); },
    put: function (store, val) { return idbReq(idbStore(store, 'readwrite').put(val)); },
    del: function (store, key) { return idbReq(idbStore(store, 'readwrite').delete(key)); },
    clear: function (store) { return idbReq(idbStore(store, 'readwrite').clear()); },
    byItem: function (itemId) {
      return idbReq(idbStore('photos').index('itemId').getAll(itemId));
    }
  },

  ls: {
    all: function (store) {
      var list = lsRead(store);
      if (store === 'photos') list = list.map(photoFromLS);
      return Promise.resolve(list);
    },
    get: function (store, key) {
      var raw;
      try { raw = localStorage.getItem(lsKey(store, key)); } catch (e) { raw = null; }
      if (!raw) return Promise.resolve(undefined);
      var rec;
      try { rec = JSON.parse(raw); } catch (e) { return Promise.resolve(undefined); }
      return Promise.resolve(store === 'photos' ? photoFromLS(rec) : rec);
    },
    put: function (store, val) {
      var recKey = (val && val.id != null) ? val.id : (val && val.key);
      if (recKey == null) return Promise.reject(new Error('记录缺少 id'));

      if (store !== 'photos') {
        return Promise.resolve().then(function () {
          lsSet(lsKey(store, recKey), JSON.stringify(val));
        });
      }
      return Promise.all([blobToDataURL(val.full), blobToDataURL(val.thumb || val.full)]).then(function (urls) {
        lsSet(lsKey(store, recKey), JSON.stringify({
          id: val.id,
          itemId: val.itemId,
          createdAt: val.createdAt,
          w: val.w,
          h: val.h,
          full: urls[0],
          thumb: urls[1]
        }));
      });
    },
    del: function (store, key) {
      try { localStorage.removeItem(lsKey(store, key)); } catch (e) { }
      return Promise.resolve();
    },
    clear: function (store) {
      var keys = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(LS_PREFIX + store + ':') === 0) keys.push(k);
        }
      } catch (e) { }
      keys.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { } });
      return Promise.resolve();
    },
    byItem: function (itemId) {
      return Promise.resolve(lsRead('photos')
        .filter(function (p) { return p.itemId === itemId; })
        .map(photoFromLS));
    }
  }
};

/* ---------------- 对外接口 ---------------- */

var DB = {};

['all', 'get', 'put', 'del', 'clear', 'byItem'].forEach(function (name) {
  DB[name] = function () {
    var args = arguments;
    return initDB().then(function (mode) {
      return DRIVERS[mode][name].apply(null, args);
    });
  };
});

DB.mode = function () { return _mode; };
