// index.js v40（確定退勤のみ描画／最新退勤が上／高さは人数分／空は極小／BC安定／全体リファクタ）
/* eslint-disable no-console */

/* ===================== 定数・設定 ===================== */
const OPEN_HOUR = 9;
const CLOSE_HOUR = 22;

const POS_ORDER = ['レジ', 'ドリンカー', 'フライヤー', 'バーガー', '休憩'];
const POS_COLOR = {
  レジ:      '#2563eb',
  ドリンカー: '#16a34a',
  フライヤー: '#f59e0b',
  バーガー:   '#ef4444',
  休憩:       '#9ca3af',
};

const ROW_HEIGHT = 22;   // 1行の高さ
const BASE_HEIGHT = 36;  // 軸・凡例分のベース
const EMPTY_HEIGHT_PX = 80; // 空表示の極小高さ

// BroadcastChannel
const BC_CHANNEL_NAME = 'punch';
const BC_DEBOUNCE_MS = 300;
const BC_THROTTLE_MS = 2000;

/* ===================== 状態 ===================== */
let currentDay = ymd(new Date());
let ganttChart = null;
let lastSig = '';        // 差分検出用シグネチャ
let refreshing = false;
let queued = false;

// BroadcastChannel
let bc = null;
let bcTimer = null;
let lastBC = 0;

/* ===================== 起動フロー ===================== */
window.addEventListener('DOMContentLoaded', async () => {
  await renderEmployeeList();

  // 初期は空（誰も退勤してない想定でも破綻しない）
  renderChartFromIntervals(new Map(), []);

  // 初期同期：開いた時点で既に退勤者がいる場合に描画
  await requestRefresh('init');

  // 退勤イベントのみで更新
  setupBroadcastChannel();

  // 日付跨ぎでリセット
  setMidnightTimer();
});

/* ===================== タイマー・更新制御 ===================== */
async function requestRefresh(_src = 'unknown') {
  if (refreshing) { queued = true; return; }
  refreshing = true;
  try {
    await refreshGantt();
  } catch (e) {
    console.error('[GANTT] refresh error:', e);
    // フォールバック：空表示
    renderChartFromIntervals(new Map(), []);
  } finally {
    refreshing = false;
    if (queued) { queued = false; requestRefresh('queued'); }
  }
}

function setMidnightTimer() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  setTimeout(() => {
    currentDay = ymd(new Date());
    lastSig = 'EMPTY';
    renderChartFromIntervals(new Map(), []);
    setMidnightTimer();
  }, next - now);
}

function setupBroadcastChannel() {
  try {
    if (!bc) bc = new BroadcastChannel(BC_CHANNEL_NAME);
    bc.addEventListener('message', (ev) => {
      const d = ev?.data || {};
      if (d.kind !== 'punch' || d.punchType !== '退勤') return;

      const at = d.at ? new Date(d.at) : new Date();
      if (ymd(at) !== currentDay) return; // 当日以外は無視

      const now = Date.now();
      if (now - lastBC < BC_THROTTLE_MS) return; // スロットル
      lastBC = now;

      clearTimeout(bcTimer);
      bcTimer = setTimeout(() => requestRefresh('bc'), BC_DEBOUNCE_MS); // デバウンス
    });
  } catch (e) {
    console.warn('[BC] init failed', e);
  }
}

/* ===================== 画面：従業員一覧 ===================== */
async function renderEmployeeList() {
  const ul = document.getElementById('employeeList');
  const tpl = document.getElementById('tpl-employee-item');
  if (!ul || !tpl) return;

  try {
    const raw = await API.fetchEmployees();
    const employees = normalizeEmployees(raw);
    const frag = document.createDocumentFragment();

    for (const emp of employees) {
      const id = coerceId(emp);
      const node = tpl.content.cloneNode(true);
      const a = node.querySelector('.emp-link');
      a.textContent = API.escapeHtml(emp?.name ?? String(id ?? ''));
      a.href = `./detail.html?empId=${encodeURIComponent(id)}`;
      frag.appendChild(node);
    }

    ul.textContent = '';
    ul.appendChild(frag);
  } catch (e) {
    console.error('[EMP] list error:', e);
    ul.textContent = '従業員一覧の取得に失敗しました。';
  }
}

/* ===================== データ取得＆区間化 ===================== */
async function refreshGantt() {
  const canvas = document.getElementById('ganttCanvas');
  if (!canvas) return;

  const raw = await API.fetchEmployees();
  const emps = normalizeEmployees(raw);

  // 履歴を並列取得（失敗は握りつぶして続行）
  const histories = await Promise.allSettled(
    emps.map(async (e) => {
      const id = coerceId(e);
      if (!id) return [];
      const rows = await API.fetchHistory({ employeeId: id, days: 1 });
      return rows
        .filter(r => normalizeDateStr(r.date) === currentDay)
        .map(r => ({
          ...r,
          employeeId: r.employeeId ?? id,
          employeeName: r.employeeName || e.name || String(id),
        }));
    })
  );

  const allRows = [];
  for (const r of histories) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      allRows.push(...r.value);
    } else if (r.status === 'rejected') {
      console.warn('[GANTT] 履歴取得失敗:', r.reason);
    }
  }

  const { intervalsByEmp, orderLabels } = buildClosedIntervalsAndOrder(allRows);
  renderChartFromIntervals(intervalsByEmp, orderLabels);
}

/**
 * rows から「確定した勤務・休憩区間」のみを構築し、
 * 直近退勤時刻の降順（最新が上）でラベル順序を返す
 */
function buildClosedIntervalsAndOrder(rows) {
  const byEmp = groupBy(rows, r => String(r.employeeId));
  const result = new Map();
  const order = []; // { name, lastEndTS }

  byEmp.forEach((list, empId) => {
    list.sort((a, b) => ts(a) - ts(b)); // 時系列
    const name = list[0]?.employeeName || empId;

    const workClosed = [];
    const breakClosed = [];

    let currentStart = null; // 勤務開始
    let currentPos = null;
    let breakStart = null;
    let lastEndTS = null;

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
                endMin: minutesFromOpen(seg.end),
                className: posClassName(currentPos),
              });
            }
            breakStart = t;
            currentStart = null; // 勤務一区切り
          }
          break;

        case '休憩終了':
          if (breakStart) {
            const seg = clip(breakStart, t, dayS, dayE);
            if (seg) {
              breakClosed.push({
                startMin: minutesFromOpen(seg.start),
                endMin: minutesFromOpen(seg.end),
              });
            }
            // 休憩明け勤務再開（posは継続）
            currentStart = t;
          }
          break;

        case '退勤':
          if (currentStart) {
            const seg = clip(currentStart, t, dayS, dayE);
            if (seg) {
              workClosed.push({
                startMin: minutesFromOpen(seg.start),
                endMin: minutesFromOpen(seg.end),
                className: posClassName(currentPos),
              });
              lastEndTS = t.getTime();
            }
            currentStart = null;
            breakStart = null;
          }
          break;
      }
    }

    // 未退勤の勤務は push しない（確定していない）
    if (workClosed.length || breakClosed.length) {
      result.set(empId, { name, work: workClosed, breaks: breakClosed });
      order.push({ name, lastEndTS: lastEndTS ?? 0 });
    }
  });

  // 最新退勤が上
  order.sort((a, b) => b.lastEndTS - a.lastEndTS);
  const labels = order.map(o => o.name);
  return { intervalsByEmp: result, orderLabels: labels };
}

/* ===================== Chart.js 描画 ===================== */
function renderChartFromIntervals(intervalsByEmp, orderedLabels) {
  const canvas = document.getElementById('ganttCanvas');
  const emptyMsg = document.getElementById('ganttEmpty');
  if (!canvas) return;

  const datasets = toChartDatasets(intervalsByEmp);
  const totalBars = datasets.reduce((n, ds) => n + (ds.data?.length || 0), 0);

  // ラベル（指定なければ intervals から抽出）
  let names = Array.isArray(orderedLabels) ? orderedLabels.slice() : [];
  if (!names.length) {
    const set = new Set();
    intervalsByEmp.forEach(info => set.add(info.name));
    names = Array.from(set);
  }

  // ---- 完全に空：チャート破棄＆極小表示 ----
  if (totalBars === 0 || names.length === 0) {
    if (ganttChart) { ganttChart.destroy(); ganttChart = null; }
    canvas.style.height = `${EMPTY_HEIGHT_PX}px`;
    const ctx = canvas.getContext('2d');
    ctx && ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (emptyMsg) emptyMsg.style.display = 'block';
    lastSig = 'EMPTY';
    return;
  }

  // ---- 高さ：人数で可変（※属性 canvas.height は触らない！） ----
  const heightPx = BASE_HEIGHT + names.length * ROW_HEIGHT;
  const heightStr = `${heightPx}px`;
  if (canvas.style.height !== heightStr) {
    canvas.style.height = heightStr; // CSS だけを更新（Chart.js の推奨）
  }

  // ---- 差分検出 ----
  const sig = makeSignature(names, datasets);
  if (sig === lastSig) {
    if (emptyMsg) emptyMsg.style.display = 'none';
    return; // 変更なしなら更新しない
  }
  lastSig = sig;

  const { min, max } = dayBoundsISO();
  const config = {
    type: 'bar',
    data: { datasets },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      animation: false,
      transitions: { active: { animation: { duration: 0 } } },
      resizeDelay: 150,
      layout: { padding: 0 },

      scales: {
        xBottom: {
          type: 'time',
          position: 'bottom',
          min, max,
          time: { unit: 'hour', displayFormats: { hour: 'HH:mm' } },
          grid: { drawOnChartArea: true },
          ticks: { maxRotation: 0 },
          stacked: true,
        },
        xTop: {
          type: 'time',
          position: 'top',
          min, max,
          time: { unit: 'hour', displayFormats: { hour: 'HH:mm' } },
          grid: { drawOnChartArea: false },
          ticks: { maxRotation: 0 },
          stacked: true,
        },
        y: {
          type: 'category',
          labels: names,
          grid: { drawBorder: false },
          ticks: { padding: 2 },
          offset: false,
          stacked: true,
        },
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label(ctx) {
              const [s, e] = ctx.raw.x;
              const a = luxon.DateTime.fromISO(s).toFormat('HH:mm');
              const b = luxon.DateTime.fromISO(e).toFormat('HH:mm');
              return `${ctx.dataset.label} ${a}–${b}`;
            },
          },
        },
      },
    },
  };

  // ---- 初期化 or 更新 ----
  if (ganttChart) {
    ganttChart.data = config.data;
    ganttChart.options = config.options;
    ganttChart.update('none'); // 無アニメ更新で安定
  } else {
    ganttChart = new Chart(canvas.getContext('2d'), config);
  }

  if (emptyMsg) emptyMsg.style.display = 'none';
}

function toChartDatasets(intervalsByEmp) {
  // 役割ごとに先にバケット作成（固定順）
  const byPos = new Map(POS_ORDER.map(p => [p, []]));

  intervalsByEmp.forEach(info => {
    const open = todayOpenMillis();
    // 勤務（確定のみ）
    for (const seg of info.work) {
      const posName = classToPosName(seg.className);
      const arr = byPos.get(posName) || [];
      arr.push({ x: [toISO(open, seg.startMin), toISO(open, seg.endMin)], y: info.name });
      byPos.set(posName, arr);
    }
    // 休憩（確定のみ）
    for (const seg of info.breaks) {
      const arr = byPos.get('休憩') || [];
      arr.push({ x: [toISO(open, seg.startMin), toISO(open, seg.endMin)], y: info.name });
      byPos.set('休憩', arr);
    }
  });

  // 固定順で返す（空データセットは自動的に描画が薄い）
  return POS_ORDER.map(posName => ({
    type: 'bar',
    label: posName,
    data: byPos.get(posName) || [],
    parsing: { xAxisKey: 'x', yAxisKey: 'y' },
    xAxisID: 'xBottom',
    stack: 'timeline',
    barThickness: 10,
    categoryPercentage: 0.65,
    barPercentage: 1.0,
    borderSkipped: false,
    borderWidth: 0,
    backgroundColor: POS_COLOR[posName] || '#999',
  }));
}

/* ===================== ユーティリティ ===================== */
function makeSignature(names, datasets) {
  // 軽量な署名（名前配列 + 各データセットの件数 + 先頭&末尾の時間）
  const dsSig = datasets.map(ds => {
    const n = ds.data?.length || 0;
    if (!n) return `${ds.label}:0`;
    const first = ds.data[0]?.x?.[0] ?? '';
    const last = ds.data[n - 1]?.x?.[1] ?? '';
    return `${ds.label}:${n}:${first}-${last}`;
  });
  return JSON.stringify({ names, ds: dsSig });
}

function normalizeEmployees(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.employees)) return raw.employees;
  console.warn('[EMP] payload not array:', raw);
  return [];
}

function coerceId(emp) {
  if (!emp) return null;
  const cand = emp.id ?? emp.employeeId;
  if (cand === null || cand === undefined) return null;
  const s = String(cand).trim();
  return s.length > 0 ? s : null;
}

function classToPosName(cls) {
  if (!cls) return 'レジ';
  const s = String(cls);
  if (s.includes('drink'))  return 'ドリンカー';
  if (s.includes('fry'))    return 'フライヤー';
  if (s.includes('burger')) return 'バーガー';
  if (s.includes('reji'))   return 'レジ';
  return 'レジ';
}

function businessDayBounds(d) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), OPEN_HOUR, 0, 0);
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), CLOSE_HOUR, 0, 0);
  return [s, e];
}
function minutesFromOpen(d) { return (d.getHours() - OPEN_HOUR) * 60 + d.getMinutes(); }
function clip(s, e, dayS, dayE) {
  const start = new Date(Math.max(s, dayS));
  const end = new Date(Math.min(e, dayE));
  return end > start ? { start, end } : null;
}

function dayBoundsISO(d = new Date()) {
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
  return {
    min: new Date(y, m, day, OPEN_HOUR, 0, 0).toISOString(),
    max: new Date(y, m, day, CLOSE_HOUR, 0, 0).toISOString(),
  };
}
function todayOpenMillis() {
  const base = new Date();
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), OPEN_HOUR, 0, 0).getTime();
}
function toISO(openMillis, minutesFromOpen_) {
  return new Date(openMillis + minutesFromOpen_ * 60 * 1000).toISOString();
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
function ts(r) { return asDate(r.date, r.time).getTime(); }
function normalizeDateStr(s) { return String(s || '').trim().replace(/\./g, '-').replace(/\//g, '-'); }
function asDate(dateStr, timeStr) {
  const d = normalizeDateStr(dateStr);
  let t = String(timeStr || '00:00:00').trim();
  const parts = t.split(':').map(p => p.padStart(2, '0'));
  while (parts.length < 3) parts.push('00');
  t = parts.slice(0, 3).join(':');
  return new Date(`${d}T${t}`);
}
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
