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

import { odtFromDoc, docFromOdt, pageOfOdt } from '../src/office/odt.js';
import { wordFromDoc, docFromWord } from '../src/office/word.js';
const qdoc = { type: 'doc', content: [
  { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A quote' }] }] },
  { type: 'codeBlock', content: [{ type: 'text', text: 'let x = 1;' }] },
] };
const kinds = (doc) => (doc.content || []).map((n) => n.type);

test('an .odt using Word’s style names (Quote, Code), as LibreOffice keeps them from a .docx, has its quote and code block', async () => {
  const z = await JSZip.loadAsync(await odtFromDoc(qdoc, 'Q'));
  let content = await z.file('content.xml').async('string');
  content = content.replaceAll('text:style-name="Quotations"', 'text:style-name="Quote"').replaceAll('text:style-name="Preformatted_20_Text"', 'text:style-name="Code"');
  z.file('content.xml', content);
  let styles = await z.file('styles.xml').async('string');
  styles = styles.replace('style:name="Quotations"', 'style:name="Quote"').replace('style:name="Preformatted_20_Text" style:display-name="Preformatted Text"', 'style:name="Code" style:display-name="Code"');
  z.file('styles.xml', styles);
  const back = await docFromOdt(await z.generateAsync({ type: 'nodebuffer' }), {});
  assert.deepEqual(kinds(back.doc), ['blockquote', 'codeBlock']);
});

test('an .odt’s page: the layout its master page uses (LibreOffice writes an empty one first, sizes in inches)', async () => {
  const z = await JSZip.loadAsync(await odtFromDoc({ type: 'doc', content: [{ type: 'paragraph' }] }, 'P', { page: { size: 'a4', orientation: 'landscape', margin: 'normal', header: '', footer: '', numbers: false } }));
  let styles = await z.file('styles.xml').async('string');
  const name = /<style:master-page\b[^>]*style:page-layout-name="([^"]+)"/.exec(styles)[1];
  styles = styles.replace('<office:automatic-styles>', '<office:automatic-styles><style:page-layout style:name="pmEmpty"><style:page-layout-properties style:layout-grid-standard-mode="true"/></style:page-layout>');
  styles = styles.replace(new RegExp(`(<style:page-layout\\b[^>]*style:name="${name}"[^>]*>\\s*<style:page-layout-properties\\b[^>]*?)fo:page-width="[^"]+" fo:page-height="[^"]+"`), '$1fo:page-width="11.6929in" fo:page-height="8.2681in"');
  z.file('styles.xml', styles);
  const page = await pageOfOdt(await z.generateAsync({ type: 'nodebuffer' }));
  assert.deepEqual([page.size, page.orientation], ['a4', 'landscape']);
});

test('through LibreOffice: a document (quote, code, landscape, page numbers) saved by it as .odt and .docx comes back whole', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-lodoc-'));
  try {
    const page = { size: 'a4', orientation: 'landscape', margin: 'normal', header: 'Acme', footer: 'Confidential', numbers: true };
    fs.writeFileSync(path.join(dir, 'd.docx'), await wordFromDoc(qdoc, 'Q', { page }));
    execFileSync('soffice', ['--headless', '--convert-to', 'odt', '--outdir', dir, path.join(dir, 'd.docx')], { stdio: 'ignore', timeout: 120000 });
    const odt = fs.readFileSync(path.join(dir, 'd.odt'));
    assert.deepEqual(kinds((await docFromOdt(odt, {})).doc), ['blockquote', 'codeBlock']);
    const p = await pageOfOdt(odt);
    assert.deepEqual([p.size, p.orientation, p.header, p.footer, p.numbers], ['a4', 'landscape', 'Acme', 'Confidential', true]);
    execFileSync('soffice', ['--headless', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', path.join(dir, 'w'), path.join(dir, 'd.docx')], { stdio: 'ignore', timeout: 120000 });
    assert.deepEqual(kinds((await docFromWord(fs.readFileSync(path.join(dir, 'w', 'd.docx')), {})).doc), ['blockquote', 'codeBlock']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
