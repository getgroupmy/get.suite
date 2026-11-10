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
  assert.match(xml, /📊 Sales[\s\S]*EU[\s\S]*Jan[\s\S]*>3<[\s\S]*Feb[\s\S]*>5</, 'a chart as its figures');
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
    { type: 'text', x: 10, y: 50, w: 50, h: 14, text: 'Hello  there', size: 61.1 }, // 44pt on a 25.4 cm slide
    { type: 'table', x: 0, y: 0, w: 50, h: 50, cells: [['A']], size: 25 },
  ]);
  assert.equal(s.notes, 'Remember the date');
});
