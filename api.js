const API = 'https://script.google.com/macros/s/AKfycbySCO7N0M2h6OULpZWMC878Ckto5OnpXO7uDQjukrGPfWnH4yZIoC_imVMbFFoHIjz9CQ/exec';

let currentEmployee = null;

// ---- JSONP ヘルパ ----
function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = 'cb_' + Math.random().toString(36).slice(2);
    const sep = url.includes('?') ? '&' : '?';
    const src = `${url}${sep}callback=${cb}`;

    window[cb] = (data) => {
      resolve(data);
      cleanup();
    };
    const s = document.createElement('script');
    s.src = src;
    s.onerror = (e) => { reject(e); cleanup(); };
    document.head.appendChild(s);

    function cleanup() {
      delete window[cb];
      if (s.parentNode) s.parentNode.removeChild(s);
    }
  });
}

// ---- ローディング ----
function showLoader(){ /* お好みで */ }
function hideLoader(){ /* お好みで */ }

// 従業員一覧を取得して描画（JSONP）
async function fetchAndDisplayEmployees() {
  showLoader();
  try {
    const data = await jsonp(`${API}?action=employee.list`);
    if (!data.ok) throw new Error(data.error || 'employee.list failed');
    const employees = data.employees || [];

    const ul = document.getElementById('employeeList');
    ul.innerHTML = '';
    employees.forEach(emp => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.textContent = emp.name;
      a.href = '#';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        loadEmployeeDetail(emp.id);
      });
      li.appendChild(a);
      ul.appendChild(li);
    });
  } catch (err) {
    console.error(err);
    alert('従業員一覧の取得に失敗しました。');
  } finally {
    hideLoader();
  }
}

async function loadEmployeeDetail(id) {
  showLoader();
  try {
    const data = await jsonp(`${API}?action=employee.get&id=${encodeURIComponent(id)}`);
    if (!data.ok) throw new Error(data.error || 'employee.get failed');
    currentEmployee = data.employee;
    renderEmployeeDetail(currentEmployee);
  } catch (err) {
    console.error(err);
    alert('従業員詳細の取得に失敗しました。');
  } finally {
    hideLoader();
  }
}

function renderEmployeeDetail(emp) {
  const detail = document.getElementById('employeeDetail');
  detail.innerHTML = `
    <div><strong>従業員ID:</strong> ${escapeHtml(String(emp.id))}</div>
    <div><strong>名前:</strong> ${escapeHtml(String(emp.name))}</div>

    <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:12px;">
      <div>
        <label>打刻種別</label><br/>
        <select id="punchType">
          <option value="出勤">出勤</option>
          <option value="退勤">退勤</option>
          <option value="休憩開始">休憩開始</option>
          <option value="休憩終了">休憩終了</option>
        </select>
      </div>
      <div>
        <label>ポジション</label><br/>
        <select id="position">
          <option value="レジ">レジ</option>
          <option value="ドリンカー">ドリンカー</option>
          <option value="フライヤー">フライヤー</option>
          <option value="バーガー">バーガー</option>
        </select>
      </div>
      <div style="align-self:end;">
        <button id="punchBtn">打刻</button>
      </div>
    </div>

    <div id="status" style="margin-top:8px;"></div>

    <hr style="margin:16px 0;" />

    <h3 style="margin:8px 0;">直近の履歴</h3>
    <div id="historyBox">読み込み中…</div>
  `;

  document.getElementById('punchBtn').addEventListener('click', submitPunch);
  
  fetchAndRenderHistory(String(emp.id),30);
}

async function submitPunch() {
  if (!currentEmployee) return;
  const type = document.getElementById('punchType').value;
  const position = document.getElementById('position').value;
  const statusEl = document.getElementById('status');
  statusEl.textContent = '送信中…';

  try {
    const url = `${API}?action=punch` +
      `&employeeId=${encodeURIComponent(String(currentEmployee.id))}` +
      `&employeeName=${encodeURIComponent(String(currentEmployee.name))}` +
      `&punchType=${encodeURIComponent(type)}` +
      `&position=${encodeURIComponent(position)}`;

    const data = await jsonp(url);
    statusEl.textContent = data.ok
      ? `打刻完了: ${data.saved.date} ${data.saved.time} / ${data.saved.punchType} / ${data.saved.position}`
      : `エラー: ${data.error || 'unknown'}`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'エラーが発生しました。';
  }
}

// 履歴を取得して描画（days = 直近N日。nullなら全期間）
async function fetchAndRenderHistory(employeeId, days = 30) {
  const box = document.getElementById('historyBox');
  try {
    const params = new URLSearchParams({ action: 'history', employeeId });
    if (typeof days === 'number' && days > 0) {
      const to = new Date();
      const from = new Date();
      from.setDate(to.getDate() - days + 1);
      params.set('from', ymd(from));
      params.set('to', ymd(to));
    }
    const url = `${API}?${params.toString()}`;
    const data = await jsonp(url);

    if (!data.ok) {
      box.textContent = `履歴の取得に失敗しました: ${data.error || 'unknown'}`;
      return;
    }

    const rows = data.rows || [];
    if (rows.length === 0) {
      box.textContent = '履歴はありません。';
      return;
    }

    // 表を描画
    box.innerHTML = renderHistoryTable(rows);
  } catch (err) {
    console.error(err);
    box.textContent = '履歴の取得中にエラーが発生しました。';
  }
}

// 履歴テーブルHTMLを生成
function renderHistoryTable(rows) {
  // rows: [{date,time,employeeId,employeeName,punchType,position}]
  // 新しい順にしたい場合はここで並べ替え
  const sorted = rows.slice().sort((a, b) => {
    const ad = `${a.date} ${a.time}`;
    const bd = `${b.date} ${b.time}`;
    return ad < bd ? 1 : ad > bd ? -1 : 0;
  });

  const header = `
    <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse; width:100%; max-width:700px;">
      <thead style="background:#f4f4f4;">
        <tr>
          <th style="text-align:left;">日付</th>
          <th style="text-align:left;">時刻</th>
          <th style="text-align:left;">種別</th>
          <th style="text-align:left;">ポジション</th>
        </tr>
      </thead>
      <tbody>
  `;

  const body = sorted.map(r => `
    <tr>
      <td>${escapeHtml(String(r.date))}</td>
      <td>${escapeHtml(String(r.time))}</td>
      <td>${escapeHtml(String(r.punchType))}</td>
      <td>${escapeHtml(String(r.position))}</td>
    </tr>
  `).join('');

  const footer = `
      </tbody>
    </table>
  `;

  return header + body + footer;
}

// 日付を YYYY-MM-DD 文字列に
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}


// XSS対策
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// 初期化
window.addEventListener('DOMContentLoaded', fetchAndDisplayEmployees);

