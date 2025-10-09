// admin.js
// 仮想API - 実運用では API.fetchSummary() を呼ぶ
const demoMode = { on: true };

async function fetchSummary() {
  if (demoMode.on) {
    // ダミーデータ
    return {
      onCount: 5,
      avgOvertime: 1.7,
      lateRate: 0.12,
      trend: { labels: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], data: [4,5,6,5,7,3,2] },
      mood: { happy: 8, neutral: 4, sad: 1 }
    };
  }
  // 実際は API.fetchSummary() を呼ぶ（下記は例）
  // const res = await API.fetchSummary();
  // return res.data;
}

let chartInst = null;

async function render() {
  const s = await fetchSummary();
  document.getElementById('kpi_on').textContent = s.onCount;
  document.getElementById('kpi_overtime').textContent = s.avgOvertime + 'h';
  document.getElementById('kpi_late').textContent = Math.round(s.lateRate * 100) + '%';

  const ctx = document.getElementById('chart').getContext('2d');
  if (chartInst) chartInst.destroy();
  chartInst = new Chart(ctx, {
    type: 'line',
    data: { labels: s.trend.labels, datasets: [{ label:'出勤人数', data: s.trend.data, tension:0.3 }] },
    options: { responsive:true, maintainAspectRatio:false }
  });

  const mood = s.mood;
  document.getElementById('moodTrend').innerHTML = `
    😊 ${mood.happy} 　😐 ${mood.neutral}　 😞 ${mood.sad}
  `;
}

document.getElementById('refreshBtn').addEventListener('click', render);
document.getElementById('demoDataBtn').addEventListener('click', () => {
  demoMode.on = !demoMode.on;
  render();
});

// 初回
render();
