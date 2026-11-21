// Suggestions (Docs' suggesting mode) in .odt files: LibreOffice's tracked changes, both ways and through LibreOffice
// (.odt saved again as .odt or .docx, and a Word file's tracked changes saved by it as .odt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { odtFromDoc, docFromOdt } from '../src/office/odt.js';
import { wordFromDoc, docFromWord } from '../src/office/word.js';

const at = Date.UTC(2026, 10, 3, 9, 30);
const ins = (id, name) => ({ type: 'suggestInsert', attrs: { id, by: 'u1', name, at } });
const del = (id, name) => ({ type: 'suggestDelete', attrs: { id, by: 'u2', name, at } });
const doc = { type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'The meeting is on ' }, { type: 'text', text: 'Monday', marks: [del('s1', 'Kim Park')] }, { type: 'text', text: 'Tuesday', marks: [ins('s1', 'Kim Park')] }, { type: 'text', text: ' at noon.' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Bring ' }, { type: 'text', text: 'your ', marks: [ins('s2', 'Olivia Owner')] }, { type: 'text', text: 'laptops', marks: [{ type: 'bold' }] }, { type: 'text', text: ' please', marks: [del('s3', 'Olivia Owner')] }, { type: 'text', text: '.' }] },
] };
// Each paragraph: its text, each suggestion's words as +[…] or -[…] with who, when, and which are one suggestion.
const show = (d) => (d.doc || d).content.map((p) => { const ids = new Map(); return (p.content || []).map((t) => { const m = (t.marks || []).find((x) => /^suggest/.test(x.type)); if (!m) return t.text; if (!ids.has(m.attrs.id)) ids.set(m.attrs.id, ids.size + 1); return `${m.type === 'suggestInsert' ? '+' : '-'}[${t.text}|${m.attrs.name}|${new Date(m.attrs.at).toISOString().slice(0, 16)}|#${ids.get(m.attrs.id)}]`; }).join(''); });
const want = show(doc);

test('.odt out: each suggestion a changed region (who, when; a deletion\'s words kept in it), marked in the text', async () => {
  const xml = await (await JSZip.loadAsync(await odtFromDoc(doc, 'T'))).file('content.xml').async('string');
  assert.match(xml, /<office:text><text:tracked-changes text:track-changes="false"><text:changed-region text:id="ct1"><text:deletion><office:change-info><dc:creator>Kim Park<\/dc:creator><dc:date>2026-11-03T09:30:00<\/dc:date><\/office:change-info><text:p>Monday<\/text:p><\/text:deletion><\/text:changed-region>/);
  // (a space before a change: written as <text:s/> or plain, the same text in ODF)
  assert.match(xml, /The meeting is on(?: |<text:s\/>)<text:change text:change-id="ct1"\/><text:change-start text:change-id="ct2"\/>Tuesday<text:change-end text:change-id="ct2"\/>/);
  assert.match(xml, /<text:deletion>(?:(?!<\/text:deletion>).)*<text:p>(<text:span text:style-name="T\d+">)?<text:s\/>please(<\/text:span>)?<\/text:p>/, 'a space at the start of deleted words is kept (in a span turning off the bold before it)');
  assert.doesNotMatch(await (await JSZip.loadAsync(await odtFromDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plain' }] }] }, 'T'))).file('content.xml').async('string'), /tracked-changes/);
});

test('.odt in: what went out comes back as the same suggestions (a deletion and its insertion one replacement)', async () => {
  assert.deepEqual(show(await docFromOdt(await odtFromDoc(doc, 'T'))), want);
});

test('.odt in: LibreOffice\'s own: ids as it writes them, a deletion across paragraphs, a format change left out, spaces ordinary', async () => {
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"';
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text');
  const info = (who) => `<office:change-info><dc:creator>${who}</dc:creator><dc:date>2026-11-03T09:30:00</dc:date></office:change-info>`;
  zip.file('content.xml', `<office:document-content ${NS}><office:body><office:text><text:tracked-changes text:track-changes="true">
    <text:changed-region xml:id="ct9493" text:id="ct9493"><text:deletion>${info('Kim Park')}<text:p>old one</text:p><text:p>and two</text:p></text:deletion></text:changed-region>
    <text:changed-region xml:id="ct9494" text:id="ct9494"><text:format-change>${info('Kim Park')}</text:format-change></text:changed-region>
    <text:changed-region xml:id="ct9495" text:id="ct9495"><text:insertion>${info('Lee')}</text:insertion></text:changed-region>
  </text:tracked-changes><text:p>Keep<text:s/><text:change text:change-id="ct9493"/>this <text:change-start text:change-id="ct9494"/>styled<text:change-end text:change-id="ct9494"/> <text:change-start text:change-id="ct9495"/><text:span>new<text:s text:c="2"/>words</text:span><text:change-end text:change-id="ct9495"/>.</text:p></office:text></office:body></office:document-content>`);
  const back = await docFromOdt(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.deepEqual(show(back), ['Keep -[old one and two|Kim Park|2026-11-03T09:30|#1]this styled +[new  words|Lee|2026-11-03T09:30|#2].']);
  assert.ok(!JSON.stringify(back).includes(' '), 'LibreOffice\'s spaces (<text:s/>) are ordinary ones');
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('through LibreOffice: suggestions in our .odt saved again as .odt or .docx, and a Word file\'s saved as .odt, come back the same', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-odtsugg-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  try {
    fs.writeFileSync(path.join(dir, 'w.odt'), await odtFromDoc(doc, 'T'));
    fs.writeFileSync(path.join(dir, 'w.docx'), await wordFromDoc(doc, 'T'));
    assert.deepEqual(show(await docFromOdt(lo('w.odt', 'odt', 'a'))), want, '.odt saved again as .odt');
    assert.deepEqual(show(await docFromWord(lo('w.odt', 'docx', 'b'))), want, '.odt saved as .docx');
    assert.deepEqual(show(await docFromOdt(lo('w.docx', 'odt', 'c'))), want, '.docx saved as .odt');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
