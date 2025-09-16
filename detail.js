// detail.js v35（退勤成功時に BroadcastChannel 送信）

let current = null;

window.addEventListener('DOMContentLoaded', init);

async function init() {
  const empId = new URL(location.href).searchParams.get('empId');
  if (!empId) {
    document.getElementById('empName').textContent = '（ID未指定）';
    return;
  }

  try {
    current = await API.fetchEmployee(empId);
    document.getElementById('empId').textContent   = API.escapeHtml(String(current.id));
    document.getElementById('empName').textContent = API.escapeHtml(String(current.name));
    await refreshUI();
  } catch (e) {
    console.error(e);
    document.getElementById('empName').textContent = '従業員情報の取得に失敗しました。';
  }
}

/** 履歴とボタンの再描画 */
async function refreshUI() {
  await loadHistoryAndRender();
  await renderActionButtons();
}

/** 今の状態を調査してボタンを出す */
async function renderActionButtons() {
  const container = document.getElementById('actionButtons');
  container.textContent = '…';
  try {
    const all = await API.fetchHistory({ employeeId: current.id, days: 30 });
    const last = getLastEvent(all);
    const nextActions = decideNextByLastType(last?.punchType);

    container.textContent = '';
    nextActions.forEach(action => {
      const btn = document.createElement('button');
      btn.textContent = action;

      // 見た目のクラス（例）
      switch (action) {
        case '出勤':     btn.className = 'btn-shukkin'; break;
        case '退勤':     btn.className = 'btn-taikin'; break;
        case '休憩開始': btn.className = 'btn-kyuukei-start'; break;
        case '休憩終了': btn.className = 'btn-kyuukei-end'; break;
        default:         btn.className = 'btn-shukkin';
      }

      btn.addEventListener('click', () => onPunchAction(action));
      container.appendChild(btn);
    });

    if (nextActions.length === 0) {
      container.textContent = '今は実行可能なアクションがありません。';
    }
  } catch (e) {
    console.error(e);
    container.textContent = 'アクションの描画に失敗しました。';
  }
}

/** アクションを押した時の動作 */
async function onPunchAction(action) {
  const status = document.getElementById('status');
  status.textContent = '送信中…';
  const position = document.getElementById('position').value;

  try {
    const saved = await API.sendPunch({
      id: current.id,
      name: current.name,
      punchType: action,
      position
    });

    status.textContent = `打刻完了: ${saved.date} ${saved.time} / ${saved.punchType} / ${saved.position}`;

    // ★ 退勤に成功したらホームへ通知（ガント再描画用）
    if (action === '退勤') {
      try {
        const bc = new BroadcastChannel('punch');
        bc.postMessage({ kind: 'punch', punchType: '退勤', at: new Date().toISOString() });
        bc.close();
      } catch (e) {
        // BroadcastChannel未対応でもOK（無視）
        console.warn('[DETAIL] BC send failed:', e);
      }
    }

    await refreshUI(); // 履歴とボタンを更新
  } catch (e) {
    console.error(e);
    status.textContent = `エラー: ${e.message || e}`;
  }
}

/** 最新の打刻1件を返す（date/time を正しくパースして比較） */
function getLastEvent(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const withTs = rows.map(r => ({ ...r, __ts: toTimestamp(r.date, r.time) }))
                    .filter(r => !Number.isNaN(r.__ts));
  if (withTs.length === 0) return null;
  withTs.sort((a, b) => b.__ts - a.__ts); // 新しい順
  return withTs[0];
}

/** “YYYY-MM-DD / YYYY/MM/DD + H:m[:s]” を Date に変換して epoch(ms) 返す */
function toTimestamp(dateStr, timeStr) {
  const d = String(dateStr || '').trim().replace(/\./g, '-').replace(/\//g, '-');
  let t = String(timeStr || '00:00:00').trim();
  const parts = t.split(':').map(x => x.padStart(2, '0'));
  while (parts.length < 3) parts.push('00');
  t = parts.slice(0,3).join(':');
  const iso = `${d}T${t}`;
  const dt = new Date(iso);
  return dt.getTime();
}

/** 直前の種別から次に押せるボタンを決める */
function decideNextByLastType(lastType) {
  if (!lastType) return ['出勤'];
  switch (lastType) {
    case '出勤':     return ['退勤', '休憩開始'];
    case '休憩開始': return ['休憩終了'];
    case '休憩終了': return ['退勤'];
    case '退勤':     return ['出勤'];
    default:         return ['出勤']; // 想定外はフォールバック
  }
}

async function loadHistoryAndRender() {
  const tbody = document.getElementById('historyBody');
  const tpl = document.getElementById('tpl-history-row');
  tbody.textContent = '';

  // 当日の履歴を取得
  const rows = await API.fetchHistory({ employeeId: current.id, days: 1 });

  // 勤務時間と給与は退勤が確定している日のみ計算
  const totalMin = sumWorkMinutes(rows);  // 分単位で勤務合計
  const durStr = totalMin ? formatHours(totalMin) : '';
  const pay = totalMin && current.hourlyWage
    ? Math.floor(totalMin * current.hourlyWage / 60) // 分単位できっちり計算
    : 0;
  const payStr = pay ? `¥${formatJPY(pay)}` : '';

  rows.forEach(r => {
    const node = tpl.content.cloneNode(true);
    node.querySelector('.c-date').textContent = r.date;
    node.querySelector('.c-time').textContent = r.time;
    node.querySelector('.c-type').textContent = r.punchType;
    node.querySelector('.c-pos').textContent  = r.position;
    // 「退勤」行のときだけ勤務時間と給与を表示
    if (r.punchType === '退勤') {
      node.querySelector('.c-dur').textContent = durStr;
      node.querySelector('.c-pay').textContent = payStr;
    }
    tbody.appendChild(node);
  });
}


/* === 区間ごとの勤務時間(ms)を計算 ===
   ・出勤/休憩終了 で start
   ・休憩開始/退勤 で stop → その stop 行に対する key で ms を保存 */
function buildWorkDurations(rowsAsc) {
  const map = new Map();
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
          const dur = ts - runningStart;
          const key = makeEventKey(r.date, r.time, r.punchType);
          map.set(key, dur);
          runningStart = null;
        }
        break;
    }
  });

  return map;
}

// 表示用フォーマット（例：3時間5分 / 45分）
function formatHm(ms) {
  const m = Math.max(0, Math.floor(ms / 1000 / 60));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h ? `${h}時間${mm}分` : `${mm}分`;
}

// event を一意に識別（降順表示でも一致するよう正規化）
function makeEventKey(dateStr, timeStr, type) {
  return `${normalizeDate(dateStr)} ${normalizeTime(timeStr)} ${type}`;
}

function normalizeDate(s) {
  return String(s || '').trim().replace(/\./g, '-').replace(/\//g, '-');
}
function normalizeTime(s) {
  let t = String(s || '00:00:00').trim();
  const parts = t.split(':').map(x => x.padStart(2, '0'));
  while (parts.length < 3) parts.push('00');
  return parts.slice(0,3).join(':'); // HH:MM:SS
}

/** 参考：本日の合計勤務時間（休憩除外） */
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
          total += ts - runningStart;
          runningStart = null;
        }
        break;
    }
  });

  return total;
}
