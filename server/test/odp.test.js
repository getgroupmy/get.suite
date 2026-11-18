import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
const { odpFromDeck, deckFromOdp, ODP_MIME } = await import('../src/office/odp.js');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const noIds = (d) => JSON.parse(JSON.stringify(d, (k, v) => (k === 'id' ? undefined : v)));

const deck = { theme: 'dark', slides: [
  { id: 'a', notes: 'Say hello\nThen pause', items: [
    { id: 't1', type: 'text', x: 10, y: 10, w: 80, h: 20, text: 'Quarterly review\nQ3 2026', size: 50, bold: true, align: 'center', color: 'accent' },
    { id: 't2', type: 'text', x: 10, y: 40, w: 40, h: 10, text: 'See the site', size: 20, italic: true, link: { url: 'https://acme.example' }, fill: '#333333', outline: '#ff0000', outlineW: 2 },
    { id: 's1', type: 'shape', shape: 'star', x: 60, y: 40, w: 20, h: 30, fill: '#ffd666', text: 'Win', rot: 30 },
    { id: 's2', type: 'shape', shape: 'arrow', dir: 'h', x: 10, y: 80, w: 30, h: 4, fill: '#ffffff' },
    { id: 's3', type: 'shape', shape: 'ellipse', x: 70, y: 75, w: 10, h: 15, fill: 'accent', link: { slide: 'b' } },
    { id: 'i1', type: 'image', fileId: 'p1', x: 50, y: 75, w: 10, h: 15, alt: 'A dot' },
  ] },
  { id: 'b', skip: true, bg: '#112233', items: [
    { id: 'tb', type: 'table', x: 5, y: 5, w: 60, h: 30, header: true, cells: [['Item', 'Qty'], ['Pens', '4']] },
    { id: 'c1', type: 'chart', x: 5, y: 50, w: 60, h: 45, title: 'Sales', chartType: 'column', data: { categories: ['Jan', 'Feb'], series: [{ name: 'EU', values: [3, 5] }] } },
    { id: 'v1', type: 'video', x: 70, y: 5, w: 25, h: 20, name: 'Demo.mp4', fileId: 'v' },
  ] },
] };

test('.odp out: slides LibreOffice opens, with notes, a hidden slide, turned shapes, links and pictures', async () => {
  const buf = await odpFromDeck(deck, { title: 'Review', pictureData: async (id) => (id === 'p1' ? { data: PNG, mime: 'image/png' } : null) });
  const zip = await JSZip.loadAsync(buf);
  assert.equal(Object.keys(zip.files)[0], 'mimetype');
  assert.equal(await zip.file('mimetype').async('string'), ODP_MIME);
  const xml = await zip.file('content.xml').async('string');
  assert.equal((xml.match(/<draw:page /g) || []).length, 2);
  assert.match(xml, /<text:span text:style-name="t\d+">Quarterly review<\/text:span><\/text:p><text:p[^>]*><text:span[^>]*>Q3 2026/);
  assert.match(xml, /<text:span text:style-name="t\d+"><text:a xlink:type="simple" xlink:href="https:\/\/acme\.example">See the site<\/text:a><\/text:span>/, 'the link inside the span, or Impress hides the text');
  assert.match(xml, /fo:font-size="39\.7pt"[^>]*fo:font-weight="bold"[^>]*fo:color="#8ab4f8"/, 'the accent of the dark theme; 50 on a 28 cm slide is 39.7pt');
  assert.match(xml, /<draw:custom-shape [^>]*draw:transform="rotate\(-0\.523599\) translate\([\d.]+cm [\d.]+cm\)"><text:p[^>]*><text:span[^>]*>Win<\/text:span><\/text:p><draw:enhanced-geometry draw:type="star5"\/>/);
  assert.match(xml, /<draw:line [^>]*svg:x1="2\.800cm" svg:y1="12\.915cm" svg:x2="11\.200cm" svg:y2="12\.915cm">/);
  assert.match(xml, /draw:marker-end="Arrow"/);
  assert.match(xml, /<draw:a xlink:type="simple" xlink:href="#page2"><draw:custom-shape[^>]*>(?:(?!<\/draw:custom-shape>).)*draw:type="ellipse"/);
  assert.match(xml, /<draw:image xlink:href="Pictures\/1\.png"[^>]*\/><svg:title>A dot<\/svg:title>/);
  assert.match(xml, /presentation:visibility="hidden"/);
  assert.match(xml, /draw:fill-color="#112233"/);
  assert.match(xml, /<presentation:notes>.*presentation:class="notes".*<text:p>Say hello<\/text:p><text:p>Then pause<\/text:p>/);
  assert.match(xml, /<table:table table:use-first-row-styles="true">/);
  assert.match(xml, /<draw:frame [^>]*><draw:object xlink:href="\.\/Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"\/><\/draw:frame>/, 'a chart as a chart object');
  const obj = await zip.file('Object 1/content.xml').async('string');
  assert.match(obj, /<chart:chart chart:class="chart:bar"[^>]*><chart:title><text:p>Sales<\/text:p><\/chart:title>/);
  assert.match(obj, /<table:table table:name="local-table">[\s\S]*>EU<[\s\S]*>Jan<[\s\S]*office:value="3"[\s\S]*>Feb<[\s\S]*office:value="5"/, 'its figures in its own table');
  assert.match(await zip.file('META-INF/manifest.xml').async('string'), /full-path="Object 1\/" manifest:version="1.3" manifest:media-type="application\/vnd\.oasis\.opendocument\.chart"/);
  assert.match(xml, /▶ Demo\.mp4/);
  assert.match(await zip.file('styles.xml').async('string'), /fo:page-width="28cm" fo:page-height="15\.75cm"/);
  assert.match(await zip.file('meta.xml').async('string'), /<dc:title>Review<\/dc:title>/);
});

test('.odp in: what went out comes back (pictures saved as files, links to slides kept)', async () => {
  const buf = await odpFromDeck(deck, { pictureData: async () => ({ data: PNG, mime: 'image/png' }) });
  const back = await deckFromOdp(buf, { savePicture: async (name, data, mime) => { assert.deepEqual([name, mime], ['Picture 1.png', 'image/png']); return 'newpic'; } });
  const [a, b] = back.slides;
  assert.equal(a.notes, 'Say hello\nThen pause');
  assert.equal(a.bg, '#202124');
  assert.equal(b.skip, true);
  assert.equal(b.bg, '#112233');
  const [t1, t2, s1, s2, s3, i1] = noIds(a.items);
  assert.deepEqual(t1, { type: 'text', x: 10, y: 10, w: 80, h: 20, text: 'Quarterly review\nQ3 2026', size: 50, bold: true, color: '#8ab4f8', align: 'center' });
  assert.deepEqual(t2, { type: 'text', x: 10, y: 40, w: 40, h: 10, text: 'See the site', size: 20, italic: true, color: '#f1f3f4', fill: '#333333', outline: '#ff0000', outlineW: 2, link: { url: 'https://acme.example' } });
  assert.deepEqual([s1.shape, s1.x, s1.y, s1.w, s1.h, s1.rot, s1.text, s1.fill], ['star', 60, 40, 20, 30, 30, 'Win', '#ffd666'], 'turned 30°, in the same place');
  assert.deepEqual([s2.shape, s2.dir, s2.x, s2.w, s2.fill], ['arrow', 'h', 10, 30, '#ffffff']);
  assert.deepEqual([s3.shape, s3.link], ['ellipse', { slide: b.id }]);
  assert.deepEqual([i1.type, i1.fileId, i1.alt], ['image', 'newpic', 'A dot']);
  const tb = b.items.find((x) => x.type === 'table');
  assert.deepEqual([tb.cells, tb.header], [[['Item', 'Qty'], ['Pens', '4']], true]);
  await assert.rejects(deckFromOdp(await new JSZip().file('a', 'b').generateAsync({ type: 'nodebuffer' })), /Not an OpenDocument presentation/);
});

test('.odp in: what Impress writes (a picture of a table beside it, notes marked as a placeholder, an empty placeholder)', async () => {
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"';
  const zip = new JSZip();
  zip.file('mimetype', ODP_MIME);
  zip.file('styles.xml', `<office:document-styles ${NS}><office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="25.4cm" fo:page-height="14.288cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>`);
  zip.file('content.xml', `<office:document-content ${NS}><office:automatic-styles><style:style style:name="T1" style:family="text"><style:text-properties fo:font-size="44pt"/></style:style></office:automatic-styles><office:body><office:presentation><draw:page draw:name="One">
    <draw:frame presentation:class="title" presentation:placeholder="true" svg:x="1cm" svg:y="1cm" svg:width="10cm" svg:height="2cm"><draw:text-box/></draw:frame>
    <draw:frame presentation:class="subtitle" svg:x="2.54cm" svg:y="7.144cm" svg:width="12.7cm" svg:height="2cm"><draw:text-box><text:p><text:span text:style-name="T1">Hello<text:s text:c="2"/>there</text:span></text:p></draw:text-box></draw:frame>
    <draw:frame svg:x="0cm" svg:y="0cm" svg:width="12.7cm" svg:height="7.144cm"><table:table><table:table-row><table:table-cell><text:p>A</text:p></table:table-cell></table:table-row></table:table><draw:image xlink:href="Pictures/x.svm"/></draw:frame>
    <presentation:notes><draw:page-thumbnail/><draw:frame presentation:class="notes" presentation:placeholder="true"><draw:text-box><text:p>Remember the date</text:p></draw:text-box></draw:frame></presentation:notes>
  </draw:page></office:presentation></office:body></office:document-content>`);
  const [s] = (await deckFromOdp(await zip.generateAsync({ type: 'nodebuffer' }))).slides;
  assert.deepEqual(noIds(s.items), [
    { type: 'text', x: 10, y: 50, w: 50, h: 14, text: 'Hello  there', size: 61 }, // 44pt on a 25.4 cm slide (61.1, a hair off a whole size)
    { type: 'table', x: 0, y: 0, w: 50, h: 50, cells: [['A']], size: 25 },
  ]);
  assert.equal(s.notes, 'Remember the date');
});

test('.odp: animations (entrances and exits) go out as Impress keeps them and come back, also through LibreOffice', async (t) => {
  const { odpAnimationsOf } = await import('../src/office/odp.js');
  const animDeck = { theme: 'light', slides: [{ id: 's1', items: [
    { id: 't', type: 'text', x: 5, y: 5, w: 60, h: 10, text: 'Title' },
    { id: 'a', type: 'text', x: 5, y: 20, w: 60, h: 10, text: 'Comes in', anim: 'appear', animAt: 2 },
    { id: 'b', type: 'text', x: 5, y: 35, w: 60, h: 10, text: 'Fades in', anim: 'fade', animAt: 1 },
    { id: 'c', type: 'text', x: 5, y: 50, w: 60, h: 10, text: 'Flies', anim: 'fly', animAt: 3, link: { url: 'https://example.com' } },
    { id: 'd', type: 'shape', shape: 'ellipse', fill: '#00ff00', x: 50, y: 50, w: 20, h: 20, anim: 'disappear', animAt: 4 },
    { id: 'e', type: 'text', x: 5, y: 65, w: 60, h: 10, text: 'Fades away', anim: 'fadeout', animAt: 5 },
  ] }, { id: 's2', items: [{ id: 'x', type: 'text', x: 5, y: 5, w: 60, h: 10, text: 'Still' }] }] };
  const order = (d) => d.slides[0].items.filter((it) => it.anim).sort((p, q) => p.animAt - q.animAt).map((it) => [it.text || it.shape, it.anim, it.animAt]);
  const want = [['Fades in', 'fade', 1], ['Comes in', 'appear', 2], ['Flies', 'fly', 3], ['ellipse', 'disappear', 4], ['Fades away', 'fadeout', 5]];
  const buf = await odpFromDeck(animDeck);
  const xml = await (await JSZip.loadAsync(buf)).file('content.xml').async('string');
  assert.equal((xml.match(/presentation:node-type="timing-root"/g) || []).length, 1, 'only the slide with animations has a timing');
  assert.match(xml, /presentation:preset-class="exit" presentation:preset-id="ooo-exit-fade-out"/);
  const back = await deckFromOdp(buf);
  assert.deepEqual(order(back), want);
  assert.equal(back.slides[0].items.find((it) => it.text === 'Title').anim, undefined);
  // Effects Slides doesn't have: entrances fade in, exits fade out.
  const tags = (n, name) => (n.children || []).filter((k) => k.type === 'tag' && (!name || k.name === name));
  const el = (name, attribs, children = []) => ({ type: 'tag', name, attribs, children });
  const timing = el('anim:par', {}, [el('anim:par', { 'presentation:preset-class': 'entrance', 'presentation:preset-id': 'ooo-entrance-spiral-in' }, [el('anim:set', { 'smil:targetElement': 'id7' })]), el('anim:par', { 'presentation:preset-class': 'exit', 'presentation:preset-id': 'ooo-exit-dissolve' }, [el('anim:set', { 'smil:targetElement': 'id8' })])]);
  assert.deepEqual(odpAnimationsOf(timing, tags), [{ target: 'id7', anim: 'fade' }, { target: 'id8', anim: 'fadeout' }]);
  // Through LibreOffice: saved again as .odp, and as .pptx.
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { t.diagnostic('LibreOffice not installed: its part skipped'); return; }
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odpanim-'));
  fs.writeFileSync(path.join(dir, 'a.odp'), buf);
  const lo = (as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, 'a.odp')], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, `a.${as}`)); };
  assert.deepEqual(order(await deckFromOdp(lo('odp', 'o'))), want);
  const { deckFromPowerPoint } = await import('../src/office/powerpoint.js');
  assert.deepEqual(order(await deckFromPowerPoint(lo('pptx', 'p'), { savePicture: async () => null })), want);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('animations that start with or after the previous one: .odp and .pptx both ways, also through LibreOffice', async (t) => {
  const { powerPointFromDeck, deckFromPowerPoint } = await import('../src/office/powerpoint.js');
  const d = { theme: 'light', slides: [{ id: 's1', items: [
    { id: 'a', type: 'text', x: 5, y: 20, w: 60, h: 10, text: 'One', anim: 'appear', animAt: 1 },
    { id: 'b', type: 'text', x: 5, y: 35, w: 60, h: 10, text: 'Two', anim: 'fade', animAt: 2, animStart: 'with' },
    { id: 'c', type: 'text', x: 5, y: 50, w: 60, h: 10, text: 'Three', anim: 'fly', animAt: 3, animStart: 'after' },
    { id: 'e', type: 'shape', shape: 'star', fill: '#ffd666', x: 70, y: 50, w: 20, h: 20, anim: 'fadeout', animAt: 4, animStart: 'with' },
    { id: 'f', type: 'text', x: 5, y: 65, w: 60, h: 10, text: 'Four', anim: 'fade', animAt: 5 },
  ] }] };
  const order = (deck) => deck.slides[0].items.filter((it) => it.anim).sort((p, q) => p.animAt - q.animAt).map((it) => `${it.text || it.shape}:${it.anim}:${it.animStart || 'click'}`);
  const want = ['One:appear:click', 'Two:fade:with', 'Three:fly:after', 'star:fadeout:with', 'Four:fade:click'];
  const odp = await odpFromDeck(d);
  const xml = await (await JSZip.loadAsync(odp)).file('content.xml').async('string');
  assert.equal((xml.match(/smil:begin="next"/g) || []).length, 2, 'two clicks');
  assert.match(xml, /<anim:par smil:begin="0.5s" smil:fill="hold"><anim:par smil:begin="0s" smil:fill="hold" presentation:node-type="after-previous"/);
  assert.deepEqual(order(await deckFromOdp(odp)), want);
  const pptx = await powerPointFromDeck(d);
  const sx = await (await JSZip.loadAsync(pptx)).file('ppt/slides/slide1.xml').async('string');
  assert.deepEqual([...sx.matchAll(/nodeType="(\w+Effect)"/g)].map((m) => m[1]), ['clickEffect', 'withEffect', 'afterEffect', 'withEffect', 'clickEffect']);
  assert.match(sx, /<p:cond delay="500"\/>/);
  const fromPpt = (b) => deckFromPowerPoint(b, { savePicture: async () => null });
  assert.deepEqual(order(await fromPpt(pptx)), want);
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { t.diagnostic('LibreOffice not installed: its part skipped'); return; }
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animstart-'));
  fs.writeFileSync(path.join(dir, 'a.odp'), odp);
  fs.writeFileSync(path.join(dir, 'b.pptx'), pptx);
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  assert.deepEqual(order(await deckFromOdp(lo('a.odp', 'odp', 'o'))), want, '.odp saved again');
  assert.deepEqual(order(await fromPpt(lo('a.odp', 'pptx', 'p'))), want, '.odp saved as .pptx');
  assert.deepEqual(order(await deckFromOdp(lo('b.pptx', 'odp', 'q'))), want, '.pptx saved as .odp');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a text box coming in a paragraph at a time: .odp and .pptx both ways, also through LibreOffice', async (t) => {
  const { powerPointFromDeck, deckFromPowerPoint } = await import('../src/office/powerpoint.js');
  const d = { theme: 'light', slides: [{ id: 's1', items: [
    { id: 'a', type: 'text', x: 5, y: 20, w: 60, h: 30, text: 'One\n\nTwo\nThree', anim: 'fade', animAt: 1, animBy: 'para' },
    { id: 'b', type: 'text', x: 5, y: 60, w: 60, h: 10, text: 'After', anim: 'fly', animAt: 2 },
    { id: 'c', type: 'text', x: 5, y: 75, w: 60, h: 10, text: 'Only one line', anim: 'fade', animAt: 3, animBy: 'para' },
  ] }] };
  const order = (deck) => deck.slides[0].items.filter((it) => it.anim).sort((p, q) => p.animAt - q.animAt).map((it) => `${it.text.split('\n')[0]}:${it.anim}:${it.animBy || 'whole'}`);
  const want = ['One:fade:para', 'After:fly:whole', 'Only one line:fade:whole'];
  const odp = await odpFromDeck(d);
  const xml = await (await JSZip.loadAsync(odp)).file('content.xml').async('string');
  assert.equal((xml.match(/smil:begin="next"/g) || []).length, 5, 'three lines, then two boxes: five clicks');
  assert.match(xml, /<text:p xml:id="anim1p3" text:id="anim1p3"/, 'the ids are on the paragraphs (the blank one has none)');
  assert.equal(/anim1p1"/.test(xml), false);
  assert.deepEqual(order(await deckFromOdp(odp)), want);
  const pptx = await powerPointFromDeck(d);
  const sx = await (await JSZip.loadAsync(pptx)).file('ppt/slides/slide1.xml').async('string');
  assert.deepEqual([...sx.matchAll(/<p:pRg st="(\d+)"/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i), ['0', '2', '3']);
  assert.match(sx, /<p:bldP spid="\d+" grpId="0" build="p"\/>/);
  const fromPpt = (b) => deckFromPowerPoint(b, { savePicture: async () => null });
  assert.deepEqual(order(await fromPpt(pptx)), want);
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { t.diagnostic('LibreOffice not installed: its part skipped'); return; }
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bypara-'));
  fs.writeFileSync(path.join(dir, 'a.odp'), odp);
  fs.writeFileSync(path.join(dir, 'b.pptx'), pptx);
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  assert.deepEqual(order(await deckFromOdp(lo('a.odp', 'odp', 'o'))), want, '.odp saved again');
  assert.deepEqual(order(await fromPpt(lo('a.odp', 'pptx', 'p'))), want, '.odp saved as .pptx');
  assert.deepEqual(order(await deckFromOdp(lo('b.pptx', 'odp', 'q'))), want, '.pptx saved as .odp');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('.odp: comment threads on slides go out as Impress keeps them and come back with their replies, also through LibreOffice', async (t) => {
  const { commentsOfOdpDeck } = await import('../src/office/odp.js');
  const d = { theme: 'light', slides: [{ id: 's1', items: [{ id: 't', type: 'text', x: 5, y: 5, w: 60, h: 10, text: 'Hello' }] }, { id: 's2', items: [] }] };
  const comments = [
    { id: 'c1', slideId: 's1', author: 'Olivia Owner', at: Date.parse('2026-11-01T10:00:00Z'), text: 'Shorter title?', replies: [{ author: 'Kim Park', at: Date.parse('2026-11-02T10:00:00Z'), text: 'Done' }] },
    { id: 'c3', slideId: 's1', author: 'Lee Wu', at: Date.parse('2026-11-01T11:00:00Z'), text: 'Another <one> & more', replies: [] },
    { id: 'c2', slideId: 's2', author: 'Kim Park', at: Date.parse('2026-11-03T10:00:00Z'), text: 'Two\nlines', replies: [] },
    { id: 'gone', slideId: 'nope', author: 'X', text: 'On a slide no longer there', replies: [] },
  ];
  const show = (deck) => commentsOfOdpDeck(deck).map((c) => [deck.slides.findIndex((s) => s.id === c.slideId), c.author, c.text, c.at, c.replies.map((r) => [r.author, r.text, r.at])]);
  const want = [
    [0, 'Olivia Owner', 'Shorter title?', Date.parse('2026-11-01T10:00:00Z'), [['Kim Park', 'Done', Date.parse('2026-11-02T10:00:00Z')]]],
    [0, 'Lee Wu', 'Another <one> & more', Date.parse('2026-11-01T11:00:00Z'), []],
    [1, 'Kim Park', 'Two\nlines', Date.parse('2026-11-03T10:00:00Z'), []],
  ];
  const buf = await odpFromDeck(d, { comments });
  const xml = await (await JSZip.loadAsync(buf)).file('content.xml').async('string');
  assert.equal((xml.match(/<officeooo:annotation /g) || []).length, 4);
  assert.deepEqual(show(await deckFromOdp(buf)), want);
  assert.deepEqual(commentsOfOdpDeck(await deckFromOdp(await odpFromDeck(d))), [], 'none: none');
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { t.diagnostic('LibreOffice not installed: its part skipped'); return; }
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odpcomments-'));
  fs.writeFileSync(path.join(dir, 'a.odp'), buf);
  execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'odp', '--outdir', path.join(dir, 'o'), path.join(dir, 'a.odp')], { stdio: 'ignore', timeout: 120000 });
  assert.deepEqual(show(await deckFromOdp(fs.readFileSync(path.join(dir, 'o', 'a.odp')))), want, 'saved again by LibreOffice');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('.odp: grouped boxes go out in one <draw:g> and come back grouped; a group of one is just a box', async () => {
  const grouped = { theme: 'light', slides: [{ id: 'a', items: [
    { id: 'a1', type: 'shape', shape: 'ellipse', x: 10, y: 10, w: 10, h: 10, fill: 'accent', group: 'g' },
    { id: 'mid', type: 'text', x: 50, y: 50, w: 20, h: 10, text: 'Between' },
    { id: 'a2', type: 'text', x: 22, y: 12, w: 20, h: 8, text: 'Acme', group: 'g' },
    { id: 'solo', type: 'text', x: 50, y: 80, w: 20, h: 10, text: 'Solo', group: 'h' },
  ] }] };
  const buf = await odpFromDeck(grouped, { pictureData: async () => null });
  const content = await (await JSZip.loadAsync(buf)).file('content.xml').async('string');
  const g = /<draw:g>([\s\S]*?)<\/draw:g>/.exec(content);
  assert.ok(g, 'a group');
  assert.equal((content.match(/<draw:g>/g) || []).length, 1);
  assert.match(g[1], /draw:custom-shape[\s\S]*Acme/);
  assert.ok(!g[1].includes('Between') && !g[1].includes('Solo'));
  assert.ok(content.indexOf('<draw:g>') < content.indexOf('Between'), 'where its first box was');
  const back = await deckFromOdp(buf, { savePicture: async () => 'x' });
  const its = back.slides[0].items;
  const inG = its.filter((i) => i.group);
  assert.equal(inG.length, 2);
  assert.equal(inG[0].group, inG[1].group);
  assert.equal(its.find((i) => i.text === 'Solo').group, undefined);
  assert.deepEqual([Math.round(its.find((i) => i.text === 'Acme').x)], [22]);
});

test('.odp: a slide\'s chart as a chart object carrying its figures, every kind, both ways and through LibreOffice (.odp and .pptx)', async (t) => {
  const data = { categories: ['Jan', 'Feb', 'Mar'], series: [{ name: 'North', values: [10, 12, 15] }, { name: 'South', values: [7, null, 11] }] };
  const types = ['column', 'stackedColumn', 'bar', 'stackedBar', 'line', 'area', 'pie', 'doughnut', 'scatter'];
  const deck2 = { theme: 'light', slides: types.map((ty, i) => ({ id: `s${i}`, items: [{ id: `c${i}`, type: 'chart', chartType: ty, title: `Sales ${ty}`, data, x: 10, y: 15, w: 70, h: 70 }] })) };
  const show = (d, { scatterNumbers = false } = {}) => d.slides.map((s) => s.items.filter((it) => it.type === 'chart').map((c) => JSON.stringify([c.chartType, c.title, Math.round(c.x), Math.round(c.y), Math.round(c.w), Math.round(c.h),
    scatterNumbers && c.chartType === 'scatter' ? { ...c.data, categories: c.data.categories.map((_, k) => String(k + 1)) } : c.data])).join(' '));
  const buf = await odpFromDeck(deck2, {});
  assert.deepEqual(show(await deckFromOdp(buf)), show(deck2));
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { t.diagnostic('LibreOffice not installed: its part skipped'); return; }
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { deckFromPowerPoint } = await import('../src/office/powerpoint.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-lo-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  try {
    fs.writeFileSync(path.join(dir, 'd.odp'), buf);
    assert.deepEqual(show(await deckFromOdp(lo('d.odp', 'odp', 'a'))), show(deck2), 'opened and saved by LibreOffice: real charts there');
    // As .pptx (a scatter chart's across-axis is numbers there: 1, 2, 3)
    assert.deepEqual(show(await deckFromPowerPoint(lo('d.odp', 'pptx', 'b'), { savePicture: async () => 'x' })), show(deck2, { scatterNumbers: true }), 'and saved by it as .pptx');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
