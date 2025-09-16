// detail.js v38（最新履歴を上で表示／退勤確定時のみ 当日勤務&給与表示／時給の堅牢バックフィル／BC送信）

let current = null;

window.addEventListener('DOMContentLoaded', init);

async function init() {
  const empId = new URL(location.href).searchParams.get('empId');
  if (!empId) {
    document.getElementById('empName').textContent = '（ID未指定）';
    return;
  }

  try {
    current = await API.fetchEmployee(empId); // {id,name, hourlyWage?}
    document.getElementById('empId').textContent   = API.escapeHtml(String(current.id));
    document.getElementById('empName').textContent = API.escapeHtml(String(current.name));

    // 時給のバックフィル（employee.get が時給未返却でも動くように）
    await ensureHourlyWage();

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

    // 退勤成功時はホームへ通知（ガント再描画用）
    if (action === '退勤') {
      try {
        const bc = new BroadcastChannel('punch');
        bc.postMessage({ kind: 'punch', punchType: '退勤', at: new Date().toISOString() });
        bc.close();
      } catch (e) {
        console.warn('[DETAIL] BC send failed:', e);
      }
    }

    // 念のため時給を再確認（途中で時給を設定/変更したケースに備える）
    await ensureHourlyWage();

    await refreshUI();
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
  return new Date(`${d}T${t}`).getTime();
}

/** 直前の種別から次に押せるボタンを決める */
function decideNextByLastType(lastType) {
  if (!lastType) return ['出勤'];
  switch (lastType) {
    case '出勤':     return ['退勤', '休憩開始'];
    case '休憩開始': return ['休憩終了'];
    case '休憩終了': return ['退勤'];
    case '退勤':     return ['出勤'];
    default:         return ['出勤'];
  }
}

/** 当日の履歴テーブル描画（最新を上に／退勤行にのみ 勤務時間&給与を表示） */
async function loadHistoryAndRender() {
  const tbody = document.getElementById('historyBody');
  const tpl = document.getElementById('tpl-history-row');
  tbody.textContent = '';

  // 当日の履歴を取得
  const rows = await API.fetchHistory({ employeeId: current.id, days: 1 });

  // 計算は昇順、表示は降順（最新が上）
  const rowsAsc  = [...rows].sort((a,b) => toTimestamp(a.date,a.time) - toTimestamp(b.date,b.time));
  const rowsDesc = [...rowsAsc].reverse();

  // 退勤がある日のみ、分単位で勤務合計＆給与を算出
  const hasTaikin = rowsAsc.some(r => r.punchType === '退勤');
  const totalMin  = hasTaikin ? sumWorkMinutes(rowsAsc) : 0; // 分
  const durStr    = totalMin > 0 ? formatHoursEn(totalMin) : '';
  const wage      = Number(current?.hourlyWage) || 0;
  const pay       = (totalMin > 0 && wage > 0) ? Math.floor(totalMin * wage / 60) : 0;
  const payStr    = pay > 0 ? `¥${formatJPY(pay)}` : '';

  // 表示（最新が上）
  rowsDesc.forEach(r => {
    const node = tpl.content.cloneNode(true);
    node.querySelector('.c-date').textContent = r.date;
    node.querySelector('.c-time').textContent = r.time;
    node.querySelector('.c-type').textContent = r.punchType;
    node.querySelector('.c-pos').textContent  = r.position;

    // 退勤行にだけ勤務時間と給与を表示
    if (r.punchType === '退勤') {
      node.querySelector('.c-dur').textContent = durStr;
      node.querySelector('.c-pay').textContent = payStr;
    }
    tbody.appendChild(node);
  });

  // 退勤が無い場合でも枠だけ欲しければ空行を追加（任意）
  if (!hasTaikin && rowsDesc.length === 0) {
    const node = tpl.content.cloneNode(true);
    tbody.appendChild(node);
  }
}

/* ===== ヘルパ ===== */

/** 時給の堅牢バックフィル：employee.get → employee.list → wage.list（存在すれば） */
async function ensureHourlyWage() {
  if (Number(current?.hourlyWage) > 0) return;

  // 1) employee.list から探す
  try {
    const list = await API.fetchEmployees();
    const arr = Array.isArray(list) ? list : (list?.employees || []);
    const me1 = arr.find(e => String(e.id) === String(current.id));
    if (me1 && Number(me1.hourlyWage) > 0) {
      current.hourlyWage = Number(me1.hourlyWage);
      return;
    }
  } catch (e) {
    console.warn('[DETAIL] fetchEmployees failed', e);
  }

  // 2) wage.list があれば使う
  try {
    if (typeof API.fetchWages === 'function') {
      const m = await API.fetchWages(); // { [id]: wage }
      const wage = Number(m?.[String(current.id)]) || 0;
      if (wage > 0) {
        current.hourlyWage = wage;
        return;
      }
    }
  } catch (e) {
    console.warn('[DETAIL] fetchWages failed', e);
  }

  // 3) 見つからなければ 0 扱い
  current.hourlyWage = 0;
}

/** 本日確定分の勤務合計（分）— 出勤/休憩終了→休憩開始/退勤 で積み上げ、未退勤は無視 */
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
  return total;
}

// "7h30m"（日本語表記にしたい場合は formatHoursJa を使ってね）
function formatHoursEn(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h${String(m).padStart(2,'0')}m` : `${h}h`;
}
function formatJPY(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
