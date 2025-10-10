// APIコール（既存のCONFIG/APIラッパがあるならそれを利用してOK）
const API_URL = /* 既存の CONFIG.API_URL を使う or ここにURL直書き */ window.CONFIG?.API_URL || '';

async function fetchSummary(dateStr) {
  const url = `${API_URL}?fn=admin.summary&date=${encodeURIComponent(dateStr)}`;
  const res = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store' });
  if (!res.ok) throw new Error('failed to fetch admin.summary');
  return await res.json();
}

function ymd(date = new Date()){
  const tz = new Date(date.getTime() - (date.getTimezoneOffset()*60000));
  return tz.toISOString().slice(0,10);
}
function toSheetDateStr(htmlDateStr){
  // "YYYY-MM-DD" -> "YYYY/MM/DD"
  return htmlDateStr.replaceAll('-', '/');
}
function yen(n){ return '¥' + (Math.round(n).toLocaleString('ja-JP')); }

window.addEventListener('DOMContentLoaded', async () => {
  const datePicker = document.getElementById('datePicker');
  const reloadBtn = document.getElementById('reloadBtn');

  datePicker.value = ymd();
  const load = async () => {
    const sheetDate = toSheetDateStr(datePicker.value);
    const data = await fetchSummary(sheetDate);

    document.getElementById('kpiDate').textContent = `対象日：${data.date}`;
    document.getElementById('kpiHeadcount').textContent = String(data.headcountNow);
    document.getElementById('kpiWork').textContent = data.totalWork || '--:--';
    document.getElementById('kpiCost').textContent = yen(data.laborCost || 0);

    const posList = document.getElementById('posList');
    posList.innerHTML = '';
    const keys = Object.keys(data.posCount || {});
    if (keys.length === 0) {
      const li = document.createElement('li'); li.textContent = '—';
      posList.appendChild(li);
    } else {
      keys.forEach(k => {
        const li = document.createElement('li');
        li.textContent = `${k}: ${data.posCount[k]} 人`;
        posList.appendChild(li);
      });
    }

    const tbody = document.querySelector('#activeTable tbody');
    tbody.innerHTML = '';
    (data.activeList || []).forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(r.empId)}</td>
        <td>${escapeHtml(r.empName)}</td>
        <td>${escapeHtml(r.pos || '-')}</td>
        <td>${escapeHtml(r.clockInAt || '')}</td>
        <td>${escapeHtml(r.elapsed || '')}</td>
      `;
      tbody.appendChild(tr);
    });
  };

  reloadBtn.addEventListener('click', load);
  await load();
});

function escapeHtml(str){
  return String(str ?? '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}
