import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
test('the server\'s copy of the Sheets formula engine is the same as the page\'s', () => {
  for (const f of ['formula.js', 'unitconvert.js', 'query.js', 'tablerefs.js', 'statmath.js', 'cellformat.js', 'numfmt.js', 'hiddenrows.js', 'filtercond.js', 'groups.js', 'csvread.js']) {
    const web = path.join(here, '../../web/src/apps/sheets', f);
    if (!fs.existsSync(web)) continue; // (the server on its own)
    assert.equal(fs.readFileSync(path.join(here, '../src/sheetcalc', f), 'utf8'), fs.readFileSync(web, 'utf8'), `${f}: copy web/src/apps/sheets/${f} to server/src/sheetcalc/`);
  }
});
