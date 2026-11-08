import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import { inText, reference, referenceText, sourcesOf, cleanSource, authorsOf } from '../src/office/cite.js';
import { markdownFromDoc } from '../src/office/markdown.js';
import { wordFromDoc } from '../src/office/word.js';
import { docText } from '../src/search.js';

const smith = { author: 'Smith, J.', year: '2020', title: 'Working from home', publisher: 'Acme Press' };
const two = { author: 'Smith, J. & Lee, K.', year: '2021', title: 'Remote teams', url: 'https://example.org/remote' };
const many = { author: 'Ng, A.; Ortiz, B.; Park, C.', year: '2019', title: 'Offices' };
const org = { author: 'World Health Organization', year: '2022', title: 'Guidance' };

test('citations in the text, APA style', () => {
  assert.equal(inText(smith), '(Smith, 2020)');
  assert.equal(inText(two), '(Smith & Lee, 2021)');
  assert.equal(inText(many), '(Ng et al., 2019)');
  assert.equal(inText(org), '(World Health Organization, 2022)');
  assert.equal(inText({ author: 'Jane Smith', year: '' }), '(Smith, n.d.)');
  assert.equal(inText({ title: 'An unsigned report' }), '(“An unsigned report”, n.d.)');
  assert.deepEqual(authorsOf('Jane Smith and Kim Lee'), ['Jane Smith', 'Kim Lee']);
});

test('the references list: one entry per source, sorted by author, title in italics', () => {
  assert.equal(referenceText(smith), 'Smith, J. (2020). Working from home. Acme Press.');
  assert.equal(referenceText(two), 'Smith, J., & Lee, K. (2021). Remote teams. https://example.org/remote');
  assert.equal(referenceText(many), 'Ng, A., Ortiz, B., & Park, C. (2019). Offices.');
  assert.deepEqual(reference(smith).filter((p) => p.italic).map((p) => p.text), ['Working from home.']);
  assert.equal(cleanSource({ url: 'javascript:alert(1)' }).url, '', 'web addresses only');
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'citation', attrs: smith }, { type: 'citation', attrs: two }, { type: 'citation', attrs: { ...smith } }, { type: 'citation', attrs: many },
  ] }] };
  assert.deepEqual(sourcesOf(doc).map((s) => s.title), ['Offices', 'Working from home', 'Remote teams']);
});

const doc = { type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Hybrid work is common ' }, { type: 'citation', attrs: smith }, { type: 'text', text: '.' }] },
  { type: 'paragraph', content: [{ type: 'citation', attrs: two }] },
  { type: 'references' },
] };

test('Markdown and Word downloads: the citations and the references list; search finds the sources', async () => {
  const md = markdownFromDoc(doc);
  assert.match(md, /Hybrid work is common \(Smith, 2020\)\./);
  assert.match(md, /\*\*References\*\*\n\nSmith, J\. \(2020\)\. \*Working from home\.\* Acme Press\.\n\nSmith, J\., & Lee, K\. \(2021\)\. \*Remote teams\.\* https:\/\/example\.org\/remote/);
  const xml = await (await JSZip.loadAsync(await wordFromDoc(doc, 'Report'))).file('word/document.xml').async('string');
  assert.match(xml, /Hybrid work is common [\s\S]*\(Smith, 2020\)/);
  assert.match(xml, /References[\s\S]*w:hanging="720"[\s\S]*<w:i\/>[\s\S]*Working from home\./);
  assert.match(docText(doc), /Working from home/);
});

test('the browser and the server format citations the same way', () => {
  const server = fs.readFileSync(new URL('../src/office/cite.js', import.meta.url), 'utf8');
  const web = fs.readFileSync(new URL('../../web/src/apps/docs/cite.js', import.meta.url), 'utf8');
  assert.equal(web, server, 'web/src/apps/docs/cite.js must match server/src/office/cite.js');
});
