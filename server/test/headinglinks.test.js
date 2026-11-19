// Links to a heading in the document (#costs) go out to a bookmark on it, which Word and LibreOffice follow, and come
// back as links to the heading, from our .docx and .odt, and as LibreOffice saves them again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { odtFromDoc, docFromOdt } from '../src/office/odt.js';
import { wordFromDoc, docFromWord } from '../src/office/word.js';
import { headingsOfDoc, linksToHeadings } from '../src/office/anchors.js';

const H = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const L = (text, href) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] });
const doc = { type: 'doc', content: [
  H(1, 'Report'),
  { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, L('the costs', '#costs'), { type: 'text', text: ', ' }, L('travel', '#travel-and-trains'), { type: 'text', text: ' and ' }, L('the other costs', '#costs-2'), { type: 'text', text: '.' }] },
  H(2, 'Costs'), H(3, 'Travel and trains'), H(2, 'Costs'), H(2, 'Not linked'),
] };
const links = (d) => (d.doc || d).content.flatMap((n) => (n.content || []).filter((t) => t.marks?.some((m) => m.type === 'link')).map((t) => [t.text, t.marks.find((m) => m.type === 'link').attrs.href]));
const want = links(doc);
const bookmarks = (d) => JSON.stringify(d.doc || d).match(/"type":"bookmark"/g)?.length || 0;

test('a document\'s headings and their anchors, as the editor makes them (a repeated title -2)', () => {
  assert.deepEqual(headingsOfDoc(doc).map((h) => [h.text, h.anchor]), [['Report', 'report'], ['Costs', 'costs'], ['Travel and trains', 'travel-and-trains'], ['Costs', 'costs-2'], ['Not linked', 'not-linked']]);
});

test('links to a bookmark that starts a heading become links to the heading, and such bookmarks go; other bookmarks stay', () => {
  const d = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'bookmark', attrs: { id: 'a1' } }, { type: 'text', text: 'Costs' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Mid ' }, { type: 'bookmark', attrs: { id: 'b2' } }, { type: 'text', text: 'here' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Late ' }, { type: 'bookmark', attrs: { id: 'c3' } }, { type: 'text', text: 'mark' }] },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'bookmark', attrs: { id: 'd4' } }, { type: 'text', text: 'Unlinked' }] },
    { type: 'paragraph', content: [L('one', '#bm-a1'), L('two', '#bm-b2'), L('three', '#bm-c3'), L('web', 'https://acme.example/#bm-a1')] },
  ] };
  linksToHeadings(d);
  assert.deepEqual(links(d), [['one', '#costs'], ['two', '#bm-b2'], ['three', '#bm-c3'], ['web', 'https://acme.example/#bm-a1']]);
  assert.deepEqual(d.content[0].content, [{ type: 'text', text: 'Costs' }], 'the heading\'s bookmark goes');
  assert.equal(bookmarks(d), 2, 'one in a paragraph, one in the middle of a heading');
});

test('.odt out: a heading that is linked to has a bookmark, and links go to it; the rest have none', async () => {
  const xml = await (await JSZip.loadAsync(await odtFromDoc(doc, 'T'))).file('content.xml').async('string');
  assert.deepEqual(xml.match(/<text:a [^>]*xlink:href="[^"]*"/g).map((a) => /href="([^"]*)"/.exec(a)[1]), ['#toc_2', '#toc_3', '#toc_4']);
  assert.match(xml, /<text:h [^>]*><text:bookmark text:name="toc_4"\/>Costs<\/text:h>/, 'the second Costs');
  assert.doesNotMatch(xml, /toc_1|toc_5/, 'Report and Not linked: no links, no bookmarks');
});

test('.docx and .odt in: links to headings come back as links to the headings, without bookmarks', async () => {
  for (const back of [await docFromWord(await wordFromDoc(doc, 'T')), await docFromOdt(await odtFromDoc(doc, 'T'))]) {
    assert.deepEqual(links(back), want);
    assert.equal(bookmarks(back), 0);
  }
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('through LibreOffice: links to headings in our .odt and .docx, saved again by it in either format, still go to the headings', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-hlinks-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  try {
    fs.writeFileSync(path.join(dir, 't.odt'), await odtFromDoc(doc, 'T'));
    fs.writeFileSync(path.join(dir, 't.docx'), await wordFromDoc(doc, 'T'));
    for (const [name, back] of [['.odt as .odt', await docFromOdt(lo('t.odt', 'odt', 'a'))], ['.odt as .docx', await docFromWord(lo('t.odt', 'docx', 'b'))], ['.docx as .odt', await docFromOdt(lo('t.docx', 'odt', 'c'))], ['.docx as .docx', await docFromWord(lo('t.docx', 'docx', 'e'))]]) {
      assert.deepEqual(links(back), want, name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
