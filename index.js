// index.js（ホーム）
// すでに window.API (fetchEmployees, fetchHistory, escapeHtml) が使える前提

// 営業時間
const OPEN_HOUR = 9;   // 09:00
const CLOSE_HOUR = 22; // 22:00
const DAY_MINUTES = (CLOSE_HOUR - OPEN_HOUR) * 60; // 780

// ポジション→CSSクラス
const POS_CLASS = {
  'レジ': 'pos-reji',
  'ドリンカー': 'pos-drink',
  'フライヤー': 'pos-fry',
  'バーガー': 'pos-burger'
};

window.addEventListener('DOMContentLoaded', async () => {
  await renderEmployeeList();
  await refreshGantt();

  // detail で打刻したらホーム更新（BroadcastChannel経由）
  try {
    const bc = new BroadcastChannel('punch');
    bc.onmessage = () => refreshGantt();
  } catch {}
  // 念のため1分おきに再描画
  setInterval(refreshGantt, 60_000);
  // 0:00切替（営業時間固定だが、日付跨ぎで再描画）
  setMidnightTimer();
});

// 一覧レンダ
async function renderEmployeeList() {
  const ul = document.getElementById('employeeList');
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
}

// ガント再描画
async function refreshGantt() {
  const container = document.getElementById('gantt');
  container.textContent = '読み込み中…';

  try {
    // 今日の履歴だけでOK（営業時間内固定・持ち越しなし）
    const today = ymd(new Date());
    const rows = await API.fetchHistory({ employeeId: '', days: 1 }); // GAS側の仕様次第
    // ↑もし fetchHistory が employeeId必須なら、GAS側で「全社員の今日」を返すAPIが必要。
    // 既存APIが個別のみなら、まず全社員一覧→社員ごとに history を取る方式に変更する：
    // const emps = await API.fetchEmployees();
    // const allRows = [];
    // for (const e of emps) {
    //   const r = await API.fetchHistory({ employeeId: e.id, days: 1 });
    //   allRows.push(...r);
    // }
    // const rows = allRows;

    // クライアントで“今日だけ”に絞る（フォーマット揺れ対策）
    const todayRows = rows.filter(r => normalizeDateStr(r.date) === today);

    // 社員ごとに区間を構築（勤務区間：ポジション色、休憩区間：グレー）
    const intervalsByEmp = buildIntervals(todayRows);

    // DOMを作る
    container.textContent = '';
    intervalsByEmp.forEach((info, empId) => {
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

      // 休憩セグメント（薄グレー）
      info.breaks.forEach(seg => {
        const el = document.createElement('div');
        el.className = 'seg seg-break';
        el.style.left  = pct(seg.startMin / DAY_MINUTES);
        el.style.width = pct((seg.endMin - seg.startMin) / DAY_MINUTES);
        track.appendChild(el);
      });

      container.appendChild(row);
    });

    if (intervalsByEmp.size === 0) {
      container.textContent = '本日の出勤はまだありません。';
    }
  } catch (e) {
    console.error(e);
    container.textContent = 'ガントの描画に失敗しました。';
  }
}

/* ---- 区間構築ロジック（今日の09:00–22:00のみ） ---- */

function buildIntervals(rows) {
  // 社員ごとにまとめ、日時昇順
  const byEmp = groupBy(rows, r => String(r.employeeId));
  const result = new Map();

  byEmp.forEach((list, empId) => {
    list.sort((a,b) => ts(a) - ts(b));

    const name = list[0]?.employeeName || empId;
    const workSegs = [];
    const breakSegs = [];

    let currentStart = null;      // 勤務開始のDate
    let currentPos = null;        // 現在のポジション
    let breakStart = null;        // 休憩開始のDate

    for (const ev of list) {
      const t = asDate(ev.date, ev.time);
      // 営業時間でクリップ用
      const [dayS, dayE] = businessDayBounds(t);

      switch (ev.punchType) {
        case '出勤':
          currentStart = t;
          currentPos = ev.position || 'レジ';
          breakStart = null;
          break;

        case '休憩開始':
          if (currentStart) {
            // 勤務区間を 休憩開始までで一旦閉じる
            pushWork(workSegs, currentStart, t, currentPos, dayS, dayE);
            breakStart = t;
          }
          break;

        case '休憩終了':
          if (breakStart) {
            // 休憩区間を追加
            pushBreak(breakSegs, breakStart, t, dayS, dayE);
            // 休憩明けから勤務再開（ポジションは直前を引き継ぐ想定）
            currentStart = t;
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

        default:
          // 想定外は無視
          break;
      }
    }

    // 退勤がまだなら、現在時刻まで勤務扱い（営業時間でクリップ）
    if (currentStart) {
      const now = new Date();
      const [dayS, dayE] = businessDayBounds(now);
      pushWork(workSegs, currentStart, now, currentPos, dayS, dayE);
    }
    // 休憩終了が無い片割れは無視（仕様）

    // 分がマイナス/ゼロの場合を除去
    const work = workSegs.filter(s => s.endMin > s.startMin);
    const brks = breakSegs.filter(s => s.endMin > s.startMin);

    if (work.length || brks.length) {
      result.set(empId, { name, work, breaks: brks });
    }
  });

  return result;
}

/* 1日の境界（そのイベントの日の 09:00–22:00）*/
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

/* 09:00 起点の分 */
function minutesFromOpen(d) {
  return (d.getHours() - OPEN_HOUR) * 60 + d.getMinutes();
}

/* 営業時間でクリップ */
function clip(s, e, dayS, dayE) {
  const start = new Date(Math.max(s, dayS));
  const end   = new Date(Math.min(e, dayE));
  return end > start ? { start, end } : null;
}

/* ---- ヘルパ ---- */
function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    const a = m.get(k);
    if (a) a.push(x); else m.set(k, [x]);
  }
  return m;
}
function ts(r) { return asDate(r.date, r.time).getTime(); }
function normalizeDateStr(s) {
  // 'YYYY/MM/DD' or 'YYYY-MM-DD' → 'YYYY-MM-DD'
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

/* 0:00で再描画 */
function setMidnightTimer() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0,0,0);
  setTimeout(() => { refreshGantt(); setMidnightTimer(); }, next - now);
}
