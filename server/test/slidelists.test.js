// Slides: a text box as a list (bullets or numbers in a style), in PowerPoint files and back, as LibreOffice shows them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { powerPointFromDeck, deckFromPowerPoint } from '../src/office/powerpoint.js';

const T = (id, text, list, y) => ({ id, type: 'text', role: 'body', text, x: 10, y, w: 80, h: 25, size: 24, ...(list && { list }) });
const deck = { slides: [{ id: 's1', items: [T('a', 'Welcome\nBudget\nNext steps', 'lower-roman', 5), T('b', 'Minutes sent\nRoom booked', 'check', 35), T('c', 'Milk\nEggs', 'disc', 65), T('d', 'Just words', null, 90)] }] };
const lists = (d) => d.slides[0].items.filter((it) => it.type === 'text').map((it) => `${it.list || '-'}:${it.text.split('\n').length}`).join(' ');

test('PowerPoint: each paragraph with its bullet or number, read back as the box’s list', async (t) => {
  const pptx = await powerPointFromDeck(deck, 'Lists');
  const xml = await (await JSZip.loadAsync(pptx)).file('ppt/slides/slide1.xml').async('string');
  assert.equal((xml.match(/<a:buAutoNum type="romanLcPeriod"/g) || []).length, 3, 'every paragraph numbered');
  assert.match(xml, /<a:buChar char="(✓|&#x2713;)"\/>/);
  assert.match(xml, /<a:buChar char="(●|&#x25CF;)"\/>/);
  const back = await deckFromPowerPoint(pptx, { savePicture: async () => null });
  assert.equal(lists(back.deck || back), 'lower-roman:3 check:2 disc:2 -:1');
  // LibreOffice: as a PDF, the numbers and bullets it draws.
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); } catch { t.diagnostic('LibreOffice or pdftotext not installed: skipped'); return; }
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-sl-'));
  try {
    fs.writeFileSync(path.join(dir, 'd.pptx'), pptx);
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'pdf', '--outdir', path.join(dir, 'o'), path.join(dir, 'd.pptx')], { stdio: 'ignore', timeout: 120000 });
    const text = execFileSync('pdftotext', [path.join(dir, 'o', 'd.pdf'), '-']).toString().replace(/\s+/g, ' ');
    assert.match(text, /i\. Welcome ii\. Budget iii\. Next steps/, text);
    assert.match(text, /✓ Minutes sent ✓ Room booked/, text);
    // …and LibreOffice's own PowerPoint file read back.
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'pptx', '--outdir', path.join(dir, 'p'), path.join(dir, 'd.pptx')], { stdio: 'ignore', timeout: 120000 });
    const again = await deckFromPowerPoint(fs.readFileSync(path.join(dir, 'p', 'd.pptx')), { savePicture: async () => null });
    assert.equal(lists(again.deck || again), 'lower-roman:3 check:2 disc:2 -:1', 'PowerPoint → LibreOffice → PowerPoint');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PDF: each line with its number or bullet', async (t) => {
  const { pdfFromDeck } = await import('../src/office/slidepdf.js');
  const pdf = await pdfFromDeck(deck, 'Lists');
  const { execFileSync } = await import('node:child_process');
  let text;
  try { text = execFileSync('pdftotext', ['-', '-'], { input: Buffer.from(pdf) }).toString().replace(/\s+/g, ' '); } catch { t.diagnostic('pdftotext not installed: skipped'); return; }
  assert.match(text, /i\. Welcome ii\. Budget iii\. Next steps ✓ Minutes sent ✓ Room booked ● Milk ● Eggs Just words/, text);
});

test('OpenDocument (.odp): a list style per box, empty lines unnumbered; read back, and as LibreOffice shows and saves it', async (t) => {
  const { odpFromDeck, deckFromOdp } = await import('../src/office/odp.js');
  const withGap = { slides: [{ id: 's1', items: [T('a', 'Welcome\n\nBudget', 'lower-roman', 5), T('b', 'Minutes sent', 'check', 35), T('c', 'Milk\nEggs', 'disc', 65), T('d', 'Just words', null, 90)] }] };
  const odp = await odpFromDeck(withGap, { title: 'Lists' });
  const content = await (await JSZip.loadAsync(odp)).file('content.xml').async('string');
  assert.match(content, /<text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="i">/);
  assert.match(content, /<text:list-level-style-bullet text:level="1" text:bullet-char="✓">/);
  assert.match(content, /<\/text:list-item><text:list-header>/, 'the empty line: a header, without a number');
  const back = await deckFromOdp(odp, { savePicture: async () => null });
  assert.equal(lists(back.deck || back), 'lower-roman:3 check:1 disc:2 -:1');
  assert.equal((back.deck || back).slides[0].items[0].text, 'Welcome\n\nBudget');
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); } catch { t.diagnostic('LibreOffice or pdftotext not installed: skipped'); return; }
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-slo-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  try {
    fs.writeFileSync(path.join(dir, 'd.odp'), odp);
    lo('d.odp', 'pdf', 'pdf');
    const text = execFileSync('pdftotext', [path.join(dir, 'pdf', 'd.pdf'), '-']).toString().replace(/\s+/g, ' ');
    assert.match(text, /i\. Welcome ii\. Budget/, `the empty line not counted: ${text}`);
    assert.match(text, /✓ Minutes sent/, text);
    assert.equal(lists(await deckFromOdp(lo('d.odp', 'odp', 'a'), { savePicture: async () => null }).then((d) => d.deck || d)), 'lower-roman:3 check:1 disc:2 -:1', '.odp → LibreOffice → .odp');
    // Our PowerPoint file, saved by LibreOffice as .odp.
    fs.writeFileSync(path.join(dir, 'p.pptx'), await powerPointFromDeck(deck, 'Lists'));
    assert.equal(lists(await deckFromOdp(lo('p.pptx', 'odp', 'b'), { savePicture: async () => null }).then((d) => d.deck || d)), 'lower-roman:3 check:2 disc:2 -:1', 'PowerPoint saved as .odp by LibreOffice');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('levels (a tab at a line’s start: a point under the one above): PowerPoint’s lvl, nested .odp lists, the PDF; as LibreOffice shows them', async (t) => {
  const { odpFromDeck, deckFromOdp } = await import('../src/office/odp.js');
  const { pdfFromDeck } = await import('../src/office/slidepdf.js');
  const text = 'Plan\n\tCosts\n\tPeople\nDo\n\tOne';
  const d = { slides: [{ id: 's1', items: [T('a', text, 'lower-roman', 5), T('b', 'Done\n\tMinutes', 'check', 50)] }] };
  const pptx = await powerPointFromDeck(d, 'Levels');
  const xml = await (await JSZip.loadAsync(pptx)).file('ppt/slides/slide1.xml').async('string');
  assert.equal((xml.match(/<a:pPr[^>]*lvl="1"/g) || []).length, 4, 'four points a level in');
  const fromPptx = await deckFromPowerPoint(pptx, { savePicture: async () => null });
  assert.deepEqual((fromPptx.deck || fromPptx).slides[0].items.map((it) => [it.list, it.text]), [['lower-roman', text], ['check', 'Done\n\tMinutes']]);
  const odp = await odpFromDeck(d, { title: 'Levels' });
  const content = await (await JSZip.loadAsync(odp)).file('content.xml').async('string');
  assert.match(content, /<text:list-item><text:p[^>]*>.*?Plan.*?<\/text:p><text:list><text:list-item>/);
  const fromOdp = await deckFromOdp(odp, { savePicture: async () => null });
  assert.deepEqual((fromOdp.deck || fromOdp).slides[0].items.map((it) => [it.list, it.text]), [['lower-roman', text], ['check', 'Done\n\tMinutes']]);
  const { execFileSync } = await import('node:child_process');
  let pdfText;
  try { pdfText = execFileSync('pdftotext', ['-', '-'], { input: Buffer.from(await pdfFromDeck(d, 'Levels')) }).toString().replace(/\s+/g, ' '); } catch { t.diagnostic('pdftotext not installed: skipped'); return; }
  assert.match(pdfText, /i\. Plan i\. Costs ii\. People ii\. Do i\. One ✓ Done – Minutes/, pdfText);
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { t.diagnostic('LibreOffice not installed: its part skipped'); return; }
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-slv-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  try {
    fs.writeFileSync(path.join(dir, 'd.pptx'), pptx); fs.writeFileSync(path.join(dir, 'e.odp'), odp);
    for (const f of ['d.pptx', 'e.odp']) {
      lo(f, 'pdf', 'pdf');
      // (as laid out: each marker on the line of its words, further in for points under others)
      const shown = execFileSync('pdftotext', ['-layout', path.join(dir, 'pdf', f.replace(/\.\w+$/, '.pdf')), '-']).toString();
      const at = (re) => { const m = shown.split('\n').find((l) => re.test(l)); assert.ok(m, `${f}: ${re} in\n${shown}`); return m.search(/\S/); };
      const top = at(/^\s*i\.\s+Plan\s*$/), sub = at(/^\s*i\.\s+Costs\s*$/);
      at(/^\s*ii\.\s+People\s*$/); at(/^\s*ii\.\s+Do\s*$/); at(/^\s*i\.\s+One\s*$/);
      assert.ok(sub > top, `${f}: Costs further in than Plan`);
    }
    const back = await deckFromPowerPoint(lo('d.pptx', 'pptx', 'a'), { savePicture: async () => null });
    assert.equal((back.deck || back).slides[0].items.find((it) => it.list === 'lower-roman')?.text, text, 'PowerPoint → LibreOffice → PowerPoint');
    const backOdp = await deckFromOdp(lo('e.odp', 'odp', 'b'), { savePicture: async () => null });
    assert.equal((backOdp.deck || backOdp).slides[0].items.find((it) => it.list === 'lower-roman')?.text, text, '.odp → LibreOffice → .odp');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
