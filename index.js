// index.js v50 - 勤怠管理システム（退勤トリガで実データを描画）

/* ==================== 定数定義 ==================== */
const OPEN_HOUR = 9;
const CLOSE_HOUR = 22;
const ROW_HEIGHT = 35;
const BASE_HEIGHT = 40;
const EMPTY_HEIGHT_PX = 80;
const MAX_HEIGHT_PX = 800;

const POS_ORDER = ['レジ', 'ドリンカー', 'フライヤー', 'バーガー', '休憩'];
const POS_COLOR = {
  レジ:      '#2563eb',
  ドリンカー: '#16a34a',
  フライヤー: '#f59e0b',
  バーガー:   '#ef4444',
  休憩:       '#9ca3af',
};

const BC_CHANNEL_NAME = 'punch';
const BC_DEBOUNCE_MS = 300;
const BC_THROTTLE_MS = 2000;
// const USE_MOCK = false; // ※デバッグ時だけ true にする（今回デフォは実データ）

/* ==================== グローバル状態 ==================== */
let currentDay = ymd(new Date());
let ganttChart = null;
let lastSig = '';
let refreshing = false;
let queued = false;
let bc = null;
let bcTimer = null;
let lastBC = 0;

/* ==================== ローディング制御 & フィードバック ==================== */
function showGanttLoading() {
  const loadingEl = document.getElementById('ganttLoading');
  if (loadingEl) loadingEl.style.display = 'flex';
}
function hideGanttLoading() {
  const loadingEl = document.getElementById('ganttLoading');
  if (loadingEl) loadingEl.style.display = 'none';
}
function showInlineLoader(element, message = '読み込み中') {
  if (!element) return;
  element.innerHTML = `<span class="inline-loader">${message}</span>`;
}
function showErrorMessage(message) {
  const container = document.createElement('div');
  container.className = 'error-message';
  container.textContent = message;
  container.style.cssText = `
    position: fixed; top: 20px; right: 20px;
    background: #ef4444; color: white; padding: 12px 20px;
    border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    z-index: 10000; animation: slideIn 0.3s ease;
  `;
  document.body.appendChild(container);
  setTimeout(() => {
    container.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => container.remove(), 300);
  }, 3000);
}
function showSuccessMessage(message) {
  const container = document.createElement('div');
  container.className = 'success-message';
  container.textContent = message;
  container.style.cssText = `
    position: fixed; top: 20px; right: 20px;
    background: #22c55e; color: white; padding: 12px 20px;
    border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    z-index: 10000; animation: slideIn 0.3s ease;
  `;
  document.body.appendChild(container);
  setTimeout(() => {
    container.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => container.remove(), 300);
  }, 3000);
}

/* ==================== 初期化処理 ==================== */
window.addEventListener('DOMContentLoaded', async () => {
  initGanttCanvas();
  showGanttLoading();

  // 直近5分のキャッシュがあれば即描画
  const cached = loadFromCache();
  if (cached && cached.intervals.size > 0) {
    renderChartFromIntervals(cached.intervals, cached.labels);
    hideGanttLoading();
  } else {
    renderChartFromIntervals(new Map(), []); // 空状態
  }

  // 従業員一覧とガントの初回取得
  const [employeeResult] = await Promise.allSettled([
    renderEmployeeList(),
    requestRefresh()
  ]);
  if (employeeResult.status === 'rejected') {
    console.error('従業員一覧の取得に失敗:', employeeResult.reason);
  }

  setupBroadcastChannel();
  setMidnightTimer();
  setupNetworkHandlers();
  setupMobileMenu();
});

function initGanttCanvas() {
  const canvas = document.getElementById('ganttCanvas');
  if (canvas) {
    canvas.style.display = 'none';
    canvas.style.overflow = 'hidden';
  }
}

/* ==================== 従業員一覧表示 ==================== */
async function renderEmployeeList() {
  const ul = document.getElementById('employeeList');
  const tpl = document.getElementById('tpl-employee-item');
  if (!ul || !tpl) return;

  showInlineLoader(ul, '従業員一覧を読み込み中');

  try {
    const raw = await API.fetchEmployees();
    const employees = normalizeEmployees(raw);
    const frag = document.createDocumentFragment();

    for (const emp of employees) {
      const id = coerceId(emp);
      const node = tpl.content.cloneNode(true);
      const a = node.querySelector('.emp-link');

      // IDのみを表示（クリックで認証モーダル）
      a.textContent = API.escapeHtml(String(id ?? ''));
      a.href = '#';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        authenticateEmployee(id, emp?.name ?? '');
      });
      frag.appendChild(node);
    }

    ul.textContent = '';
    ul.appendChild(frag);
  } catch (e) {
    console.error('[EMP] list error:', e);
    ul.textContent = '従業員一覧の取得に失敗しました。';
  }
}

// 本人確認モーダル
function authenticateEmployee(empId, correctName) {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center; z-index: 10000;
  `;

  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: white; padding: 30px; border-radius: 12px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.2); max-width: 400px; width: 90%;
  `;
  dialog.innerHTML = `
    <h3 style="margin:0 0 20px; font-size: 1.2rem; color:#1a1a1a;">本人確認</h3>
    <p style="margin:0 0 15px; color:#666;">ID: <strong>${empId}</strong></p>
    <p style="margin:0 0 20px; color:#666;">フルネームを入力してください：</p>
    <input type="text" id="nameInput" placeholder="フルネーム" style="
      width:100%; padding:12px; border:2px solid #e5e7eb; border-radius:8px; font-size:1rem; margin-bottom:8px; box-sizing:border-box;"/>
    <div id="errorMessage" style="
      color:#ef4444; font-size:14px; margin-bottom:12px; display:none;
      padding:8px 12px; background:#fef2f2; border-radius:6px; border:1px solid #fecaca;">
      名前が正しくありません
    </div>
    <div style="display:flex; gap:10px; justify-content:flex-end;">
      <button id="cancelBtn" style="padding:10px 20px; background:#e5e7eb; color:#374151; border:none; border-radius:8px; cursor:pointer; font-size:1rem;">キャンセル</button>
      <button id="confirmBtn" style="padding:10px 20px; background:#2563eb; color:white; border:none; border-radius:8px; cursor:pointer; font-size:1rem;">確認</button>
    </div>
  `;
  modal.appendChild(dialog);
  document.body.appendChild(modal);

  const input = dialog.querySelector('#nameInput');
  const confirmBtn = dialog.querySelector('#confirmBtn');
  const cancelBtn = dialog.querySelector('#cancelBtn');
  const errorMessage = dialog.querySelector('#errorMessage');
  input.focus();

  input.addEventListener('input', () => {
    if (errorMessage.style.display === 'block') {
      errorMessage.style.display = 'none';
      input.style.borderColor = '#e5e7eb';
    }
  });

  const handleConfirm = () => {
    const enteredName = input.value.trim();
    const normalizedEntered = enteredName.replace(/[\s\u3000]+/g, '');
    const normalizedCorrect = (correctName || '').replace(/[\s\u3000]+/g, '');
    if (normalizedEntered === normalizedCorrect) {
      window.location.href = `./detail.html?empId=${encodeURIComponent(empId)}`;
    } else {
      errorMessage.style.display = 'block';
      input.style.borderColor = '#ef4444';
      input.value = '';
      input.focus();
      setTimeout(() => {
        errorMessage.style.display = 'none';
        input.style.borderColor = '#e5e7eb';
      }, 3000);
    }
  };

  confirmBtn.addEventListener('click', handleConfirm);
  input.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleConfirm(); });
  cancelBtn.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

/* ==================== ガントチャート更新（退勤トリガ対応の実データ版） ==================== */
let refreshDebounceTimer = null;

async function requestRefresh() {
  clearTimeout(refreshDebounceTimer);
  refreshDebounceTimer = setTimeout(async () => {
    if (refreshing) {
      queued = true;
      return;
    }
    refreshing = true;
    try {
      await refreshGantt();
    } catch (e) {
      console.error('[GANTT] refresh error:', e);
      showErrorMessage('データの更新に失敗しました');
      renderChartFromIntervals(new Map(), []);
      hideGanttLoading();
    } finally {
      refreshing = false;
      if (queued) {
        queued = false;
        requestRefresh();
      }
    }
  }, 100);
}

async function refreshGantt() {
  const canvas = document.getElementById('ganttCanvas');
  if (!canvas) return;

  showGanttLoading();
  try {
    // 実データ取得（当日分）
    const rows = await fetchTodayRowsAllEmployees();

    // 打刻行→閉区間へ整形
    const { intervalsByEmp, orderLabels } = buildClosedIntervalsAndOrder(rows);

    // キャッシュ & 描画
    saveToCache(intervalsByEmp, orderLabels);
    renderChartFromIntervals(intervalsByEmp, orderLabels);
  } catch (error) {
    console.error('[GANTT] エラー:', error);
    showErrorMessage('データの取得に失敗しました');
    renderChartFromIntervals(new Map(), []);
  } finally {
    hideGanttLoading();
  }
}

/* === 当日分を全員ぶん集約 === */
async function fetchTodayRowsAllEmployees() {
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
  const to   = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

  // 従業員一覧
  const employees = normalizeEmployees(await API.fetchEmployees());

  // 各従業員の当日履歴を取得（並列）
  const results = await Promise.allSettled(
    employees.map(emp => API.fetchHistory({
      employeeId: coerceId(emp),
      from, to
    }))
  );

  // フラット化＋正規化
  const allRows = [];
  results.forEach((res, idx) => {
    const emp = employees[idx];
    if (res.status === 'fulfilled') {
      const normalized = normalizeRows(res.value, emp);
      allRows.push(...normalized);
    } else {
      console.warn('[HISTORY] failed for', emp, res.reason);
    }
  });

  return allRows;
}

/* === API返却の差異を吸収して既存整形関数が読める形に === */
function normalizeRows(rawRows, fallbackEmp = null) {
  return (rawRows ?? []).map(r => {
    const employeeId = String(
      r.employeeId ?? r.empId ?? r.id ?? fallbackEmp?.id ?? fallbackEmp?.employeeId ?? ''
    ).trim();
    const employeeName = String(
      r.employeeName ?? r.name ?? fallbackEmp?.name ?? ''
    ).trim();
    const punchType = String(r.punchType ?? r.type ?? '').trim(); // 出勤/休憩開始/休憩終了/退勤
    const position = String(r.position ?? r.pos ?? 'レジ').trim();
    const date = normalizeDateStr(r.date ?? r.dt ?? r.yyyymmdd ?? '');
    const time = String(r.time ?? r.hhmm ?? r.hhmmss ?? '00:00:00').trim();
    return { employeeId, employeeName, punchType, position, date, time };
  });
}

function buildClosedIntervalsAndOrder(rows) {
  const byEmp = groupBy(rows, r => String(r.employeeId));
  const result = new Map();
  const order = [];

  byEmp.forEach((list, empId) => {
    list.sort((a, b) => ts(a) - ts(b));
    const name = list[0]?.employeeName || empId;

    const workClosed = [];
    const breakClosed = [];

    // 現在のシフト状態
    let currentStart = null;   // 勤務開始時刻
    let breakStart   = null;   // 休憩開始時刻
    let pendingWork  = [];     // 退勤で色をつけるまで“保留”の勤務セグメント
    let lastEndTS    = null;

    for (const ev of list) {
      const t = asDate(ev.date, ev.time);
      const [dayS, dayE] = businessDayBounds(t);

      switch (ev.punchType) {
        case '出勤': {
          currentStart = t;
          breakStart = null;
          pendingWork = []; // 新しいシフト開始
          break;
        }
        case '休憩開始': {
          if (currentStart) {
            const seg = clip(currentStart, t, dayS, dayE);
            if (seg) {
              pendingWork.push({
                startMin: minutesFromOpen(seg.start),
                endMin:   minutesFromOpen(seg.end),
                className: null // 退勤で色付け
              });
            }
            breakStart = t;
            currentStart = null;
          }
          break;
        }
        case '休憩終了': {
          if (breakStart) {
            const seg = clip(breakStart, t, dayS, dayE);
            if (seg) {
              breakClosed.push({
                startMin: minutesFromOpen(seg.start),
                endMin:   minutesFromOpen(seg.end),
              });
            }
            currentStart = t;
            breakStart = null;
          }
          break;
        }
        case '退勤': {
          // 休憩中のまま退勤するケースは基本無い想定だが念のため
          if (breakStart) {
            const seg = clip(breakStart, t, dayS, dayE);
            if (seg) {
              breakClosed.push({
                startMin: minutesFromOpen(seg.start),
                endMin:   minutesFromOpen(seg.end),
              });
            }
            breakStart = null;
          }
          if (currentStart) {
            const seg = clip(currentStart, t, dayS, dayE);
            if (seg) {
              pendingWork.push({
                startMin: minutesFromOpen(seg.start),
                endMin:   minutesFromOpen(seg.end),
                className: null // ここも色は後で
              });
            }
          }

          // ★退勤イベントのポジションを全勤務セグメントに適用
          const cls = posClassName(ev.position || 'レジ');
          for (const seg of pendingWork) seg.className = cls;
          workClosed.push(...pendingWork);

          lastEndTS = t.getTime();
          currentStart = null;
          pendingWork = [];
          break;
        }
      }
    }

    if (workClosed.length || breakClosed.length) {
      result.set(empId, { name, work: workClosed, breaks: breakClosed });
      order.push({ name, lastEndTS: lastEndTS ?? 0 });
    }
  });

  order.sort((a, b) => b.lastEndTS - a.lastEndTS);
  const labels = order.map(o => o.name);
  return { intervalsByEmp: result, orderLabels: labels };
}


/* ==================== Chart.js 描画 ==================== */
function renderChartFromIntervals(intervalsByEmp, orderedLabels) {
  const canvas = document.getElementById('ganttCanvas');
  const emptyMsg = document.getElementById('ganttEmpty');
  if (!canvas) return;

  // ラベル準備
  let names = Array.isArray(orderedLabels) ? orderedLabels.slice() : [];
  if (!names.length) {
    const set = new Set();
    intervalsByEmp.forEach(info => set.add(info.name));
    names = Array.from(set);
  }

  // データセット作成
  const datasets = toChartDatasets(intervalsByEmp);
  const totalBars = datasets.reduce((n, ds) => n + (ds.data?.length || 0), 0);

  // 空の場合
  if (totalBars === 0 || names.length === 0) {
    destroyChart();
    canvas.style.display = 'none';
    if (emptyMsg) {
      emptyMsg.style.display = 'flex';
      hideGanttLoading();
    }
    lastSig = 'EMPTY';
    return;
  }

  // データあり：canvas表示
  canvas.style.display = 'block';

  // キャンバスサイズ設定
  const canvasHeight = Math.min(BASE_HEIGHT + names.length * ROW_HEIGHT, 600);
  canvas.style.height = `${canvasHeight}px`;
  canvas.style.maxHeight = `${canvasHeight}px`;
  canvas.style.overflow = 'hidden';

  // 差分チェック
  const sig = makeSignature(names, datasets);
  if (sig === lastSig) {
    if (emptyMsg) emptyMsg.style.display = 'none';
    return;
  }
  lastSig = sig;

  // 再作成
  destroyChart();
  createChart(canvas, names, datasets, canvasHeight);

  if (emptyMsg) emptyMsg.style.display = 'none';
}

function destroyChart() {
  if (ganttChart) {
    ganttChart.destroy();
    ganttChart = null;
  }
}

function createChart(canvas, names, datasets, canvasHeight) {
  const { min, max } = dayBoundsISO();

  const config = {
    type: 'bar',
    data: { labels: names, datasets },
    options: {
      indexAxis: 'y',
      responsive: false,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      layout: { padding: 10 },
      scales: {
        x: {
          type: 'time',
          min, max,
          time: { unit: 'hour', displayFormats: { hour: 'HH:mm' } },
          stacked: true,
          grid: { display: true, color: 'rgba(0, 0, 0, 0.1)' },
          ticks: { font: { size: 10 } }
        },
        y: {
          stacked: true,
          grid: { display: false },
          ticks: { font: { size: 10 }, padding: 5 }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const [s, e] = ctx.raw.x;
              const start = luxon.DateTime.fromISO(s).toFormat('HH:mm');
              const end = luxon.DateTime.fromISO(e).toFormat('HH:mm');
              return `${ctx.dataset.label}: ${start} - ${end}`;
            }
          }
        }
      }
    }
  };

  const parent = canvas.parentElement;
  const maxWidth = parent ? parent.clientWidth : 800;
  canvas.width = Math.min(maxWidth, 800);
  canvas.height = canvasHeight;

  try {
    ganttChart = new Chart(canvas.getContext('2d'), config);
    window.ganttChart = ganttChart;
  } catch (error) {
    console.error('Chart creation failed:', error);
  }
}

function toChartDatasets(intervalsByEmp) {
  const byPos = new Map(POS_ORDER.map(p => [p, []]));

  intervalsByEmp.forEach(info => {
    const open = todayOpenMillis();

    // 勤務セグメント
    for (const seg of info.work) {
      const posName = classToPosName(seg.className);
      const arr = byPos.get(posName) || [];
      arr.push({
        x: [toISO(open, seg.startMin), toISO(open, seg.endMin)],
        y: info.name
      });
      byPos.set(posName, arr);
    }
    // 休憩セグメント
    for (const seg of info.breaks) {
      const arr = byPos.get('休憩') || [];
      arr.push({
        x: [toISO(open, seg.startMin), toISO(open, seg.endMin)],
        y: info.name
      });
      byPos.set('休憩', arr);
    }
  });

  return POS_ORDER.map(posName => ({
    label: posName,
    data: byPos.get(posName) || [],
    parsing: { xAxisKey: 'x', yAxisKey: 'y' },
    backgroundColor: POS_COLOR[posName] || '#999',
    barThickness: 30,
    borderWidth: 0,
    borderSkipped: false
  }));
}

/* ==================== BroadcastChannel 制御 ==================== */
function setupBroadcastChannel() {
  try {
    if (!bc) bc = new BroadcastChannel(BC_CHANNEL_NAME);
    bc.addEventListener('message', (ev) => {
      const d = ev?.data || {};
      if (d.kind !== 'punch' || d.punchType !== '退勤') return;

      const at = d.at ? new Date(d.at) : new Date();
      if (ymd(at) !== currentDay) return;

      const now = Date.now();
      if (now - lastBC < BC_THROTTLE_MS) return;
      lastBC = now;

      clearTimeout(bcTimer);
      bcTimer = setTimeout(() => requestRefresh('bc'), BC_DEBOUNCE_MS);
    });
  } catch (e) {
    console.warn('[BC] init failed', e);
  }
}

/* ==================== タイマー設定 ==================== */
function setMidnightTimer() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  setTimeout(() => {
    currentDay = ymd(new Date());
    lastSig = 'EMPTY';
    renderChartFromIntervals(new Map(), []); // 日付切替直後は空表示
    setMidnightTimer();
  }, next - now);
}

/* ==================== ユーティリティ関数 ==================== */
// データ正規化
function normalizeEmployees(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.employees)) return raw.employees;
  console.warn('[EMP] payload not array:', raw);
  return [];
}
function coerceId(emp) {
  if (!emp) return null;
  const cand = emp.id ?? emp.employeeId ?? emp.ID ?? emp.Id;
  if (cand === null || cand === undefined) return null;
  const s = String(cand).trim();
  return s.length > 0 ? s : null;
}

// ポジション変換
function posClassName(position) {
  if (!position) return 'pos-reji';
  const posMap = {
    'レジ': 'pos-reji',
    'ドリンク': 'pos-drink',
    'ドリンカー': 'pos-drink',
    'フライヤー': 'pos-fry',
    'バーガー': 'pos-burger',
    'reji': 'pos-reji',
    'drink': 'pos-drink',
    'fry': 'pos-fry',
    'burger': 'pos-burger'
  };
  const normalized = String(position).toLowerCase().trim();
  return posMap[position] || posMap[normalized] || 'pos-reji';
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

// 日時処理
function businessDayBounds(d) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), OPEN_HOUR, 0, 0);
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), CLOSE_HOUR, 0, 0);
  return [s, e];
}
function minutesFromOpen(d) {
  return (d.getHours() - OPEN_HOUR) * 60 + d.getMinutes();
}
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

// 配列処理
function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

// 日付フォーマット
function ts(r) {
  return asDate(r.date, r.time).getTime();
}
function normalizeDateStr(s) {
  return String(s || '').trim().replace(/\./g, '-').replace(/\//g, '-');
}
function asDate(dateStr, timeStr) {
  const d = normalizeDateStr(dateStr);
  let t = String(timeStr || '00:00:00').trim();
  const parts = t.split(':').map(p => p.padStart(2, '0'));
  while (parts.length < 3) parts.push('00');
  t = parts.slice(0, 3).join(':');
  // ローカル時刻での Date 化（GAS 側と整合していればOK）
  return new Date(`${d}T${t}`);
}
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// シグネチャ生成
function makeSignature(names, datasets) {
  const dsSig = datasets.map(ds => {
    const n = ds.data?.length || 0;
    if (!n) return `${ds.label}:0`;
    const first = ds.data[0]?.x?.[0] ?? '';
    const last = ds.data[n - 1]?.x?.[1] ?? '';
    return `${ds.label}:${n}:${first}-${last}`;
  });
  return JSON.stringify({ names, ds: dsSig });
}

/* ==================== キャッシュ管理 ==================== */
function saveToCache(intervalsByEmp, orderLabels) {
  try {
    const cacheData = {
      intervals: Array.from(intervalsByEmp.entries()),
      labels: orderLabels,
      timestamp: Date.now(),
      day: currentDay
    };
    localStorage.setItem('gantt_cache', JSON.stringify(cacheData));
  } catch (e) {
    console.warn('キャッシュ保存失敗:', e);
  }
}
function loadFromCache() {
  try {
    const cached = localStorage.getItem('gantt_cache');
    if (!cached) return null;

    const data = JSON.parse(cached);
    if (data.day !== currentDay) {
      localStorage.removeItem('gantt_cache');
      return null;
    }
    if (Date.now() - data.timestamp > 5 * 60 * 1000) {
      localStorage.removeItem('gantt_cache');
      return null;
    }
    return { intervals: new Map(data.intervals), labels: data.labels };
  } catch (e) {
    console.warn('キャッシュ読み込み失敗:', e);
    return null;
  }
}

/* ==================== ネットワーク監視 ==================== */
function setupNetworkHandlers() {
  window.addEventListener('online', () => {
    showSuccessMessage('オンラインに復帰しました');
    requestRefresh();
  });
  window.addEventListener('offline', () => {
    showErrorMessage('オフラインです - キャッシュデータを表示中');
  });
}

/* ==================== モバイルメニュー制御 ==================== */
function setupMobileMenu() {
  const menuToggle = document.getElementById('menuToggle');
  const ganttArea = document.querySelector('.gantt-area');
  const mobileOverlay = document.getElementById('mobileOverlay');
  if (!menuToggle || !ganttArea || !mobileOverlay) return;

  menuToggle.addEventListener('click', () => {
    const isOpen = ganttArea.classList.contains('show');
    if (isOpen) {
      ganttArea.classList.remove('show');
      mobileOverlay.classList.remove('show');
      menuToggle.classList.remove('active');
      menuToggle.setAttribute('aria-expanded', 'false');
    } else {
      ganttArea.classList.add('show');
      mobileOverlay.classList.add('show');
      menuToggle.classList.add('active');
      menuToggle.setAttribute('aria-expanded', 'true');
    }
  });

  mobileOverlay.addEventListener('click', () => {
    ganttArea.classList.remove('show');
    mobileOverlay.classList.remove('show');
    menuToggle.classList.remove('active');
    menuToggle.setAttribute('aria-expanded', 'false');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ganttArea.classList.contains('show')) {
      ganttArea.classList.remove('show');
      mobileOverlay.classList.remove('show');
      menuToggle.classList.remove('active');
      menuToggle.setAttribute('aria-expanded', 'false');
    }
  });
}
