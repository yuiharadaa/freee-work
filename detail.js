// detail.js（バニラ・グローバルAPI版）
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
  await renderActionButtons(); // 履歴から状態を見てボタンを出す
}

/** 今日の状態から次に押せるアクションを計算してボタン化 */
async function renderActionButtons() {
  const container = document.getElementById('actionButtons');
  container.textContent = '…';
  try {
    // 直近30日を取得し、今日のレコードだけ抽出
    const all = await API.fetchHistory({ employeeId: current.id, days: 30 });
    const today = ymd(new Date());
    const todayRows = all.filter(r => r.date === today)
                         .sort((a, b) => (`${a.date} ${a.time}` < `${b.date} ${b.time}` ? 1 : -1));

    const nextActions = decideNextActions(todayRows);
    container.textContent = '';

    nextActions.forEach(action => {
      const btn = document.createElement('button');
      btn.textContent = action; // 出勤 / 退勤 / 休憩開始 / 休憩終了
      btn.addEventListener('click', () => onPunchAction(action));
      container.appendChild(btn);
    });

    if (nextActions.length === 0) {
      // フォールバック（通常は来ない）
      const msg = document.createElement('span');
      msg.textContent = '今は実行可能なアクションがありません。';
      container.appendChild(msg);
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
      punchType: action, // ← ここが肝：選択肢ではなく決め打ち
      position
    });
    status.textContent = `打刻完了: ${saved.date} ${saved.time} / ${saved.punchType} / ${saved.position}`;
    await refreshUI(); // 履歴とボタンを更新
  } catch (e) {
    console.error(e);
    status.textContent = `エラー: ${e.message || e}`;
  }
}

/** 今日の最後の打刻から「次に押せるアクション」を返す */
function decideNextActions(todayRows) {
  // 状態遷移：
  // START or OFF(退勤済) → [出勤]
  // WORKING(出勤後) → [退勤, 休憩開始]
  // BREAK(休憩開始後) → [休憩終了]
  // AFTER_BREAK(休憩終了後) → [退勤]

  if (!todayRows.length) return ['出勤'];

  const last = todayRows[0]; // 新しい順ソート済みの先頭
  const lastType = last.punchType;

  switch (lastType) {
    case '出勤':
      return ['退勤', '休憩開始'];
    case '休憩開始':
      return ['休憩終了'];
    case '休憩終了':
      return ['退勤'];
    case '退勤':
      return ['出勤'];
    default:
      // 想定外の種別が来た場合は出勤だけを許可（フォールバック）
      return ['出勤'];
  }
}

/** 履歴テーブルの再描画 */
async function loadHistoryAndRender() {
  const tbody  = document.getElementById('historyBody');
  const tplRow = document.getElementById('tpl-history-row');

  tbody.textContent = '読み込み中…';
  try {
    const rows = await API.fetchHistory({ employeeId: current.id, days: 30 });
    rows.sort((a, b) => (`${a.date} ${a.time}` < `${b.date} ${b.time}` ? 1 : -1));

    const frag = document.createDocumentFragment();
    rows.forEach(r => {
      const tr = tplRow.content.cloneNode(true);
      tr.querySelector('.c-date').textContent = API.escapeHtml(r.date);
      tr.querySelector('.c-time').textContent = API.escapeHtml(r.time);
      tr.querySelector('.c-type').textContent = API.escapeHtml(r.punchType);
      tr.querySelector('.c-pos').textContent  = API.escapeHtml(r.position);
      frag.appendChild(tr);
    });

    tbody.textContent = '';
    if (rows.length === 0) {
      const empty = document.createElement('tr');
      empty.innerHTML = `<td colspan="4">履歴はありません。</td>`;
      tbody.appendChild(empty);
    } else {
      tbody.appendChild(frag);
    }
  } catch (e) {
    console.error(e);
    tbody.textContent = '';
    const err = document.createElement('tr');
    err.innerHTML = `<td colspan="4">履歴の取得に失敗しました。</td>`;
    tbody.appendChild(err);
  }
}

/** YYYY-MM-DD */
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
