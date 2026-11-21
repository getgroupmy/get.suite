// Docs list styles (1. a. A. i. I.; ● ○ ■ – ➢ ✓) in Word downloads and back, as Word and LibreOffice read them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { docFromWord, wordFromDoc, docFromHtml } from '../src/office/word.js';

const P = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const items = (xs, nested) => xs.map((x, i) => ({ type: 'listItem', content: [P(x), ...(nested && i === 0 ? [nested] : [])] }));
const OL = (listStyle, xs, nested, start = 1) => ({ type: 'orderedList', attrs: { start, ...(listStyle && { listStyle }) }, content: items(xs, nested) });
const UL = (bullet, xs) => ({ type: 'bulletList', attrs: { ...(bullet && { bullet }) }, content: items(xs) });
const doc = { type: 'doc', content: [
  OL('lower-roman', ['Intro', 'Body'], OL('lower-alpha', ['Point a', 'Point b'])), P('Then'),
  OL('upper-alpha', ['Alpha', 'Beta'], null, 3), P('And'),
  UL('dash', ['Dash one', 'Dash two']), UL('check', ['Done']), UL(null, ['Plain']), OL(null, ['Normal']),
] };
const show = (d) => (d.doc || d).content.filter((n) => /List$/.test(n.type)).map((n) => `${n.type === 'orderedList' ? `OL:${n.attrs?.listStyle || '1'}${(n.attrs?.start ?? 1) !== 1 ? `@${n.attrs.start}` : ''}` : `UL:${n.attrs?.bullet || '●'}`}[${n.content.map((li) => li.content.map((c) => (/List$/.test(c.type) ? `(${c.attrs?.listStyle || c.attrs?.bullet || '-'})` : c.content?.[0]?.text)).join('')).join(',')}]`).join(' ');
const want = 'OL:lower-roman[Intro(lower-alpha),Body] OL:upper-alpha@3[Alpha,Beta] UL:dash[Dash one,Dash two] UL:check[Done] UL:●[Plain] OL:1[Normal]';

test('HTML: the editor’s attributes read back (and an <ol type> from other programs)', () => {
  const d = docFromHtml('<ol type="I"><li><p>x</p></li></ol><ul data-bullet="square"><li><p>y</p></li></ul>');
  assert.deepEqual(d.content.map((n) => n.attrs.listStyle ?? n.attrs.bullet), ['upper-roman', 'square']);
});

test('Word: the styles are written as Word’s own numbering formats and bullets, and read back', async (t) => {
  const docx = await wordFromDoc(doc, 'Styles');
  const numbering = await (await JSZip.loadAsync(docx)).file('word/numbering.xml').async('string');
  for (const fmt of ['lowerRoman', 'lowerLetter', 'upperLetter', 'decimal']) assert.match(numbering, new RegExp(`<w:numFmt w:val="${fmt}"/>`));
  assert.match(numbering, /<w:lvlText w:val="–"\/>/);
  assert.match(numbering, /<w:lvlText w:val="✓"\/>/);
  assert.equal(show(await docFromWord(docx)), want);
  // LibreOffice: what it shows for the file, and its own Word file read back.
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { t.diagnostic('LibreOffice not installed: its part skipped'); return; }
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-ls-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as.split(':')[0]}`))); };
  try {
    fs.writeFileSync(path.join(dir, 'd.docx'), docx);
    const text = lo('d.docx', 'txt:Text', 't').toString('utf8').replace(/\s+/g, ' ');
    assert.match(text, /i\. Intro a\. Point a b\. Point b ii\. Body Then C\. Alpha D\. Beta And/, text); // (its text shows every bullet as -: they're checked through its Word file below)
    assert.equal(show(await docFromWord(lo('d.docx', 'docx', 'a'))), want, 'Word → LibreOffice → Word');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('OpenDocument (.odt): written as ODF list styles (number formats, bullet characters), read back; and LibreOffice’s', async (t) => {
  const { odtFromDoc, docFromOdt } = await import('../src/office/odt.js');
  const odt = await odtFromDoc(doc, 'Styles');
  const content = await (await JSZip.loadAsync(odt)).file('content.xml').async('string');
  assert.match(content, /<text:list-style style:name="LNum_lower-roman"><text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="i">/);
  assert.match(content, /<text:list-style style:name="LBul_check"><text:list-level-style-bullet text:level="1" text:bullet-char="✓">/);
  assert.equal(show(await docFromOdt(odt)), want);
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { t.diagnostic('LibreOffice not installed: its part skipped'); return; }
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-lso-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as.split(':')[0]}`))); };
  try {
    fs.writeFileSync(path.join(dir, 'd.odt'), odt);
    const text = lo('d.odt', 'txt:Text', 't').toString('utf8').replace(/\s+/g, ' ');
    assert.match(text, /i\. Intro a\. Point a b\. Point b ii\. Body Then C\. Alpha D\. Beta And/, text);
    assert.equal(show(await docFromOdt(lo('d.odt', 'odt', 'a'))), want, '.odt → LibreOffice → .odt');
    // (Not checked: a Word download saved as .odt by LibreOffice, which splits a list with a differently styled list
    // inside it into separate lists; the README says so.)
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
