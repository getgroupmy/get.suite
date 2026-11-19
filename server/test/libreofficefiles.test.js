// Files made in LibreOffice (or by it from ours) come back whole: speaker notes, formulas as usually typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { odpFromDeck, deckFromOdp } from '../src/office/odp.js';
import { powerPointFromDeck, deckFromPowerPoint } from '../src/office/powerpoint.js';
import { formulaFromExcel } from '../src/office/excel.js';

const deck = { slides: [{ id: 's1', items: [{ id: 'b1', type: 'text', x: 10, y: 10, w: 80, h: 20, text: 'Title slide' }], notes: 'Speaker notes here' }] };

test('our .odp marks speaker notes as LibreOffice reads them (a presentation style on the notes frame)', async () => {
  const xml = await (await JSZip.loadAsync(await odpFromDeck(deck, { title: 'D' }))).file('content.xml').async('string');
  assert.match(xml, /<draw:frame presentation:style-name="prNotes" presentation:class="notes"/);
  assert.match(xml, /<style:style style:name="prNotes" style:family="presentation"\/>/);
  assert.equal((await deckFromOdp(await odpFromDeck(deck, { title: 'D' }), {})).slides[0].notes, 'Speaker notes here');
});

test('a .pptx whose notes are in a plain text box (as LibreOffice wrote them) keeps them', async () => {
  const z = await JSZip.loadAsync(await powerPointFromDeck(deck, { title: 'D' }));
  const name = Object.keys(z.files).find((n) => /notesSlides\/notesSlide\d+\.xml$/.test(n));
  const xml = await z.file(name).async('string');
  z.file(name, xml.replace(/<p:ph type="body"[^>]*\/>/, '')); // no body placeholder: just a shape with text
  const back = await deckFromPowerPoint(await z.generateAsync({ type: 'nodebuffer' }), {});
  assert.equal(back.slides[0].notes, 'Speaker notes here');
});

test('TRUE() and FALSE() (as LibreOffice writes them in .xlsx) come in as TRUE and FALSE, not inside text', () => {
  assert.equal(formulaFromExcel('IFS(A1>3,"TRUE()",TRUE(),"no")'), 'IFS(A1>3,"TRUE()",TRUE,"no")');
  assert.equal(formulaFromExcel('_xlfn.XOR(FALSE(),true())'), 'XOR(FALSE,TRUE)');
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('through LibreOffice: our .odp saved by it as .pptx keeps its notes', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-lofiles-'));
  try {
    fs.writeFileSync(path.join(dir, 'd.odp'), await odpFromDeck(deck, { title: 'D' }));
    execFileSync('soffice', ['--headless', '--convert-to', 'pptx', '--outdir', dir, path.join(dir, 'd.odp')], { stdio: 'ignore', timeout: 120000 });
    const back = await deckFromPowerPoint(fs.readFileSync(path.join(dir, 'd.pptx')), {});
    assert.equal(back.slides[0].notes, 'Speaker notes here');
    const notes = await (await JSZip.loadAsync(fs.readFileSync(path.join(dir, 'd.pptx')))).file('ppt/notesSlides/notesSlide1.xml').async('string');
    assert.match(notes, /<p:ph type="body"/, 'as real speaker notes (PowerPoint’s notes placeholder)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
