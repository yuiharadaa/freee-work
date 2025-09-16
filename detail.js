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

// === ここからコピペ（detail.js 内の loadHistoryAndRender を置き換え）===

async function loadHistoryAndRender() {
  const tbody = document.getElementById('historyBody');
  const tpl = document.getElementById('tpl-history-row');
  tbody.textContent = '';

  // 1) 当日の履歴取得
  const rows = await API.fetchHistory({ employeeId: current.id, days: 1 });
  // 安全のため時系列昇順に
  rows.sort((a,b) => toTimestamp(a.date,a.time) - toTimestamp(b.date,b.time));

  // 2) 時給が current に無ければ補完（employee.list から引く）
  if (current.hourlyWage == null) {
    try {
      const list = await API.fetchEmployees();
      const me = Array.isArray(list) ? list.find(e => String(e.id) === String(current.id))
                                     : (list.employees || []).find(e => String(e.id) === String(current.id));
      if (me && me.hourlyWage != null) current.hourlyWage = Number(me.hourlyWage) || 0;
    } catch (e) {
      console.warn('[DETAIL] failed to backfill hourlyWage', e);
      current.hourlyWage = 0;
    }
  }

  // 3) 勤務合計（分）を「退勤で閉じた分だけ」計算
  const totalMin = computeClosedWorkMinutes(rows); // 分
  const durStr = totalMin > 0 ? formatHoursEn(totalMin) : ''; // "7h30m"
  // 分単位できっちり計算（切り捨て）
  const pay = (totalMin > 0 && current.hourlyWage > 0)
    ? Math.floor(totalMin * current.hourlyWage / 60)
    : 0;
  const payStr = pay > 0 ? `¥${formatJPY(pay)}` : '';

  // 4) テーブル描画：退勤行にだけ勤務時間と給与を出す
  rows.forEach(r => {
    const node = tpl.content.cloneNode(true);
    node.querySelector('.c-date').textContent = r.date;
    node.querySelector('.c-time').textContent = r.time;
    node.querySelector('.c-type').textContent = r.punchType;
    node.querySelector('.c-pos').textContent  = r.position;

    if (r.punchType === '退勤') {
      node.querySelector('.c-dur').textContent = durStr;
      node.querySelector('.c-pay').textContent = payStr;
    }
    tbody.appendChild(node);
  });

  // 退勤がまだ無い場合でも「枠」は出したいなら、最後に空行を1つ足す
  if (!rows.some(r => r.punchType === '退勤')) {
    const node = tpl.content.cloneNode(true);
    // 日付・時刻・種別・ポジションは空、勤務時間と給与も空のまま
    tbody.appendChild(node);
  }
}

/* ===== ここから下はこのファイルに無ければ一緒に貼ってOK（重複があれば既存を優先） ===== */

// 退勤で閉じた勤務だけを合計（分）
function computeClosedWorkMinutes(rowsAsc) {
  let total = 0;
  let start = null;      // 勤務開始 ts
  let onBreak = false;   // 休憩中フラグ（明示的には不要だが可読性用）

  for (const r of rowsAsc) {
    const ts = toTimestamp(r.date, r.time);
    switch (r.punchType) {
      case '出勤':
        start = ts;
        onBreak = false;
        break;
      case '休憩開始':
        if (start != null) {
          total += Math.max(0, Math.floor((ts - start) / 60000)); // 分
          start = null;   // 勤務一区切り
        }
        onBreak = true;
        break;
      case '休憩終了':
        start = ts;       // 勤務再開
        onBreak = false;
        break;
      case '退勤':
        if (start != null) {
          total += Math.max(0, Math.floor((ts - start) / 60000)); // 分
          start = null;
        }
        onBreak = false;
        break;
    }
  }
  // 未退勤分はカウントしない（start が残っていても無視）
  return total;
}

// "7h30m" 表記（日本語にしたいなら formatHoursJa に差し替え）
function formatHoursEn(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h${String(m).padStart(2,'0')}m` : `${h}h`;
}
function formatHoursJa(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}時間${m}分` : `${m}分`;
}

function formatJPY(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 既存 toTimestamp を利用（無い場合だけ）
if (typeof toTimestamp !== 'function') {
  function toTimestamp(dateStr, timeStr) {
    const d = String(dateStr || '').trim().replace(/\./g, '-').replace(/\//g, '-');
    let t = String(timeStr || '00:00:00').trim();
    const parts = t.split(':').map(x => x.padStart(2, '0'));
    while (parts.length < 3) parts.push('00');
    t = parts.slice(0,3).join(':');
    return new Date(`${d}T${t}`).getTime();
  }
}

// === ここまでコピペ ===



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

/** 本日の勤務合計（分単位、休憩は除外、退勤で閉じた分だけ） */
function sumWorkMinutes(rowsAsc) {
  let total = 0;
  let start = null;

  for (const r of rowsAsc) {
    const ts = toTimestamp(r.date, r.time);
    switch (r.punchType) {
      case '出勤':
      case '休憩終了':
        start = ts;
        break;

      case '休憩開始':
      case '退勤':
        if (start != null) {
          total += Math.max(0, Math.floor((ts - start) / 60000)); // 分
          start = null;
        }
        break;
    }
  }
  // 退勤で閉じられていない勤務は無視（未確定なので）
  return total;
}
