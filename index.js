// index.js v36（退勤確定のみ描画／最新退勤が上／高さは人数分／空は極小／安定BC）

console.log('[INDEX.JS] Chart.js v36');

const OPEN_HOUR = 9;
const CLOSE_HOUR = 22;

// 当日のキー（0:00で更新）
let currentDay = ymd(new Date());

// 色
const POS_COLOR = {
  'レジ':      '#2563eb',
  'ドリンカー':'#16a34a',
  'フライヤー':'#f59e0b',
  'バーガー':  '#ef4444',
  '休憩':      '#9ca3af'
};

// Chart.js インスタンスと制御フラグ
let ganttChart = null;
let lastSig = '';            // 前回描画のシグネチャ（差分検出用）
let refreshing = false;
let queued = false;

// BroadcastChannel 制御
let bc; 
let bcTimer = null;
const BC_DEBOUNCE_MS = 300;
const BC_THROTTLE_MS = 2000;
let lastBC = 0;

window.addEventListener('DOMContentLoaded', async () => {
  await renderEmployeeList();

  // 初期は空表示（誰も退勤していない前提で描画しない）
  renderChartFromIntervals(new Map(), []);

  // ★ページを開いた時点で既に退勤者がいる場合に備えて1回だけ取得して描く
  await requestRefresh('init');

  // 退勤時のみ再描画（当日判定・スロットル・デバウンス付き）
  try {
    if (!bc) bc = new BroadcastChannel('punch');
    bc.addEventListener('message', (ev) => {
      const d = ev?.data || {};
      if (d.kind !== 'punch' || d.punchType !== '退勤') return;

      const at = d.at ? new Date(d.at) : new Date();
      if (ymd(at) !== currentDay) return;  // 当日以外は無視

      const now = Date.now();
      if (now - lastBC < BC_THROTTLE_MS) return;
      lastBC = now;

      clearTimeout(bcTimer);
      bcTimer = setTimeout(() => {
        requestRefresh('bc');
      }, BC_DEBOUNCE_MS);
    });
  } catch (e) {
    console.warn('[BC] init failed', e);
  }

  // 0:00で日替わりリセット（前日は表示しない）
  setMidnightTimer();
});

/* ====== リフレッシュ制御 ====== */
async function requestRefresh(_src='unknown') {
  if (refreshing) { queued = true; return; }
  refreshing = true;
  try {
    await refreshGantt();
  } finally {
    refreshing = false;
    if (queued) { queued = false; requestRefresh('queued'); }
  }
}

/* ====== 0:00で空にする ====== */
function setMidnightTimer() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0,0,0);
  setTimeout(() => {
    currentDay = ymd(new Date());
    // 新しい日：完全に空で極小表示
    lastSig = 'EMPTY';
    renderChartFromIntervals(new Map(), []);
    setMidnightTimer();
  }, next - now);
}

/* ====== 従業員一覧 ====== */
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
      const id = coerceId(emp);
      a.textContent = API.escapeHtml(emp.name ?? String(id ?? ''));
      a.href = `./detail.html?empId=${encodeURIComponent(id)}`;
      frag.appendChild(node);
    });
    ul.textContent = '';
    ul.appendChild(frag);
  } catch (e) {
    console.error(e);
    ul.textContent = '従業員一覧の取得に失敗しました。';
  }
}

/* ====== 当日＋退勤確定だけ取得・描画 ====== */
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

    // 区間化（未退勤は含めない＝描画しない）
    const { intervalsByEmp, orderLabels } = buildClosedIntervalsAndOrder(allRows);

    // 描画（順序は orderLabels に合わせる／フォールバック付き）
    renderChartFromIntervals(intervalsByEmp, orderLabels);

  } catch (e) {
    console.error(e);
    renderChartFromIntervals(new Map(), []); // 失敗時は空
  }
}

/* ====== Chart.js 描画 ====== */
function dayBoundsISO(d=new Date()){
  const y=d.getFullYear(), m=d.getMonth(), day=d.getDate();
  return {
    min: new Date(y,m,day,OPEN_HOUR,0,0).toISOString(),
    max: new Date(y,m,day,CLOSE_HOUR,0,0).toISOString()
  };
}
function toChartDatasets(intervalsByEmp){
  const byPos = new Map();
  intervalsByEmp.forEach(info=>{
    // 勤務（確定のみ）
    info.work.forEach(seg=>{
      const posName = classToPosName(seg.className);
      const arr = byPos.get(posName) || [];
      const base = new Date(); const y=base.getFullYear(), m=base.getMonth(), d=base.getDate();
      const open = new Date(y,m,d,OPEN_HOUR,0,0).getTime();
      const sISO = new Date(open + seg.startMin*60*1000).toISOString();
      const eISO = new Date(open + seg.endMin*60*1000).toISOString();
      arr.push({ x:[sISO,eISO], y: info.name });
      byPos.set(posName, arr);
    });
    // 休憩（確定のみ）
    info.breaks.forEach(seg=>{
      const arr = byPos.get('休憩') || [];
      const base = new Date(); const y=base.getFullYear(), m=base.getMonth(), d=base.getDate();
      const open = new Date(y,m,d,OPEN_HOUR,0,0).getTime();
      const sISO = new Date(open + seg.startMin*60*1000).toISOString();
      const eISO = new Date(open + seg.endMin*60*1000).toISOString();
      arr.push({ x:[sISO,eISO], y: info.name });
      byPos.set('休憩', arr);
    });
  });

  const datasets = [];
  byPos.forEach((data, posName)=>{
    datasets.push({
      type: 'bar',
      label: posName,
      data,
      parsing: { xAxisKey: 'x', yAxisKey: 'y' },
      xAxisID: 'xBottom',
      borderSkipped: false,
      borderWidth: 0,
      backgroundColor: POS_COLOR[posName] || '#999',
      barThickness: 14,
    });
  });
  return datasets;
}
function classToPosName(cls){
  if (!cls) return 'レジ';
  if (cls.includes('reji'))   return 'レジ';
  if (cls.includes('drink'))  return 'ドリンカー';
  if (cls.includes('fry'))    return 'フライヤー';
  if (cls.includes('burger')) return 'バーガー';
  return 'レジ';
}

// ===== v36: データ有無で描画/破棄を切替。ラベル未指定でも描ける／差分更新 =====
function renderChartFromIntervals(intervalsByEmp, orderedLabels){
  const canvas = document.getElementById('ganttCanvas');
  const emptyMsg = document.getElementById('ganttEmpty');
  if (!canvas) return;

  // dataset を先に作って「本当にデータがあるか」を判定
  const datasets = toChartDatasets(intervalsByEmp);
  const totalBars = datasets.reduce((n, ds) => n + (ds.data?.length || 0), 0);

  // Y軸ラベル：指定が無ければ intervals から抽出
  let names = Array.isArray(orderedLabels) ? orderedLabels.slice() : [];
  if (!names.length) {
    const set = new Set();
    intervalsByEmp.forEach(info => set.add(info.name));
    names = Array.from(set);
  }

  // ---- 完全に空：チャート破棄＆小さく ----
  if (totalBars === 0 || names.length === 0) {
    if (ganttChart) { ganttChart.destroy(); ganttChart = null; }
    canvas.style.height = '80px'; // 空は極小
    const ctx = canvas.getContext('2d');
    ctx && ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (emptyMsg) emptyMsg.style.display = 'block';
    lastSig = 'EMPTY';
    return;
  }

  // ---- データあり：高さを人数で可変、差分がなければ再描画しない ----
  const sig = JSON.stringify({
    names,
    ds: datasets.map(d => ({ label: d.label, n: d.data.length }))
  });
  if (sig === lastSig) {
    if (emptyMsg) emptyMsg.style.display = 'none';
    return; // 同一内容なら何もしない（チラつき防止）
  }
  lastSig = sig;

  const ROW_HEIGHT = 34, BASE = 48;
  canvas.style.height = `${BASE + names.length * ROW_HEIGHT}px`;

  const {min, max} = dayBoundsISO();
  const config = {
    type: 'bar',
    data: { datasets },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      scales: {
        xBottom: {
          type: 'time',
          position: 'bottom',
          min, max,
          time: { unit: 'hour', displayFormats: { hour: 'HH:mm' } },
          grid: { drawOnChartArea: true },
          ticks: { maxRotation: 0 }
        },
        xTop: {
          type: 'time',
          position: 'top',
          min, max,
          time: { unit: 'hour', displayFormats: { hour: 'HH:mm' } },
          grid: { drawOnChartArea: false },
          ticks: { maxRotation: 0 }
        },
        y: {
          type: 'category',
          labels: names,
          grid: { drawBorder: false }
        }
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label(ctx){
              const [s,e] = ctx.raw.x;
              const a = luxon.DateTime.fromISO(s).toFormat('HH:mm');
              const b = luxon.DateTime.fromISO(e).toFormat('HH:mm');
              return `${ctx.dataset.label} ${a}–${b}`;
            }
          }
        }
      }
    }
  };

  if (ganttChart) {
    ganttChart.data = config.data;
    ganttChart.options = config.options;
    ganttChart.update();
  } else {
    ganttChart = new Chart(canvas.getContext('2d'), config);
  }

  if (emptyMsg) emptyMsg.style.display = 'none';
}

/* ====== 正規化＆ユーティリティ ====== */
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

/* ====== 「確定区間のみ」構築 & 並び順ラベル ======
   ・未退勤の勤務は描画しない（“今まで”で閉じない）
   ・休憩も開始～終了の確定分だけ
   ・各従業員の最終「退勤」時刻で降順に並べる（最新退勤が上） */
function buildClosedIntervalsAndOrder(rows) {
  const byEmp = groupBy(rows, r => String(r.employeeId));
  const result = new Map();
  const order = []; // [{name, lastEndTS}]

  byEmp.forEach((list, empId) => {
    list.sort((a,b) => ts(a) - ts(b));
    const name = list[0]?.employeeName || empId;

    const workClosed = [];
    const breakClosed = [];
    let currentStart = null; // 勤務開始
    let currentPos   = null;
    let breakStart   = null;
    let lastEndTS    = null; // 直近退勤のDate.getTime()

    for (const ev of list) {
      const t = asDate(ev.date, ev.time);
      const [dayS, dayE] = businessDayBounds(t);

      switch (ev.punchType) {
        case '出勤':
          currentStart = t;
          currentPos = ev.position || 'レジ';
          breakStart = null;
          break;

        case '休憩開始':
          if (currentStart) {
            const seg = clip(currentStart, t, dayS, dayE);
            if (seg) {
              workClosed.push({
                startMin: minutesFromOpen(seg.start),
                endMin:   minutesFromOpen(seg.end),
                className: posClassName(currentPos)
              });
            }
            breakStart = t;
            currentStart = null; // 勤務はここで一区切り
          }
          break;

        case '休憩終了':
          if (breakStart) {
            const seg = clip(breakStart, t, dayS, dayE);
            if (seg) {
              breakClosed.push({
                startMin: minutesFromOpen(seg.start),
                endMin:   minutesFromOpen(seg.end)
              });
            }
            // 休憩明けから勤務再開
            currentStart = t;
            // ポジションは直前のを継続とみなす
          }
          break;

        case '退勤':
          if (currentStart) {
            const seg = clip(currentStart, t, dayS, dayE);
            if (seg) {
              workClosed.push({
                startMin: minutesFromOpen(seg.start),
                endMin:   minutesFromOpen(seg.end),
                className: posClassName(currentPos)
              });
              lastEndTS = t.getTime();
            }
            currentStart = null;
            breakStart = null;
          }
          break;
      }
    }

    // 未退勤の勤務は push しない（確定していないので描画対象外）

    if (workClosed.length || breakClosed.length) {
      result.set(empId, { name, work: workClosed, breaks: breakClosed });
      order.push({ name, lastEndTS: lastEndTS ?? 0 });
    }
  });

  // 最新退勤が上（lastEndTS 降順、0は一番下）
  order.sort((a,b) => b.lastEndTS - a.lastEndTS);
  const labels = order.map(o => o.name);
  return { intervalsByEmp: result, orderLabels: labels };
}

/* ====== 09:00–22:00 ユーティリティ ====== */
function businessDayBounds(d) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), OPEN_HOUR, 0, 0);
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), CLOSE_HOUR, 0, 0);
  return [s, e];
}
function posClassName(pos){
  switch (pos) {
    case 'ドリンカー': return 'pos-drink';
    case 'フライヤー': return 'pos-fry';
    case 'バーガー':   return 'pos-burger';
    case 'レジ':
    default:           return 'pos-reji';
  }
}
function minutesFromOpen(d){ return (d.getHours()-OPEN_HOUR)*60 + d.getMinutes(); }
function clip(s,e,dayS,dayE){ const start=new Date(Math.max(s,dayS)), end=new Date(Math.min(e,dayE)); return end>start?{start,end}:null; }

/* ====== 小物 ====== */
function groupBy(arr, keyFn){ const m=new Map(); for(const x of arr){ const k=keyFn(x); (m.get(k)||m.set(k,[]).get(k)).push(x);} return m; }
function ts(r){ return asDate(r.date, r.time).getTime(); }
function normalizeDateStr(s){ return String(s||'').trim().replace(/\./g,'-').replace(/\//g,'-'); }
function asDate(dateStr, timeStr){
  const d = normalizeDateStr(dateStr);
  let t = String(timeStr || '00:00:00').trim();
  const parts = t.split(':').map(p => p.padStart(2,'0')); while(parts.length<3) parts.push('00');
  t = parts.slice(0,3).join(':');
  return new Date(`${d}T${t}`);
}
function ymd(d){ const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }
