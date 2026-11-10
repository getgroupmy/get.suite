import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slideFileName, crc32, zipStored } from './slideimages.js';

test('slide pictures: file names padded to sort, unsafe characters replaced', () => {
  assert.equal(slideFileName('Quarterly review', 3, 12), 'Quarterly review - 03.png');
  assert.equal(slideFileName('Q3: plan/draft', 1, 5), 'Q3_ plan_draft - 1.png');
  assert.equal(slideFileName('', 7, 120), 'Presentation - 007.png');
});

test('slide pictures: a .zip that unzip reads back exactly (names with accents too)', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'the standard check value');
  const files = [{ name: 'Café - 1.png', bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) }, { name: 'Café - 2.png', bytes: new Uint8Array(70000).map((_, i) => i % 251) }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipt-'));
  fs.writeFileSync(path.join(dir, 'a.zip'), zipStored(files));
  execFileSync('unzip', ['-q', '-t', path.join(dir, 'a.zip')]); // integrity (CRCs) checked
  execFileSync('unzip', ['-q', '-o', path.join(dir, 'a.zip'), '-d', path.join(dir, 'out')]);
  for (const f of files) assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dir, 'out', f.name))), f.bytes);
  fs.rmSync(dir, { recursive: true, force: true });
});
