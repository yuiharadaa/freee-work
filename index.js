window.addEventListener('DOMContentLoaded', async () => {
  const ul  = document.getElementById('employeeList');
  const tpl = document.getElementById('tpl-employee-item');

  try {
    const employees = await API.fetchEmployees();
    const frag = document.createDocumentFragment();

    employees.forEach(emp => {
      const node = tpl.content.cloneNode(true);
      const a = node.querySelector('.emp-link');
      a.textContent = API.escapeHtml(emp.name);
      a.href = `./detail.html?empId=${encodeURIComponent(emp.id)}`;
      frag.appendChild(node);
    });

    ul.textContent = '';
    ul.appendChild(frag);
  } catch (e) {
    console.error(e);
    ul.textContent = '従業員一覧の取得に失敗しました。';
  }
});
