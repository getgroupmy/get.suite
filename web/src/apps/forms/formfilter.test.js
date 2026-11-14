import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { matchesFilter, filterOptions } from './formfilter.js';
import * as server from '../../../../server/src/formfilter.js';

test('the web filter matches the server one, case for case (the server filters downloads)', async () => {
  // The same rules: the code below the header comments is the same on both sides.
  const body = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').split('\n').filter((l) => !l.startsWith('//')).join('\n');
  assert.equal(body('./formfilter.js').split('/** What to filter by')[0].trim(), body('../../../../server/src/formfilter.js').trim());
  const { QS, CASES } = await import('../../../../server/test/formfilter.test.js');
  for (const [answers, f, want] of CASES) {
    assert.equal(matchesFilter(QS, answers, f), want);
    assert.equal(server.matchesFilter(QS, answers, f), want);
  }
  assert.ok(filterOptions);
});
