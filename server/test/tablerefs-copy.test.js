import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test("the server's copy of the tables' structured references matches the web app's", () => {
  const server = fs.readFileSync(new URL('../src/office/tablerefs.js', import.meta.url), 'utf8').split('\n').slice(2).join('\n')
    .replace("from './sheetnames.js';", "from './formula.js';");
  const web = fs.readFileSync(new URL('../../web/src/apps/sheets/tablerefs.js', import.meta.url), 'utf8');
  assert.equal(server, web);
});
