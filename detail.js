// detail.js - 従業員詳細ページ

/* ==================== グローバル状態 ==================== */
let current = null;
let maxIncomeLimit = 1500000; // デフォルト上限値

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

  // 収入グラフの初期化
  initIncomeChart();

  // 上限値更新ボタンのイベント設定
  setupMaxIncomeControl();

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
  // 履歴とアクションボタンは同期的に更新
  await loadHistoryAndRender();
  await renderActionButtons();

  // 収入チャートは非同期で更新（ブロックしない）
  updateIncomeChartAsync();
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

  // スタイルクラス設定
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
    if (btn === clickedButton) {
      btn.classList.add('loading');
    }
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

    // 成功通知
    showToast(`${action}を記録しました`, 'success');

    // 退勤時はBroadcastChannelで通知
    if (action === '退勤') {
      notifyPunchEvent();
    }

    await refreshUI();
  } catch (e) {
    console.error(e);
    const errorMessage = e.message || '打刻に失敗しました';
    status.textContent = `エラー: ${errorMessage}`;

    // エラー通知
    showToast(errorMessage, 'error');

    // エラー時もボタンを再有効化（リトライ可能にする）
    buttons.forEach(btn => {
      btn.classList.remove('loading');
      btn.disabled = false;
    });

    // リトライボタン表示
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
    bc.postMessage({
      kind: 'punch',
      punchType: '退勤',
      at: new Date().toISOString()
    });
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

    // 勤務時間計算
    const durMap = buildWorkDurations(rows);

    // 履歴表示
    renderHistoryRows(tbody, tplRow, rowsDesc, durMap);

    // 本日の合計勤務時間
    if (totalEl) {
      updateTodayTotal(totalEl, rows);
    }
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

    // 勤務時間表示
    const key = makeEventKey(r.date, r.time, r.punchType);
    const ms = durMap.get(key);
    tr.querySelector('.c-dur').textContent = ms ? formatHm(ms) : '';

    frag.appendChild(tr);
  });

  tbody.textContent = '';
  tbody.appendChild(frag);
}

function updateTodayTotal(totalEl, rows) {
  const today = ymd(new Date());
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
    // 時給を表示
    const hourlyWage = current.hourlyWage;
    hourlyWageEl.textContent = `¥${hourlyWage.toLocaleString()}`;

    // 給料を計算（勤務時間（時間）× 時給）
    const workHours = totalMs / 1000 / 60 / 60;
    const dailySalary = Math.floor(workHours * hourlyWage);
    dailySalaryEl.textContent = `¥${dailySalary.toLocaleString()}`;

    // 給料表示エリアを表示
    salaryContainer.style.display = 'block';
  } else if (salaryContainer) {
    // 退勤していない場合は非表示
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
          // 秒を切り捨て（分単位に切り捨て）
          const durMinutes = Math.floor(dur / 1000 / 60);
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
          // 秒を切り捨て（分単位に切り捨て）
          const durationMinutes = Math.floor(durationMs / 1000 / 60);
          total += durationMinutes * 60 * 1000; // ミリ秒に戻す
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
  // 即座に時計を更新
  updateDigitalClock();

  // 1秒ごとに時計を更新
  if (clockUpdateInterval) {
    clearInterval(clockUpdateInterval);
  }
  clockUpdateInterval = setInterval(updateDigitalClock, 1000);
}

function updateDigitalClock() {
  const now = new Date();
  const timeElement = document.querySelector('.time-large');
  const dateElement = document.querySelector('.date-large');

  if (!timeElement || !dateElement) return;

  // 時刻をフォーマット (HH:MM:SS)
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const timeString = `${hours}:${minutes}:${seconds}`;

  // 日付をフォーマット (YYYY年MM月DD日)
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  const dateString = `${year}年${month}月${date}日`;

  // DOM要素を更新
  timeElement.textContent = timeString;
  dateElement.textContent = dateString;
}

// ページを離れる時にintervalをクリア
window.addEventListener('beforeunload', () => {
  if (clockUpdateInterval) {
    clearInterval(clockUpdateInterval);
  }
});

/* ==================== 収入グラフ機能 ==================== */
let incomeChart = null;

// 上限値コントロールの設定
function setupMaxIncomeControl() {
  const input = document.getElementById('maxIncomeInput');
  const button = document.getElementById('updateMaxIncome');
  const display = document.getElementById('maxIncomeDisplay');

  if (!input || !button || !display) return;

  // 入力値のフォーマット（コンマ区切り表示）
  const formatInput = () => {
    const value = parseInt(input.value.replace(/,/g, ''));
    if (!isNaN(value)) {
      input.value = value.toLocaleString();
    }
  };

  // 更新ボタンクリック時
  button.addEventListener('click', () => {
    const cleanValue = input.value.replace(/,/g, '');
    const newValue = parseInt(cleanValue);
    if (isNaN(newValue) || newValue <= 0) {
      alert('正しい金額を入力してください');
      input.value = maxIncomeLimit.toLocaleString();
      return;
    }

    maxIncomeLimit = newValue;
    display.textContent = '¥' + maxIncomeLimit.toLocaleString();
    formatInput();

    // グラフを再描画
    if (incomeChart) {
      updateIncomeChartAsync();
    }
  });

  // Enterキーでも更新
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      button.click();
    }
  });

  // フォーカスアウト時にフォーマット
  input.addEventListener('blur', formatInput);

  // 初期値をフォーマット表示
  input.value = maxIncomeLimit.toLocaleString();
}

function initIncomeChart() {
  const canvas = document.getElementById('incomeChart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  // 初期チャート設定
  incomeChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['稼いだ額', '上限まで'],
      datasets: [{
        data: [0, maxIncomeLimit],
        backgroundColor: [
          'linear-gradient(135deg, #2563eb, #0ea5e9)',
          '#e5e7eb'
        ],
        borderWidth: 0
      }]
    },
    options: {
      responsive: false,
      maintainAspectRatio: true,
      cutout: '75%',
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const label = context.label || '';
              const value = context.parsed || 0;
              return label + ': ¥' + value.toLocaleString();
            }
          }
        }
      }
    },
    plugins: [{
      id: 'centerText',
      beforeDraw: function(chart) {
        const ctx = chart.ctx;
        ctx.save();
        const centerX = (chart.chartArea.left + chart.chartArea.right) / 2;
        const centerY = (chart.chartArea.top + chart.chartArea.bottom) / 2;

        const earned = chart.data.datasets[0].data[0];
        const percentage = Math.round((earned / maxIncomeLimit) * 100);

        ctx.font = 'bold 24px sans-serif';
        ctx.fillStyle = '#1a1a1a';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(percentage + '%', centerX, centerY - 5);

        ctx.font = '12px sans-serif';
        ctx.fillStyle = '#6b7280';
        ctx.fillText('', centerX, centerY + 15);

        ctx.restore();
      }
    }]
  });
}

// 収入チャートの非同期更新
function updateIncomeChartAsync() {
  if (!incomeChart || !current) return;

  // ローディング表示
  const incomeLoading = document.getElementById('incomeLoading');
  if (incomeLoading) {
    incomeLoading.style.display = 'flex';
  }

  // 非同期で実行
  setTimeout(() => {
    updateIncomeChart();
  }, 100);
}

async function updateIncomeChart() {
  if (!incomeChart || !current) return;

  const incomeLoading = document.getElementById('incomeLoading');

  try {
    // 今年の全履歴を取得（最大365日分だが、APIの制限に応じて調整）
    const rows = await API.fetchHistory({ employeeId: current.id, days: 365 });

    // 今年のデータのみフィルタリング
    const currentYear = new Date().getFullYear();
    const yearRows = rows.filter(r => {
      const date = new Date(normalizeDate(r.date));
      return date.getFullYear() === currentYear;
    });

    // 日別に勤務データをグループ化
    const dailyWork = new Map();
    yearRows.forEach(r => {
      const date = normalizeDate(r.date);
      if (!dailyWork.has(date)) {
        dailyWork.set(date, []);
      }
      dailyWork.get(date).push(r);
    });

    // 実際の勤務時間から収入を計算
    let totalIncome = 0;
    const hourlyWage = 1200; // 時給¥1,200（固定値）

    dailyWork.forEach((dayRows) => {
      const sortedRows = dayRows.sort((a, b) =>
        toTimestamp(a.date, a.time) - toTimestamp(b.date, b.time)
      );
      const workMs = calcWorkTotal(sortedRows);
      const workHours = workMs / 1000 / 60 / 60;
      totalIncome += Math.floor(workHours * hourlyWage);
    });

    // 実データのみ使用、モック値は一切使わない
    const remaining = Math.max(0, maxIncomeLimit - totalIncome);
    const percentage = Math.min(100, Math.round((totalIncome / maxIncomeLimit) * 100));

    // グラフ更新
    incomeChart.data.datasets[0].data = [totalIncome, remaining];

    // グラデーション背景を適用
    const gradient = incomeChart.ctx.createLinearGradient(0, 0, 200, 200);
    gradient.addColorStop(0, '#2563eb');
    gradient.addColorStop(1, '#0ea5e9');
    incomeChart.data.datasets[0].backgroundColor = [gradient, '#e5e7eb'];

    incomeChart.update();

    // UI更新
    document.getElementById('totalIncome').textContent = '¥' + totalIncome.toLocaleString();
    document.getElementById('progressBar').style.width = percentage + '%';
    document.getElementById('progressPercent').textContent = percentage + '%';

    // ローディングを非表示
    if (incomeLoading) {
      incomeLoading.style.display = 'none';
    }

  } catch (e) {
    console.error('収入データの取得に失敗:', e);
    // エラー時は0円を表示
    const totalIncome = 0;
    const percentage = 0;

    incomeChart.data.datasets[0].data = [0, maxIncomeLimit];
    incomeChart.update();

    document.getElementById('totalIncome').textContent = '¥0';
    document.getElementById('progressBar').style.width = '0%';
    document.getElementById('progressPercent').textContent = '0%';

    // ローディングを非表示
    if (incomeLoading) {
      incomeLoading.style.display = 'none';
    }
  }
}