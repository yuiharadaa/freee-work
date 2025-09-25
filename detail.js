// detail.js v51 - 退勤だけポジション入力／履歴は退勤だけ表示／本日の合計勤務時間と日給の集計あり
(function () {
  'use strict';

  const BC_CHANNEL_NAME = 'punch';
  const HISTORY_DAYS_SHOWN = 30;

  let currentEmp = null;
  let bc = null;

  /* ========= 起動 ========= */
  window.addEventListener('DOMContentLoaded', init);

  async function init() {
    const empId = new URL(location.href).searchParams.get('empId');
    if (!empId) {
      setText('#empName', '（ID未指定）');
      return;
    }

    try {
      currentEmp = await API.fetchEmployee(empId);
      setText('#empId', safe(currentEmp?.id ?? empId));
      setText('#empName', safe(currentEmp?.name ?? '（名前不明）'));
    } catch (e) {
      console.error(e);
      setText('#empName', '従業員情報の取得に失敗しました');
    }

    startClock();
    await refreshUI();

    try { bc = new BroadcastChannel(BC_CHANNEL_NAME); } catch (e) { console.warn('BC init failed', e); }
  }

  async function refreshUI() {
    const rows = await fetchRecentHistory(currentEmp?.id);
    const state = computeStateToday(rows);

    renderStatus(state);
    renderActionButtons(state);
    togglePositionGroup(hasClockOutAction(state));
    renderHistoryTable(rows);
    updateTodaySummary(rows);        // ★ 本日の合計勤務時間＆日給を更新
  }

  /* ========= 履歴取得＆状態推定 ========= */
  async function fetchRecentHistory(employeeId) {
    if (!employeeId) return [];
    try {
      const to = new Date();
      const from = new Date();
      from.setDate(to.getDate() - (HISTORY_DAYS_SHOWN - 1));
      const rows = await API.fetchHistory({ employeeId, from, to });
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      console.error('[HISTORY] fetch error', e);
      return [];
    }
  }

  function computeStateToday(allRows) {
    const today = ymd(new Date());
    const rows = (allRows || []).filter(r => normalizeDateStr(r.date) === today)
                                .sort((a, b) => ts(a) - ts(b));
    let mode = 'idle'; // idle | working | break
    for (const r of rows) {
      switch (String(r.punchType)) {
        case '出勤':       mode = 'working'; break;
        case '休憩開始':   if (mode === 'working') mode = 'break'; break;
        case '休憩終了':   if (mode === 'break') mode = 'working'; break;
        case '退勤':       mode = 'idle'; break;
      }
    }
    return { mode, todayRows: rows };
  }

  function hasClockOutAction(state) { return state?.mode === 'working'; }

  /* ========= UI表示 ========= */
  function renderStatus(state) {
    const el = qs('#status');
    if (el) {
      const map = { idle: '未出勤', working: '勤務中', break: '休憩中' };
      el.textContent = `現在の状態：${map[state.mode] ?? '不明'}`;
    }
  }

  function renderActionButtons(state) {
    const box = qs('#actionButtons');
    if (!box) return;
    box.textContent = '';

    const btns = [];
    if (state.mode === 'idle') {
      btns.push(makeButton('出勤', 'primary', () => onPunch('出勤')));
    } else if (state.mode === 'working') {
      btns.push(makeButton('休憩開始', 'secondary', () => onPunch('休憩開始')));
      btns.push(makeButton('退勤', 'danger', () => onPunch('退勤')));
    } else if (state.mode === 'break') {
      btns.push(makeButton('休憩終了', 'secondary', () => onPunch('休憩終了')));
    }

    for (const b of btns) box.appendChild(b);
  }

  function makeButton(label, kind, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = `btn btn-${kind}`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function togglePositionGroup(show) {
    const group = qs('#positionGroup');
    if (group) group.style.display = show ? '' : 'none';
  }

  /* ========= 打刻送信（退勤だけ position 必須） ========= */
  async function onPunch(punchType) {
    const id = currentEmp?.id ?? qs('#empId')?.textContent?.trim();
    const name = currentEmp?.name ?? qs('#empName')?.textContent?.trim();
    if (!id || !name) {
      toast('従業員情報が未取得です', 'error');
      return;
    }

    const isClockOut = (punchType === '退勤');
    let position = '';

    if (isClockOut) {
      position = (qs('#position')?.value ?? '').trim();
      if (!position) {
        toast('退勤時はポジションを選択してください', 'error');
        qs('#position')?.focus();
        return;
      }
    }

    try {
      await API.sendPunch({ id, name, punchType, position });

      if (isClockOut && bc) {
        try { bc.postMessage({ kind: 'punch', punchType: '退勤', at: Date.now() }); } catch {}
      }
      toast(`${punchType} を記録しました`, 'success');
      await refreshUI();
    } catch (e) {
      console.error('[PUNCH] error', e);
      toast(`「${punchType}」の記録に失敗しました`, 'error');
    }
  }

  /* ========= 履歴テーブル（退勤だけポジション表示） ========= */
  function renderHistoryTable(rows) {
    const tbody = qs('#historyBody');
    const tpl = qs('#tpl-history-row');
    if (!tbody || !tpl) return;

    const sorted = (rows || []).slice().sort((a, b) => ts(b) - ts(a));

    const frag = document.createDocumentFragment();
    for (const r of sorted) {
      const node = tpl.content.cloneNode(true);
      setTextNode(node, '.c-date', normalizeDateStr(r.date));
      setTextNode(node, '.c-time', normalizeTimeStr(r.time));
      setTextNode(node, '.c-type', String(r.punchType ?? ''));
      const posCell = sel(node, '.c-pos');
      posCell.textContent = (r.punchType === '退勤' && r.position) ? String(r.position) : '';
      // 「勤務時間」列（.c-dur）は用途が分かれるため、ここでは空にしておく
      setTextNode(node, '.c-dur', '');
      frag.appendChild(node);
    }

    tbody.textContent = '';
    tbody.appendChild(frag);
  }

  /* ========= 今日の勤務時間＆給料の更新（前に入れていた機能） ========= */
  function updateTodaySummary(allRows) {
    const today = ymd(new Date());
    const rows = (allRows || []).filter(r => normalizeDateStr(r.date) === today)
                                .sort((a,b) => ts(a) - ts(b));

    let workMin = 0;
    let currentStart = null;
    let breakStart   = null;

    for (const r of rows) {
      const t = new Date(`${normalizeDateStr(r.date)}T${normalizeTimeStr(r.time)}`);
      switch (String(r.punchType)) {
        case '出勤':
          currentStart = t;
          breakStart = null;
          break;
        case '休憩開始':
          if (currentStart) {
            workMin += minutesDiff(currentStart, t);
            currentStart = null;
          }
          breakStart = t;
          break;
        case '休憩終了':
          if (breakStart) {
            breakStart = null;
            currentStart = t;
          }
          break;
        case '退勤':
          if (currentStart) {
            workMin += minutesDiff(currentStart, t);
            currentStart = null;
          }
          breakStart = null;
          break;
      }
    }

    // 退勤前で勤務中なら「今」まで加算（休憩中は加算しない）
    if (currentStart && !breakStart) {
      workMin += minutesDiff(currentStart, new Date());
    }

    const workTotalEl = qs('#workTotal');
    if (workTotalEl) workTotalEl.textContent = formatHM(workMin);

    const wage = Number(currentEmp?.hourlyWage) || 0;
    const dailySalaryEl = qs('#dailySalary');
    const dailySalaryBox = qs('#dailySalaryContainer');
    const hourlyWageEl = qs('#hourlyWage');

    if (wage > 0 && dailySalaryEl && dailySalaryBox) {
      const yenVal = Math.floor((wage * workMin) / 60);
      dailySalaryEl.textContent = yen(yenVal);
      if (hourlyWageEl) hourlyWageEl.textContent = yen(wage);
      dailySalaryBox.style.display = '';
    }
  }

  /* ========= ユーティリティ ========= */
  function qs(sel, root = document) { return root.querySelector(sel); }
  function sel(node, s) { return node.querySelector(s); }
  function setText(selector, v) { const el = qs(selector); if (el) el.textContent = v; }
  function setTextNode(node, s, v) { const el = sel(node, s); if (el) el.textContent = v; }
  function safe(v) { return API.escapeHtml(v ?? ''); }

  function normalizeDateStr(s) { return String(s || '').trim().replace(/\./g, '-').replace(/\//g, '-'); }
  function normalizeTimeStr(s) {
    const t = String(s || '00:00:00').trim();
    const parts = t.split(':').map(p => p.padStart(2, '0'));
    while (parts.length < 3) parts.push('00');
    return parts.slice(0, 3).join(':');
  }
  function ts(r) { return new Date(`${normalizeDateStr(r.date)}T${normalizeTimeStr(r.time)}`).getTime(); }
  function ymd(d) {
    const y = d.getFullYear(); const m = String(d.getMonth()+1).padStart(2,'0'); const day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }
  function minutesDiff(a, b) { return Math.floor(Math.max(0, b.getTime() - a.getTime()) / 60000); }
  function formatHM(min) { const h = Math.floor(min / 60); const m = min % 60; return `${h}時間${m}分`; }
  function yen(n) { return '¥' + (Number(n)||0).toLocaleString('ja-JP'); }

  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `
      position: fixed; top: 20px; right: 20px; z-index: 10000;
      padding: 12px 16px; border-radius: 8px; color: #fff;
      background: ${type === 'error' ? '#ef4444' : type === 'success' ? '#22c55e' : '#111827'};
      box-shadow: 0 4px 12px rgba(0,0,0,.12);
    `;
    document.body.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .25s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, 2200);
  }

  function startClock() {
    const timeEl = qs('.time-large');
    const dateEl = qs('.date-large');
    const pad = n => String(n).padStart(2, '0');
    const tick = () => {
      const d = new Date();
      if (timeEl) timeEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      if (dateEl) dateEl.textContent = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
    };
    tick();
    setInterval(tick, 1000);
  }
})();
