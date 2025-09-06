// api.js（グローバル公開：モジュール不要）
(function () {
  'use strict';

  const API_URL = 'https://script.google.com/macros/s/AKfycbySCO7N0M2h6OULpZWMC878Ckto5OnpXO7uDQjukrGPfWnH4yZIoC_imVMbFFoHIjz9CQ/exec';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[m]);
  }

  function ymd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // JSONP（file://でも動く）
  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const cb = 'cb_' + Math.random().toString(36).slice(2);
      const sep = url.includes('?') ? '&' : '?';
      const src = `${url}${sep}callback=${cb}`;

      window[cb] = (data) => { resolve(data); cleanup(); };

      const s = document.createElement('script');
      s.src = src;
      s.onerror = (e) => { reject(e); cleanup(); };
      document.head.appendChild(s);

      function cleanup() {
        try { delete window[cb]; } catch {}
        if (s.parentNode) s.parentNode.removeChild(s);
      }
    });
  }

  async function fetchEmployees() {
    const data = await jsonp(`${API_URL}?action=employee.list`);
    if (!data.ok) throw new Error(data.error || 'employee.list failed');
    return data.employees || [];
  }

  async function fetchEmployee(id) {
    const data = await jsonp(`${API_URL}?action=employee.get&id=${encodeURIComponent(id)}`);
    if (!data.ok) throw new Error(data.error || 'employee.get failed');
    return data.employee;
  }

  async function sendPunch({ id, name, punchType, position }) {
    const url = `${API_URL}?action=punch` +
      `&employeeId=${encodeURIComponent(String(id))}` +
      `&employeeName=${encodeURIComponent(String(name))}` +
      `&punchType=${encodeURIComponent(punchType)}` +
      `&position=${encodeURIComponent(position)}`;

    const data = await jsonp(url);
    if (!data.ok) throw new Error(data.error || 'punch failed');
    return data.saved; // {date,time,punchType,position}
  }

  async function fetchHistory({ employeeId, days = 30 }) {
    const params = new URLSearchParams({ action: 'history', employeeId: String(employeeId) });
    if (typeof days === 'number' && days > 0) {
      const to = new Date();
      const from = new Date();
      from.setDate(to.getDate() - days + 1);
      params.set('from', ymd(from));
      params.set('to', ymd(to));
    }
    const data = await jsonp(`${API_URL}?${params.toString()}`);
    if (!data.ok) throw new Error(data.error || 'history failed');
    return data.rows || [];
  }

  // ここでグローバル公開（window.API で使える）
  window.API = {
    API_URL, escapeHtml, ymd, jsonp,
    fetchEmployees, fetchEmployee, sendPunch, fetchHistory
  };
})();
