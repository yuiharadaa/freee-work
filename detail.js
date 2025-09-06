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
    document.getElementById('punchBtn').addEventListener('click', onPunch);
    await loadHistory();
  } catch (e) {
    console.error(e);
    document.getElementById('empName').textContent = '従業員情報の取得に失敗しました。';
  }
}

async function onPunch() {
  if (!current) return;
  const status = document.getElementById('status');
  status.textContent = '送信中…';

  const punchType = document.getElementById('punchType').value;
  const position  = document.getElementById('position').value;

  try {
    const saved = await API.sendPunch({
      id: current.id,
      name: current.name,
      punchType,
      position
    });
    status.textContent = `打刻完了: ${saved.date} ${saved.time} / ${saved.punchType} / ${saved.position}`;
    await loadHistory();
  } catch (e) {
    console.error(e);
    status.textContent = `エラー: ${e.message || e}`;
  }
}

async function loadHistory() {
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
