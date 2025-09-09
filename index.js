// index.js（ガント描画・営業時間 09:00–22:00 固定・全社員個別で履歴取得）

const OPEN_HOUR = 9;
const CLOSE_HOUR = 22;
const DAY_MINUTES = (CLOSE_HOUR - OPEN_HOUR) * 60;

// ポジション→CSSクラス（style.css と一致させる）
const POS_CLASS = {
  'レジ': 'pos-reji',
  'ドリンカー': 'pos-drink',
  'フライヤー': 'pos-fry',
  'バーガー': 'pos-burger'
};

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await renderEmployeeList();
    await refreshGantt();

    // detail で打刻完了時の更新通知（BroadcastChannel）
    try {
      const bc = new BroadcastChannel('punch');
      bc.onmessage = () => refreshGantt();
    } catch {}

    // 念のためポーリング（1分）
    setInterval(refreshGantt, 60_000);
    setMidnightTimer();
  } catch (e) {
    console.error(e);
  }
});

// 従業員一覧を描画
async function renderEmployeeList() {
  const ul = document.getElementById('employeeList');
  const tpl = document.getElementById('tpl-employee-item');
  if (!ul || !tpl) return;

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
}

// ガント再描画（ID検証つき＆ログあり）
async function refreshGantt() {
  const container = document.getElementById('gantt');
  if (!container) return;
  container.textContent = '読み込み中…';

  try {
    const emps = await API.fetchEmployees();
    const allRows = [];
    const todayYMD = ymd(new Date());

    // 従業員ごとに履歴取得
    for (const e of emps) {
      // id と employeeId の両対応
      const id = (e && (e.id ?? e.employeeId)) ?? null;

      console.log('[GANTT] fetch対象:', { id, name: e?.name, raw: e });

      if (!id || String(id).trim() === '') {
        console.warn('[GANTT] skip: invalid employeeId', e);
        continue;
      }

      try {
        const rows = await API.fetchHistory({ employeeId: id, days: 1 });
        rows
          .filter(r => normalizeDateStr(r.date) === todayYMD)
          .forEach(r => {
            r.employeeId = r.employeeId ?? id;        // 無ければ補完
            r.employeeName = r.employeeName || e.name || String(id);
            allRows.push(r);
          });
      } catch (err) {
        console.warn('[GANTT] 履歴取得失敗:', { id, name: e?.name, err });
      }
    }

    console.log('[GANTT] 集計後の行数:', allRows.length);

    const intervalsByEmp = buildIntervals(allRows);

    // DOM描画
    container.textContent = '';
    if (intervalsByEmp.size === 0) {
      container.textContent = '本日の出勤はまだありません。';
      return;
    }

    intervalsByEmp.forEach((info) => {
      const row = document.createElement('div');
      row.className = 'gantt-row';

      const label = document.createElement('div');
      label.className = 'gantt-label';
      label.textContent = info.name;
      row.appendChild(label);

      const track = document.createElement('div');
      track.className = 'gantt-track';
      row.appendChild(track);

      // 勤務セグメント
      info.work.forEach(seg => {
        const el = document.createElement('div');
        el.className = `seg ${seg.className}`;
        el.style.left  = pct(seg.startMin / DAY_MINUTES);
        el.style.width = pct((seg.endMin - seg.startMin) / DAY_MINUTES);
        track.appendChild(el);
      });

      // 休憩セグメント
      info.breaks.forEach(seg => {
        const el = document.createElement('div');
        el.className = 'seg seg-break';
        el.style.left  = pct(seg.startMin / DAY_MINUTES);
        el.style.width = pct((seg.endMin - seg.startMin) / DAY_MINUTES);
        track.appendChild(el);
      });

      container.appendChild(row);
    });

  } catch (e) {
    console.error(e);
    container.textContent = 'ガントの描画に失敗しました。';
  }
}


// ID検証（null/undefined/空文字を弾く。0は許容しない）
function isValidId(id) {
  // 文字列/数値ともOKだが、空文字とNaNは除外
  if (id === null || id === undefined) return false;
  const s = String(id).trim();
  return s.length > 0;
}

/* ========= 区間構築（今日 09:00–22:00 のみ） ========= */

function buildIntervals(rows) {
  const byEmp = groupBy(rows, r => String(r.employeeId));
  const result = new Map();

  byEmp.forEach((list, empId) => {
    list.sort((a,b) => ts(a) - ts(b));

    const name = list[0]?.employeeName || empId;
    const workSegs = [];
    const breakSegs = [];

    let currentStart = null; // 勤務開始のDate
    let currentPos   = null; // その勤務のポジション
    let breakStart   = null; // 休憩開始のDate

    for (const ev of list) {
      const t = asDate(ev.date, ev.time);
      const [dayS, dayE] = businessDayBounds(t);

      switch (ev.punchType) {
        case '出勤':
          currentStart = t;
          currentPos = ev.position || 'レジ';
          breakStart = null;
          break;

        case '休憩開始':
          if (currentStart) {
            pushWork(workSegs, currentStart, t, currentPos, dayS, dayE);
            breakStart = t;
          }
          break;

        case '休憩終了':
          if (breakStart) {
            pushBreak(breakSegs, breakStart, t, dayS, dayE);
            currentStart = t;      // 休憩明けから勤務再開
            breakStart = null;
          }
          break;

        case '退勤':
          if (currentStart) {
            pushWork(workSegs, currentStart, t, currentPos, dayS, dayE);
            currentStart = null;
            breakStart = null;
          }
          break;
      }
    }

    // 退勤がまだなら、現在時刻まで勤務扱い（営業時間でクリップ）
    if (currentStart) {
      const now = new Date();
      const [dayS, dayE] = businessDayBounds(now);
      pushWork(workSegs, currentStart, now, currentPos, dayS, dayE);
    }

    const work = workSegs.filter(s => s.endMin > s.startMin);
    const brks = breakSegs.filter(s => s.endMin > s.startMin);

    if (work.length || brks.length) {
      result.set(empId, { name, work, breaks: brks });
    }
  });

  return result;
}

/* 1日の境界（その日の 09:00–22:00）*/
function businessDayBounds(d) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), OPEN_HOUR, 0, 0);
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), CLOSE_HOUR, 0, 0);
  return [s, e];
}

function pushWork(out, s, e, pos, dayS, dayE) {
  const seg = clip(s, e, dayS, dayE);
  if (!seg) return;
  out.push({
    startMin: minutesFromOpen(seg.start),
    endMin:   minutesFromOpen(seg.end),
    className: POS_CLASS[pos] || 'pos-reji'
  });
}
function pushBreak(out, s, e, dayS, dayE) {
  const seg = clip(s, e, dayS, dayE);
  if (!seg) return;
  out.push({
    startMin: minutesFromOpen(seg.start),
    endMin:   minutesFromOpen(seg.end)
  });
}

function minutesFromOpen(d) {
  return (d.getHours() - OPEN_HOUR) * 60 + d.getMinutes();
}
function clip(s, e, dayS, dayE) {
  const start = new Date(Math.max(s, dayS));
  const end   = new Date(Math.min(e, dayE));
  return end > start ? { start, end } : null;
}

/* ========= ヘルパ ========= */
function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    (m.get(k) || m.set(k, []).get(k)).push(x);
  }
  return m;
}
function ts(r) { return asDate(r.date, r.time).getTime(); }
function normalizeDateStr(s) {
  return String(s || '').trim().replace(/\./g,'-').replace(/\//g,'-');
}
function asDate(dateStr, timeStr) {
  const d = normalizeDateStr(dateStr);
  let t = String(timeStr || '00:00:00').trim();
  const parts = t.split(':').map(p => p.padStart(2, '0'));
  while (parts.length < 3) parts.push('00');
  t = parts.slice(0,3).join(':');
  return new Date(`${d}T${t}`);
}
function ymd(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function pct(f) { return `${Math.max(0, Math.min(1, f)) * 100}%`; }

function setMidnightTimer() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0,0,0);
  setTimeout(() => { refreshGantt(); setMidnightTimer(); }, next - now);
}
