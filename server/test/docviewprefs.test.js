// Docs' layout choices (outline, typewriter scrolling, dimming other paragraphs, sprint options) and the voice
// typing language are kept with your account: null until chosen, only proper values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-docview-'));
const { cleanPrefs } = await import('../src/routes/docprefs.js');

test('not chosen yet: null', () => {
  const p = cleanPrefs({});
  assert.deepEqual([p.outline, p.typewriter, p.dim_others, p.sprint_quiet, p.sprint_status, p.voice_lang], [null, null, null, null, null, null]);
});
test('true or false; a language tag or the browser’s own', () => {
  assert.deepEqual([cleanPrefs({ outline: true }).outline, cleanPrefs({ typewriter: false }).typewriter, cleanPrefs({ dim_others: 'yes' }).dim_others], [true, false, null]);
  assert.equal(cleanPrefs({ voice_lang: 'pt-BR' }).voice_lang, 'pt-BR');
  assert.equal(cleanPrefs({ voice_lang: '' }).voice_lang, '');
  for (const bad of ['<script>', 'english please', 'x', 42]) assert.equal(cleanPrefs({ voice_lang: bad }).voice_lang, null, String(bad));
});
test('one change keeps the rest', () => {
  const a = cleanPrefs({ ...cleanPrefs({ zoom: 125, outline: true }), typewriter: true });
  assert.deepEqual([a.zoom, a.outline, a.typewriter], [125, true, true]);
});
