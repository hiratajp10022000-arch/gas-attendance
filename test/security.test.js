// セキュリティ：外から来た文が、シートで計算式として動かないか（数はそのまま）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Main.gs'), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(src, ctx);

test('text_: 式になる文だけ、頭に引用符を付ける', () => {
  ['=1+1', '+SUM(1,1)', '@SUM(1,1)', '-SUM(1,1)'].forEach((v) => assert.equal(ctx.text_(v), "'" + v));
  ['山田 太郎', '131:15', '-5', '', '2026-11-24'].forEach((v) => assert.equal(ctx.text_(v), v));
  assert.equal(ctx.text_(5), 5);
});

test('集計・出勤簿に書く表は、すべて text_ を通す', () => {
  const lines = src.split('\n').filter((l) => l.includes("setNumberFormat('@').setValues("));
  assert.equal(lines.length, 4);
  lines.forEach((l) => assert.match(l, /text_/));
});
