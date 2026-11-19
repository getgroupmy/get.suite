import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test("the web app's copy of the list merge matches the server's", () => {
  const server = fs.readFileSync(new URL('../src/listmerge.js', import.meta.url), 'utf8');
  const web = fs.readFileSync(new URL('../../web/src/apps/forms/listmerge.js', import.meta.url), 'utf8');
  assert.equal(web, server);
});
