const API = 'https://script.google.com/macros/s/AKfycbxkjGfYoRaY9fLuVgpVQaIrtIGsVcQHEcOYEaOeyASnNN9drp9l1AC4MRSZNTtEDBFRQw/exec';

const PUNCH_API = API;

let currentEmployee = null;

// --- ローディング（全画面オーバーレイ）準備 ---
document.addEventListener("DOMContentLoaded", () => {
  const overlay = document.createElement("div");
  overlay.id = "loader";
  overlay.textContent = "読み込み中...";
  Object.assign(overlay.style, {
    position: "fixed",
    top: "0", left: "0",
    width: "100%", height: "100%",
    background: "rgba(0,0,0,0.5)",
    color: "#fff",
    fontSize: "24px",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "9999",
    pointerEvents: "auto"
  });
  document.body.appendChild(overlay);
});

function showLoader() {
  const el = document.getElementById("loader");
  if (el) el.style.display = "flex";
}
function hideLoader() {
  const el = document.getElementById("loader");
  if (el) el.style.display = "none";
}

// 従業員一覧を取得して描画
async function fetchAndDisplayEmployees() {
  try {
    const response = await fetch(`${API}?action=employee.list`);
    if (!response.ok) {
      throw new Error(`HTTPエラー: ${response.status}`);
    }
    const data = await response.json();
    const employees = data.employees || [];

    const ul = document.getElementById('employeeList');
    ul.innerHTML = ''; // 既存のリストをクリア

    employees.forEach(emp => {
      const li = document.createElement('li');

      const a = document.createElement('a');
      a.textContent = emp.name;
      a.href = "#"; // ページ遷移しない
      a.dataset.id = emp.id;

      // クリック時に詳細を取得して表示
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        showLoader();
        try {
          const employee = await fetchEmployeeById(emp.id);
          if (employee) {
            currentEmployee = employee;
            renderEmployeeDetail(employee);
          }
        } catch (err) {
          console.error(err);
          alert('従業員詳細の取得に失敗しました。');
        } finally {
          hideLoader();
        }
      });

      li.appendChild(a);
      ul.appendChild(li);
    });

    console.log(employees); // デバッグ
  } catch (error) {
    console.error('取得エラー:', error);
  }
}

// 単一従業員を取得
async function fetchEmployeeById(id) {
  const response = await fetch(`${API}?action=employee.get&id=${encodeURIComponent(id)}`);
  const data = await response.json();
  if (data.ok) {
    console.log("従業員:", data.employee);
    return data.employee;
  } else {
    console.error("取得失敗:", data.error);
    return null;
  }
}

// 詳細＋打刻フォームを描画
function renderEmployeeDetail(emp) {
  const detail = document.getElementById("employeeDetail");
  detail.innerHTML = `
    <div><strong>従業員ID:</strong> ${escapeHtml(String(emp.id))}</div>
    <div><strong>名前:</strong> ${escapeHtml(String(emp.name))}</div>

    <div class="row" style="display:flex; gap:12px; flex-wrap:wrap; margin-top:12px;">
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
        <button id="punchBtn">打刻する</button>
      </div>
    </div>

    <div id="status" style="margin-top:8px; color:#444;"></div>
  `;

  // 打刻ボタン
  document.getElementById('punchBtn').addEventListener('click', submitPunch);
}

// 打刻送信（GAS doPost 側で日本時間の日時を採用）
async function submitPunch() {
  if (!currentEmployee) return;
  const type = document.getElementById('punchType').value;
  const position = document.getElementById('position').value;
  const statusEl = document.getElementById('status');
  const btn = document.getElementById('punchBtn');

  // 送信中ブロック
  btn.disabled = true;
  showLoader();
  statusEl.textContent = '送信中…';

  try {
    const payload = {
      employeeId: String(currentEmployee.id),
      employeeName: String(currentEmployee.name),
      punchType: type,
      position: position
    };

    const res = await fetch(PUNCH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // GAS側がJSONを返すなら res.json() に変更してOK
    const text = await res.text();
    statusEl.textContent = `打刻完了: ${text}`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'エラーが発生しました。';
  } finally {
    btn.disabled = false;
    hideLoader();
  }
}

// XSS対策の簡易エスケープ
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}

// ページ読み込み時に実行
window.addEventListener('DOMContentLoaded', fetchAndDisplayEmployees);
