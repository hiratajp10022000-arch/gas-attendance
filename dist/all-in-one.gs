/** 勤怠管理デモ（1ファイル版）: Apps Script の「コード.gs」を全部消して貼り付けてください */

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

/**
 * Google フォーム＋スプレッドシートの勤怠管理（デモ）
 * メニュー「🕒 勤怠管理」から操作する。
 */

var CONFIG = {
  STORES: ['店舗A', '店舗B', '店舗C', '店舗D'],
  OVERTIME_THRESHOLD_MIN: 480, // 1日の所定労働時間（分）。超えた分を残業として集計
  SHEET: { LOG: '打刻ログ', STAFF: 'スタッフ', DAILY: '日次', MONTHLY: '月次集計' },
  FORM_TITLE: '出退勤 打刻フォーム',
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🕒 勤怠管理')
    .addItem('初期セットアップ', 'setup')
    .addItem('集計を更新', 'refresh')
    .addItem('出勤簿を作成', 'createAttendanceBook')
    .addSeparator()
    .addItem('フォームのスタッフ一覧を更新', 'syncStaffToForm')
    .addItem('（デモ）サンプル打刻を投入', 'seedDemoData')
    .addToUi();
}

// ---------- セットアップ ----------

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var staffSheet = ensureStaffSheet_(ss);
  if (!findLogSheet_(ss)) {
    var form = FormApp.create(CONFIG.FORM_TITLE);
    form.setDescription('店舗・名前・打刻の種類を選んで送信してください。打刻時刻は自動で記録されます。');
    form.setConfirmationMessage('打刻しました。お疲れさまです！');
    form.addListItem().setTitle('店舗').setChoiceValues(CONFIG.STORES).setRequired(true);
    form.addListItem().setTitle('スタッフ名').setChoiceValues(staffNames_(staffSheet)).setRequired(true);
    form.addMultipleChoiceItem().setTitle('打刻の種類')
      .setChoiceValues([PUNCH.IN, PUNCH.BREAK_START, PUNCH.BREAK_END, PUNCH.OUT]).setRequired(true);
    form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
    PropertiesService.getScriptProperties().setProperty('FORM_ID', form.getId());
    var log = waitForLogSheet_(ss);
    log.setName(CONFIG.SHEET.LOG);
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onPunch') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onPunch').forSpreadsheet(ss).onFormSubmit().create();
  refresh();
  var formId = PropertiesService.getScriptProperties().getProperty('FORM_ID');
  if (formId) console.log('打刻フォームのURL: ' + FormApp.openById(formId).getPublishedUrl());
  ss.toast('セットアップが完了しました。打刻フォームのURLは実行ログに出力しています。', '🕒 勤怠管理', 10);
}

function ensureStaffSheet_(ss) {
  var sh = ss.getSheetByName(CONFIG.SHEET.STAFF);
  if (sh) return sh;
  sh = ss.insertSheet(CONFIG.SHEET.STAFF);
  sh.getRange(1, 1, 1, 3).setValues([['氏名', '所属店舗', '雇用区分']]).setFontWeight('bold').setBackground('#e8f0fe');
  sh.getRange(2, 1, 8, 3).setValues([
    ['山田 太郎', '店舗A', '社員'], ['田中 花子', '店舗A', 'パート'],
    ['佐藤 健', '店舗B', '社員'], ['伊藤 美咲', '店舗B', 'アルバイト'],
    ['鈴木 一郎', '店舗C', '社員'], ['高橋 結衣', '店舗C', 'パート'],
    ['渡辺 翔', '店舗D', '社員'], ['中村 葵', '店舗D', 'アルバイト'],
  ]);
  sh.setFrozenRows(1);
  return sh;
}

function staffNames_(staffSheet) {
  var v = staffSheet.getDataRange().getValues().slice(1);
  return v.map(function (r) { return String(r[0]).trim(); }).filter(String);
}

/** スタッフシートの変更をフォームの選択肢に反映 */
function syncStaffToForm() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var formId = PropertiesService.getScriptProperties().getProperty('FORM_ID');
  if (!formId) throw new Error('先に「初期セットアップ」を実行してください。');
  var item = FormApp.openById(formId).getItems().filter(function (i) { return i.getTitle() === 'スタッフ名'; })[0];
  item.asListItem().setChoiceValues(staffNames_(ss.getSheetByName(CONFIG.SHEET.STAFF)));
  ss.toast('フォームのスタッフ一覧を更新しました。', '🕒 勤怠管理', 5);
}

function findLogSheet_(ss) {
  return ss.getSheets().filter(function (s) { return s.getFormUrl(); })[0] || null;
}

function waitForLogSheet_(ss) {
  for (var i = 0; i < 10; i++) {
    SpreadsheetApp.flush();
    var s = findLogSheet_(SpreadsheetApp.openById(ss.getId()));
    if (s) return s;
    Utilities.sleep(1000);
  }
  throw new Error('回答シートの作成を確認できませんでした。もう一度「初期セットアップ」を実行してください。');
}

// ---------- 打刻時・集計 ----------

function onPunch() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { refresh(); } finally { lock.releaseLock(); }
}

function readData_(ss) {
  var log = findLogSheet_(ss);
  if (!log) throw new Error('打刻ログが見つかりません。先に「初期セットアップ」を実行してください。');
  var rows = log.getDataRange().getValues().slice(1);
  var punches = rows.filter(function (r) { return r[0] instanceof Date; }).map(function (r) {
    return { ts: r[0], store: String(r[1]), staff: String(r[2]).trim(), type: String(r[3]) };
  });
  var master = {};
  ss.getSheetByName(CONFIG.SHEET.STAFF).getDataRange().getValues().slice(1).forEach(function (r) {
    var name = String(r[0]).trim();
    if (name) master[name] = { store: String(r[1]), employment: String(r[2]) };
  });
  return { punches: punches, master: master };
}

/** 日次・月次集計シートを作り直す（対象は今月） */
function refresh() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = readData_(ss);
  var shifts = buildShifts(data.punches, data.master, { overtimeThresholdMin: CONFIG.OVERTIME_THRESHOLD_MIN });
  var ym = monthKey(new Date());
  var log = findLogSheet_(ss);
  if (log.getLastRow() > 1) log.getRange(2, 1, log.getLastRow() - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm:ss'); // 打刻時刻を秒まで表示
  writeDaily_(ss, shifts, ym);
  writeMonthly_(ss, shifts, data.master, ym);
}

/** 「=」や「+」で始まる文が、計算式として動かないようにする（@ 書式では止まらない。-5 などの数はそのまま） */
function text_(v) {
  return typeof v === 'string' && /^[=+@-]/.test(v) && isNaN(v) ? "'" + v : v;
}

function setWidths_(sh, widths) { widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); }); }

function hm_(d) { return d ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'HH:mm') : ''; }
function md_(d) { return d ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'M/d HH:mm') : ''; }

function writeDaily_(ss, shifts, ym) {
  var sh = ss.getSheetByName(CONFIG.SHEET.DAILY) || ss.insertSheet(CONFIG.SHEET.DAILY);
  sh.clear();
  var header = ['日付', '勤務店舗', 'スタッフ', '応援', '出勤', '退勤', '休憩', '実働', '残業', '要確認'];
  var rows = shifts.filter(function (s) { return s.date.slice(0, 7) === ym; }).map(function (s) {
    var outText = s.out && s.in && dateKey(s.out) !== s.date ? md_(s.out) : hm_(s.out); // 日またぎは日付も表示
    return [s.date, s.store, s.staff, s.help ? '応援（所属: ' + s.homeStore + '）' : '', hm_(s.in), outText,
      formatHM(s.breakMin), formatHM(s.workMin), formatHM(s.overtimeMin), s.issues.join(' / ')];
  });
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8f0fe');
  if (rows.length) {
    // 「142:30」などがスプレッドシートに時刻（24時間で折り返し）と解釈されないよう、書式を文字列にしてから書き込む
    sh.getRange(2, 1, rows.length, header.length).setNumberFormat('@').setValues(rows.map(function (r) { return r.map(text_); }));
    rows.forEach(function (r, i) {
      if (r[9]) sh.getRange(i + 2, 1, 1, header.length).setBackground('#fde8e8');
      else if (r[3]) sh.getRange(i + 2, 1, 1, header.length).setBackground('#fff7e0');
    });
  }
  sh.setFrozenRows(1);
  setWidths_(sh, [95, 75, 100, 150, 55, 85, 55, 55, 55, 340]);
}

function writeMonthly_(ss, shifts, master, ym) {
  var sh = ss.getSheetByName(CONFIG.SHEET.MONTHLY) || ss.insertSheet(CONFIG.SHEET.MONTHLY);
  sh.clear();
  var rows = monthlySummary(shifts, master, ym);
  sh.getRange('A1').setValue(ym.replace('-', '年') + '月 勤怠集計').setFontSize(14).setFontWeight('bold');
  sh.getRange('A2').setValue('最終更新: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm') +
    '（所定 ' + formatHM(CONFIG.OVERTIME_THRESHOLD_MIN) + ' 超を残業として集計）');
  var header = ['所属店舗', 'スタッフ', '雇用区分', '出勤日数', '実働時間', '休憩時間', '残業時間', '応援日数', '要確認'];
  sh.getRange(4, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8f0fe');
  var body = rows.map(function (r) {
    return [r.store, r.staff, r.employment, r.days, formatHM(r.workMin), formatHM(r.breakMin), formatHM(r.overtimeMin), r.helpDays, r.issueCount || ''];
  });
  if (body.length) sh.getRange(5, 1, body.length, header.length).setNumberFormat('@').setValues(body.map(function (r) { return r.map(text_); }));
  body.forEach(function (r, i) { if (r[8]) sh.getRange(5 + i, 9).setBackground('#fde8e8'); });

  var top = 5 + body.length + 2;
  var stores = storeSummary(rows);
  sh.getRange(top, 1).setValue('店舗別 合計').setFontWeight('bold');
  var sh2 = [['店舗', '人数', '延べ出勤日数', '実働合計', '残業合計', '要確認']];
  stores.forEach(function (s) { sh2.push([s.store, s.staffCount, s.days, formatHM(s.workMin), formatHM(s.overtimeMin), s.issueCount || '']); });
  sh.getRange(top + 1, 1, sh2.length, 6).setNumberFormat('@').setValues(sh2.map(function (r) { return r.map(text_); }));
  sh.getRange(top + 1, 1, 1, 6).setFontWeight('bold').setBackground('#e8f0fe');
  // 自動調整は日本語の列で狭くなることがあるため、列幅は固定で指定する
  setWidths_(sh, sh.getName() === CONFIG.SHEET.MONTHLY ? [80, 100, 85, 75, 80, 75, 75, 75, 60] : [60, 45, 80, 60, 75, 60, 60, 60, 260]);
  sh.activate();
}

// ---------- 出勤簿 ----------

/** スタッフを1人選んで、今月の出勤簿シートを作る（印刷・PDF保存用） */
function createAttendanceBook() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = readData_(ss);
  var names = Object.keys(data.master);
  var res = ui.prompt('出勤簿を作成', 'スタッフ名を入力してください（例: ' + names[0] + '）', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var name = res.getResponseText().trim();
  if (!data.master[name]) { ui.alert('「' + name + '」はスタッフシートにいません。'); return; }
  buildBook_(ss, name, data);
}

function buildBook_(ss, name, data) {
  var now = new Date();
  var ym = monthKey(now);
  var shifts = buildShifts(data.punches, data.master, { overtimeThresholdMin: CONFIG.OVERTIME_THRESHOLD_MIN })
    .filter(function (s) { return s.staff === name && s.date.slice(0, 7) === ym; });
  var title = '出勤簿_' + name.replace(/\s/g, '');
  var sh = ss.getSheetByName(title) || ss.insertSheet(title);
  sh.clear();
  sh.getRange('A1').setValue(ym.replace('-', '年') + '月 出勤簿　' + name + '（' + data.master[name].store + '・' + data.master[name].employment + '）')
    .setFontSize(13).setFontWeight('bold');
  var header = ['日付', '曜日', '勤務店舗', '出勤', '退勤', '休憩', '実働', '残業', '備考'];
  sh.getRange(3, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8f0fe');
  var days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  var dow = ['日', '月', '火', '水', '木', '金', '土'];
  var rows = [];
  var tot = { days: 0, work: 0, brk: 0, ot: 0 };
  for (var d = 1; d <= days; d++) {
    var date = new Date(now.getFullYear(), now.getMonth(), d);
    var key = dateKey(date);
    var s = shifts.filter(function (x) { return x.date === key; });
    if (!s.length) { rows.push([d + '日', dow[date.getDay()], '', '', '', '', '', '', '']); continue; }
    s.forEach(function (x) {
      if (x.in) tot.days++;
      tot.work += x.workMin || 0; tot.brk += x.breakMin || 0; tot.ot += x.overtimeMin || 0;
      var note = (x.help ? '応援 ' : '') + x.issues.join(' / ');
      rows.push([d + '日', dow[date.getDay()], x.store, hm_(x.in), x.out && dateKey(x.out) !== key ? '翌' + hm_(x.out) : hm_(x.out),
        formatHM(x.breakMin), formatHM(x.workMin), formatHM(x.overtimeMin), note]);
    });
  }
  rows.push(['合計', '', '', '', '', formatHM(tot.brk), formatHM(tot.work), formatHM(tot.ot), '出勤 ' + tot.days + '日']);
  sh.getRange(4, 1, rows.length, header.length).setNumberFormat('@').setValues(rows.map(function (r) { return r.map(text_); }));
  sh.getRange(4 + rows.length - 1, 1, 1, header.length).setFontWeight('bold').setBackground('#f1f3f4');
  // 自動調整は日本語の列で狭くなることがあるため、列幅は固定で指定する
  setWidths_(sh, sh.getName() === CONFIG.SHEET.MONTHLY ? [80, 100, 85, 75, 80, 75, 75, 75, 60] : [60, 45, 80, 60, 75, 60, 60, 60, 260]);
  sh.activate();
}

// ---------- デモ用 ----------

/** 今月1日〜昨日のサンプル打刻を「打刻ログ」に入れる（夜勤・応援・打刻漏れ・休憩2回を含む） */
function seedDemoData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var log = findLogSheet_(ss);
  if (!log) throw new Error('先に「初期セットアップ」を実行してください。');
  var now = new Date();
  var y = now.getFullYear(), m = now.getMonth();
  var lastDay = Math.max(1, now.getDate() - 1);
  var rows = [];
  var add = function (d, h, min, store, staff, type) { rows.push([new Date(y, m, d, h, min), store, staff, type]); };
  var pattern = [
    ['山田 太郎', '店舗A', 9, 0, 18, 30], ['田中 花子', '店舗A', 10, 0, 15, 0],
    ['佐藤 健', '店舗B', 9, 30, 19, 0], ['伊藤 美咲', '店舗B', 17, 0, 22, 0],
    ['鈴木 一郎', '店舗C', 9, 0, 18, 0], ['高橋 結衣', '店舗C', 11, 0, 16, 0],
    ['渡辺 翔', '店舗D', 10, 0, 20, 0], ['中村 葵', '店舗D', 18, 0, 22, 30],
  ];
  for (var d = 1; d <= lastDay; d++) {
    pattern.forEach(function (p, i) {
      if ((d + i) % 7 === 0 || (d + i) % 7 === 3) return; // 週2日は休み
      var store = p[1];
      if (p[0] === '田中 花子' && d % 6 === 0) store = '店舗B'; // 応援勤務
      add(d, p[2], p[3], store, p[0], PUNCH.IN);
      if (p[4] - p[2] >= 6) {
        add(d, p[2] + 3, 0, store, p[0], PUNCH.BREAK_START);
        add(d, p[2] + 3, 45, store, p[0], PUNCH.BREAK_END);
        if (p[0] === '渡辺 翔') { // 休憩2回
          add(d, p[2] + 7, 0, store, p[0], PUNCH.BREAK_START);
          add(d, p[2] + 7, 15, store, p[0], PUNCH.BREAK_END);
        }
      }
      if (p[0] === '伊藤 美咲' && d === 5) return; // 退勤の打刻漏れ
      add(d, p[4], p[5], store, p[0], PUNCH.OUT);
    });
    if (d % 5 === 2) { // 夜勤（日またぎ）
      add(d, 22, 0, '店舗C', '鈴木 一郎', PUNCH.IN);
      add(d + 1, 2, 0, '店舗C', '鈴木 一郎', PUNCH.BREAK_START);
      add(d + 1, 2, 45, '店舗C', '鈴木 一郎', PUNCH.BREAK_END);
      add(d + 1, 7, 0, '店舗C', '鈴木 一郎', PUNCH.OUT);
    }
  }
  log.getRange(log.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
  refresh();
  ss.toast(rows.length + '件のサンプル打刻を投入しました。', '🕒 勤怠管理', 5);
}

