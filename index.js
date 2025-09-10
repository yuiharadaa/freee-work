// index.js v30 (Chart.js 版：当日表示、退勤時のみ再描画、0:00にリセット)
console.log('[INDEX.JS] Chart.js version v30');

const OPEN_HOUR = 9;
const CLOSE_HOUR = 22;
const DAY_MINUTES = (CLOSE_HOUR - OPEN_HOUR) * 60;

// 当日のキー（0:00で更新）
let currentDay = ymd(new Date());

// ポジション→色（Chart.js用）
const POS_COLOR = {
  'レジ':      '#2563eb',
  'ドリンカー':'#16a34a',
  'フライヤー':'#f59e0b',
  'バーガー':  '#ef4444',
  '休憩':      '#9ca3af'
};

// 既存CSSのクラス名→ポジション名（自家製buildIntervalsのclassNameから復元する用）
function classToPosName(cls) {
  if (!cls) return 'レジ';
  if (cls.includes('reji'))   return 'レジ';
  if (cls.includes('drink'))  return 'ドリンカー';
  if (cls.includes('fry'))    return 'フライヤー';
  if (cls.includes('burger')) return 'バーガー';
  return 'レジ';
}

// Chart.js インスタンス（グローバル）
let ganttChart = null;

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await renderEmployeeList();
    await refreshGantt(); // 初期描画（今日）

    // detail からの打刻通知：当日内の「退勤」のみ再描画
    try {
      const bc = new BroadcastChannel('punch');
      bc.onmessage = (ev) => {
        const d = ev?.data || {};
        const atTs = d.at ? new Date(d.at) : new Date();
        if (d.kind === 'punch' && d.punchType === '退勤' && ymd(atTs) === currentDay) {
          refreshGantt();
        }
      };
    } catch {}

    // 0:00 で日替わりリセット（前日のグラフは表示しない）
    setMidnightTimer();
  } catch (e) {
    console.error(e);
  }
});

/* ===== 0:00 リセット ===== */
function setMidnightTimer() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  setTimeout(() => {
    currentDay = ymd(new Date());
    // 当日を空で表示（チャートを空データにして更新）
    renderChartFromIntervals(new Map()); 
    setMidnightTimer();
  }, next - now);
}

/* ===== 従業員一覧（そのまま） ===== */
async function renderEmployeeList() {
  const ul = document.getElementById('employeeList');
  const tpl = document.getElementById('tpl-employee-item');
  if (!ul || !tpl) return;

  try {
    const raw = await API.fetchEmployees();
    const employees = normalizeEmployees(raw);
    const frag = document.createDocumentFragment();
    employees.forEach(emp => {
      const node = tpl.content.cloneNode(true);
      const a = node.querySelector('.emp-link');
      a.textContent = API.escapeHtml(emp.name ?? String(emp.id ?? emp.employeeId ?? ''));
      a.href = `./detail.html?empId=${encodeURIComponent(emp.id ?? emp.employeeId)}`;
      frag.appendChild(node);
    });
    ul.textContent = '';
    ul.appendChild(frag);
  } catch (e) {
    console.error(e);
    ul.textContent = '従業員一覧の取得に失敗しました。';
  }
}

/* ===== ガント再描画（currentDay のみ対象） ===== */
async function refreshGantt() {
  const canvas = document.getElementById('ganttCanvas');
  if (!canvas) return;

  try {
    const raw = await API.fetchEmployees();
    const emps = normalizeEmployees(raw);
    const allRows = [];

    for (const e of emps) {
      const id = coerceId(e);
      if (!id) continue;

      try {
        const rows = await API.fetchHistory({ employeeId: id, days: 1 });
        rows
          .filter(r => normalizeDateStr(r.date) === currentDay)
          .forEach(r => {
            r.employeeId = r.employeeId ?? id;
            r.employeeName = r.employeeName || e.name || String(id);
            allRows.push(r);
          });
      } catch (err) {
        console.warn('[GANTT] 履歴取得失敗:', { id, name: e?.name, err });
      }
    }

    const intervalsByEmp = buildIntervals(allRows);
    renderChartFromIntervals(intervalsByEmp);
  } catch (e) {
    console.error(e);
    // 失敗時は空表示
    renderChartFromIntervals(new Map());
  }
}

/* ===== Chart.js 描画 ===== */

// 今日の 09:00 と 22:00 のISO
function dayBoundsISO(d = new Date()){
  const y=d.getFullYear(), m=d.getMonth(), day=d.getDate();
  const min = new Date(y,m,day,OPEN_HOUR,0,0).toISOString();
  const max = new Date(y,m,day,CLOSE_HOUR,0,0).toISOString();
  return {min,max};
}

// buildIntervals(Map) → Chart.js datasets へ変換
function toChartDatasets(intervalsByEmp){
  const byPos = new Map(); // posName -> [{x:[startISO,endISO], y:'従業員名'}]

  intervalsByEmp.forEach(info=>{
    // 勤務セグメント（ポジション色）
    info.work.forEach(seg=>{
      const posName = classToPosName(seg.className); // 'レジ' 等に変換
      const arr = byPos.get(posName) || [];
      const base = new Date();
      const y=base.getFullYear(), m=base.getMonth(), d=base.getDate();
      const open = new Date(y,m,d,OPEN_HOUR,0,0).getTime();
      const startISO = new Date(open + seg.startMin*60*1000).toISOString();
      const endISO   = new Date(open + seg.endMin*60*1000).toISOString();
      arr.push({ x:[startISO,endISO], y: info.name });
      byPos.set(posName, arr);
    });

    // 休憩セグメント（グレー）
    info.breaks.forEach(seg=>{
      const arr = byPos.get('休憩') || [];
      const base = new Date();
      const y=base.getFullYear(), m=base.getMonth(), d=base.getDate();
      const open = new Date(y,m,d,OPEN_HOUR,0,0).getTime();
      const startISO = new Date(open + seg.startMin*60*1000).toISOString();
      const endISO   = new Date(open + seg.endMin*60*1000).toISOString();
      arr.push({ x:[startISO,endISO], y: info.name });
      byPos.set('休憩', arr);
    });
  });

  const datasets = [];
  byPos.forEach((data, posName)=>{
    datasets.push({
      type: 'bar',
      label: posName,
      data,
      parsing: { xAxisKey: 'x', yAxisKey: 'y' }, // x は [start,end] の浮動バー
      borderSkipped: false,
      borderWidth: 0,
      backgroundColor: POS_COLOR[posName] || '#999',
      barThickness: 14
    });
  });
  return datasets;
}

function renderChartFromIntervals(intervalsByEmp){
  const canvas = document.getElementById('ganttCanvas');
  if (!canvas) return;

  // Y軸ラベル（従業員名）
  const names = [];
  intervalsByEmp.forEach(info=>{ if(!names.includes(info.name)) names.push(info.name); });

  // データセット
  const datasets = toChartDatasets(intervalsByEmp);
  const {min,max} = dayBoundsISO();

  // 行数に応じて高さを自動調整（1人あたり 36px + 余白）
  const baseH = 60;
  const perRow = 36;
  canvas.style.height = `${baseH + Math.max(1, names.length)*perRow}px`;

  const config = {
    type: 'bar',
    data: { datasets },
    options: {
      indexAxis: 'y',                 // 横棒
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        // 下側の時間軸
        xBottom: {
          type: 'time',
          position: 'bottom',
          time: { unit: 'hour', displayFormats: { hour: 'HH:mm' } },
          min, max,
          grid: { drawOnChartArea: true },
          ticks: { source: 'auto', maxRotation: 0 }
        },
        // 上側の時間軸（→ これで“上部に時間表示”）
        xTop: {
          type: 'time',
          position: 'top',
          time: { unit: 'hour', displayFormats: { hour: 'HH:mm' } },
          min, max,
          grid: { drawOnChartArea: false },
          ticks: { source: 'auto', maxRotation: 0 }
        },
        y: {
          type: 'category',
          labels: names,
          grid: { drawBorder: false }
        }
      },
      parsing: false, // dataset.parsing を個別指定してるので false でOK
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label(ctx){
              const [s,e] = ctx.raw.x;
              const start = luxon.DateTime.fromISO(s).toFormat('HH:mm');
              const end   = luxon.DateTime.fromISO(e).toFormat('HH:mm');
              return `${ctx.dataset.label} ${start}–${end}`;
            }
          }
        }
      }
    }
  };

  // 2つのX軸に同じデータ範囲を使うよう関連付け（Chart.jsは自動で同期する）
  config.data.datasets.forEach(ds => {
    ds.xAxisID = 'xBottom'; // データは下側にバインド（上側は目盛り表示専用）
  });

  if (ganttChart) {
    ganttChart.data = config.data;
    ganttChart.options = config.options;
    ganttChart.update();
  } else {
    ganttChart = new Chart(canvas.getContext('2d'), config);
  }

  // データが無いときのプレースホルダー（任意）
  if (names.length === 0) {
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillStyle = '#666';
    ctx.fillText('本日の出勤はまだありません。', 12, 24);
    ctx.restore();
  }
}

/* ========= 正規化＆検証 ========= */
function normalizeEmployees(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.employees)) return raw.employees;
  console.warn('[GANTT] employees payload not array:', raw);
  return [];
}
function coerceId(emp) {
  if (!emp) return null;
  const cand = emp.id ?? emp.employeeId;
  if (cand === null || cand === undefined) return null;
  const s = String(cand).trim();
  return s.length > 0 ? s : null;
}

/* ========= 区間構築（currentDay の 09:00–22:00） ========= */
function buildIntervals(rows) {
  const byEmp = groupBy(rows, r => String(r.employeeId));
  const result = new Map();

  byEmp.forEach((list, empId) => {
    list.sort((a,b) => ts(a) - ts(b));
    const name = list[0]?.employeeName || empId;
    const workSegs = [];
    const breakSegs = [];

    let currentStart = null, currentPos = null, breakStart = null;

    for (const ev of list) {
      const t = asDate(ev.date, ev.time);
      const [dayS, dayE] = businessDayBounds(t);

      switch (ev.punchType) {
        case '出勤':
          currentStart = t; currentPos = ev.position || 'レジ'; breakStart = null; break;
        case '休憩開始':
          if (currentStart) { pushWork(workSegs, currentStart, t, currentPos, dayS, dayE); breakStart = t; }
          break;
        case '休憩終了':
          if (breakStart) { pushBreak(breakSegs, breakStart, t, dayS, dayE); currentStart = t; breakStart = null; }
          break;
        case '退勤':
          if (currentStart) { pushWork(workSegs, currentStart, t, currentPos, dayS, dayE); currentStart = null; breakStart = null; }
          break;
      }
    }
    if (currentStart) {
      const now = new Date();
      const [dayS, dayE] = businessDayBounds(now);
      pushWork(workSegs, currentStart, now, currentPos, dayS, dayE);
    }

    const work = workSegs.filter(s => s.endMin > s.startMin);
    const brks = breakSegs.filter(s => s.endMin > s.startMin);
    if (work.length || brks.length) result.set(empId, { name, work, breaks: brks });
  });

  return result;
}
function businessDayBounds(d) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), OPEN_HOUR, 0, 0);
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), CLOSE_HOUR, 0, 0);
  return [s, e];
}
function pushWork(out, s, e, pos, dayS, dayE) {
  const seg = clip(s, e, dayS, dayE); if (!seg) return;
  out.push({ startMin: minutesFromOpen(seg.start), endMin: minutesFromOpen(seg.end), className: posClassName(pos) });
}
function pushBreak(out, s, e, dayS, dayE) {
  const seg = clip(s, e, dayS, dayE); if (!seg) return;
  out.push({ startMin: minutesFromOpen(seg.start), endMin: minutesFromOpen(seg.end) });
}
function posClassName(pos){
  // 既存のクラス名に合わせる（念のため）
  switch (pos) {
    case 'ドリンカー': return 'pos-drink';
    case 'フライヤー': return 'pos-fry';
    case 'バーガー':   return 'pos-burger';
    case 'レジ':
    default:           return 'pos-reji';
  }
}
function minutesFromOpen(d) { return (d.getHours() - OPEN_HOUR) * 60 + d.getMinutes(); }
function clip(s, e, dayS, dayE) { const start = new Date(Math.max(s, dayS)), end = new Date(Math.min(e, dayE)); return end > start ? { start, end } : null; }

/* ========= ヘルパ ========= */
function groupBy(arr, keyFn) { const m = new Map(); for (const x of arr) { const k = keyFn(x); (m.get(k) || m.set(k, []).get(k)).push(x); } return m; }
function ts(r) { return asDate(r.date, r.time).getTime(); }
function normalizeDateStr(s) { return String(s || '').trim().replace(/\./g,'-').replace(/\//g,'-'); }
function asDate(dateStr, timeStr) {
  const d = normalizeDateStr(dateStr);
  let t = String(timeStr || '00:00:00').trim();
  const parts = t.split(':').map(p => p.padStart(2, '0'));
  while (parts.length < 3) parts.push('00');
  t = parts.slice(0,3).join(':');
  return new Date(`${d}T${t}`);
}
function ymd(d) { const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }
