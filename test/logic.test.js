// 実行: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/Logic.gs');

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m); // 2026年11月d日 h:m
const P = (staff, store, type, ts) => ({ staff, store, type, ts });
const master = {
  山田: { store: '店舗A', employment: '社員' },
  佐藤: { store: '店舗B', employment: 'パート' },
  鈴木: { store: '店舗C', employment: 'アルバイト' },
};

test('基本：出勤→休憩→退勤で実働・休憩・残業を計算', () => {
  const [s] = L.buildShifts([
    P('山田', '店舗A', '出勤', at(1, 9)),
    P('山田', '店舗A', '休憩開始', at(1, 12)),
    P('山田', '店舗A', '休憩終了', at(1, 13)),
    P('山田', '店舗A', '退勤', at(1, 19, 30)),
  ], master);
  assert.equal(s.date, '2026-11-01');
  assert.equal(s.breakMin, 60);
  assert.equal(s.workMin, 570); // 9:30
  assert.equal(s.overtimeMin, 90); // 8時間超の1:30
  assert.deepEqual(s.issues, []);
  assert.equal(L.formatHM(s.workMin), '9:30');
});

test('休憩が複数回でも合計する', () => {
  const [s] = L.buildShifts([
    P('佐藤', '店舗B', '出勤', at(2, 10)),
    P('佐藤', '店舗B', '休憩開始', at(2, 12)),
    P('佐藤', '店舗B', '休憩終了', at(2, 12, 30)),
    P('佐藤', '店舗B', '休憩開始', at(2, 15)),
    P('佐藤', '店舗B', '休憩終了', at(2, 15, 15)),
    P('佐藤', '店舗B', '退勤', at(2, 17)),
  ], master);
  assert.equal(s.breakMin, 45);
  assert.equal(s.workMin, 375);
  assert.equal(s.overtimeMin, 0);
});

test('日をまたぐ夜勤は出勤日に計上する（22時〜翌7時、休憩45分 → 実働8:15）', () => {
  const shifts = L.buildShifts([
    P('鈴木', '店舗C', '出勤', at(30, 22)),
    P('鈴木', '店舗C', '休憩開始', at(31, 2)),
    P('鈴木', '店舗C', '休憩終了', at(31, 2, 45)),
    P('鈴木', '店舗C', '退勤', at(31, 7)),
  ], master);
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].date, '2026-11-30');
  assert.equal(L.formatHM(shifts[0].workMin), '8:15');
  assert.equal(shifts[0].overtimeMin, 15);
});

test('所属と違う店舗での出勤は応援勤務として記録', () => {
  const [s] = L.buildShifts([
    P('山田', '店舗B', '出勤', at(3, 9)),
    P('山田', '店舗B', '退勤', at(3, 15)),
  ], master);
  assert.equal(s.help, true);
  assert.equal(s.store, '店舗B');
  assert.equal(s.homeStore, '店舗A');
});

test('退勤の打刻漏れ：次の出勤で前のシフトを閉じ、注意を残す', () => {
  const shifts = L.buildShifts([
    P('山田', '店舗A', '出勤', at(4, 9)),
    P('山田', '店舗A', '出勤', at(5, 9)),
    P('山田', '店舗A', '退勤', at(5, 18)),
  ], master);
  assert.equal(shifts.length, 2);
  assert.equal(shifts[0].workMin, null);
  assert.match(shifts[0].issues[0], /退勤の打刻がありません/);
  assert.equal(shifts[1].workMin, 540);
});

test('退勤の打刻漏れ：20時間を超えたら別の勤務とみなす', () => {
  const shifts = L.buildShifts([
    P('山田', '店舗A', '出勤', at(6, 9)),
    P('山田', '店舗A', '休憩開始', at(7, 12)), // 翌日の休憩開始（出勤打刻なし）
  ], master);
  assert.equal(shifts.length, 2);
  assert.match(shifts[0].issues.join(), /退勤の打刻がありません/);
  assert.match(shifts[1].issues.join(), /出勤の打刻がないまま「休憩開始」/);
});

test('休憩終了の打刻漏れ・休憩中の退勤', () => {
  const [s] = L.buildShifts([
    P('佐藤', '店舗B', '出勤', at(8, 10)),
    P('佐藤', '店舗B', '休憩開始', at(8, 13)),
    P('佐藤', '店舗B', '退勤', at(8, 14)),
  ], master);
  // 休憩中に退勤 → 退勤時刻で休憩終了とみなす
  assert.equal(s.breakMin, 60);
  assert.equal(s.workMin, 180);
});

test('出勤なしの退勤は孤立した打刻として注意', () => {
  const shifts = L.buildShifts([P('佐藤', '店舗B', '退勤', at(9, 18))], master);
  assert.equal(shifts.length, 1);
  assert.match(shifts[0].issues[0], /出勤の打刻がないまま「退勤」/);
});

test('打刻順が入れ替わって記録されても時刻順で処理する', () => {
  const [s] = L.buildShifts([
    P('山田', '店舗A', '退勤', at(10, 18)),
    P('山田', '店舗A', '出勤', at(10, 9)),
  ], master);
  assert.equal(s.workMin, 540);
});

test('所定労働時間を設定で変えられる（例：7時間）', () => {
  const [s] = L.buildShifts([
    P('山田', '店舗A', '出勤', at(11, 9)),
    P('山田', '店舗A', '退勤', at(11, 17)),
  ], master, { overtimeThresholdMin: 420 });
  assert.equal(s.overtimeMin, 60);
});

test('月次集計：出勤日数・実働・残業・応援・注意件数。打刻がないスタッフも0で並ぶ', () => {
  const shifts = L.buildShifts([
    P('山田', '店舗A', '出勤', at(1, 9)), P('山田', '店舗A', '退勤', at(1, 18)),
    P('山田', '店舗B', '出勤', at(2, 9)), P('山田', '店舗B', '退勤', at(2, 19)),
    P('佐藤', '店舗B', '出勤', at(2, 10)),
  ], master);
  const rows = L.monthlySummary(shifts, master, '2026-11');
  const yamada = rows.find((r) => r.staff === '山田');
  assert.equal(yamada.days, 2);
  assert.equal(yamada.workMin, 540 + 600);
  assert.equal(yamada.overtimeMin, 60 + 120);
  assert.equal(yamada.helpDays, 1);
  assert.equal(rows.find((r) => r.staff === '佐藤').issueCount, 1);
  assert.equal(rows.find((r) => r.staff === '鈴木').days, 0);
});

test('月次集計：対象月以外は含めない', () => {
  const shifts = L.buildShifts([
    P('山田', '店舗A', '出勤', new Date(2026, 9, 31, 9)), P('山田', '店舗A', '退勤', new Date(2026, 9, 31, 17)),
  ], master);
  assert.equal(L.monthlySummary(shifts, master, '2026-11').find((r) => r.staff === '山田').days, 0);
});

test('店舗ごとの合計', () => {
  const rows = [
    { store: '店舗A', days: 2, workMin: 100, overtimeMin: 10, issueCount: 0 },
    { store: '店舗A', days: 1, workMin: 50, overtimeMin: 0, issueCount: 1 },
    { store: '店舗B', days: 3, workMin: 200, overtimeMin: 20, issueCount: 0 },
  ];
  assert.deepEqual(L.storeSummary(rows), [
    { store: '店舗A', staffCount: 2, days: 3, workMin: 150, overtimeMin: 10, issueCount: 1 },
    { store: '店舗B', staffCount: 1, days: 3, workMin: 200, overtimeMin: 20, issueCount: 0 },
  ]);
});

test('formatHM', () => {
  assert.equal(L.formatHM(0), '0:00');
  assert.equal(L.formatHM(495), '8:15');
  assert.equal(L.formatHM(null), '');
});
