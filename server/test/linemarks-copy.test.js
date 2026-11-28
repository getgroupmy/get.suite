import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test("the server's line-comment placing is the web app's", () => {
  assert.equal(fs.readFileSync(new URL('../src/linemarks.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../../web/src/apps/linemarks.js', import.meta.url), 'utf8'));
});
