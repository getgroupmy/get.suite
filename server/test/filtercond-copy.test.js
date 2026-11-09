import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test("the server's copy of the filter conditions match the web app's", () => {
  const server = fs.readFileSync(new URL('../src/office/filtercond.js', import.meta.url), 'utf8').split('\n').slice(2).join('\n');
  const web = fs.readFileSync(new URL('../../web/src/apps/sheets/filtercond.js', import.meta.url), 'utf8');
  assert.equal(server, web);
});
