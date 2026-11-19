// A document's table of contents goes out as each format's own (LibreOffice's index in .odt, Word's Table of Contents
// block and TOC field in .docx) and comes back as Docs' contents block, also through LibreOffice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { odtFromDoc, docFromOdt } from '../src/office/odt.js';
import { wordFromDoc, docFromWord } from '../src/office/word.js';

const H = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const P = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = { type: 'doc', content: [H(1, 'Report'), { type: 'tableOfContents' }, H(2, 'Costs'), P('Money spent.'), H(3, 'Travel'), P('Trains.'), H(2, 'Plans'), P('Next year.')] };
const show = (d) => (d.doc || d).content.map((n) => (n.type === 'tableOfContents' ? 'contents' : `${n.type}${n.attrs?.level || ''} ${(n.content || []).map((c) => c.text || '').join('')}`));
const want = show(doc);

test('.odt out: LibreOffice\'s table of contents, its entries links to bookmarks on the headings', async () => {
  const zip = await JSZip.loadAsync(await odtFromDoc(doc, 'T'));
  const xml = await zip.file('content.xml').async('string');
  assert.match(xml, /<text:table-of-content text:protected="true" text:name="Table of Contents1"><text:table-of-content-source text:outline-level="6" text:use-index-marks="false"><text:index-title-template text:style-name="Contents_20_Heading">Contents<\/text:index-title-template>/);
  assert.match(xml, /<text:index-body><text:index-title [^>]*><text:p text:style-name="Contents_20_Heading">Contents<\/text:p><\/text:index-title><text:p text:style-name="Contents_20_1"><text:a [^>]*xlink:href="#toc_1"[^>]*>Report<\/text:a><\/text:p><text:p text:style-name="Contents_20_2"><text:a [^>]*xlink:href="#toc_2"[^>]*>Costs<\/text:a><\/text:p><text:p text:style-name="Contents_20_3"><text:a [^>]*xlink:href="#toc_3"[^>]*>Travel/);
  assert.match(xml, /<text:h text:style-name="Heading_20_3" text:outline-level="3"><text:bookmark text:name="toc_3"\/>Travel<\/text:h>/);
  assert.match(await zip.file('styles.xml').async('string'), /<style:style style:name="Contents_20_2" style:display-name="Contents 2"[^>]*><style:paragraph-properties fo:margin-left="0\.5cm"/);
  const plain = await (await JSZip.loadAsync(await odtFromDoc({ type: 'doc', content: [H(1, 'A'), P('b')] }, 'T'))).file('content.xml').async('string');
  assert.doesNotMatch(plain, /table-of-content|toc_1/, 'without a contents block: no bookmarks either');
});

test('.odt and .docx in: a table of contents is Docs\' contents block (other indexes stay their words)', async () => {
  assert.deepEqual(show(await docFromOdt(await odtFromDoc(doc, 'T'))), want);
  assert.deepEqual(show(await docFromWord(await wordFromDoc(doc, 'T'))), want);
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text');
  zip.file('content.xml', `<office:document-content ${NS}><office:body><office:text><text:alphabetical-index text:name="Index1"><text:index-body><text:p>apples, 3</text:p></text:index-body></text:alphabetical-index><text:p>End</text:p></office:text></office:body></office:document-content>`);
  assert.deepEqual(show(await docFromOdt(await zip.generateAsync({ type: 'nodebuffer' }))), ['paragraph apples, 3', 'paragraph End']);
});

test('.docx in: Word\'s table of contents as a bare TOC field (no Table of Contents block), with its heading', async () => {
  const zip = await JSZip.loadAsync(await wordFromDoc(doc, 'T'));
  const xml = await zip.file('word/document.xml').async('string');
  // As older Word files have it: the block's content without the block, and a field inside an entry (a page number).
  const bare = xml.replace(/<w:sdt><w:sdtPr>[\s\S]*?<\/w:sdtPr><w:sdtContent>([\s\S]*?)<\/w:sdtContent><\/w:sdt>/, '$1')
    .replace('<w:t xml:space="preserve">Costs</w:t>', '<w:t xml:space="preserve">Costs</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGEREF toc_2 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/>');
  assert.notEqual(bare, xml);
  assert.doesNotMatch(bare, /<w:sdt>/);
  zip.file('word/document.xml', bare);
  assert.deepEqual(show(await docFromWord(await zip.generateAsync({ type: 'nodebuffer' }))), want);
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('through LibreOffice: the table of contents in our .odt and .docx, saved again by it in either format, comes back', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-doctoc-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  try {
    fs.writeFileSync(path.join(dir, 't.odt'), await odtFromDoc(doc, 'T'));
    fs.writeFileSync(path.join(dir, 't.docx'), await wordFromDoc(doc, 'T'));
    assert.deepEqual(show(await docFromOdt(lo('t.odt', 'odt', 'a'))), want, '.odt saved again as .odt');
    assert.deepEqual(show(await docFromWord(lo('t.odt', 'docx', 'b'))), want, '.odt saved as .docx');
    assert.deepEqual(show(await docFromOdt(lo('t.docx', 'odt', 'c'))), want, '.docx saved as .odt');
    assert.deepEqual(show(await docFromWord(lo('t.docx', 'docx', 'e'))), want, '.docx saved again as .docx');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
