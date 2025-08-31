const API = 'https://script.google.com/macros/s/AKfycbxkjGfYoRaY9fLuVgpVQaIrtIGsVcQHEcOYEaOeyASnNN9drp9l1AC4MRSZNTtEDBFRQw/exec';

async function fetchAndDisplayEmployees() {
  try {
    const response = await fetch(API);
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

// ページ読み込み時に実行
window.addEventListener('DOMContentLoaded', fetchAndDisplayEmployees);