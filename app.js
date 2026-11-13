/* 健康總覽 App：資料全部來自使用者自己的 Google 試算表（Apps Script＋密碼），本檔不含任何健康資料。 */
'use strict';
const APP_VERSION = '1.2.1';
const LS = { cfg: 'hc-cfg-v1', cache: 'hc-cache-v1', page: 'hc-page' };
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

const state = { cfg: lsGet(LS.cfg) || {}, data: lsGet(LS.cache), page: 'home', sub: {}, busy: false };

// ---------- 日期工具 ----------
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => iso(new Date());
const parseD = s => { const p = String(s).slice(0, 10).split('-'); return new Date(+p[0], p[1] - 1, +p[2]); };
const diffDays = (a, b) => Math.round((parseD(b) - parseD(a)) / 864e5);
const W = ['日', '一', '二', '三', '四', '五', '六'];
const fmtD = s => { if (!s) return '日期未填'; const d = parseD(s); return (d.getMonth() + 1) + '/' + d.getDate() + '（' + W[d.getDay()] + '）'; };
const fmtYMD = s => s ? String(s).slice(0, 10).replace(/-/g, '/') : '日期未填';
const addMonths = (s, m) => { const d = parseD(s); d.setMonth(d.getMonth() + m); return iso(d); };
const fmtNum = (v, d) => v === '' || v == null || isNaN(v) ? '–' : (d != null ? Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : Number(v).toLocaleString());

// ---------- 資料存取 ----------
function rowsOf(tab) {
  const t = state.data && state.data.tabs && state.data.tabs[tab];
  if (!t || t.length < 1) return [];
  const h = t[0].map(String);
  return t.slice(1).map((r, i) => {
    const o = { _row: i + 2, _raw: r };
    h.forEach((k, j) => { o[k] = r[j] === undefined ? '' : r[j]; });
    return o;
  }).filter(o => o._raw.some(c => c !== '' && c != null));
}

async function api(body) {
  if (!state.cfg.url || !state.cfg.key) throw new Error('請先到設定填網址和密碼');
  const res = await fetch(state.cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ key: state.cfg.key }, body)) });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || '失敗');
  return j;
}

async function refresh(quiet) {
  if (!state.cfg.url) { render(); if (!quiet) openSettings(); return; }
  setStatus('更新中…');
  try {
    const j = await api({ action: 'read' });
    state.data = { tabs: j.tabs, tip: j.tip, sheetUrl: j.sheetUrl, at: Date.now() }; state.fresh = true;
    lsSet(LS.cache, state.data);
    setStatus('');
    render();
  } catch (e) {
    setStatus('');
    toast('更新失敗：' + e.message);
  }
}

async function write(body, okMsg) {
  if (state.busy) return false;
  state.busy = true; setStatus('寫入中…');
  try {
    await api(body);
    toast(okMsg || '已儲存');
    state.busy = false;
    await refresh(true);
    return true;
  } catch (e) {
    state.busy = false; setStatus('');
    alert('沒有存成功：' + e.message);
    return false;
  }
}

function setStatus(t) { $('#status').textContent = t; }
let toastT;
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 2600); }

// ---------- 健檢數值整理 ----------
function examDates() {
  const m = {};
  rowsOf('健檢數值').forEach(r => { m[r['日期']] = r['醫院']; });
  rowsOf('健檢發現').forEach(r => { if (!m[r['日期']]) m[r['日期']] = r['醫院']; });
  return Object.keys(m).filter(Boolean).sort().map(d => ({ date: d, hosp: m[d] }));
}
function examItems() {
  // { 類別: { 項目: { unit, ref, vals: {date: {v, flag, row}} } } }，保持試算表順序
  const cats = {}; const order = [];
  rowsOf('健檢數值').forEach(r => {
    const c = r['類別'] || '其他';
    if (!cats[c]) { cats[c] = {}; order.push(c); }
    const it = cats[c][r['項目']] || (cats[c][r['項目']] = { unit: r['單位'], ref: r['參考值'], vals: {} });
    if (r['單位']) it.unit = r['單位'];
    if (r['參考值']) it.ref = r['參考值'];
    it.vals[r['日期']] = { v: r['數值'], flag: r['異常'] === '★', row: r };
  });
  return { cats, order };
}
function latestExam(item) {
  const rs = rowsOf('健檢數值').filter(r => r['項目'] === item && r['數值'] !== '').sort((a, b) => String(a['日期']).localeCompare(String(b['日期'])));
  return rs.length ? { v: rs[rs.length - 1]['數值'], date: rs[rs.length - 1]['日期'], prev: rs.length > 1 ? rs[rs.length - 2]['數值'] : null, flag: rs[rs.length - 1]['異常'] === '★' } : null;
}
// 依參考值文字判斷是否超出（<100、≥40、0.35–4.94、> -1.0）
function outOfRef(v, ref) {
  v = parseFloat(v); if (isNaN(v) || !ref) return false;
  const s = String(ref).replace(/[^\d.<>≤≥=–\-~ ]/g, ' ');
  let m = s.match(/(-?\d+(?:\.\d+)?)\s*[–~]\s*(-?\d+(?:\.\d+)?)/);
  if (m && !/[<>≤≥]/.test(s)) return v < +m[1] || v > +m[2];
  m = s.match(/(<|≤|<=)\s*(-?\d+(?:\.\d+)?)/); if (m) return m[1] === '<' ? v >= +m[2] : v > +m[2];
  m = s.match(/(>|≥|>=)\s*(-?\d+(?:\.\d+)?)/); if (m) return m[1] === '>' ? v <= +m[2] : v < +m[2];
  return false;
}

// ---------- 每日數據 ----------
function daily(days) {
  const rs = rowsOf('每日數據').filter(r => r['日期']).sort((a, b) => String(a['日期']).localeCompare(String(b['日期'])));
  if (!days) return rs;
  const from = iso(new Date(Date.now() - days * 864e5));
  return rs.filter(r => r['日期'] > from);
}
function avg(rs, k) { const v = rs.map(r => parseFloat(r[k])).filter(x => !isNaN(x) && x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
function lastVal(rs, k) { for (let i = rs.length - 1; i >= 0; i--) { const x = parseFloat(rs[i][k]); if (!isNaN(x) && x > 0) return { v: x, date: rs[i]['日期'] }; } return null; }

// ---------- 圖表（SVG） ----------
function lineChart(series, opt = {}) {
  // series: [{name, color, pts:[{x(label), y}] }]；opt: {lines:[{y,color,label}], bars:true, h}
  const Wd = 340, H = opt.h || 150, L = 34, R = 8, T = 10, B = 22;
  const all = []; series.forEach(s => s.pts.forEach(p => { if (p.y != null && !isNaN(p.y)) all.push(p.y); }));
  (opt.lines || []).forEach(l => all.push(l.y));
  if (!all.length) return '<div class="empty">還沒有資料</div>';
  let lo = Math.min(...all), hi = Math.max(...all);
  if (opt.zero) lo = Math.min(0, lo);
  if (hi === lo) { hi += 1; lo -= 1; }
  const padv = (hi - lo) * 0.12; hi += padv; if (!opt.zero) lo -= padv;
  const xs = series[0].pts.map(p => p.x); const n = xs.length;
  const IN = opt.bars ? 6 : 14;
  const X = i => L + IN + (n <= 1 ? (Wd - L - R - 2 * IN) / 2 : i * (Wd - L - R - 2 * IN) / (n - 1));
  const Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  let g = '';
  for (let k = 0; k <= 3; k++) {
    const v = lo + (hi - lo) * k / 3, y = Y(v);
    g += `<line x1="${L}" x2="${Wd - R}" y1="${y}" y2="${y}" stroke="var(--chart-grid)"/><text x="${L - 4}" y="${y + 3}" text-anchor="end">${Math.abs(v) >= 1000 ? Math.round(v / 100) / 10 + 'k' : +v.toFixed(Math.abs(hi - lo) < 5 ? 1 : 0)}</text>`;
  }
  const step = Math.max(1, Math.ceil(n / 6));
  xs.forEach((x, i) => { if ((i % step === 0 && n - 1 - i >= step / 2) || i === n - 1) g += `<text x="${X(i)}" y="${H - 6}" text-anchor="middle">${esc(x)}</text>`; });
  (opt.lines || []).forEach(l => { g += `<line x1="${L}" x2="${Wd - R}" y1="${Y(l.y)}" y2="${Y(l.y)}" stroke="${l.color || 'var(--warn)'}" stroke-dasharray="4 3"/>`; });
  series.forEach(s => {
    if (opt.bars) {
      const bw = Math.max(2, (Wd - L - R) / n * 0.6);
      s.pts.forEach((p, i) => { if (p.y == null || isNaN(p.y)) return; const y = Y(p.y), y0 = Y(Math.max(lo, 0)); g += `<rect x="${X(i) - bw / 2}" y="${y}" width="${bw}" height="${Math.max(1, y0 - y)}" rx="2" fill="${p.c || s.color}"/>`; });
    } else {
      let d = ''; let pen = false;
      s.pts.forEach((p, i) => { if (p.y == null || isNaN(p.y)) { if (!opt.connect) pen = false; return; } d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.y).toFixed(1); pen = true; });
      g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
      s.pts.forEach((p, i) => { if (p.y == null || isNaN(p.y)) return; g += `<circle cx="${X(i)}" cy="${Y(p.y)}" r="${n > 20 ? 2 : 3.5}" fill="${p.flag ? 'var(--bad)' : s.color}"/>`; if (opt.labels) g += `<text x="${X(i)}" y="${Y(p.y) - 7}" text-anchor="middle" style="fill:var(--text);font-size:11px">${esc(p.y)}</text>`; });
    }
  });
  let lg = '';
  if (series.length > 1 || (opt.lines || []).some(l => l.label)) {
    lg = '<div class="legend">' + series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('') +
      (opt.lines || []).filter(l => l.label).map(l => `<span><i style="background:${l.color || 'var(--warn)'}"></i>${esc(l.label)}</span>`).join('') + '</div>';
  }
  return `<svg class="chart" viewBox="0 0 ${Wd} ${H}" role="img">${g}</svg>${lg}`;
}

// ---------- 指標說明 ----------
function openInfo(name) {
  const x = infoFor(name);
  const exam = rowsOf('健檢數值').some(r => r['項目'] === name);
  if (!x) { if (exam) showItem(name); return; }
  let h = `<h3>${esc(name)}<button class="btn ghost small" data-close>關閉</button></h3>` + infoHtml(x);
  if (exam) h += `<div class="btns"><button class="btn" id="toTrend">📈 看歷年數值</button></div>`;
  openSheet(h);
  const b = $('#toTrend'); if (b) b.onclick = () => showItem(name);
}
function infoHtml(x) {
  const part = (icon, t, v) => v ? `<div class="info"><b>${icon} ${t}</b><div>${esc(v)}</div></div>` : '';
  return part('📖', '這是什麼', x.d) + part('⚠️', '偏高／偏低的影響', x.e) + part('👀', '要注意', x.w) + part('✅', '怎麼控制', x.c) +
    '<div class="sub" style="margin:6px 0 10px">一般衛教說明，實際狀況請以醫師判斷為準。</div>';
}
const ib = name => infoFor(name) ? `<button class="ib" data-info="${esc(name)}" aria-label="說明">ⓘ</button>` : '';

// ---------- 畫面 ----------
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.page === state.page));
  const titles = { home: '健康總覽', exam: '歷年健檢', daily: '日常數據', care: '就醫紀錄', plan: '健康規劃' };
  $('#title').textContent = titles[state.page];
  const m = $('#main');
  if (!state.data) {
    m.innerHTML = `<div class="card empty">還沒有資料<br><br><button class="btn" id="goSet">設定試算表連線</button></div>`;
    $('#goSet').onclick = openSettings; return;
  }
  ({ home: renderHome, exam: renderExam, daily: renderDaily, care: renderCare, plan: renderPlan })[state.page](m);
  m.querySelectorAll('[data-info]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); openInfo(el.dataset.info); }));
  if ($('#sheet').classList.contains('hidden')) checkMhb();
}

function renderHome(m) {
  const t = today(), now = new Date();
  const goals = goalMap();
  const d7 = daily(7), all = daily(), last = all.slice(-1)[0];
  const bp = lastVal(all, '收縮壓'), bpd = lastVal(all, '舒張壓'), wt = lastVal(all, '體重');
  const st = avg(d7, '步數'), stGoal = goals.steps || 8000;
  const todayRow = all.find(r => r['日期'] === t);
  const stepsToday = todayRow && todayRow['步數'] !== '' ? +todayRow['步數'] : null;
  const hr = avg(d7, '靜止心率'), ex7 = d7.reduce((s, r) => s + (parseFloat(r['運動分鐘']) || 0), 0);
  const hello = now.getHours() < 11 ? '早安' : now.getHours() < 18 ? '午安' : '晚安';
  let h = '';

  // ── 今日卡：問候＋今日步數環＋7 天數據＋提醒 ──
  const ringV = stepsToday != null ? stepsToday : st;
  h += `<div class="hero">
    <div class="hero-top"><div><div class="hero-date">${now.getMonth() + 1} 月 ${now.getDate()} 日 星期${W[now.getDay()]}</div><div class="hero-hi">${hello}，今天也要照顧好自己</div></div>
    ${ring(ringV, stGoal, stepsToday != null ? '今日步數' : '7 天平均')}</div>
    <div class="stats">
      ${stat('❤️', '靜止心率', hr != null ? Math.round(hr) : '–', '下/分', '近 7 天', '靜止心率')}
      ${stat('🩸', '血壓', bp && bpd ? bp.v + '/' + bpd.v : '–', '', bp ? fmtD(bp.date) : '還沒量', '血壓', bp && (bp.v >= 135 || bpd.v >= 85) ? 'bad' : '')}
      ${stat('⚖️', '體重', wt ? fmtNum(wt.v, 1) : '–', 'kg', wt ? '目標 ' + (goals.weight || '–') : '還沒量', '體重')}
      ${stat('🏃', '運動', Math.round(ex7), '分', '近 7 天／150', '運動分鐘', ex7 >= 150 ? 'good' : '')}
    </div>`;
  const tips = String(state.data.tip || '').split('\n').filter(l => l.trim() && !/^📊|^🏃|^📅|^🩸 血壓 \d+\/\d+$/.test(l.trim()));
  if (tips.length) h += `<div class="hero-tips">${tips.map(l => { const mm = l.trim().match(/^(\S+)\s+([\s\S]*)$/); return `<div class="htip"><span>${esc(mm ? mm[1] : '•')}</span><div>${esc(mm ? mm[2] : l)}</div></div>`; }).join('')}</div>`;
  h += `<div class="hero-foot">${last ? '最後同步 ' + esc(String(last['更新時間'] || last['日期']).slice(5)) : '尚未同步 Apple 健康'}<button class="more light" data-go="daily">日常數據 ›</button></div></div>`;

  // ── 就醫行程：預約＋追蹤合併 ──
  const appts = rowsOf('預約').filter(a => a['狀態'] !== '已完成' && a['狀態'] !== '取消' && a['日期'] >= t).sort((a, b) => (a['日期'] + a['時間']).localeCompare(b['日期'] + b['時間']));
  const fuAll = followups();
  const todo = fuAll.filter(f => !f._appt && (f._d == null ? f['狀態'] === '待確認' : f._d <= 60));
  h += `<div class="card"><div class="ch"><span class="ci" style="--c:var(--blue)">🗓</span><h2>就醫行程</h2><button class="more" data-go="care">預約紀錄 ›</button></div>`;
  if (appts.length) {
    h += '<div class="tl">' + appts.slice(0, 4).map(a => {
      const d = diffDays(t, a['日期']); const fs = fuIds(a).map(id => fuAll.find(f => f.id === id) || rowsOf('追蹤項目').find(f => f.id === id)).filter(Boolean);
      return `<div class="tl-item" data-a="${esc(a.id)}"><div class="tl-date ${d <= 3 ? 'soon' : ''}"><b>${parseD(a['日期']).getDate()}</b><span>${parseD(a['日期']).getMonth() + 1}月</span></div>
        <div class="grow"><div class="t">${esc(a['事由'] || a['科別'] || '看診')}</div><div class="sub">${esc([W[parseD(a['日期']).getDay()] && '週' + W[parseD(a['日期']).getDay()], a['時間'], a['醫院'], a['科別']].filter(Boolean).join('・'))}</div>
        ${fs.length ? `<div class="links">${fs.map(f => `<span class="pill good">✓ ${esc(f['項目'])}</span>`).join('')}</div>` : ''}</div>
        <span class="when ${d <= 3 ? 'soon' : ''}">${d === 0 ? '今天' : d === 1 ? '明天' : d + ' 天後'}</span></div>`;
    }).join('') + '</div>';
  } else h += '<div class="sub">目前沒有預約</div>';
  if (todo.length) {
    h += `<div class="sec2">待安排的追蹤</div><div class="todo">` + todo.slice(0, 6).map(f => `<div class="todo-item" data-f="${esc(f.id)}"><div class="grow"><div class="t">${esc(f['項目'])}</div><div class="sub">${esc(f['科別'])}${f['下次日期'] ? '・建議 ' + fmtYMD(f['下次日期']) : ''}</div></div>${fuBadge(f)}<button class="btn small" data-mk="${esc(f.id)}">預約</button></div>`).join('') + '</div>';
  }
  h += '</div>';

  // ── 重要健檢指標：迷你趨勢 ──
  const keys = [['LDL', 'mg/dL'], ['HDL', 'mg/dL'], ['HbA1c', '%'], ['三酸甘油脂', 'mg/dL'], ['體重', 'kg'], ['腰圍', 'cm']];
  h += `<div class="card"><div class="ch"><span class="ci" style="--c:var(--accent)">📋</span><h2>重要健檢指標</h2><button class="more" data-go="exam">歷年 ›</button></div><div class="kgrid">`;
  keys.forEach(([k, u]) => {
    const rs = examSeries(k); if (!rs.length) return;
    const x = rs[rs.length - 1], prev = rs.length > 1 ? rs[rs.length - 2] : null;
    const ch = prev && !isNaN(x.y) && !isNaN(prev.y) ? x.y - prev.y : null;
    h += `<div class="kcard ${x.flag ? 'is-bad' : 'is-ok'}" data-info="${esc(k)}"><div class="kh"><span>${esc(k)}</span><i class="dot"></i></div>
      <div class="kval">${esc(x.v)}<small>${esc(u)}</small></div>
      ${spark(rs)}
      <div class="kf">${String(x.date).slice(0, 4)}${ch != null ? ` <b class="${ch === 0 ? '' : (ch > 0) !== (k === 'HDL') ? 'up' : 'down'}">${ch > 0 ? '▲' : ch < 0 ? '▼' : '＝'} ${Math.abs(+ch.toFixed(2))}</b>` : ''}・${esc(rs[rs.length - 1].ref || '')}</div></div>`;
  });
  h += '</div></div>';

  // ── 最近一次健檢重點 ──
  const ed = examDates(); const lastE = ed[ed.length - 1];
  if (lastE) {
    const fs = rowsOf('健檢發現').filter(f => f['日期'] === lastE.date && f['等級'] !== '正常').sort((a, b) => lvRank(a['等級']) - lvRank(b['等級']));
    const cnt = l => fs.filter(f => f['等級'] === l).length;
    h += `<div class="card"><div class="ch"><span class="ci" style="--c:var(--warn)">🔎</span><h2>${String(lastE.date).slice(0, 4)} 健檢重點</h2><span class="sub">${esc(lastE.hosp)}・${fmtYMD(lastE.date)}</span></div>
      <div class="lvbar">${['盡快', '追蹤', '注意'].map(l => cnt(l) ? `<span class="lvc lvc-${l}"><b>${cnt(l)}</b>${l}</span>` : '').join('')}</div>
      <div class="flist">${fs.filter(f => f['等級'] !== '注意').map(findingCard).join('')}</div>`;
    const minor = fs.filter(f => f['等級'] === '注意');
    if (minor.length) h += `<details class="more-f"><summary>另外 ${minor.length} 項「注意」</summary><div class="flist">${minor.map(findingCard).join('')}</div></details>`;
    h += '</div>';
  }
  m.innerHTML = h;
  bindCommon(m);
  m.querySelectorAll('[data-a]').forEach(el => el.onclick = () => showAppt(rowsOf('預約').find(a => a.id === el.dataset.a)));
  m.querySelectorAll('[data-f]').forEach(el => el.onclick = () => showFu(rowsOf('追蹤項目').find(f => f.id === el.dataset.f)));
  m.querySelectorAll('[data-mk]').forEach(b => b.onclick = e => { e.stopPropagation(); const f = rowsOf('追蹤項目').find(x => x.id === b.dataset.mk); editAppt(null, { 日期: f['下次日期'] && f['下次日期'] >= today() ? f['下次日期'] : '', 科別: String(f['科別']).replace(/（.*）/, ''), 事由: f['項目'], 追蹤: f.id }); });
}

function ring(v, goal, label) {
  const p = v != null && goal ? Math.min(1, v / goal) : 0, R = 34, C = 2 * Math.PI * R;
  return `<div class="ring" data-info="步數"><svg viewBox="0 0 84 84"><circle cx="42" cy="42" r="${R}" class="ring-bg"/><circle cx="42" cy="42" r="${R}" class="ring-fg" stroke-dasharray="${(C * p).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 42 42)"/></svg>
    <div class="ring-t"><b>${v != null ? fmtNum(v, 0) : '–'}</b><span>${esc(label)}</span></div></div>`;
}
function stat(icon, k, v, unit, sub, info, cls) {
  return `<div class="stat" ${info && infoFor(info) ? `data-info="${esc(info)}"` : ''}><div class="sk">${icon} ${esc(k)}</div><div class="sv ${cls || ''}">${esc(v)}<small>${esc(unit)}</small></div><div class="ss">${esc(sub)}</div></div>`;
}
function examSeries(item) {
  return rowsOf('健檢數值').filter(r => r['項目'] === item && r['數值'] !== '').sort((a, b) => String(a['日期']).localeCompare(String(b['日期'])))
    .map(r => ({ date: r['日期'], x: String(r['日期']).slice(2, 4), y: parseFloat(r['數值']), v: r['數值'], flag: r['異常'] === '★', ref: r['參考值'], unit: r['單位'], hosp: r['醫院'] }));
}
// 迷你趨勢線（含年份與數值），參考值畫虛線
function spark(rs, opt = {}) {
  const pts = rs.filter(p => !isNaN(p.y));
  if (pts.length < 2) return `<div class="spark-empty">${pts.length ? '只有一年資料' : ''}</div>`;
  const Wd = opt.w || 150, H = opt.h || 54, L = opt.labels ? 16 : 10, R = opt.labels ? 16 : 10, T = 14, B = 14;
  const ys = pts.map(p => p.y); const refN = refLine(pts[pts.length - 1].ref);
  let lo = Math.min(...ys, ...(refN != null ? [refN] : [])), hi = Math.max(...ys, ...(refN != null ? [refN] : []));
  if (hi === lo) { hi += 1; lo -= 1; }
  const X = i => L + i * (Wd - L - R) / (pts.length - 1), Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  let g = '';
  if (refN != null) g += `<line x1="${L}" x2="${Wd - R}" y1="${Y(refN)}" y2="${Y(refN)}" class="sp-ref"/>`;
  g += `<path d="${pts.map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.y).toFixed(1)).join('')}" class="sp-line"/>`;
  pts.forEach((p, i) => { g += `<circle cx="${X(i)}" cy="${Y(p.y)}" r="2.8" class="${p.flag ? 'sp-bad' : 'sp-dot'}"/><text x="${X(i)}" y="${H - 2}" text-anchor="middle" class="sp-x">${esc(p.x)}</text>`; if (opt.labels) g += `<text x="${X(i)}" y="${Y(p.y) - 5}" text-anchor="middle" class="sp-v">${esc(p.v)}</text>`; });
  return `<svg class="spark" viewBox="0 0 ${Wd} ${H}">${g}</svg>`;
}
function refLine(ref) {
  const s = String(ref || '').replace(/[^\d.<>≤≥–\-~ ]/g, ' ');
  const m = s.match(/[<>≤≥]\s*(-?\d+(?:\.\d+)?)/) || s.match(/(-?\d+(?:\.\d+)?)\s*[–~]/);
  return m ? +m[1] : null;
}
function findingCard(f) {
  return `<div class="fcard lv-b-${esc(f['等級'])}"><div class="fh"><b>${esc(f['類別'])}</b><span class="pill ${f['等級'] === '盡快' ? 'bad' : f['等級'] === '追蹤' ? 'warn' : ''}">${esc(f['等級'])}</span></div><div>${esc(f['發現'])}</div>${f['建議'] ? `<div class="sub">→ ${esc(f['建議'])}</div>` : ''}</div>`;
}
function fuIds(a) { return String(a['追蹤'] || '').split(/[,，\s]+/).filter(Boolean); }
function nextApptFor(fid) {
  const t = today();
  return rowsOf('預約').filter(a => a['狀態'] !== '已完成' && a['狀態'] !== '取消' && a['日期'] >= t && fuIds(a).includes(fid))
    .sort((a, b) => (a['日期'] + a['時間']).localeCompare(b['日期'] + b['時間']))[0] || null;
}
function fuBadge(f) {
  if (f._appt) return `<span class="pill good">已預約 ${parseD(f._appt['日期']).getMonth() + 1}/${parseD(f._appt['日期']).getDate()}</span>`;
  if (f['狀態'] === '待確認' && f._d == null) return '<span class="pill">待確認</span>';
  return dueBadge(f._d);
}

function tile(k, v, unit, dec, cls, sub) {
  const has = v != null && v !== '';
  const c = has && cls ? cls(v) : '';
  return `<div class="tile" ${infoFor(k) ? `data-info="${esc(k)}"` : ''}><div class="k">${esc(k)}${infoFor(k) ? ' <span class="ibs">ⓘ</span>' : ''}</div><div class="v ${c}">${has ? esc(typeof v === 'number' ? fmtNum(v, dec) : v) : '–'}${has && unit ? `<small>${esc(unit)}</small>` : ''}</div>${sub ? `<div class="d sub">${esc(sub)}</div>` : ''}</div>`;
}
const lvRank = l => ({ '盡快': 0, '追蹤': 1, '注意': 2, '正常': 3 }[l] ?? 4);
function findingLi(f) {
  return `<li class="row" style="align-items:stretch"><span class="lv lv-${esc(f['等級'])}"></span><div class="grow"><div class="t">${esc(f['類別'])} <span class="pill ${f['等級'] === '盡快' ? 'bad' : f['等級'] === '追蹤' ? 'warn' : ''}">${esc(f['等級'])}</span></div><div>${esc(f['發現'])}</div>${f['建議'] ? `<div class="sub">→ ${esc(f['建議'])}</div>` : ''}</div></li>`;
}
function dueBadge(d) {
  if (d == null) return '<span class="pill">未排</span>';
  if (d < 0) return `<span class="pill bad">過期 ${-d} 天</span>`;
  if (d === 0) return '<span class="pill warn">今天</span>';
  return `<span class="pill ${d <= 14 ? 'warn' : 'acc'}">${d} 天後</span>`;
}
function apptLi(a) {
  const d = diffDays(today(), a['日期']);
  return `<li class="row"><div class="date-box"><b>${parseD(a['日期']).getDate()}</b><span>${parseD(a['日期']).getMonth() + 1}月・${W[parseD(a['日期']).getDay()]}</span></div>
    <div class="grow"><div class="t">${esc(a['科別'] || a['事由'] || '看診')} <span class="sub">${esc(a['時間'])}</span></div><div class="sub">${esc([a['醫院'], a['醫師'] && a['醫師'] + ' 醫師', a['事由']].filter(Boolean).join('・'))}</div></div>
    ${d >= 0 ? dueBadge(d) : ''}</li>`;
}
function bindCommon(m) {
  m.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
}

// ---------- 健檢頁 ----------
function renderExam(m) {
  const sub = state.sub.exam || 'trend';
  const ed = examDates();
  let h = `<div class="seg"><button data-s="trend" class="${sub === 'trend' ? 'on' : ''}">歷年比較</button><button data-s="year" class="${sub === 'year' ? 'on' : ''}">各年重點</button></div>`;
  if (sub === 'trend') {
    h += examTrendHtml(ed);
  } else {
    const sel = state.sub.year && ed.some(e => e.date === state.sub.year) ? state.sub.year : (ed.length ? ed[ed.length - 1].date : '');
    h += '<div class="chips">' + ed.slice().reverse().map(e => `<button data-y="${esc(e.date)}" class="${e.date === sel ? 'on' : ''}">${String(e.date).slice(0, 4)} ${esc(e.hosp)}</button>`).join('') + '</div>';
    const fs = rowsOf('健檢發現').filter(f => f['日期'] === sel).sort((a, b) => lvRank(a['等級']) - lvRank(b['等級']));
    h += `<div class="card"><h2>${fmtYMD(sel)} 檢查發現</h2>${fs.length ? '<ul class="list">' + fs.map(f => findingLi(f).replace('<li ', `<li data-frow="${f._row}" `)).join('') + '</ul>' : '<div class="sub">沒有紀錄</div>'}</div>`;
    const abn = rowsOf('健檢數值').filter(r => r['日期'] === sel && r['異常'] === '★');
    if (abn.length) h += `<div class="card"><h2>超出參考值的數值</h2><ul class="list">${abn.map(r => `<li class="row"><div class="grow">${esc(r['項目'])}</div><b class="bad">${esc(r['數值'])}</b><span class="sub">${esc(r['單位'])}（${esc(r['參考值'])}）</span></li>`).join('')}</ul></div>`;
    h += `<div class="btns"><button class="btn ghost" id="addFinding">＋ 新增檢查發現</button></div>`;
  }
  h += `<button class="add" id="addExam" aria-label="新增健檢">＋</button>`;
  m.innerHTML = h;
  m.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { state.sub.exam = b.dataset.s; render(); });
  m.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { state.sub.cat = b.dataset.c; render(); });
  m.querySelectorAll('[data-ev]').forEach(b => b.onclick = () => { state.sub.ev = b.dataset.ev; render(); });
  m.querySelectorAll('[data-y]').forEach(b => b.onclick = () => { state.sub.year = b.dataset.y; render(); });
  m.querySelectorAll('[data-item]').forEach(tr => tr.onclick = () => showItem(tr.dataset.item));
  m.querySelectorAll('[data-frow]').forEach(li => li.onclick = () => editFinding(rowsOf('健檢發現').find(f => f._row === +li.dataset.frow)));
  $('#addExam').onclick = addExamForm;
  const af = $('#addFinding'); if (af) af.onclick = () => editFinding(null);
}

function showItem(name) {
  const rs = rowsOf('健檢數值').filter(r => r['項目'] === name).sort((a, b) => String(a['日期']).localeCompare(String(b['日期'])));
  const it = rs[rs.length - 1] || {};
  const pts = rs.map(r => ({ x: String(r['日期']).slice(0, 4), y: parseFloat(r['數值']), flag: r['異常'] === '★' }));
  const ref = String(it['參考值'] || ''); const lines = [];
  const mm = ref.replace(/[^\d.<>≤≥–\-~ ]/g, ' ').match(/-?\d+(\.\d+)?/g);
  if (mm) mm.slice(0, 2).forEach(v => lines.push({ y: +v, label: lines.length ? '' : '參考值 ' + ref }));
  let h = `<h3>${esc(name)}<button class="btn ghost small" data-close>關閉</button></h3><div class="sub">${esc([it['單位'], '參考值 ' + ref].filter(Boolean).join('・'))}</div>`;
  const inf = infoFor(name);
  const infoBlock = inf ? `<details class="infobox" open><summary>這項檢查是什麼？</summary>${infoHtml(inf)}</details>` : '';
  h += pts.some(p => !isNaN(p.y)) ? lineChart([{ name, color: 'var(--accent)', pts }], { lines, labels: true, h: 180 }) : '';
  h += infoBlock;
  h += '<ul class="list" style="margin-top:8px">' + rs.slice().reverse().map(r => `<li class="row" data-vrow="${r._row}"><div class="grow">${fmtYMD(r['日期'])} ${esc(r['醫院'])}</div><b class="${r['異常'] === '★' ? 'bad' : ''}">${esc(r['數值'])}</b> <span class="sub">${esc(r['單位'])}</span> <button class="btn ghost small">改</button></li>`).join('') + '</ul>';
  openSheet(h);
  $('#sheetBody').querySelectorAll('[data-vrow]').forEach(li => li.onclick = () => editValue(rowsOf('健檢數值').find(r => r._row === +li.dataset.vrow)));
}

function editValue(r) {
  form('修改數值', [
    { k: '日期', type: 'date' }, { k: '醫院' }, { k: '類別' }, { k: '項目' },
    { k: '數值' }, { k: '單位' }, { k: '參考值' }, { k: '異常', type: 'select', options: ['', '★'], label: '異常（★）' },
  ], r, async o => write({ action: 'update', tab: '健檢數值', rowNum: r._row, match: r._raw.slice(0, 4).map(String), row: o }),
  async () => write({ action: 'delete', tab: '健檢數值', rowNum: r._row, match: r._raw.slice(0, 4).map(String) }, '已刪除'));
}

function addExamForm() {
  const { cats, order } = examItems();
  let h = `<h3>新增一次健檢<button class="btn ghost small" data-close>取消</button></h3>
    <div class="f2"><div class="f"><label>檢查日期</label><input type="date" id="exDate" value="${today()}"></div><div class="f"><label>醫院</label><input id="exHosp" placeholder="例如 敏盛"></div></div>
    <div class="sub" style="margin-bottom:8px">有做的項目才填，沒填的不會存。超出參考值會自動標★。</div>`;
  order.forEach(c => {
    h += `<div class="sec">${esc(c)}</div>`;
    Object.keys(cats[c]).forEach(name => {
      const it = cats[c][name];
      h += `<div class="f row"><label class="grow" style="margin:0">${esc(name)}<br><span class="sub">${esc([it.unit, it.ref].filter(Boolean).join('・'))}</span></label><input style="width:110px" inputmode="decimal" data-cat="${esc(c)}" data-name="${esc(name)}" data-unit="${esc(it.unit || '')}" data-ref="${esc(it.ref || '')}"></div>`;
    });
  });
  h += `<div class="sec">其他新項目</div><div id="extra"></div><button class="btn ghost small" id="moreItem">＋ 新項目</button>
    <div class="btns" style="margin-top:16px"><button class="btn" id="exSave">儲存</button></div>`;
  openSheet(h);
  $('#moreItem').onclick = () => {
    const d = document.createElement('div'); d.className = 'f2'; d.style.marginBottom = '8px';
    d.innerHTML = '<input placeholder="類別" class="xc"><input placeholder="項目" class="xn"><input placeholder="數值" class="xv" inputmode="decimal"><input placeholder="單位" class="xu"><input placeholder="參考值，例如 <100" class="xr" style="grid-column:span 2">';
    d.querySelectorAll('input').forEach(i => { i.style.cssText = 'font-size:16px;padding:8px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);width:100%'; });
    $('#extra').appendChild(d);
  };
  $('#exSave').onclick = async () => {
    const date = $('#exDate').value, hosp = $('#exHosp').value.trim();
    if (!date) return alert('請填日期');
    const rows = [];
    $('#sheetBody').querySelectorAll('input[data-name]').forEach(i => {
      const v = i.value.trim(); if (!v) return;
      rows.push({ 日期: date, 醫院: hosp, 類別: i.dataset.cat, 項目: i.dataset.name, 數值: isNaN(v) ? v : +v, 單位: i.dataset.unit, 參考值: i.dataset.ref, 異常: outOfRef(v, i.dataset.ref) ? '★' : '' });
    });
    $('#extra').querySelectorAll('.f2').forEach(d => {
      const g = c => d.querySelector(c).value.trim();
      if (!g('.xn') || !g('.xv')) return;
      rows.push({ 日期: date, 醫院: hosp, 類別: g('.xc') || '其他', 項目: g('.xn'), 數值: isNaN(g('.xv')) ? g('.xv') : +g('.xv'), 單位: g('.xu'), 參考值: g('.xr'), 異常: outOfRef(g('.xv'), g('.xr')) ? '★' : '' });
    });
    if (!rows.length) return alert('至少填一個數值');
    $('#exSave').disabled = true;
    if (await write({ action: 'addMany', tab: '健檢數值', rows }, `已新增 ${rows.length} 個數值`)) closeSheet();
    else $('#exSave').disabled = false;
  };
}

function editFinding(f) {
  const ed = examDates();
  form(f ? '修改檢查發現' : '新增檢查發現', [
    { k: '日期', type: 'date', def: state.sub.year || (ed.length ? ed[ed.length - 1].date : today()) },
    { k: '醫院', def: ed.length ? ed[ed.length - 1].hosp : '' }, { k: '類別', ph: '例如 腹部超音波' },
    { k: '發現', type: 'textarea' }, { k: '建議', type: 'textarea' },
    { k: '等級', type: 'select', options: ['盡快', '追蹤', '注意', '正常'], def: '注意' },
  ], f, async o => f ? write({ action: 'update', tab: '健檢發現', rowNum: f._row, match: f._raw.slice(0, 4).map(String), row: o }) : write({ action: 'add', tab: '健檢發現', row: o }),
  f ? async () => write({ action: 'delete', tab: '健檢發現', rowNum: f._row, match: f._raw.slice(0, 4).map(String) }, '已刪除') : null);
}

// 健檢「歷年比較」：圖表卡（預設）或表格
function examTrendHtml(ed) {
  const { cats, order } = examItems();
  const cat = state.sub.cat && cats[state.sub.cat] ? state.sub.cat : 'all';
  const view = state.sub.ev || 'chart';
  let h = '<div class="chips"><button data-c="all" class="' + (cat === 'all' ? 'on' : '') + '">全部</button>' + order.map(c => `<button data-c="${esc(c)}" class="${cat === c ? 'on' : ''}">${esc(c)}</button>`).join('') + '</div>';
  h += `<div class="viewtog"><button data-ev="chart" class="${view === 'chart' ? 'on' : ''}">📈 圖表</button><button data-ev="table" class="${view === 'table' ? 'on' : ''}">▦ 表格</button></div>`;
  (cat === 'all' ? order : [cat]).forEach(c => {
    if (view === 'chart') {
      const names = Object.keys(cats[c]);
      const bad = names.filter(n => { const s = examSeries(n); return s.length && s[s.length - 1].flag; }).length;
      h += `<div class="sec2 big">${esc(c)}${bad ? ` <span class="pill bad">${bad} 項超標</span>` : ''}</div><div class="cgrid">`;
      names.forEach(name => {
        const s = examSeries(name); if (!s.length) return;
        const x = s[s.length - 1];
        h += `<div class="ccard ${x.flag ? 'is-bad' : 'is-ok'}" data-item="${esc(name)}"><div class="kh"><span>${esc(name)}${infoFor(name) ? ' <i class="ibs">ⓘ</i>' : ''}</span><i class="dot"></i></div>
          <div class="kval">${esc(x.v)}<small>${esc(x.unit || '')}</small></div>
          ${spark(s, { labels: true, w: 160, h: 62 })}
          <div class="kf">${esc(x.ref ? '參考 ' + x.ref : '')}</div></div>`;
      });
      h += '</div>';
    } else {
      h += `<div class="card"><h2>${esc(c)}</h2><div class="tbl-wrap"><table class="tbl"><tr><th>項目</th>${ed.map(e => `<th>${String(e.date).slice(0, 4)}<br>${esc(e.hosp)}</th>`).join('')}</tr>`;
      Object.keys(cats[c]).forEach(name => {
        const it = cats[c][name];
        h += `<tr class="click" data-item="${esc(name)}"><td>${esc(name)}${infoFor(name) ? ' <span class="ibs">ⓘ</span>' : ''}<div class="ref">${esc([it.unit, it.ref].filter(Boolean).join('・'))}</div></td>` +
          ed.map(e => { const x = it.vals[e.date]; return x ? `<td class="${x.flag ? 'flag' : ''}">${esc(x.v)}</td>` : '<td class="muted">–</td>'; }).join('') + '</tr>';
      });
      h += '</table></div></div>';
    }
  });
  h += `<div class="sub" style="text-align:center;margin-top:8px">紅色＝最近一次超出參考值，虛線＝參考值，點卡片看詳細與說明</div>`;
  return h;
}

// ---------- 日常頁 ----------
function renderDaily(m) {
  const range = state.sub.range || 30;
  const rs = daily(range), prev = (() => { const from = iso(new Date(Date.now() - 2 * range * 864e5)), to = iso(new Date(Date.now() - range * 864e5)); return daily().filter(r => r['日期'] > from && r['日期'] <= to); })();
  const goals = goalMap();
  const xs = rs.map(r => { const d = parseD(r['日期']); return (d.getMonth() + 1) + '/' + d.getDate(); });
  const P = k => rs.map((r, i) => ({ x: xs[i], y: r[k] === '' || r[k] == null ? null : parseFloat(r[k]) }));
  const cmp = (k, dec, goodUp) => { const a = avg(rs, k), b = avg(prev, k); if (a == null) return ''; if (b == null) return ''; const d = a - b; if (Math.abs(d) < (dec ? 0.05 : 0.5)) return '<span class="ch0">持平</span>'; const good = goodUp == null ? null : (d > 0) === goodUp; return `<span class="${good == null ? 'ch0' : good ? 'chg' : 'chb'}">${d > 0 ? '▲' : '▼'} ${fmtNum(Math.abs(d), dec)}</span>`; };
  let h = '<div class="seg">' + [7, 30, 90, 365].map(n => `<button data-r="${n}" class="${range === n ? 'on' : ''}">${n === 365 ? '一年' : n + ' 天'}</button>`).join('') + '</div>';
  if (!rs.length) h += '<div class="card empty">這段期間沒有資料。<br>用捷徑從 Apple 健康同步，或按右下角＋手動記錄血壓、體重。</div>';
  else {
    const sA = avg(rs, '收縮壓'), dA = avg(rs, '舒張壓');
    h += `<div class="dsum">
      ${dsum('👟', '平均步數', fmtNum(avg(rs, '步數'), 0), '步', cmp('步數', 0, true), '步數', (avg(rs, '步數') || 0) >= (goals.steps || 8000) ? 'good' : 'warn')}
      ${dsum('❤️', '靜止心率', fmtNum(avg(rs, '靜止心率'), 0), '下/分', cmp('靜止心率', 0, false), '靜止心率')}
      ${dsum('🩸', '平均血壓', sA ? Math.round(sA) + '/' + Math.round(dA) : '–', '', cmp('收縮壓', 0, false), '血壓', sA && (sA >= 135 || dA >= 85) ? 'bad' : '')}
      ${dsum('⚖️', '體重', lastVal(rs, '體重') ? fmtNum(lastVal(rs, '體重').v, 1) : '–', 'kg', cmp('體重', 1, false), '體重')}
    </div><div class="sub" style="margin:-4px 4px 10px">箭頭是和前 ${range === 365 ? '一年' : range + ' 天'}比較</div>`;
    const card = (icon, color, title, info, sub, chart) => `<div class="card"><div class="ch"><span class="ci" style="--c:${color}">${icon}</span><h2>${title}</h2>${ib(info)}<span class="sub ml">${sub}</span></div>${chart}</div>`;
    h += card('👟', 'var(--accent)', '步數', '步數', '目標 ' + fmtNum(goals.steps || 8000), lineChart([{ name: '步數', color: 'var(--accent)', pts: P('步數').map(p => Object.assign(p, { c: p.y >= (goals.steps || 8000) ? 'var(--accent)' : 'var(--warn)' })) }], { bars: true, zero: true, lines: [{ y: goals.steps || 8000 }] }));
    if (rs.some(r => r['收縮壓'] !== '')) h += card('🩸', 'var(--bad)', '血壓', '血壓', bpSummary(rs), lineChart([{ name: '收縮壓', color: 'var(--bad)', pts: P('收縮壓') }, { name: '舒張壓', color: 'var(--blue)', pts: P('舒張壓') }], { connect: true, lines: [{ y: goals.sbp || 130 }, { y: goals.dbp || 80 }] }));
    else h += `<div class="card mini-empty"><span class="ci" style="--c:var(--bad)">🩸</span><div class="grow"><b>血壓</b><div class="sub">這段期間沒有量測。OMRON connect 開啟 Apple 健康同步，或按＋手動記錄</div></div></div>`;
    h += card('❤️', 'var(--bad)', '心率', '靜止心率', '靜止平均 ' + fmtNum(avg(rs, '靜止心率'), 0), lineChart([{ name: '靜止心率', color: 'var(--bad)', pts: P('靜止心率') }, { name: '平均心率', color: 'var(--warn)', pts: P('平均心率') }]));
    if (rs.some(r => r['HRV'] !== '' && r['HRV'] != null)) h += card('〰️', 'var(--blue)', '心率變異 HRV', 'HRV', '平均 ' + fmtNum(avg(rs, 'HRV'), 0) + ' ms', lineChart([{ name: 'HRV', color: 'var(--blue)', pts: P('HRV') }], { connect: true }));
    if (rs.some(r => r['體重'] !== '' && r['體重'] != null)) h += card('⚖️', 'var(--accent)', '體重', '體重', '目標 ' + (goals.weight || '–') + ' kg', lineChart([{ name: '體重', color: 'var(--accent)', pts: P('體重') }], { connect: true, lines: goals.weight ? [{ y: goals.weight }] : [] }));
    if (rs.some(r => r['體脂率'] !== '' && r['體脂率'] != null)) h += card('🧈', 'var(--warn)', '體脂率', '體脂率', '男性理想 11–23%', lineChart([{ name: '體脂率', color: 'var(--warn)', pts: P('體脂率') }], { connect: true, lines: [{ y: 23 }] }));
    if (rs.some(r => r['運動分鐘'] !== '' && r['運動分鐘'] != null)) h += card('🏃', 'var(--good)', '運動分鐘', '運動分鐘', '平均每天 ' + fmtNum(avg(rs, '運動分鐘'), 0), lineChart([{ name: '運動分鐘', color: 'var(--good)', pts: P('運動分鐘') }], { bars: true, zero: true, lines: [{ y: 30 }] }));
    if (rs.some(r => r['活動大卡'] !== '' && r['活動大卡'] != null)) h += card('🔥', 'var(--warn)', '活動消耗', '活動大卡', '平均 ' + fmtNum(avg(rs, '活動大卡'), 0) + ' 大卡', lineChart([{ name: '活動大卡', color: 'var(--warn)', pts: P('活動大卡') }], { bars: true, zero: true, lines: [{ y: 300 }] }));
    if (rs.some(r => r['睡眠小時'] !== '' && r['睡眠小時'] != null)) h += card('😴', 'var(--blue)', '睡眠', '睡眠', '平均 ' + fmtNum(avg(rs, '睡眠小時'), 1) + ' 小時', lineChart([{ name: '睡眠', color: 'var(--blue)', pts: P('睡眠小時') }], { bars: true, zero: true, lines: [{ y: goals.sleep || 7 }] }));
    h += `<div class="card"><div class="ch"><span class="ci" style="--c:var(--sub)">📅</span><h2>每日紀錄</h2></div><div class="dlist">` +
      rs.slice().reverse().slice(0, 60).map(r => `<div class="drow" data-day="${esc(r['日期'])}"><div class="dd"><b>${parseD(r['日期']).getDate()}</b><span>${parseD(r['日期']).getMonth() + 1}月・${W[parseD(r['日期']).getDay()]}</span></div>
        <div class="dvals"><span>👟 ${fmtNum(r['步數'])}</span>${r['靜止心率'] ? `<span>❤️ ${r['靜止心率']}</span>` : ''}${r['收縮壓'] ? `<span class="${+r['收縮壓'] >= 135 || +r['舒張壓'] >= 85 ? 'bad' : ''}">🩸 ${r['收縮壓']}/${r['舒張壓']}</span>` : ''}${r['體重'] ? `<span>⚖️ ${r['體重']}</span>` : ''}${r['運動分鐘'] ? `<span>🏃 ${r['運動分鐘']}</span>` : ''}${r['睡眠小時'] ? `<span>😴 ${r['睡眠小時']}</span>` : ''}</div></div>`).join('') + '</div></div>';
  }
  h += `<button class="add" id="addDaily" aria-label="手動記錄">＋</button>`;
  m.innerHTML = h;
  m.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { state.sub.range = +b.dataset.r; render(); });
  m.querySelectorAll('[data-day]').forEach(tr => tr.onclick = () => manualDaily(rowsOf('每日數據').find(r => r['日期'] === tr.dataset.day)));
  $('#addDaily').onclick = () => manualDaily(null);
}
function dsum(icon, k, v, unit, ch, info, cls) {
  return `<div class="dcard" data-info="${esc(info)}"><div class="sk">${icon} ${esc(k)}</div><div class="sv ${cls || ''}">${esc(v)}<small>${esc(unit)}</small></div><div class="ss">${ch || '&nbsp;'}</div></div>`;
}

// ---------- 健康存摺半年更新提醒（1/10、6/10 起，直到按「已更新」） ----------
function mhbDue() {
  const t = today(), y = +t.slice(0, 4);
  const cands = [(y - 1) + '-06-10', y + '-01-10', y + '-06-10'].filter(d => d <= t);
  return cands[cands.length - 1];
}
function checkMhb() {
  if (state.mhbShown || !state.fresh || !state.data || !state.data.tabs || !state.data.tabs['目標']) return;
  const row = rowsOf('目標').find(r => r.key === '_mhb');
  const last = row ? String(row['目標']).slice(0, 10) : '';
  const due = mhbDue();
  if (last && last >= due) return;
  state.mhbShown = true;
  openSheet(`<h3>📥 該更新健康存摺了</h3>
    <div class="info"><b>為什麼</b><div>每半年（1/10、6/10 起）把健保的就醫、檢驗、用藥紀錄更新進來，追蹤和病史才會完整。上次更新：${last ? fmtYMD(last) : '還沒有紀錄'}</div></div>
    <ol class="steps"><li>打開<b>健保快易通</b> → 健康存摺 → 下載服務 →「<b>JSON 下載</b>」</li><li>等「產製列表」出現檔案後下載</li><li>把 zip 檔存到 Google 雲端硬碟「<b>健康存摺</b>」資料夾</li><li>跟 Claude 說「匯入健康存摺」</li></ol>
    <div class="btns"><a class="btn" href="https://myhealthbank.nhi.gov.tw/" target="_blank" rel="noopener">開啟健康存摺網站</a><button class="btn ghost" id="mhbDone">✓ 我已經更新了</button></div>
    <div class="btns"><button class="btn ghost small" data-close>下次打開再提醒</button></div>`);
  $('#mhbDone').onclick = async () => {
    const ok = row ? await write({ action: 'update', tab: '目標', id: '_mhb', row: { 目標: today() } }, '已記錄，下次 ' + (today().slice(5) < '06-10' ? '6/10' : '1/10') + ' 再提醒')
      : await write({ action: 'add', tab: '目標', row: { key: '_mhb', 項目: '健康存摺上次更新', 目標: today(), 說明: 'App 用來判斷半年更新提醒，不要刪' } }, '已記錄');
    if (ok) closeSheet();
  };
}

function bpSummary(rs) {
  const s = avg(rs, '收縮壓'), d = avg(rs, '舒張壓');
  return s ? `平均 ${Math.round(s)}/${Math.round(d)}` : '沒有量測';
}
function manualDaily(r) {
  form(r ? '修改 ' + fmtD(r['日期']) : '手動記錄', [
    { k: '日期', type: 'date', def: today() },
    { k: '收縮壓', type: 'number' }, { k: '舒張壓', type: 'number' }, { k: '血壓脈搏', type: 'number', label: '脈搏' },
    { k: '體重', type: 'number' }, { k: '體脂率', type: 'number' }, { k: '步數', type: 'number' }, { k: '睡眠小時', type: 'number' },
    { k: '運動分鐘', type: 'number' },
    { k: '肌力', type: 'select', options: ['', '有做'], label: '肌力訓練' }, { k: '核心', type: 'select', options: ['', '有做'], label: '核心運動' },
  ], r ? Object.assign({}, r, { 肌力: r['肌力'] ? '有做' : '', 核心: r['核心'] ? '有做' : '' }) : null,
  async o => write({ action: 'sync', source: '手動', date: o['日期'], sys: o['收縮壓'], dia: o['舒張壓'], bpPulse: o['血壓脈搏'], weight: o['體重'], fat: o['體脂率'], steps: o['步數'], sleep: o['睡眠小時'], exMin: o['運動分鐘'], strength: o['肌力'] ? 1 : '', core: o['核心'] ? 1 : '' }),
  r ? async () => write({ action: 'delete', tab: '每日數據', id: r['日期'] }, '已刪除') : null);
}

// ---------- 就醫頁（預約＋病史） ----------
function renderCare(m) {
  const sub = state.sub.care || 'appt';
  let h = `<div class="seg"><button data-s="appt" class="${sub === 'appt' ? 'on' : ''}">預約看診</button><button data-s="hist" class="${sub === 'hist' ? 'on' : ''}">病史・手術</button></div>`;
  const t = today();
  if (sub === 'appt') {
    const all = rowsOf('預約').sort((a, b) => (a['日期'] + a['時間']).localeCompare(b['日期'] + b['時間']));
    const up = all.filter(a => a['狀態'] !== '已完成' && a['狀態'] !== '取消' && a['日期'] >= t);
    const past = all.filter(a => !up.includes(a)).reverse();
    h += `<div class="card"><h2>即將看診</h2>${up.length ? '<ul class="list">' + up.map(a => apptLi(a).replace('<li ', `<li data-a="${esc(a.id)}" `)).join('') + '</ul>' : '<div class="sub">沒有預約，按右下角＋新增</div>'}</div>`;
    if (past.length) h += `<div class="card"><h2>過去的看診</h2><ul class="list">${past.map(a => `<li class="row" data-a="${esc(a.id)}"><div class="grow"><div class="t">${fmtYMD(a['日期'])} ${esc(a['科別'])}</div><div class="sub">${esc([a['醫院'], a['事由'], a['備註']].filter(Boolean).join('・'))}</div></div><span class="pill ${a['狀態'] === '已完成' ? 'good' : ''}">${esc(a['狀態'] || '未完成')}</span></li>`).join('')}</ul></div>`;
    h += '<div class="sub" style="text-align:center">每天的捷徑通知會提醒 3 天內的看診；點預約可「加入行事曆」，到時間由 iPhone 準時提醒。</div>';
    h += `<button class="add" id="addAppt" aria-label="新增預約">＋</button>`;
  } else {
    const hs = rowsOf('病史').sort((a, b) => String(b['日期'] || '9999').localeCompare(String(a['日期'] || '9999')));
    const types = ['全部', ...new Set(hs.map(x => x['類型']).filter(Boolean))];
    const ty = state.sub.htype && types.includes(state.sub.htype) ? state.sub.htype : '全部';
    h += '<div class="chips">' + types.map(x => `<button data-t="${esc(x)}" class="${x === ty ? 'on' : ''}">${esc(x)}</button>`).join('') + '</div>';
    const list = hs.filter(x => ty === '全部' || x['類型'] === ty);
    h += `<div class="card"><ul class="list timeline">${list.map(x => `<li data-h="${esc(x.id)}"><div class="date-box"><b>${x['日期'] ? String(x['日期']).slice(0, 4) : '？'}</b><span>${x['日期'] ? String(x['日期']).slice(5, 7) + '月' : '未填'}</span></div><div class="grow"><div class="t">${esc(x['名稱'])} <span class="pill">${esc(x['類型'])}</span></div><div class="sub">${esc([x['醫院科別'], x['說明']].filter(Boolean).join('・'))}</div><span class="pill ${x['狀態'] === '追蹤中' ? 'warn' : x['狀態'] === '待確認' ? 'bad' : 'good'}">${esc(x['狀態'])}</span></div></li>`).join('') || '<li class="sub">沒有紀錄</li>'}</ul></div>`;
    h += `<button class="add" id="addHist" aria-label="新增病史">＋</button>`;
  }
  m.innerHTML = h;
  m.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { state.sub.care = b.dataset.s; render(); });
  m.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { state.sub.htype = b.dataset.t; render(); });
  m.querySelectorAll('[data-a]').forEach(li => li.onclick = () => showAppt(rowsOf('預約').find(a => a.id === li.dataset.a)));
  m.querySelectorAll('[data-h]').forEach(li => li.onclick = () => editHist(rowsOf('病史').find(a => a.id === li.dataset.h)));
  const aa = $('#addAppt'); if (aa) aa.onclick = () => editAppt(null);
  const ah = $('#addHist'); if (ah) ah.onclick = () => editHist(null);
}

const APPT_FIELDS = [
  { k: '日期', type: 'date' }, { k: '時間', type: 'time', def: '09:00' }, { k: '醫院' }, { k: '科別' }, { k: '醫師' },
  { k: '事由', ph: '例如 動脈瘤追蹤、抽血看報告' }, { k: '備註', type: 'textarea', ph: '要帶的東西、要問醫師的問題' },
  { k: '狀態', type: 'select', options: ['待看診', '已完成', '取消'], def: '待看診' },
];
function showAppt(a) {
  if (!a) return;
  let h = `<h3>${esc(a['科別'] || '看診')}<button class="btn ghost small" data-close>關閉</button></h3>
    <div class="kval"><b>${fmtYMD(a['日期'])}（${W[parseD(a['日期']).getDay()]}）${esc(a['時間'])}</b></div>
    <div>${esc([a['醫院'], a['醫師'] && a['醫師'] + ' 醫師'].filter(Boolean).join('・'))}</div>
    ${a['事由'] ? `<div class="sub">事由：${esc(a['事由'])}</div>` : ''}${a['備註'] ? `<div class="sub" style="white-space:pre-line">備註：${esc(a['備註'])}</div>` : ''}
    <div class="btns" style="margin-top:14px"><button class="btn" id="ics">📅 加入行事曆</button><button class="btn ghost" id="done">✓ 看診完成</button><button class="btn ghost" id="edit">修改</button></div>`;
  openSheet(h);
  $('#ics').onclick = () => downloadIcs(a);
  $('#edit').onclick = () => editAppt(a);
  $('#done').onclick = () => {
    const f = fuIds(a).length && rowsOf('追蹤項目').find(x => x.id === fuIds(a)[0]);
    if (f) return recordFu(f, null, a);
    form('看診完成：' + (a['事由'] || a['科別'] || ''), [
      { k: '結果', type: 'textarea', ph: '醫師怎麼說、有沒有開藥、下次什麼時候回診' },
      { k: '記到病史', type: 'select', options: ['是', '否'], def: '是' },
    ], null, async o => {
      const ops = [{ action: 'update', tab: '預約', id: a.id, row: { 狀態: '已完成', 備註: [a['備註'], o['結果'] && '結果：' + o['結果']].filter(Boolean).join('\n') } }];
      if (o['結果'] && o['記到病史'] === '是') ops.push({ action: 'add', tab: '病史', row: { 日期: a['日期'], 類型: '看診', 名稱: (a['事由'] || a['科別'] || '看診'), 醫院科別: [a['醫院'], a['科別']].filter(Boolean).join(' '), 說明: o['結果'], 狀態: '已完成' } });
      return write({ action: 'batch', ops }, '已記錄');
    });
  };
}
function editAppt(a, preset) {
  form(a ? '修改預約' : '新增預約', APPT_FIELDS, a || preset || null,
    async o => a ? write({ action: 'update', tab: '預約', id: a.id, row: o })
      : preset && preset['追蹤'] ? write({ action: 'batch', ops: [{ action: 'add', tab: '預約', row: Object.assign({ 追蹤: preset['追蹤'] }, o) }, { action: 'update', tab: '追蹤項目', id: preset['追蹤'], row: { 狀態: '已預約', 下次日期: o['日期'] } }] }, '已新增預約')
      : write({ action: 'add', tab: '預約', row: o }, '已新增預約'),
    a ? async () => write({ action: 'delete', tab: '預約', id: a.id }, '已刪除') : null,
    a ? null : '存好後點預約可以加入行事曆，到時間 iPhone 會準時提醒');
}
function downloadIcs(a) {
  const d = String(a['日期']).replace(/-/g, '');
  const tm = /^\d{1,2}:\d{2}$/.test(String(a['時間'])) ? String(a['時間']).padStart(5, '0').replace(':', '') + '00' : '090000';
  const end = (() => { const h = +tm.slice(0, 2) + 1; return pad(Math.min(h, 23)) + tm.slice(2); })();
  const e = s => String(s || '').replace(/[\\,;]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const title = '看診：' + [a['醫院'], a['科別']].filter(Boolean).join(' ');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//health-dashboard//TW', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    'UID:' + a.id + '-' + d + '@health-dashboard', 'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z',
    'DTSTART:' + d + 'T' + tm, 'DTEND:' + d + 'T' + end,
    'SUMMARY:' + e(title), 'LOCATION:' + e(a['醫院']), 'DESCRIPTION:' + e([a['事由'], a['醫師'] && a['醫師'] + ' 醫師', a['備註']].filter(Boolean).join('\n')),
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + e('明天' + title), 'TRIGGER:-P1D', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + e(title), 'TRIGGER:-PT2H', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = 'appointment-' + d + '.ics';
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast('打開後按「加入行事曆」：前一天和前 2 小時會提醒');
}
function editHist(x) {
  form(x ? '修改病史' : '新增病史・手術', [
    { k: '日期', type: 'date' },
    { k: '類型', type: 'select', options: ['手術', '疾病', '慢性病', '檢查', '看診', '用藥', '住院', '其他'], def: '手術' },
    { k: '名稱', ph: '例如 頸椎椎間盤突出手術' }, { k: '醫院科別', ph: '例如 長庚 神經外科' },
    { k: '說明', type: 'textarea', ph: '經過、醫師說明、術後注意事項' },
    { k: '狀態', type: 'select', options: ['已完成', '追蹤中', '已改善', '待確認'], def: '已完成' },
  ], x, async o => x ? write({ action: 'update', tab: '病史', id: x.id, row: o }) : write({ action: 'add', tab: '病史', row: o }, '已新增'),
  x ? async () => write({ action: 'delete', tab: '病史', id: x.id }, '已刪除') : null);
}

// ---------- 規劃頁 ----------
function goalMap() { const g = {}; rowsOf('目標').forEach(r => { g[r.key] = parseFloat(r['目標']); }); return g; }
function followups() {
  const t = today();
  return rowsOf('追蹤項目').filter(f => f['狀態'] !== '已完成' && f['狀態'] !== '停止')
    .map(f => { const ap = nextApptFor(f.id); return Object.assign(f, { _appt: ap, _d: ap ? diffDays(t, ap['日期']) : f['下次日期'] ? diffDays(t, f['下次日期']) : null }); })
    .sort((a, b) => (a._d == null ? 1e9 : a._d) - (b._d == null ? 1e9 : b._d));
}
function goalCurrent(key) {
  const d7 = daily(7), d30 = daily(30);
  const ex = k => { const x = latestExam(k); return x ? { v: parseFloat(x.v), src: String(x.date).slice(0, 4) + ' 健檢' } : null; };
  const dv = (k, rs, label) => { const a = avg(rs, k); return a ? { v: a, src: label } : null; };
  switch (key) {
    case 'steps': return dv('步數', d7, '近 7 天平均');
    case 'weight': { const w = lastVal(daily(), '體重'); return w ? { v: w.v, src: fmtYMD(w.date) } : ex('體重'); }
    case 'waist': return ex('腰圍');
    case 'sbp': return dv('收縮壓', d30, '近 30 天平均') || ex('收縮壓');
    case 'dbp': return dv('舒張壓', d30, '近 30 天平均') || ex('舒張壓');
    case 'ldl': return ex('LDL');
    case 'hdl': return ex('HDL');
    case 'a1c': return ex('HbA1c');
    case 'sleep': return dv('睡眠小時', d7, '近 7 天平均');
    default: return null;
  }
}
function goalOk(key, cur, target) {
  if (cur == null || isNaN(target)) return null;
  return ['steps', 'hdl', 'sleep'].includes(key) ? cur >= target : cur <= target;
}
function renderPlan(m) {
  const sub = state.sub.plan || 'goal';
  let h = `<div class="seg"><button data-s="goal" class="${sub === 'goal' ? 'on' : ''}">目標</button><button data-s="fu" class="${sub === 'fu' ? 'on' : ''}">追蹤</button><button data-s="ex" class="${sub === 'ex' ? 'on' : ''}">運動</button><button data-s="tip" class="${sub === 'tip' ? 'on' : ''}">建議</button></div>`;
  if (sub === 'goal') {
    h += '<div class="card"><h2>健康目標</h2><ul class="list">';
    rowsOf('目標').filter(g => !String(g.key).startsWith('_')).forEach(g => {
      const target = parseFloat(g['目標']); const c = goalCurrent(g.key); const ok = c ? goalOk(g.key, c.v, target) : null;
      let pct = null;
      if (c && !isNaN(target) && target > 0) pct = ['steps', 'hdl', 'sleep'].includes(g.key) ? c.v / target : target / c.v;
      h += `<li data-g="${esc(g.key)}"><div class="row"><div class="grow"><div class="t">${esc(g['項目'])} ${ib(g['項目'])}</div><div class="sub">${esc(g['說明'])}</div></div>
        <div style="text-align:right"><b class="${ok === true ? 'good' : ok === false ? 'warn' : ''}">${c ? fmtNum(c.v, c.v >= 100 || c.v % 1 === 0 ? 0 : 1) : '–'}</b> <span class="sub">/ ${esc(g['目標'])} ${esc(g['單位'])}</span><div class="sub">${c ? esc(c.src) : g.key === 'smoke' ? '自己記錄' : '還沒有資料'}</div></div></div>
        ${pct != null ? `<div class="prog"><i style="width:${Math.min(100, pct * 100).toFixed(0)}%;${ok ? '' : 'background:var(--warn)'}"></i></div>` : ''}</li>`;
    });
    h += '</ul><div class="sub" style="margin-top:6px">點目標可以修改數字。</div></div>';
  } else if (sub === 'fu') {
    const fu = followups();
    const done = rowsOf('追蹤項目').filter(f => f['狀態'] === '已完成' || f['狀態'] === '停止');
    h += `<div class="card"><h2>追蹤檢查時間表</h2><ul class="list">${fu.map(f => `<li data-f="${esc(f.id)}"><div class="row"><div class="grow"><div class="t">${esc(f['項目'])}</div><div class="sub">${esc([f['科別'], f['頻率']].filter(Boolean).join('・'))}</div>${f['依據'] ? `<div class="sub">依據：${esc(f['依據'])}</div>` : ''}<div class="sub">下次：${f['下次日期'] ? fmtYMD(f['下次日期']) : '未排'}${f['上次完成'] ? '・上次 ' + fmtYMD(f['上次完成']) : ''}</div>${lastRec(f.id) ? `<div class="sub">上次結果：${esc(String(lastRec(f.id)['結果']).slice(0, 40))}</div>` : ''}</div>${fuBadge(f)}</div></li>`).join('') || '<li class="sub">沒有待追蹤項目</li>'}</ul></div>`;
    if (done.length) h += `<div class="card"><h2>已完成／停止</h2><ul class="list">${done.map(f => `<li data-f="${esc(f.id)}" class="row"><div class="grow">${esc(f['項目'])}</div><span class="pill good">${esc(f['狀態'])}</span></li>`).join('')}</ul></div>`;
    h += `<div class="sub" style="text-align:center">追蹤日期是依健檢報告建議推算，實際請依醫師安排修改。</div><button class="add" id="addFu" aria-label="新增追蹤">＋</button>`;
  } else if (sub === 'ex') {
    h += renderExercise();
  } else {
    const tips = rowsOf('建議');
    const cats = [...new Set(tips.map(t => t['類別']).filter(Boolean))];
    h += `<div class="card"><h2>🔔 今天的通知內容</h2><div class="tip">${esc(state.data.tip || '（重新整理後顯示）')}</div></div>`;
    cats.forEach(c => {
      h += `<div class="card"><h2>${esc(c)}</h2><ul class="list">${tips.filter(t => t['類別'] === c).map(t => `<li class="row" data-t="${esc(t.id)}"><div class="grow ${t['啟用'] === '否' ? 'muted' : ''}">${esc(t['內容'])}</div>${t['啟用'] === '否' ? '<span class="pill">不提醒</span>' : ''}</li>`).join('')}</ul></div>`;
    });
    h += `<div class="sub" style="text-align:center">每天的通知會輪流挑一則「提醒」的建議。</div><button class="add" id="addTip" aria-label="新增建議">＋</button>`;
  }
  m.innerHTML = h;
  m.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { state.sub.plan = b.dataset.s; render(); });
  m.querySelectorAll('[data-g]').forEach(li => li.onclick = () => editGoal(rowsOf('目標').find(g => g.key === li.dataset.g)));
  m.querySelectorAll('[data-f]').forEach(li => li.onclick = () => showFu(rowsOf('追蹤項目').find(f => f.id === li.dataset.f)));
  m.querySelectorAll('[data-t]').forEach(li => li.onclick = () => editTip(rowsOf('建議').find(t => t.id === li.dataset.t)));
  m.querySelectorAll('[data-ex]').forEach(li => li.onclick = () => editEx(rowsOf('運動指標').find(t => t.key === li.dataset.ex)));
  const af = $('#addFu'); if (af) af.onclick = () => editFu(null);
  const at = $('#addTip'); if (at) at.onclick = () => editTip(null);
}
function periodSum(key, from) {
  const rs = daily().filter(r => r['日期'] >= from && r['日期'] <= today());
  const col = { exmin: '運動分鐘', steps: '步數', energy: '活動大卡', sleep: '睡眠小時', strength: '肌力', core: '核心' }[key];
  if (!col) return null;
  let sum = 0;
  rs.forEach(r => { const v = parseFloat(r[col]); if (!isNaN(v)) sum += (key === 'strength' || key === 'core') ? (v > 0 ? 1 : 0) : v; });
  return sum;
}
function weekStart() { const d = new Date(); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return iso(d); }
function renderExercise() {
  const ex = rowsOf('運動指標');
  if (!ex.length) return '<div class="card empty">試算表還沒有「運動指標」分頁</div>';
  const ws = weekStart(), ms = today().slice(0, 8) + '01';
  const bar = (cur, tgt) => { const p = tgt > 0 ? Math.min(100, cur / tgt * 100) : 0; return `<div class="prog"><i style="width:${p.toFixed(0)}%;${cur >= tgt ? '' : 'background:var(--warn)'}"></i></div>`; };
  let h = `<div class="card"><h2>🏃 本週與本月進度</h2><div class="sub" style="margin-bottom:6px">本週從 ${fmtD(ws)} 起・本月從 ${fmtD(ms)} 起，數據來自 Apple Watch 與手動記錄</div><ul class="list">`;
  ex.filter(x => x['每週目標'] !== '' || x['每月目標'] !== '').forEach(x => {
    const w = periodSum(x.key, ws), mo = periodSum(x.key, ms), u = x['單位'];
    const f = v => v == null ? '–' : fmtNum(v, v % 1 ? 1 : 0);
    h += `<li data-ex="${esc(x.key)}"><div class="t">${esc(x['項目'])} ${ib(x['項目'])}</div>
      <div class="f2" style="margin-top:4px"><div><div class="sub">本週 <b style="color:var(--text)">${f(w)}</b> / ${esc(x['每週目標'])} ${esc(u)}</div>${w != null ? bar(w, +x['每週目標']) : ''}</div>
      <div><div class="sub">本月 <b style="color:var(--text)">${f(mo)}</b> / ${esc(x['每月目標'])} ${esc(u)}</div>${mo != null ? bar(mo, +x['每月目標']) : ''}</div></div>
      <div class="sub" style="margin-top:4px">${esc(x['說明'])}</div></li>`;
  });
  h += '</ul></div>';
  // 近 8 週運動分鐘
  const weeks = [];
  for (let k = 7; k >= 0; k--) { const d = parseD(ws); d.setDate(d.getDate() - 7 * k); const a = iso(d); const e = new Date(d); e.setDate(e.getDate() + 6); weeks.push({ a, b: iso(e) }); }
  const pts = weeks.map(w => { let s = 0, any = false; daily().forEach(r => { if (r['日期'] >= w.a && r['日期'] <= w.b && r['運動分鐘'] !== '' && r['運動分鐘'] != null) { s += +r['運動分鐘']; any = true; } }); const d = parseD(w.a); return { x: (d.getMonth() + 1) + '/' + d.getDate(), y: any ? s : null }; });
  const tgt = +(ex.find(x => x.key === 'exmin') || {})['每週目標'] || 150;
  h += `<div class="card"><h2>📊 近 8 週運動分鐘</h2>${lineChart([{ name: '每週運動分鐘', color: 'var(--good)', pts: pts.map(p => Object.assign(p, { c: p.y >= tgt ? 'var(--good)' : 'var(--warn)' })) }], { bars: true, zero: true, lines: [{ y: tgt, label: '每週 ' + tgt + ' 分鐘' }] })}</div>`;
  ex.filter(x => x['每週目標'] === '' && x['每月目標'] === '').forEach(x => { h += `<div class="card" data-ex="${esc(x.key)}"><h2>📌 ${esc(x['項目'])}</h2><div>${esc(x['說明'])}</div></div>`; });
  h += '<div class="sub" style="text-align:center">肌力、核心運動在「日常」右下角＋手動勾選；點項目可以改目標。</div>';
  return h;
}
function editEx(x) {
  if (!x) return;
  form('修改：' + x['項目'], [{ k: '每週目標', type: 'number' }, { k: '每月目標', type: 'number' }, { k: '單位' }, { k: '說明', type: 'textarea' }], x,
    async o => write({ action: 'update', tab: '運動指標', id: x.key, row: o }));
}
function editGoal(g) {
  form('修改目標：' + g['項目'], [{ k: '目標', type: 'number' }, { k: '單位' }, { k: '說明', type: 'textarea' }], g,
    async o => write({ action: 'update', tab: '目標', id: g.key, row: o }));
}
function fuRecords(id) { return rowsOf('追蹤紀錄').filter(r => r['追蹤id'] === id).sort((a, b) => String(b['日期']).localeCompare(String(a['日期']))); }
function lastRec(id) { return fuRecords(id)[0] || null; }
function fuMonths(f) {
  const m = String(f['頻率']).match(/(\d+)\s*個月/); const y = String(f['頻率']).match(/每\s*(\d*)\s*年|每年/);
  return m ? +m[1] : y ? (+(y[1] || 1) * 12) : 6;
}
function showFu(f) {
  if (!f) return;
  const recs = fuRecords(f.id);
  const appt = rowsOf('預約').filter(a => fuIds(a).includes(f.id) && a['狀態'] === '待看診' && a['日期'] >= today()).sort((a, b) => String(a['日期']).localeCompare(String(b['日期'])))[0];
  let h = `<h3>${esc(f['項目'])}<button class="btn ghost small" data-close>關閉</button></h3>
    <div class="sub">${esc([f['科別'], f['頻率']].filter(Boolean).join('・'))}</div>${f['依據'] ? `<div>依據：${esc(f['依據'])}</div>` : ''}
    <div class="kv" style="margin-top:8px">下次追蹤：<b>${f['下次日期'] ? fmtYMD(f['下次日期']) : '未排'}</b> ${f['下次日期'] ? dueBadge(diffDays(today(), f['下次日期'])) : ''}
      ${appt ? `<br>📅 已預約 ${fmtYMD(appt['日期'])} ${esc(appt['時間'])} ${esc(appt['醫院'])}` : ''}</div>
    <div class="btns"><button class="btn" id="fuRec">📝 記錄這次追蹤</button>${appt ? '' : '<button class="btn ghost" id="mkAppt">📅 預約下次</button>'}<button class="btn ghost" id="fuEdit">修改項目</button></div>
    <div class="sec">追蹤紀錄</div>
    ${recs.length ? '<ul class="list">' + recs.map(r => `<li data-rec="${esc(r.id)}"><div class="row"><b class="grow">${fmtYMD(r['日期'])}</b><span class="sub">${esc(r['醫院科別'])}</span></div><div style="white-space:pre-line">${esc(r['結果'] || '（沒寫結果）')}</div>${r['下次日期'] ? `<div class="sub">→ 下次 ${fmtYMD(r['下次日期'])}</div>` : ''}</li>`).join('') + '</ul>'
      : `<div class="sub">還沒有紀錄。${f['上次完成'] ? '上次完成 ' + fmtYMD(f['上次完成']) + '（來自健檢）' : ''}</div>`}`;
  openSheet(h);
  const ma = $('#mkAppt'); if (ma) ma.onclick = () => editAppt(null, { 日期: f['下次日期'] && f['下次日期'] >= today() ? f['下次日期'] : '', 科別: f['科別'], 事由: f['項目'], 追蹤: f.id });
  $('#fuEdit').onclick = () => editFu(f);
  $('#fuRec').onclick = () => recordFu(f, null, appt && appt['日期'] <= today() ? appt : null);
  $('#sheetBody').querySelectorAll('[data-rec]').forEach(li => li.onclick = () => recordFu(f, recs.find(r => r.id === li.dataset.rec)));
}
// 記錄一次追蹤：寫追蹤紀錄、更新追蹤項目，可順便建立下次預約；從預約進來會把預約標成完成
function recordFu(f, rec, appt) {
  const months = fuMonths(f);
  const base = rec ? rec['日期'] : appt ? appt['日期'] : today();
  form(rec ? '修改追蹤紀錄' : '記錄追蹤：' + f['項目'], [
    { k: '日期', type: 'date', def: base, label: '這次追蹤的日期' },
    { k: '醫院科別', def: appt ? [appt['醫院'], appt['科別']].filter(Boolean).join(' ') : f['科別'] },
    { k: '結果', type: 'textarea', ph: '例如：大小沒變、維持 0.2 cm；醫師說一年後再追' },
    { k: '下次日期', type: 'date', def: rec ? rec['下次日期'] : addMonths(base, months), label: '下次追蹤日期（預設 ' + months + ' 個月後，依醫師說的改）' },
    ...(rec ? [] : [
      { k: '下次預約', type: 'select', options: ['先不用', '建立預約'], def: '先不用', label: '同時建立下次預約' },
      { k: '時間', type: 'time', def: '09:00', label: '預約時間（建立預約才用到）' },
      { k: '醫院', def: appt ? appt['醫院'] : '', label: '預約醫院（建立預約才用到）' },
      { k: '後續', type: 'select', options: ['繼續追蹤', '不用再追蹤'], def: '繼續追蹤' },
    ]),
    { k: '備註', type: 'textarea' },
  ], rec, async o => {
    const row = { 追蹤id: f.id, 日期: o['日期'], 醫院科別: o['醫院科別'], 結果: o['結果'], 下次日期: o['下次日期'], 備註: o['備註'] };
    if (rec) return write({ action: 'update', tab: '追蹤紀錄', id: rec.id, row }, '已修改');
    const stop = o['後續'] === '不用再追蹤', mk = !stop && o['下次預約'] === '建立預約' && o['下次日期'];
    const ops = [{ action: 'add', tab: '追蹤紀錄', row },
      { action: 'update', tab: '追蹤項目', id: f.id, row: { 上次完成: o['日期'], 下次日期: stop ? '' : o['下次日期'], 狀態: stop ? '已完成' : mk ? '已預約' : '待安排' } }];
    if (appt) ops.push({ action: 'update', tab: '預約', id: appt.id, row: { 狀態: '已完成' } });
    if (mk) ops.push({ action: 'add', tab: '預約', row: { 日期: o['下次日期'], 時間: o['時間'], 醫院: o['醫院'], 科別: f['科別'], 事由: f['項目'], 狀態: '待看診', 追蹤: f.id } });
    return write({ action: 'batch', ops }, mk ? '已記錄，也建立了下次預約' : '已記錄');
  }, rec ? async () => write({ action: 'delete', tab: '追蹤紀錄', id: rec.id }, '已刪除') : null);
}
function editFu(f) {
  form(f ? '修改追蹤項目' : '新增追蹤項目', [
    { k: '項目' }, { k: '科別' }, { k: '頻率', ph: '例如 每 6 個月、每年' }, { k: '下次日期', type: 'date' },
    { k: '依據', type: 'textarea' }, { k: '狀態', type: 'select', options: ['待安排', '已預約', '待確認', '已完成', '停止'], def: '待安排' }, { k: '上次完成', type: 'date' },
  ], f, async o => f ? write({ action: 'update', tab: '追蹤項目', id: f.id, row: o }) : write({ action: 'add', tab: '追蹤項目', row: o }, '已新增'),
  f ? async () => write({ action: 'delete', tab: '追蹤項目', id: f.id }, '已刪除') : null);
}
function editTip(t) {
  form(t ? '修改建議' : '新增建議', [{ k: '類別', ph: '例如 飲食、運動' }, { k: '內容', type: 'textarea' }, { k: '啟用', type: 'select', options: ['是', '否'], def: '是', label: '放進每日通知' }], t,
    async o => t ? write({ action: 'update', tab: '建議', id: t.id, row: o }) : write({ action: 'add', tab: '建議', row: o }, '已新增'),
    t ? async () => write({ action: 'delete', tab: '建議', id: t.id }, '已刪除') : null);
}

// ---------- 通用表單 ----------
function form(title, fields, rec, onSave, onDelete, note) {
  let h = `<h3>${esc(title)}<button class="btn ghost small" data-close>取消</button></h3>`;
  if (note) h += `<div class="sub" style="margin-bottom:8px">${esc(note)}</div>`;
  fields.forEach((f, i) => {
    const v = rec && rec[f.k] !== undefined && rec[f.k] !== '' ? rec[f.k] : (f.def ?? '');
    const id = 'ff' + i, lab = `<label for="${id}">${esc(f.label || f.k)}</label>`;
    let inp;
    if (f.type === 'select') inp = `<select id="${id}">${f.options.map(o => `<option ${String(o) === String(v) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    else if (f.type === 'textarea') inp = `<textarea id="${id}" placeholder="${esc(f.ph || '')}">${esc(v)}</textarea>`;
    else inp = `<input id="${id}" type="${f.type === 'number' ? 'text' : (f.type || 'text')}" ${f.type === 'number' ? 'inputmode="decimal"' : ''} value="${esc(v)}" placeholder="${esc(f.ph || '')}">`;
    h += `<div class="f">${lab}${inp}</div>`;
  });
  h += `<div class="btns" style="margin-top:14px"><button class="btn" id="fSave">儲存</button>${onDelete ? '<button class="btn danger" id="fDel">刪除</button>' : ''}</div>`;
  openSheet(h);
  $('#fSave').onclick = async () => {
    const o = {};
    fields.forEach((f, i) => { let v = $('#ff' + i).value.trim(); if (f.type === 'number' && v !== '' && !isNaN(v)) v = +v; o[f.k] = v; });
    $('#fSave').disabled = true;
    if (await onSave(o)) closeSheet(); else $('#fSave').disabled = false;
  };
  if (onDelete) $('#fDel').onclick = async () => { if (!confirm('確定刪除？')) return; if (await onDelete()) closeSheet(); };
}
function openSheet(html) {
  $('#sheetBody').innerHTML = html; $('#sheet').classList.remove('hidden');
  $('#sheetBody').querySelectorAll('[data-close]').forEach(b => b.onclick = closeSheet);
  $('#sheet').querySelector('.sheet-card').scrollTop = 0;
}
function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheetBody').innerHTML = ''; }
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

// ---------- 設定 ----------
function openSettings() {
  const c = state.cfg;
  const at = state.data && state.data.at ? new Date(state.data.at).toLocaleString('zh-TW', { hour12: false }) : '–';
  let h = `<h3>設定<button class="btn ghost small" data-close>關閉</button></h3>
    <div class="f"><label>Apps Script 網址</label><input id="sUrl" value="${esc(c.url || '')}" placeholder="https://script.google.com/macros/s/…/exec" autocapitalize="off"></div>
    <div class="f"><label>密碼（指令碼屬性 KEY）</label><input id="sKey" type="password" value="${esc(c.key || '')}"></div>
    <div class="btns"><button class="btn" id="sSave">儲存並連線</button>${state.data && state.data.sheetUrl ? `<a class="btn ghost" href="${esc(state.data.sheetUrl)}" target="_blank" rel="noopener">開啟試算表</a>` : ''}</div>
    <div class="sub" style="margin-top:8px">上次更新：${esc(at)}・App ${APP_VERSION}</div>
    <div class="sec">Apple 健康・歐姆龍血壓</div>
    <div class="card" style="background:var(--bg)"><button class="btn ghost" id="sGuide" style="width:100%">📲 捷徑設定教學（每天自動同步＋通知）</button></div>
    <div class="sec">其他</div>
    <div class="btns"><button class="btn ghost" id="sClear">清除這台手機的快取</button></div>`;
  openSheet(h);
  $('#sSave').onclick = async () => {
    state.cfg = { url: $('#sUrl').value.trim(), key: $('#sKey').value.trim() };
    lsSet(LS.cfg, state.cfg); closeSheet(); await refresh();
  };
  $('#sGuide').onclick = openGuide;
  $('#sClear').onclick = () => { if (!confirm('清除後要重新整理才會有資料，確定？')) return; localStorage.removeItem(LS.cache); state.data = null; closeSheet(); render(); };
}

function openGuide() {
  const url = state.cfg.url || '（先在設定填 Apps Script 網址）';
  const h = `<h3>捷徑設定教學<button class="btn ghost small" data-close>關閉</button></h3><div class="guide">
  <p class="sub">iPhone 的網頁 App 不能直接讀 Apple 健康，所以用「捷徑」每天讀一次再送到試算表。歐姆龍 OMRON connect 先在它的設定裡開啟「Apple 健康」同步，血壓就會進到 Apple 健康；米家體脂秤 S400 要用「小米運動健康」App 綁定並開啟 Apple 健康同步，體重、體脂才會進去。捷徑再一起讀。</p>
  <div class="sec">一、建立捷徑「健康同步」</div>
  <ol>
    <li>打開「捷徑」App → 右上角＋ → 名稱改成 <b>健康同步</b>。</li>
    <li>加入動作「<b>尋找健康樣本</b>」：類型選 <b>步數</b>，條件「開始日期」<b>是今天</b>。接著加「<b>計算統計資料</b>」選 <b>總和</b>，再加「<b>設定變數</b>」命名 <code>steps</code>。</li>
    <li>同樣做法（尋找 → 計算統計資料 → 設定變數），每一項做一組：
      <div class="kval">靜止心率：今天、<b>平均</b> → <code>restingHR</code><br>心率：今天、<b>平均</b> → <code>avgHR</code>；再一組 <b>最大值</b> → <code>maxHR</code><br>心率變異性：今天、<b>平均</b> → <code>hrv</code><br>動態能量（活動能量）：今天、<b>總和</b> → <code>energy</code><br>運動分鐘（Apple Watch 綠圈）：今天、<b>總和</b> → <code>exMin</code><br>收縮壓：今天、<b>平均</b> → <code>sys</code><br>舒張壓：今天、<b>平均</b> → <code>dia</code><br>體重：開始日期<b>在過去 7 天</b>、排序最新、限制 1 個 → <code>weight</code>（不用計算統計）<br>身體脂肪百分比：同體重的設定 → <code>fat</code><br>睡眠分析（可選）：開始日期在<b>過去 1 天</b>、值<b>不是「在床上」</b> → 加「取得健康樣本的詳細資訊」選<b>持續時間</b> → 計算統計資料<b>總和</b> → <code>sleep</code></div>
      不需要的項目可以跳過，沒有的資料會自動略過。</li>
    <li>加入動作「<b>取得 URL 內容</b>」：網址填下面這個；展開後方法選 <b>POST</b>，要求本文選 <b>JSON</b>，新增欄位（類型都選「文字」，值點變數）：
      <div class="kval"><code>${esc(url)}</code><br><button class="btn ghost small" id="cpUrl" style="margin-top:6px">複製網址</button></div>
      <div class="kval"><code>key</code>＝你的密碼<br><code>action</code>＝<code>sync</code><br><code>date</code>＝「目前日期」（點變數後格式選「自訂」<code>yyyy-MM-dd</code>）<br><code>steps</code>、<code>restingHR</code>、<code>avgHR</code>、<code>maxHR</code>、<code>hrv</code>、<code>energy</code>、<code>exMin</code>、<code>sys</code>、<code>dia</code>、<code>weight</code>、<code>fat</code>、<code>sleep</code>＝對應的變數</div></li>
    <li>加入「<b>取得字典值</b>」：鍵 <code>text</code>，字典選上一步的「URL 內容」。</li>
    <li>加入「<b>顯示通知</b>」，內容選上一步的「字典值」。</li>
    <li>按▶︎ 試跑一次，第一次會問健康資料權限，全部允許。跑完回 App 重新整理，「日常」就會有今天的資料。</li>
  </ol>
  <div class="sec">二、每天自動執行</div>
  <ol><li>捷徑 App 下方「自動化」→ ＋ →「特定時間」→ 例如 <b>每天 21:30</b>。</li>
  <li>選「<b>立即執行</b>」（不要詢問），動作選「執行捷徑 → 健康同步」。之後每天晚上自動同步，並跳出通知：今天的數據、3 天內的看診、到期的追蹤檢查、一則生活建議。</li></ol>
  <div class="sec">三、早上再提醒一次（可選）</div>
  <ol><li>複製一個捷徑叫「健康提醒」，只留「取得 URL 內容」（<code>action</code> 改成 <code>tip</code>，其他欄位刪掉，只留 <code>key</code>）、「取得字典值」、「顯示通知」。</li>
  <li>自動化設每天 <b>07:30</b> 執行它，早上就會看到今天的看診和建議。</li></ol>
  <div class="sec">看診準時提醒</div>
  <p>在「就醫 → 預約看診」點一筆預約 →「加入行事曆」，iPhone 行事曆會在前一天和前 2 小時提醒。</p>
  </div>`;
  openSheet(h);
  const cp = $('#cpUrl'); if (cp) cp.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(state.cfg.url || '').then(() => toast('已複製')); };
}

// ---------- 導覽 ----------
function go(p) { state.page = p; try { localStorage.setItem(LS.page, p); } catch (e) {} window.scrollTo(0, 0); render(); }
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => go(b.dataset.page));
$('#btnRefresh').onclick = () => refresh();
$('#btnSettings').onclick = openSettings;
try { const p = localStorage.getItem(LS.page); if (p && ['home', 'exam', 'daily', 'care', 'plan'].includes(p)) state.page = p; } catch (e) {}
render();
if (state.cfg.url) refresh(true); else if (!state.data) openSettings();
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.cfg.url && state.data && Date.now() - (state.data.at || 0) > 5 * 60 * 1000) refresh(true); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
