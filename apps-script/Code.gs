/**
 * 健康總覽 App 的後端（綁定在「健康總覽」試算表）。
 * 部署：擴充功能 → Apps Script → 貼上本檔 → 專案設定 → 指令碼屬性新增 KEY（App 與捷徑用的密碼）
 *       → 部署 → 新增部署作業 → 網頁應用程式（執行身分：我；存取權：任何人）。
 * 本檔不含任何健康資料，資料全部在試算表裡。
 */
const VERSION = 4;

// 每個分頁的識別方式：id＝第一欄 id；key＝以某欄為唯一鍵；row＝用列號＋原始內容比對
const TABS = {
  '健檢數值': { mode: 'row' },
  '健檢發現': { mode: 'row' },
  '病史': { mode: 'id', prefix: 'h' },
  '追蹤項目': { mode: 'id', prefix: 'f' },
  '預約': { mode: 'id', prefix: 'a' },
  '建議': { mode: 'id', prefix: 't' },
  '追蹤紀錄': { mode: 'id', prefix: 'r' },
  '運動指標': { mode: 'key', key: 'key' },
  '目標': { mode: 'key', key: 'key' },
  '每日數據': { mode: 'key', key: '日期' },
};
const DAILY_FIELDS = {
  steps: '步數', restingHR: '靜止心率', avgHR: '平均心率', maxHR: '最高心率', hrv: 'HRV',
  sys: '收縮壓', dia: '舒張壓', bpPulse: '血壓脈搏', weight: '體重', sleep: '睡眠小時', energy: '活動大卡',
  exMin: '運動分鐘', fat: '體脂率', strength: '肌力', core: '核心',
};

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: '格式錯誤' }); }
  const key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key) return out({ ok: false, error: '尚未設定 KEY（專案設定 → 指令碼屬性）' });
  if (String(body.key || '') !== key) return out({ ok: false, error: '密碼錯誤' });
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const r = route(body);
    return out(Object.assign({ ok: true, v: VERSION }, r));
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function doGet() {
  return out({ ok: true, v: VERSION, msg: '健康總覽後端運作中' });
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function route(b) {
  switch (b.action) {
    case 'read': return { tabs: readAll(), tip: buildTip(readAll()), sheetUrl: SpreadsheetApp.getActive().getUrl() };
    case 'add': return { row: addRow(b.tab, b.row) };
    case 'addMany': return { n: addMany(b.tab, b.rows) };
    case 'update': updateRow(b.tab, b); return {};
    case 'delete': deleteRow(b.tab, b); return {};
    case 'batch': { // 依序執行多個寫入，回傳每個新增的列
      const res = [];
      (b.ops || []).forEach(function (op) {
        if (op.action === 'add') res.push(addRow(op.tab, op.row));
        else if (op.action === 'update') { updateRow(op.tab, op); res.push(null); }
        else if (op.action === 'delete') { deleteRow(op.tab, op); res.push(null); }
        else throw new Error('批次不支援 ' + op.action);
      });
      return { rows: res };
    }
    case 'sync': {
      const date = syncDaily(b);
      const tabs = readAll();
      return { date: date, text: buildTip(tabs) };
    }
    case 'tip': return { text: buildTip(readAll()) };
    default: throw new Error('未知動作 ' + b.action);
  }
}

// ---------- 讀取 ----------
let CACHE = null;
function tz() { return SpreadsheetApp.getActive().getSpreadsheetTimeZone() || 'Asia/Taipei'; }

function norm(v) {
  if (v instanceof Date) {
    if (v.getFullYear() < 1901) return Utilities.formatDate(v, tz(), 'HH:mm');
    const t = Utilities.formatDate(v, tz(), 'HH:mm');
    return Utilities.formatDate(v, tz(), t === '00:00' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm');
  }
  return v;
}

function sheet(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('找不到分頁 ' + name);
  return sh;
}

function readAll() {
  if (CACHE) return CACHE;
  const res = {};
  Object.keys(TABS).forEach(function (name) {
    const sh = SpreadsheetApp.getActive().getSheetByName(name);
    if (!sh) return;
    res[name] = sh.getDataRange().getValues().map(function (r) { return r.map(norm); });
  });
  CACHE = res;
  return res;
}

function headers(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function toRow(hdr, obj) {
  return hdr.map(function (h) { return obj[h] === undefined || obj[h] === null ? '' : obj[h]; });
}

function writeRow(sh, rowNum, hdr, values) {
  const rng = sh.getRange(rowNum, 1, 1, hdr.length);
  // 日期、時間欄存成文字，避免被轉成其他格式
  const fmt = hdr.map(function (h) { return /日期|時間|上次完成/.test(h) ? '@' : 'General'; });
  rng.setNumberFormats([fmt]);
  rng.setValues([values]);
}

// ---------- 寫入 ----------
function checkTab(tab) {
  if (!TABS[tab]) throw new Error('不能寫入分頁 ' + tab);
  return TABS[tab];
}

function newId(sh, prefix) {
  const ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  let n = 1;
  ids.forEach(function (id) { const m = id.match(/(\d+)$/); if (m && +m[1] >= n) n = +m[1] + 1; });
  return prefix + n;
}

function addRow(tab, obj) {
  const cfg = checkTab(tab);
  const sh = sheet(tab);
  const hdr = headers(sh);
  obj = Object.assign({}, obj);
  if (cfg.mode === 'id' && !obj.id) obj.id = newId(sh, cfg.prefix);
  if (cfg.mode === 'key') {
    const r = findKey(sh, hdr, cfg.key, obj[cfg.key]);
    if (r) { writeRow(sh, r, hdr, toRow(hdr, obj)); log('更新', tab + ' ' + obj[cfg.key]); return obj; }
  }
  writeRow(sh, sh.getLastRow() + 1, hdr, toRow(hdr, obj));
  log('新增', tab + ' ' + (obj.id || obj[hdr[0]] || ''));
  return obj;
}

function addMany(tab, rows) {
  checkTab(tab);
  if (!rows || !rows.length) return 0;
  rows.forEach(function (o) { addRow(tab, o); });
  return rows.length;
}

function findKey(sh, hdr, keyName, value) {
  const c = hdr.indexOf(keyName);
  if (c < 0 || sh.getLastRow() < 2) return 0;
  const vals = sh.getRange(2, c + 1, sh.getLastRow() - 1, 1).getValues();
  const want = String(norm(value));
  for (let i = 0; i < vals.length; i++) if (String(norm(vals[i][0])) === want) return i + 2;
  return 0;
}

function locate(tab, b) {
  const cfg = checkTab(tab);
  const sh = sheet(tab);
  const hdr = headers(sh);
  let r = 0;
  if (cfg.mode === 'id') r = findKey(sh, hdr, 'id', b.id);
  else if (cfg.mode === 'key') r = findKey(sh, hdr, cfg.key, b.id);
  else {
    r = +b.rowNum;
    if (!(r >= 2 && r <= sh.getLastRow())) throw new Error('列號不對，請重新整理');
    const cur = sh.getRange(r, 1, 1, hdr.length).getValues()[0].map(norm).map(String);
    const want = (b.match || []).map(String);
    if (want.join('\u0001') !== cur.slice(0, want.length).join('\u0001')) throw new Error('資料已變動，請重新整理再試');
  }
  if (!r) throw new Error('找不到這筆資料，請重新整理');
  return { sh: sh, hdr: hdr, r: r };
}

function updateRow(tab, b) {
  const L = locate(tab, b);
  const cur = L.sh.getRange(L.r, 1, 1, L.hdr.length).getValues()[0].map(norm);
  const obj = {};
  L.hdr.forEach(function (h, i) { obj[h] = cur[i]; });
  Object.assign(obj, b.row || {});
  writeRow(L.sh, L.r, L.hdr, toRow(L.hdr, obj));
  log('修改', tab + ' ' + (b.id || ('第' + L.r + '列')));
}

function deleteRow(tab, b) {
  const L = locate(tab, b);
  L.sh.deleteRow(L.r);
  log('刪除', tab + ' ' + (b.id || ('第' + L.r + '列')));
}

function log(act, txt) {
  const sh = SpreadsheetApp.getActive().getSheetByName('App 紀錄');
  if (!sh) return;
  sh.appendRow([Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm:ss'), act, txt]);
  if (sh.getLastRow() > 600) sh.deleteRows(2, 100);
}

// ---------- 捷徑同步 ----------
function num(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'number') return isFinite(v) ? v : '';
  const s = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return s ? +s[0] : '';
}

function syncDaily(b) {
  const sh = sheet('每日數據');
  const hdr = headers(sh);
  let date = String(b.date || '').trim().replace(/\//g, '-');
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(date)) {
    const y = new Date(Date.now() - 24 * 3600 * 1000);
    date = Utilities.formatDate(y, tz(), 'yyyy-MM-dd');
  } else {
    const p = date.split('-');
    date = p[0] + '-' + ('0' + p[1]).slice(-2) + '-' + ('0' + p[2]).slice(-2);
  }
  const r = findKey(sh, hdr, '日期', date);
  const cur = {};
  if (r) {
    const vals = sh.getRange(r, 1, 1, hdr.length).getValues()[0].map(norm);
    hdr.forEach(function (h, i) { cur[h] = vals[i]; });
  }
  cur['日期'] = date;
  Object.keys(DAILY_FIELDS).forEach(function (k) {
    let v = num(b[k]);
    if (k === 'sleep' && v !== '') { // 捷徑可能給秒或分鐘
      if (v > 1440) v = v / 3600; else if (v > 24) v = v / 60;
      v = Math.round(v * 10) / 10;
    }
    if (v !== '') {
      // 捷徑單位設錯時自動換算
      if (k === 'hrv' && v < 1) v = v * 1000;          // 秒 → 毫秒
      if (k === 'energy' && v > 5000) v = v / 1000;    // 卡 → 大卡
      if (k === 'exMin' && v > 1440) v = v / 60;       // 秒 → 分鐘
      if (k === 'weight' && v > 300) v = v / 1000;     // 公克 → 公斤
      if (k === 'fat' && v < 1) v = v * 100;           // 0.222 → 22.2
      // 四捨五入
      if (k === 'steps' || k === 'energy' || k === 'exMin' || k === 'restingHR' || k === 'avgHR' || k === 'maxHR' ||
          k === 'sys' || k === 'dia' || k === 'bpPulse') v = Math.round(v);
      else if (k === 'hrv' || k === 'weight' || k === 'fat') v = Math.round(v * 10) / 10;
    }
    if (v !== '' && v !== 0) cur[DAILY_FIELDS[k]] = v;
  });
  cur['來源'] = b.source || '捷徑';
  cur['更新時間'] = Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm');
  writeRow(sh, r || sh.getLastRow() + 1, hdr, toRow(hdr, cur));
  CACHE = null;
  return date;
}

// ---------- 通知文字 ----------
function objs(tab) {
  const rows = (readAll()[tab] || []);
  if (rows.length < 2) return [];
  const h = rows[0].map(String);
  return rows.slice(1).filter(function (r) { return r.some(function (c) { return c !== ''; }); }).map(function (r) {
    const o = {}; h.forEach(function (k, i) { o[k] = r[i]; }); return o;
  });
}

function dayDiff(a, b) {
  const pa = String(a).slice(0, 10).split('-'), pb = String(b).slice(0, 10).split('-');
  return Math.round((Date.UTC(+pb[0], pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], pa[1] - 1, +pa[2])) / 864e5);
}

function buildTip() {
  const today = Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd');
  const lines = [];
  const W = ['日', '一', '二', '三', '四', '五', '六'];
  const goals = {};
  objs('目標').forEach(function (g) { goals[g.key] = +g['目標']; });

  // 1. 預約
  objs('預約').filter(function (a) { return a['狀態'] !== '已完成' && a['狀態'] !== '取消' && a['日期']; })
    .map(function (a) { a._d = dayDiff(today, a['日期']); return a; })
    .filter(function (a) { return a._d >= 0 && a._d <= 3; })
    .sort(function (x, y) { return x._d - y._d; })
    .forEach(function (a) {
      const when = a._d === 0 ? '今天' : a._d === 1 ? '明天' : a._d === 2 ? '後天' : String(a['日期']).slice(5).replace('-', '/');
      lines.push('📅 ' + when + ' ' + (a['時間'] || '') + ' ' + [a['醫院'], a['科別']].filter(String).join(' ') + (a['事由'] ? '（' + a['事由'] + '）' : ''));
    });

  // 2. 追蹤項目：14 天內到期每天提醒；過期的週一提醒
  const fu = objs('追蹤項目').filter(function (f) { return f['狀態'] !== '已完成' && f['狀態'] !== '停止' && f['狀態'] !== '已預約' && f['下次日期']; })
    .map(function (f) { f._d = dayDiff(today, f['下次日期']); return f; });
  fu.filter(function (f) { return f._d >= 0 && f._d <= 14; }).forEach(function (f) {
    lines.push('🩺 ' + f['項目'] + '：' + (f._d === 0 ? '今天' : f._d + ' 天後') + '到期，記得預約' + (f['科別'] ? f['科別'] : ''));
  });
  const over = fu.filter(function (f) { return f._d < 0; });
  const dow = +Utilities.formatDate(new Date(), tz(), 'u') % 7;
  if (over.length && dow === 1) lines.push('⚠️ ' + over.length + ' 項追蹤已過期：' + over.slice(0, 3).map(function (f) { return f['項目']; }).join('、') + (over.length > 3 ? '…' : ''));

  // 3. 昨天的數據
  const daily = objs('每日數據').sort(function (a, b) { return String(b['日期']).localeCompare(String(a['日期'])); });
  const y = daily[0];
  if (y && dayDiff(y['日期'], today) <= 2) {
    const bits = [];
    if (y['步數'] !== '') {
      const g = goals.steps || 8000;
      bits.push('步數 ' + Number(y['步數']).toLocaleString() + (y['步數'] >= g ? ' ✓' : '（目標 ' + g.toLocaleString() + '）'));
    }
    if (y['靜止心率'] !== '') bits.push('靜止心率 ' + y['靜止心率']);
    if (y['睡眠小時'] !== '') bits.push('睡眠 ' + y['睡眠小時'] + ' 小時');
    if (bits.length) lines.push('📊 ' + (y['日期'] === today ? '今天' : String(y['日期']).slice(5).replace('-', '/')) + '：' + bits.join('，'));
    if (y['收縮壓'] !== '' && y['舒張壓'] !== '') {
      const s = +y['收縮壓'], d = +y['舒張壓'];
      if (s >= 135 || d >= 85) lines.push('🩸 血壓 ' + s + '/' + d + ' 偏高，休息 5 分鐘後再量一次；連續偏高請回診');
      else lines.push('🩸 血壓 ' + s + '/' + d);
    }
    if (y['睡眠小時'] !== '' && +y['睡眠小時'] < 6) lines.push('😴 睡不到 6 小時，今天早點休息');
  } else {
    lines.push('📊 最近兩天沒有同步到健康數據');
  }

  // 3b. 本週運動分鐘（週一起算）
  const ex = objs('運動指標').filter(function (x) { return x.key === 'exmin'; })[0];
  if (ex && +ex['每週目標'] > 0) {
    const back = (dow + 6) % 7; // 週一＝0
    let sum = 0, any = false;
    daily.forEach(function (d) { const dd = dayDiff(d['日期'], today); if (dd >= 0 && dd <= back && d['運動分鐘'] !== '' && d['運動分鐘'] !== undefined) { sum += +d['運動分鐘']; any = true; } });
    if (any) lines.push('🏃 本週運動 ' + sum + '／' + ex['每週目標'] + ' 分鐘' + (sum >= +ex['每週目標'] ? ' ✓' : '，還差 ' + (ex['每週目標'] - sum)));
  }

  // 4. 每日建議（從「建議」分頁輪播）
  const tips = objs('建議').filter(function (t) { return String(t['啟用'] || '是') !== '否' && t['內容']; });
  if (tips.length) {
    const n = Math.floor(Date.now() / 864e5);
    const t = tips[n % tips.length];
    lines.push('💡 ' + t['內容']);
  }
  return lines.join('\n');
}
