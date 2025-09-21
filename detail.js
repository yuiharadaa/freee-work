// detail.js v47 - 従業員詳細ページ（KPI：左=今月の合計数値 / 中央=時計 / 右=年ドーナツ）
// =================================================================================

/* ==================== グローバル状態 ==================== */
let current = null;

/* ==== KPI & 給料可視化 ====
   年の上限（103万円）や見せ方をここで調整できます。 */
const ANNUAL_CAP = 1030000;      // 年間の目安上限（103万円）。必要に応じて 1060000 / 1300000 などに変更
let annualChart = null;
const yen = n => "¥" + Math.round(n).toLocaleString("ja-JP");

/* ==================== ローディング制御 & フィードバック ==================== */
function showLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.classList.add('active');
}

function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.classList.remove('active');
}

function showInlineLoader(element, message = '読み込み中') {
  if (!element) return;
  element.innerHTML = `<span class="inline-loader">${message}</span>`;
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: ${type === 'success' ? '#22c55e' : '#ef4444'};
    color: white;
    padding: 12px 24px;
    border-radius: 8px;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    z-index: 10000;
    animation: fadeInUp 0.3s ease;
  `;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'fadeOutDown 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/* ==================== 初期化処理 ==================== */
window.addEventListener('DOMContentLoaded', init);

async function init() {
  // デジタル時計の初期化
  initDigitalClock();

  const empId = new URL(location.href).searchParams.get('empId');
  if (!empId) {
    document.getElementById('empName').textContent = '（ID未指定）';
    showToast('従業員IDが指定されていません', 'error');
    return;
  }

  showLoading();
  let retryCount = 0;
  const maxRetries = 3;

  async function fetchWithRetry() {
    try {
      current = await API.fetchEmployee(empId);
      document.getElementById('empId').textContent = API.escapeHtml(String(current.id));
      document.getElementById('empName').textContent = API.escapeHtml(String(current.name));
      await refreshUI();
    } catch (e) {
      console.error(e);
      retryCount++;
      if (retryCount < maxRetries) {
        console.log(`リトライ ${retryCount}/${maxRetries}`);
        setTimeout(fetchWithRetry, 1000 * retryCount);
      } else {
        document.getElementById('empName').textContent = '従業員情報の取得に失敗しました。';
        showToast('データの取得に失敗しました', 'error');
        hideLoading();
      }
    }
  }

  await fetchWithRetry();
  hideLoading();
}

/* ==================== UI更新 ==================== */
async function refreshUI() {
  await loadHistoryAndRender();
  await renderActionButtons();
  await renderKpisFromApi(); // ✅ 追加：KPI（今月・年）を描画
}

/* ==================== アクションボタン表示 ==================== */
async function renderActionButtons() {
  const container = document.getElementById('actionButtons');
  showInlineLoader(container, 'アクションを読み込み中');

  try {
    const all = await API.fetchHistory({ employeeId: current.id, days: 30 });
    const last = getLastEvent(all);
    const nextActions = decideNextByLastType(last?.punchType);

    container.textContent = '';

    if (nextActions.length === 0) {
      container.textContent = '今は実行可能なアクションがありません。';
      return;
    }

    nextActions.forEach(action => {
      const btn = createActionButton(action);
      container.appendChild(btn);
    });
  } catch (e) {
    console.error(e);
    container.textContent = 'アクションの描画に失敗しました。';
  }
}

function createActionButton(action) {
  const btn = document.createElement('button');
  btn.textContent = action;

  const classMap = {
    '出勤': 'btn btn-shukkin',
    '退勤': 'btn btn-taikin',
    '休憩開始': 'btn btn-kyuukei-start',
    '休憩終了': 'btn btn-kyuukei-end'
  };
  btn.className = classMap[action] || 'btn btn-shukkin';

  btn.addEventListener('click', (e) => onPunchAction(action, e));
  return btn;
}

/* ==================== 打刻処理 ==================== */
async function onPunchAction(action, event) {
  const status = document.getElementById('status');
  const position = document.getElementById('position').value;

  // 二重送信防止：すべてのボタンを無効化
  const buttons = document.querySelectorAll('#actionButtons button');
  const clickedButton = event ? event.target : buttons[0];

  buttons.forEach(btn => {
    btn.disabled = true;
    if (btn === clickedButton) btn.classList.add('loading');
  });

  showInlineLoader(status, '送信中');

  try {
    const saved = await API.sendPunch({
      id: current.id,
      name: current.name,
      punchType: action,
      position
    });

    status.textContent = `打刻完了: ${saved.date} ${saved.time} / ${saved.punchType} / ${saved.position}`;
    showToast(`${action}を記録しました`, 'success');

    if (action === '退勤') notifyPunchEvent();

    await refreshUI();
  } catch (e) {
    console.error(e);
    const errorMessage = e.message || '打刻に失敗しました';
    status.textContent = `エラー: ${errorMessage}`;
    showToast(errorMessage, 'error');

    // リトライ可に戻す
    buttons.forEach(btn => {
      btn.classList.remove('loading');
      btn.disabled = false;
    });

    // リトライボタン
    const retryBtn = document.createElement('button');
    retryBtn.textContent = '再試行';
    retryBtn.className = 'btn btn-retry';
    retryBtn.style.marginLeft = '10px';
    retryBtn.onclick = () => {
      retryBtn.remove();
      onPunchAction(action, event);
    };
    status.appendChild(retryBtn);
  }
}

function notifyPunchEvent() {
  try {
    const bc = new BroadcastChannel('punch');
    bc.postMessage({ kind: 'punch', punchType: '退勤', at: new Date().toISOString() });
    bc.close();
  } catch (e) {
    console.warn('[DETAIL] BC send failed:', e);
  }
}

/* ==================== 履歴表示 ==================== */
async function loadHistoryAndRender() {
  const tbody = document.getElementById('historyBody');
  const tplRow = document.getElementById('tpl-history-row');
  const totalEl = document.getElementById('workTotal');

  showInlineLoader(tbody, '履歴を読み込み中');

  try {
    const rows = await API.fetchHistory({ employeeId: current.id, days: 30 });

    if (rows.length === 0) {
      renderEmptyHistory(tbody, totalEl);
      return;
    }

    // 新しい順にソート
    const rowsDesc = sortHistoryDescending(rows);

    // 勤務時間計算（各イベント時点での直近区間の長さ）
    const durMap = buildWorkDurations(rows);

    // 履歴表示
    renderHistoryRows(tbody, tplRow, rowsDesc, durMap);

    // 本日の合計勤務時間
    if (totalEl) updateTodayTotal(totalEl, rows);
  } catch (e) {
    console.error(e);
    renderHistoryError(tbody, totalEl);
  }
}

function renderEmptyHistory(tbody, totalEl) {
  tbody.innerHTML = '<tr><td colspan="5">履歴はありません。</td></tr>';
  if (totalEl) totalEl.textContent = '0時間0分';
}

function renderHistoryError(tbody, totalEl) {
  tbody.innerHTML = '<tr><td colspan="5">履歴の取得に失敗しました。</td></tr>';
  if (totalEl) totalEl.textContent = '-';
}

function renderHistoryRows(tbody, tplRow, rows, durMap) {
  const frag = document.createDocumentFragment();

  rows.forEach(r => {
    const tr = tplRow.content.cloneNode(true);
    tr.querySelector('.c-date').textContent = API.escapeHtml(r.date);
    tr.querySelector('.c-time').textContent = API.escapeHtml(r.time);
    tr.querySelector('.c-type').textContent = API.escapeHtml(r.punchType);
    tr.querySelector('.c-pos').textContent = API.escapeHtml(r.position);

    const key = makeEventKey(r.date, r.time, r.punchType);
    const ms = durMap.get(key);
    tr.querySelector('.c-dur').textContent = ms ? formatHm(ms) : '';

    frag.appendChild(tr);
  });

  tbody.textContent = '';
  tbody.appendChild(frag);
}

function updateTodayTotal(totalEl, rows) {
  const today = ymd(new Date()).replace(/\./g, '-').replace(/\//g, '-');
  const todayRows = rows
    .filter(r => normalizeDate(r.date) === today)
    .sort((a, b) => toTimestamp(a.date, a.time) - toTimestamp(b.date, b.time));

  const totalMs = calcWorkTotal(todayRows);
  const h = Math.floor(totalMs / 1000 / 60 / 60);
  const m = Math.floor(totalMs / 1000 / 60) % 60;
  totalEl.textContent = `${h}時間${m}分`;

  // 退勤済みチェックと給料計算
  const hasClockedOut = todayRows.some(r => r.punchType === '退勤');
  const salaryContainer = document.getElementById('dailySalaryContainer');
  const dailySalaryEl = document.getElementById('dailySalary');
  const hourlyWageEl = document.getElementById('hourlyWage');

  if (hasClockedOut && current?.hourlyWage && salaryContainer && dailySalaryEl && hourlyWageEl) {
    const hourlyWage = current.hourlyWage;
    hourlyWageEl.textContent = `¥${hourlyWage.toLocaleString()}`;
    const workHours = totalMs / 1000 / 60 / 60;
    const dailySalary = Math.floor(workHours * hourlyWage);
    dailySalaryEl.textContent = `¥${dailySalary.toLocaleString()}`;
    salaryContainer.style.display = 'block';
  } else if (salaryContainer) {
    salaryContainer.style.display = 'none';
  }
}

/* ==================== 勤務時間計算 ==================== */
function buildWorkDurations(rowsAsc) {
  const map = new Map();
  let runningStart = null;

  rowsAsc.sort((a, b) => toTimestamp(a.date, a.time) - toTimestamp(b.date, b.time));

  rowsAsc.forEach(r => {
    const ts = toTimestamp(r.date, r.time);
    switch (r.punchType) {
      case '出勤':
      case '休憩終了':
        runningStart = ts;
        break;
      case '休憩開始':
      case '退勤':
        if (runningStart != null) {
          const dur = ts - runningStart;
          const durMinutes = Math.floor(dur / 1000 / 60); // 分へ切り捨て
          const durMs = durMinutes * 60 * 1000;
          const key = makeEventKey(r.date, r.time, r.punchType);
          map.set(key, durMs);
          runningStart = null;
        }
        break;
    }
  });
  return map;
}

function calcWorkTotal(rowsAsc) {
  let total = 0;
  let runningStart = null;

  rowsAsc.forEach(r => {
    const ts = toTimestamp(r.date, r.time);
    switch (r.punchType) {
      case '出勤':
      case '休憩終了':
        runningStart = ts;
        break;
      case '休憩開始':
      case '退勤':
        if (runningStart != null) {
          const durationMs = ts - runningStart;
          const durationMinutes = Math.floor(durationMs / 1000 / 60);
          total += durationMinutes * 60 * 1000; // ミリ秒
          runningStart = null;
        }
        break;
    }
  });
  return total;
}

/* ==================== 状態判定 ==================== */
function getLastEvent(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const withTs = rows
    .map(r => ({ ...r, __ts: toTimestamp(r.date, r.time) }))
    .filter(r => !Number.isNaN(r.__ts));
  if (withTs.length === 0) return null;
  withTs.sort((a, b) => b.__ts - a.__ts);
  return withTs[0];
}

function decideNextByLastType(lastType) {
  if (!lastType) return ['出勤'];
  const transitions = {
    '出勤': ['退勤', '休憩開始'],
    '休憩開始': ['休憩終了'],
    '休憩終了': ['退勤', '休憩開始'],
    '退勤': ['出勤']
  };
  return transitions[lastType] || ['出勤'];
}

/* ==================== ユーティリティ関数 ==================== */
// ソート
function sortHistoryDescending(rows) {
  return rows.slice().sort((a, b) => {
    const tsA = toTimestamp(a.date, a.time);
    const tsB = toTimestamp(b.date, b.time);
    return tsB - tsA;
  });
}

// 日時処理
function toTimestamp(dateStr, timeStr) {
  const d = normalizeDate(dateStr);
  const t = normalizeTime(timeStr);
  const iso = `${d}T${t}`;
  return new Date(iso).getTime();
}

function normalizeDate(s) {
  return String(s || '').trim().replace(/\./g, '-').replace(/\//g, '-');
}

function normalizeTime(s) {
  let t = String(s || '00:00:00').trim();
  const parts = t.split(':').map(x => x.padStart(2, '0'));
  while (parts.length < 3) parts.push('00');
  return parts.slice(0, 3).join(':');
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// フォーマット
function formatHm(ms) {
  const m = Math.max(0, Math.floor(ms / 1000 / 60));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h ? `${h}時間${mm}分` : `${mm}分`;
}

function makeEventKey(dateStr, timeStr, type) {
  return `${normalizeDate(dateStr)} ${normalizeTime(timeStr)} ${type}`;
}

/* ==================== デジタル時計機能 ==================== */
let clockUpdateInterval = null;

function initDigitalClock() {
  updateDigitalClock(); // すぐ更新
  if (clockUpdateInterval) clearInterval(clockUpdateInterval);
  clockUpdateInterval = setInterval(updateDigitalClock, 1000);
}

function updateDigitalClock() {
  const now = new Date();
  const timeElement = document.querySelector('.digital-clock .time');
  const dateElement = document.querySelector('.digital-clock .date');
  if (!timeElement || !dateElement) return;

  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const timeString = `${hours}:${minutes}:${seconds}`;

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  const dateString = `${year}年${month}月${date}日`;

  timeElement.textContent = timeString;
  dateElement.textContent = dateString;
}

window.addEventListener('beforeunload', () => {
  if (clockUpdateInterval) clearInterval(clockUpdateInterval);
});

/* ==================== KPI（今月/年）集計と描画 ==================== */
// ある日の rows から IN/OUT ペアで分を計算
function dailyMinutesFromRows(dayRows) {
  const rows = dayRows.slice().sort((a, b) => toTimestamp(a.date, a.time) - toTimestamp(b.date, b.time));
  let totalMin = 0;
  let runningStart = null;

  for (const r of rows) {
    const ts = toTimestamp(r.date, r.time);
    if (r.punchType === '出勤' || r.punchType === '休憩終了') {
      runningStart = ts;
    } else if ((r.punchType === '休憩開始' || r.punchType === '退勤') && runningStart != null) {
      const diffMs = ts - runningStart;
      const diffMin = Math.max(0, Math.floor(diffMs / 1000 / 60));
      totalMin += diffMin;
      runningStart = null;
    }
  }
  return totalMin;
}

// 今月・今年の給料（円）を算出
function computeMonthlyAnnualPay(allRows, hourlyWage) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-11

  const byDate = new Map(); // 'YYYY-MM-DD' -> rows[]
  for (const r of allRows) {
    const key = normalizeDate(r.date);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(r);
  }

  let monthlyMin = 0;
  let annualMin  = 0;

  for (const [dateStr, rows] of byDate.entries()) {
    const d = new Date(dateStr + "T00:00:00");
    if (isNaN(d.getTime())) continue;
    const dy = d.getFullYear();
    const dm = d.getMonth();
    const mins = dailyMinutesFromRows(rows);
    if (dy === y) {
      annualMin += mins;
      if (dm === m) monthlyMin += mins;
    }
  }

  const perMin = Number(hourlyWage || 0) / 60;
  return {
    monthlyPay: monthlyMin * perMin,
    annualPay:  annualMin  * perMin
  };
}

// KPIの描画（左：数値 / 右：ドーナツ）
function renderKpis({ monthlyPay, annualPay }) {
  // 左：今月の数値
  const monthlyCap = ANNUAL_CAP / 12;
  const monthlyTotalText = document.getElementById('monthlyTotalText');
  const monthlyCapText   = document.getElementById('monthlyCapText');
  if (monthlyTotalText) monthlyTotalText.textContent = yen(monthlyPay);
  if (monthlyCapText)   monthlyCapText.textContent   = yen(monthlyCap);

  // 右：今年のドーナツ
  const annualTotalText = document.getElementById('annualTotalText');
  const annualCapText   = document.getElementById('annualCapText');
  if (annualTotalText) annualTotalText.textContent = yen(annualPay);
  if (annualCapText)   annualCapText.textContent   = yen(ANNUAL_CAP);

  const remain = Math.max(0, ANNUAL_CAP - annualPay);
  const ctx = document.getElementById('annualPie')?.getContext('2d');
  if (!ctx) return;

  const data = {
    labels: ['今年の給料', '残り（上限）'],
    datasets: [{ data: [annualPay, remain] }]
  };
  const opts = {
    responsive: true,
    cutout: '65%',
    plugins: {
      legend: { display: true },
      tooltip: { callbacks: { label: (c) => `${c.label}: ${yen(c.raw)}` } }
    }
  };

  if (annualChart) {
    annualChart.data = data;
    annualChart.update();
  } else {
    annualChart = new Chart(ctx, { type: 'doughnut', data, options: opts });
  }
}

// APIから年間分取得してKPI反映
async function renderKpisFromApi() {
  try {
    if (!current?.id) return;

    // 直近365日を取得（APIがdaysに対応済み）
    const all = await API.fetchHistory({ employeeId: current.id, days: 365 });

    // 時給：employee優先。無ければUI表示からフォールバック
    const hourly =
      Number(current?.hourlyWage ?? 0) ||
      Number(String(document.getElementById('hourlyWage')?.textContent || '').replace(/[^\d]/g, '')) ||
      0;

    const result = computeMonthlyAnnualPay(all, hourly);
    renderKpis(result);
  } catch (e) {
    console.error('KPI描画中に失敗:', e);
  }
}
