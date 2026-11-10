import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
const { odtFromDoc, docFromOdt, ODT_MIME } = await import('../src/office/odt.js');

const P = (...content) => ({ type: 'paragraph', content });
const T = (text, ...marks) => ({ type: 'text', text, ...(marks.length && { marks: marks.map((m) => (typeof m === 'string' ? { type: m } : m)) }) });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const doc = { type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [T('Plan')] },
  { type: 'paragraph', attrs: { textAlign: 'center' }, content: [T('Bold', 'bold'), T(' and '), T('italic', 'italic'), T(' and '), T('red', { type: 'textStyle', attrs: { color: '#cc0000' } }), T(', '), T('a link', { type: 'link', attrs: { href: 'https://a.example/x?y=1&z=2' } }), { type: 'footnote', attrs: { note: 'Source: survey' } }] },
  { type: 'orderedList', content: [{ type: 'listItem', content: [P(T('one')), { type: 'bulletList', content: [{ type: 'listItem', content: [P(T('inner'))] }] }] }] },
  { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [P(T('done'))] }, { type: 'taskItem', attrs: { checked: false }, content: [P(T('to do'))] }] },
  { type: 'blockquote', content: [P(T('quoted'))] },
  { type: 'codeBlock', content: [T('let  x = 1;')] },
  P(T('chips: '), { type: 'mention', attrs: { name: 'Kim Park' } }, T(' '), { type: 'datechip', attrs: { date: '2026-11-09' } }, T(' '), { type: 'filechip', attrs: { id: 'f', name: 'Budget' } }),
  { type: 'pageBreak' },
  { type: 'table', content: [
    { type: 'tableRow', content: [{ type: 'tableHeader', content: [P(T('Item'))] }, { type: 'tableHeader', content: [P(T('Qty'))] }] },
    { type: 'tableRow', content: [{ type: 'tableCell', content: [P(T('Pens'))] }, { type: 'tableCell', content: [P(T('4'))] }] },
  ] },
  { type: 'image', attrs: { fileId: 'pic1', alt: 'A dot' } },
] };

test('OpenDocument text out: a file LibreOffice opens, with styles, lists, notes, tables and pictures', async () => {
  const buf = await odtFromDoc(doc, 'Plan & budget', { pictureData: async (id) => (id === 'pic1' ? { data: PNG, mime: 'image/png' } : null) });
  const zip = await JSZip.loadAsync(buf);
  assert.equal(Object.keys(zip.files)[0], 'mimetype', 'the mimetype comes first');
  assert.equal(await zip.file('mimetype').async('string'), ODT_MIME);
  assert.equal(buf.subarray(30, 38).toString(), 'mimetype', 'stored as is, so apps can recognise the file');
  const xml = await zip.file('content.xml').async('string');
  assert.match(xml, /<text:h text:style-name="Heading_20_1" text:outline-level="1">Plan<\/text:h>/);
  assert.match(xml, /<text:p text:style-name="Standard_center">/);
  assert.match(xml, /<text:a xlink:type="simple" xlink:href="https:\/\/a\.example\/x\?y=1&amp;z=2">a link<\/text:a>/);
  assert.match(xml, /<text:note [^>]*text:note-class="footnote"><text:note-citation>1<\/text:note-citation><text:note-body><text:p[^>]*>Source: survey/);
  assert.match(xml, /<text:list text:style-name="LNum"><text:list-item><text:p[^>]*>one<\/text:p><text:list text:style-name="LBul">/);
  assert.match(xml, /☑ done[\s\S]*☐ to do/);
  assert.match(xml, /text:style-name="Quotations">quoted/);
  assert.match(xml, /let <text:s text:c="1"\/>x = 1;/, 'runs of spaces kept');
  assert.match(xml, /@Kim Park[\s\S]*9 Nov 2026[\s\S]*Budget/);
  assert.match(xml, /<text:p text:style-name="PageBreak"\/>/);
  assert.match(xml, /<table:table-header-rows><table:table-row>[\s\S]*Item[\s\S]*<\/table:table-header-rows>/);
  assert.match(xml, /<draw:image xlink:href="Pictures\/1\.png"/);
  assert.ok(zip.file('Pictures/1.png'));
  assert.match(await zip.file('META-INF/manifest.xml').async('string'), /Pictures\/1\.png" manifest:media-type="image\/png"/);
  assert.match(await zip.file('meta.xml').async('string'), /<dc:title>Plan &amp; budget<\/dc:title>/);
  // Bold, italic and red are automatic styles the text points to.
  const bold = /<text:span text:style-name="(T\d+)">Bold<\/text:span>/.exec(xml)[1];
  assert.match(xml, new RegExp(`style:name="${bold}" style:family="text"><style:text-properties fo:font-weight="bold"`));
  const red = /<text:span text:style-name="(T\d+)">red<\/text:span>/.exec(xml)[1];
  assert.match(xml, new RegExp(`style:name="${red}" style:family="text"><style:text-properties fo:color="#cc0000"`));
});

test('OpenDocument text in: what went out comes back (pictures saved as files)', async () => {
  const buf = await odtFromDoc(doc, 'Plan', { pictureData: async () => ({ data: PNG, mime: 'image/png' }) });
  const saved = [];
  const back = (await docFromOdt(buf, { savePicture: async (name, data, mime) => { saved.push({ name, mime, size: data.length }); return 'newpic'; } })).doc;
  const s = JSON.stringify(back);
  const types = back.content.map((n) => n.type);
  assert.deepEqual(types, ['heading', 'paragraph', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'paragraph', 'pageBreak', 'table', 'image']);
  assert.equal(back.content[0].attrs.level, 1);
  assert.equal(back.content[1].attrs.textAlign, 'center');
  assert.match(s, /"marks":\[\{"type":"bold"\}\],"text":"Bold"/);
  assert.match(s, /"marks":\[\{"type":"italic"\}\],"text":"italic"/);
  assert.match(s, /"color":"#cc0000"[^}]*\}\}\],"text":"red"/);
  assert.match(s, /"href":"https:\/\/a\.example\/x\?y=1&z=2"/);
  assert.match(s, /\{"type":"footnote","attrs":\{"note":"Source: survey"\}\}/);
  assert.equal(back.content[2].content[0].content[1].type, 'bulletList', 'a list inside a list');
  assert.deepEqual(back.content[3].content.map((i) => i.attrs.checked), [true, false]);
  assert.equal(back.content[5].content[0].text, 'let  x = 1;');
  assert.equal(back.content[8].content[0].content[0].type, 'tableHeader');
  assert.match(s, /"text":"Pens"/);
  assert.deepEqual(saved, [{ name: 'Picture 1.png', mime: 'image/png', size: PNG.length }]);
  assert.match(s, /"fileId":"newpic"/);
});

test('OpenDocument text in: styles LibreOffice writes (a heading by its style, colour on the paragraph, code)', async () => {
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';
  const zip = new JSZip();
  zip.file('mimetype', ODT_MIME);
  zip.file('styles.xml', `<office:document-styles ${NS}><office:styles><style:style style:name="Heading_20_1" style:family="paragraph" style:default-outline-level="1"/><style:style style:name="Preformatted_20_Text" style:family="paragraph"/></office:styles></office:document-styles>`);
  zip.file('content.xml', `<office:document-content ${NS}><office:automatic-styles>
    <style:style style:name="P1" style:family="paragraph" style:parent-style-name="Heading_20_1"/>
    <style:style style:name="P2" style:family="paragraph" style:parent-style-name="Text_20_body"><style:text-properties fo:color="#cc0000"/></style:style>
    <style:style style:name="P3" style:family="paragraph" style:parent-style-name="Preformatted_20_Text"/>
    <style:style style:name="P4" style:family="paragraph"><style:paragraph-properties fo:text-align="end"/></style:style>
    <style:style style:name="T1" style:family="text"><style:text-properties style:text-underline-style="solid" fo:font-weight="700"/></style:style>
    <text:list-style style:name="L1"><text:list-level-style-number text:level="1"/></text:list-style>
  </office:automatic-styles><office:body><office:text>
    <text:p text:style-name="P1">Report</text:p>
    <text:p text:style-name="P2">Red text</text:p>
    <text:p text:style-name="P3">code<text:s text:c="2"/>here</text:p>
    <text:p text:style-name="P4">To the <text:span text:style-name="T1">right</text:span><text:tab/>end</text:p>
    <text:list text:style-name="L1"><text:list-item><text:p>first</text:p></text:list-item></text:list>
    <text:p>Tricky &lt;b&gt; &amp; "quotes"</text:p>
  </office:text></office:body></office:document-content>`);
  const back = (await docFromOdt(await zip.generateAsync({ type: 'nodebuffer' }))).doc;
  assert.deepEqual(back.content.map((n) => n.type), ['heading', 'paragraph', 'codeBlock', 'paragraph', 'orderedList', 'paragraph']);
  assert.equal(back.content[0].attrs.level, 1);
  assert.equal(back.content[1].content[0].marks[0].attrs.color, '#cc0000');
  assert.equal(back.content[2].content[0].text, 'code  here');
  assert.equal(back.content[3].attrs.textAlign, 'right');
  assert.deepEqual(back.content[3].content[1].marks.map((m) => m.type).sort(), ['bold', 'underline']);
  assert.equal(back.content[5].content[0].text, 'Tricky <b> & "quotes"');
  await assert.rejects(docFromOdt(await new JSZip().file('x.txt', 'no').generateAsync({ type: 'nodebuffer' })), /Not an OpenDocument/);
});
