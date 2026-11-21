/**
 * 勤怠計算のロジック（Google のサービスに依存しない純粋関数）
 * Node.js で単体テストできる → test/logic.test.js
 */

var PUNCH = { IN: '出勤', OUT: '退勤', BREAK_START: '休憩開始', BREAK_END: '休憩終了' };

/** 出勤から退勤までの最大時間。これを超えたら退勤打刻漏れとみなす（夜勤の日またぎは許容） */
var MAX_SHIFT_MS = 20 * 60 * 60 * 1000;

function pad2(n) { return ('0' + n).slice(-2); }

/** "yyyy-MM-dd"（スクリプトのタイムゾーン基準） */
function dateKey(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** "yyyy-MM" */
function monthKey(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}

/** 分 → "8:30" 形式。null は空文字 */
function formatHM(min) {
  if (min === null || min === undefined) return '';
  var sign = min < 0 ? '-' : '';
  var m = Math.abs(Math.round(min));
  return sign + Math.floor(m / 60) + ':' + pad2(m % 60);
}

function minutesBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

/**
 * 打刻の一覧を、スタッフごとの「勤務（シフト）」にまとめる。
 * punches: [{ ts: Date, store: '店舗A', staff: '山田', type: '出勤' }]
 * staffMaster: { 山田: { store: '店舗A', employment: '社員' } }（任意。応援勤務の判定に使う）
 * options.overtimeThresholdMin: 1日の所定労働時間（分）。これを超えた分を残業とする（既定 480）
 *
 * 戻り値: [{ staff, date, store, homeStore, help, in, out, breaks, workMin, breakMin, overtimeMin, issues }]
 *  - date: 出勤した日（日をまたぐ夜勤も出勤日に計上）
 *  - help: 所属店舗と違う店舗で出勤した（応援勤務）
 *  - issues: 打刻漏れなどの注意点（管理者の確認・修正用）
 */
function buildShifts(punches, staffMaster, options) {
  staffMaster = staffMaster || {};
  options = options || {};
  var threshold = options.overtimeThresholdMin == null ? 480 : options.overtimeThresholdMin;

  var sorted = punches
    .filter(function (p) { return p && p.ts instanceof Date && !isNaN(p.ts.getTime()) && p.staff; })
    .slice()
    .sort(function (a, b) { return a.ts - b.ts; });

  var open = {};   // staff -> 進行中のシフト
  var shifts = [];
  var orphans = []; // シフトに属さない打刻（出勤なしの退勤など）

  function startShift(p) {
    var home = staffMaster[p.staff] ? staffMaster[p.staff].store : '';
    return {
      staff: p.staff,
      date: dateKey(p.ts),
      store: p.store,
      homeStore: home,
      help: Boolean(home) && home !== p.store,
      in: p.ts,
      out: null,
      breaks: [],
      issues: [],
    };
  }

  function close(shift) {
    var breakMin = 0;
    shift.breaks.forEach(function (b) {
      if (b.end) breakMin += minutesBetween(b.start, b.end);
      else shift.issues.push('休憩終了の打刻がありません');
    });
    shift.breakMin = breakMin;
    if (shift.out) {
      shift.workMin = minutesBetween(shift.in, shift.out) - breakMin;
      shift.overtimeMin = Math.max(0, shift.workMin - threshold);
    } else {
      shift.workMin = null;
      shift.overtimeMin = null;
      shift.issues.push('退勤の打刻がありません');
    }
    shifts.push(shift);
  }

  sorted.forEach(function (p) {
    var cur = open[p.staff];
    // 前のシフトが長すぎる場合は、退勤漏れとして閉じる
    if (cur && p.ts - cur.in > MAX_SHIFT_MS) {
      close(cur);
      cur = open[p.staff] = null;
    }

    if (p.type === PUNCH.IN) {
      if (cur) close(cur); // 退勤しないまま再出勤 → 前のシフトは退勤漏れ
      open[p.staff] = startShift(p);
      return;
    }
    if (!cur) {
      orphans.push(p);
      return;
    }
    var last = cur.breaks[cur.breaks.length - 1];
    if (p.type === PUNCH.BREAK_START) {
      if (last && !last.end) cur.issues.push('休憩開始が続けて打刻されています');
      else cur.breaks.push({ start: p.ts, end: null });
    } else if (p.type === PUNCH.BREAK_END) {
      if (last && !last.end) last.end = p.ts;
      else cur.issues.push('休憩開始がないまま休憩終了が打刻されています');
    } else if (p.type === PUNCH.OUT) {
      if (last && !last.end) last.end = p.ts; // 休憩中に退勤 → 退勤時刻で休憩終了とみなす
      cur.out = p.ts;
      if (p.store && p.store !== cur.store) cur.issues.push('出勤と退勤の店舗が異なります（' + cur.store + '→' + p.store + '）');
      close(cur);
      open[p.staff] = null;
    }
  });

  Object.keys(open).forEach(function (k) { if (open[k]) close(open[k]); });

  orphans.forEach(function (p) {
    shifts.push({
      staff: p.staff, date: dateKey(p.ts), store: p.store,
      homeStore: staffMaster[p.staff] ? staffMaster[p.staff].store : '', help: false,
      in: null, out: p.type === PUNCH.OUT ? p.ts : null, breaks: [],
      workMin: null, breakMin: 0, overtimeMin: null,
      issues: ['出勤の打刻がないまま「' + p.type + '」が打刻されています'],
    });
  });

  return shifts.sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : a.staff < b.staff ? -1 : a.staff > b.staff ? 1 : 0;
  });
}

/**
 * 月次集計（スタッフごと）
 * 戻り値: [{ staff, store, employment, days, workMin, breakMin, overtimeMin, helpDays, issueCount }]
 */
function monthlySummary(shifts, staffMaster, yearMonth) {
  staffMaster = staffMaster || {};
  var byStaff = {};
  Object.keys(staffMaster).forEach(function (name) {
    byStaff[name] = {
      staff: name, store: staffMaster[name].store, employment: staffMaster[name].employment || '',
      days: 0, workMin: 0, breakMin: 0, overtimeMin: 0, helpDays: 0, issueCount: 0,
    };
  });
  shifts.forEach(function (s) {
    if (s.date.slice(0, 7) !== yearMonth) return;
    var row = byStaff[s.staff] || (byStaff[s.staff] = {
      staff: s.staff, store: s.homeStore || s.store, employment: '',
      days: 0, workMin: 0, breakMin: 0, overtimeMin: 0, helpDays: 0, issueCount: 0,
    });
    if (s.in) row.days++;
    row.workMin += s.workMin || 0;
    row.breakMin += s.breakMin || 0;
    row.overtimeMin += s.overtimeMin || 0;
    if (s.help) row.helpDays++;
    row.issueCount += s.issues.length;
  });
  return Object.keys(byStaff).map(function (k) { return byStaff[k]; }).sort(function (a, b) {
    return a.store < b.store ? -1 : a.store > b.store ? 1 : a.staff < b.staff ? -1 : 1;
  });
}

/** 店舗ごとの合計（月次） */
function storeSummary(summaryRows) {
  var by = {};
  summaryRows.forEach(function (r) {
    var s = by[r.store] || (by[r.store] = { store: r.store, staffCount: 0, days: 0, workMin: 0, overtimeMin: 0, issueCount: 0 });
    s.staffCount++;
    s.days += r.days;
    s.workMin += r.workMin;
    s.overtimeMin += r.overtimeMin;
    s.issueCount += r.issueCount;
  });
  return Object.keys(by).sort().map(function (k) { return by[k]; });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PUNCH: PUNCH, dateKey: dateKey, monthKey: monthKey, formatHM: formatHM, buildShifts: buildShifts, monthlySummary: monthlySummary, storeSummary: storeSummary };
}
