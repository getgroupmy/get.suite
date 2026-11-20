// CSV files we write (exports of contacts, people, tasks, time, forms, the audit log…) read back by Python's csv module
// as exactly what was written, but for text a spreadsheet would run as a formula, which gets a ' in front (CSV
// injection: a contact named =HYPERLINK(…), a sign-in name in the audit log).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { csvCell, csvText, looksLikeFormula } from '../src/csvcell.js';

const hasPython = spawnSync('python3', ['-c', 'import csv'], { stdio: 'ignore' }).status === 0;
const PIECES = ['a', 'Smith, John', 'say "hi"', 'two\nlines', 'cr\ronly', 'x;y', '', ' lead', 'trail ', 'é€😀', '=SUM(A1)', '+1-555',
  '-5', '+3.2', '-1e3', '@cmd', '\tTab', '-', '--note', '=HYPERLINK("http://x","y")', '1,5', '0', "'quoted"];

test('written fields read back by Python as they were (formulas kept as text)', { skip: !hasPython && 'Python isn’t installed here' }, () => {
  let seed = 9; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const files = [];
  for (let k = 0; k < 300; k++) {
    const sep = rnd() < 0.7 ? ',' : ';';
    const rows = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => PIECES[Math.floor(rnd() * PIECES.length)]));
    files.push({ sep, rows, text: csvText(rows, { sep }) });
  }
  const back = JSON.parse(execFileSync('python3', ['-c', `import csv, io, json, sys
print(json.dumps([list(csv.reader(io.StringIO(f['text'], newline=''), delimiter=f['sep'])) for f in json.load(sys.stdin)]))`], { input: JSON.stringify(files), encoding: 'utf8' }));
  files.forEach((f, i) => {
    const want = f.rows.map((r) => r.map((v) => (looksLikeFormula(v) ? `'${v}` : v)));
    assert.deepEqual(back[i], want, JSON.stringify(f.text));
  });
});

test('the page\'s copy is the same as the server\'s', async () => {
  const fs = await import('node:fs');
  assert.equal(fs.readFileSync(new URL('../../web/src/csvcell.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../src/csvcell.js', import.meta.url), 'utf8'), 'copy server/src/csvcell.js to web/src/csvcell.js');
});

test('which values are kept from running as formulas', () => {
  for (const v of ['=1+1', '@SUM(A1)', '+HYPERLINK("http://evil")', '-x', '--note', '-2+cmd|x', '\tx', '\rx', '=HYPERLINK("http://evil","Click")']) assert.equal(looksLikeFormula(v), true, v);
  for (const v of ['-5', '+3.2', '-1e3', '.5', '5', 'Smith', '', '1-2', 'a=b', '+60 12-345 6789', '+1 (555) 010-0100', '-']) assert.equal(looksLikeFormula(v), false, v);
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('-5'), '-5', 'a negative number stays a number');
  assert.equal(csvCell('=1+1', { guard: false }), '=1+1');
  assert.equal(csvCell('cr\ronly'), '"cr\ronly"', 'a lone \\r is quoted too');
  assert.equal(csvCell('x;y', { sep: ';' }), '"x;y"');
  assert.equal(csvCell(' lead'), '" lead"');
});
