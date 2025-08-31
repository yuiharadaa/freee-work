const API = 'https://script.google.com/macros/s/AKfycbxkjGfYoRaY9fLuVgpVQaIrtIGsVcQHEcOYEaOeyASnNN9drp9l1AC4MRSZNTtEDBFRQw/exec';

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
      li.textContent = `ID: ${emp.id} - 名前: ${emp.name}`;
      ul.appendChild(li);
    });

    console.log(employees); // コンソールにも表示
  } catch (error) {
    console.error('取得エラー:', error);
  }
}

async function getEmployeeById(id) {
  const empSheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[1];
  const last_row = empSheet.getLastRow();
  const empRange = empSheet.getRange(2, 1, last_row - 1, 2); // ヘッダ除外
  const values = empRange.getValues();

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(id)) {
      return {
        id: values[i][0],
        name: values[i][1]
      };
    }
  }
  return null; // 見つからなかった場合
}


// ページ読み込み時に実行
window.addEventListener('DOMContentLoaded', fetchAndDisplayEmployees);