// CSV files read as Python's csv module reads them: separators (comma or semicolon, as Excel saves in much of Europe),
// quotes, quoted separators and line breaks, CRLF, a byte-order mark, a last empty quoted field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseCsv, csvSeparator } from '../src/contactfiles.js';

const hasPython = spawnSync('python3', ['-c', 'import csv'], { stdio: 'ignore' }).status === 0;
// Files as Python writes them: { text, rows }. quoting: QUOTE_ALL (every field quoted) or QUOTE_MINIMAL (as Excel: only
// fields with the separator, a quote or a line break; so in a ";" file, decimals such as 1,5 stand bare).
const files = (seed, quoting) => JSON.parse(execFileSync('python3', ['-c', `
import csv, io, json, random
random.seed(${seed})
pieces = ['a', 'Smith, John', 'say "hi"', 'two\\nlines', 'x;y', '', ' sp ', 'é€', 'tab\\there', '"', '123', '1,5', '2,25', 'Jones', 'cr\\r\\nlf']
out = []
for k in range(1500):
    delim = random.choice([',', ';'])
    rows = [[random.choice(pieces) for _ in range(random.randint(2, 5))] for _ in range(random.randint(3, 8))]
    n = max(len(r) for r in rows); rows = [r + [''] * (n - len(r)) for r in rows]
    buf = io.StringIO()
    csv.writer(buf, delimiter=delim, quoting=csv.${quoting}, lineterminator=random.choice(['\\r\\n', '\\n'])).writerows(rows)
    text = buf.getvalue()
    if random.random() < 0.2: text = '\\ufeff' + text
    out.append({'text': text, 'rows': list(csv.reader(io.StringIO(text.lstrip('\\ufeff'), newline=''), delimiter=delim))})
print(json.dumps(out))`], { encoding: 'utf8', maxBuffer: 64 << 20 }));
const differing = (cases) => cases.filter((c) => JSON.stringify(parseCsv(c.text, { keepEmpty: true })) !== JSON.stringify(c.rows));

test('every field quoted: read exactly as Python reads them', { skip: !hasPython && 'Python isn’t installed here' }, () => {
  const bad = differing(files(1, 'QUOTE_ALL'));
  assert.equal(bad.length, 0, bad.slice(0, 2).map((c) => JSON.stringify(c.text)).join('\n'));
});

test('quoted only where needed, as Excel saves: read as Python reads them (but for a rare few that read either way)', { skip: !hasPython && 'Python isn’t installed here' }, () => {
  // A few can't be told: every row with exactly one bare comma and one bare semicolon ("Smith, John;1,5").
  const all = files(2, 'QUOTE_MINIMAL'), bad = differing(all);
  assert.ok(bad.length <= all.length / 300, `${bad.length} of ${all.length}:\n${bad.slice(0, 3).map((c) => JSON.stringify(c.text)).join('\n')}`);
});

test('the separator: semicolons with quoted commas, decimal commas, notes lines first, line breaks in the first field', () => {
  assert.equal(csvSeparator('"Smith, John";"x"\n"Lee, Ann";"y"\n'), ';', 'commas inside quotes don\'t count');
  assert.equal(csvSeparator('"Notes,\nmore, notes";a;b\nx;y;z\n'), ';', 'a quoted line break doesn\'t end the first row');
  assert.equal(csvSeparator('Name;Amount\nSmith;1,5\nJones;2,25\n'), ';', 'decimal commas');
  assert.equal(csvSeparator('Item;Price\npear;1,5\n'), ';', 'even both ways: 1,5 is a decimal comma');
  assert.equal(csvSeparator('Notes:\n"When exporting, you may notice"\n\nFirst Name,Last Name,Email\nNora,Diaz,nora@example.com\n'), ',', 'LinkedIn: a notes line first');
  assert.equal(csvSeparator('Name,Qty,Price\nApple,3,5\nPear,1,2\n'), ',', 'numbers in separate columns');
  assert.equal(csvSeparator('just one column\nsecond\n'), ',');
  assert.deepEqual(parseCsv('﻿Name;Note\n"Smith, John";"say ""hi"""\n'), [['Name', 'Note'], ['Smith, John', 'say "hi"']]);
  assert.deepEqual(parseCsv('a\n""', { keepEmpty: true }), [['a'], ['']], 'a last row of one quoted empty field');
});
