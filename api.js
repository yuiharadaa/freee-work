const API = 'https://script.google.com/macros/s/AKfycbxkjGfYoRaY9fLuVgpVQaIrtIGsVcQHEcOYEaOeyASnNN9drp9l1AC4MRSZNTtEDBFRQw/exec';

// --- ローディング表示用の準備 ---
document.addEventListener("DOMContentLoaded", () => {
  const overlay = document.createElement("div");
  overlay.id = "loader";
  overlay.textContent = "読み込み中...";
  overlay.style.position = "fixed";
  overlay.style.top = "0";
  overlay.style.left = "0";
  overlay.style.width = "100%";
  overlay.style.height = "100%";
  overlay.style.background = "rgba(0,0,0,0.5)";
  overlay.style.color = "#fff";
  overlay.style.fontSize = "24px";
  overlay.style.display = "none"; // 初期は非表示
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.zIndex = "9999";
  overlay.style.display = "none";
  overlay.style.display = "flex"; // flexレイアウト用
  overlay.style.display = "none"; // 初期は非表示
  document.body.appendChild(overlay);
});

function showLoader() {
  document.getElementById("loader").style.display = "flex";
}
function hideLoader() {
  document.getElementById("loader").style.display = "none";
}

// 従業員一覧を取得して描画
async function fetchAndDisplayEmployees() {
  try {
    const response = await fetch(`${API}?action=employee.list`);
    if (!response.ok) {
      throw new Error(`HTTPエラー: ${response.status}`);
    }
    const data = await response.json();
    const employees = data.employees;

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
        showLoader(); // ←クリック時にローディング表示
        const employee = await fetchEmployeeById(emp.id);
        hideLoader(); // ←取得完了で非表示
        if (employee) {
          document.getElementById("employeeDetail").textContent =
            `ID: ${employee.id}, 名前: ${employee.name}`;
        }
      });

      li.appendChild(a);
      ul.appendChild(li);
    });

    console.log(employees); // コンソールにも表示
  } catch (error) {
    console.error('取得エラー:', error);
  }
}

// 単一従業員を取得
async function fetchEmployeeById(id) {
  const response = await fetch(`${API}?action=employee.get&id=${id}`);
  const data = await response.json();
  if (data.ok) {
    console.log("従業員:", data.employee);
    return data.employee;
  } else {
    console.error("取得失敗:", data.error);
    return null;
  }
}

// ページ読み込み時に実行
window.addEventListener('DOMContentLoaded', fetchAndDisplayEmployees);
