import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test("the server's copy of the calendar maths matches the web app's", () => {
  const server = fs.readFileSync(new URL('../src/calmath.js', import.meta.url), 'utf8').split('\n').slice(2).join('\n');
  const web = fs.readFileSync(new URL('../../web/src/apps/calendar/calmath.js', import.meta.url), 'utf8');
  assert.equal(server, web);
});
