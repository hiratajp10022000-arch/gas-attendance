// Google のサービスを簡易的に再現して、Main.gs の処理が最後まで動くか確かめる（実行時エラーの検出用）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function makeSheet(name, data = []) {
  const sheet = {
    name, data: data.map((r) => r.slice()), formUrl: null,
    getName: () => sheet.name, setName: (n) => { sheet.name = n; return sheet; },
    getFormUrl: () => sheet.formUrl,
    getDataRange: () => ({ getValues: () => (sheet.data.length ? sheet.data.map((r) => r.slice()) : [['']]) }),
    getLastRow: () => sheet.data.length,
    clear: () => { sheet.data = []; return sheet; },
    getRange: (a, b, c, d) => {
      let r, col, nr, nc;
      if (typeof a === 'string') { const m = /^([A-Z])(\d+)$/.exec(a); col = m[1].charCodeAt(0) - 64; r = +m[2]; nr = 1; nc = 1; } else { r = a; col = b; nr = c || 1; nc = d || 1; }
      const range = {
        setValues: (vals) => {
          assert.equal(vals.length, nr, `${sheet.name}: 行数が範囲と合わない`);
          vals.forEach((row, i) => {
            assert.equal(row.length, nc, `${sheet.name}: 列数が範囲と合わない`);
            while (sheet.data.length < r + i) sheet.data.push([]);
            row.forEach((v, j) => { sheet.data[r + i - 1][col + j - 1] = v; });
          });
          return range;
        },
        setValue: (v) => range.setValues([[v]]),
        setFontWeight: () => range, setBackground: () => range, setFontSize: () => range,
        setNumberFormat: (f) => { range.format = f; return range; },
      };
      return range;
    },
    setFrozenRows: () => sheet, autoResizeColumns: () => sheet, setColumnWidth: () => sheet, activate: () => sheet,
  };
  return sheet;
}

function loadGas() {
  const log = makeSheet('フォームの回答 1', [['タイムスタンプ', '店舗', 'スタッフ名', '打刻の種類']]);
  log.formUrl = 'https://docs.google.com/forms/d/x';
  const sheets = [log];
  const ss = {
    getSheets: () => sheets,
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    insertSheet: (n) => { const s = makeSheet(n); sheets.push(s); return s; },
    toast: () => {}, getId: () => 'id',
  };
  const ui = { prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => '鈴木 一郎' }), alert: () => {}, Button: { OK: 'OK' }, ButtonSet: { OK_CANCEL: 1 } };
  const pad = (n) => String(n).padStart(2, '0');
  const mocks = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ui, flush: () => {}, openById: () => ss },
    Utilities: {
      formatDate: (d, _tz, fmt) => fmt === 'HH:mm' ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
        : fmt === 'M/d HH:mm' ? `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}` : d.toISOString(),
      sleep: () => {},
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
    console: { log: () => {} },
  };
  const src = ['Logic.gs', 'Main.gs'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n;\n');
  const names = Object.keys(mocks);
  const gas = new Function(...names, src + '\nreturn { refresh, seedDemoData, createAttendanceBook, CONFIG };')(...names.map((n) => mocks[n]));
  return { gas, ss, log };
}

test('スタッフシートを用意 → サンプル投入 → 集計 → 出勤簿まで実行時エラーなく動く', () => {
  const { gas, ss, log } = loadGas();
  // setup() はフォーム作成が必要なので、スタッフシートだけ setup と同じ内容で用意する
  const staff = ss.insertSheet('スタッフ');
  staff.data = [['氏名', '所属店舗', '雇用区分'], ['山田 太郎', '店舗A', '社員'], ['田中 花子', '店舗A', 'パート'], ['佐藤 健', '店舗B', '社員'],
    ['伊藤 美咲', '店舗B', 'アルバイト'], ['鈴木 一郎', '店舗C', '社員'], ['高橋 結衣', '店舗C', 'パート'], ['渡辺 翔', '店舗D', '社員'], ['中村 葵', '店舗D', 'アルバイト']];

  gas.seedDemoData();
  assert.ok(log.data.length > 1, '打刻が投入されていない');

  const monthly = ss.getSheetByName('月次集計');
  assert.ok(monthly, '月次集計シートがない');
  assert.deepEqual(monthly.data[3].slice(0, 4), ['所属店舗', 'スタッフ', '雇用区分', '出勤日数']);
  const staffRows = monthly.data.slice(4, 12);
  assert.equal(staffRows.length, 8);
  assert.ok(staffRows.every((r) => typeof r[3] === 'number'));

  const daily = ss.getSheetByName('日次');
  assert.ok(daily.data.length > 1);

  gas.createAttendanceBook();
  const book = ss.getSheetByName('出勤簿_鈴木一郎');
  assert.ok(book, '出勤簿シートがない');
  assert.equal(book.data[book.data.length - 1][0], '合計');
});
