// How a presentation is shown, in .odp files both ways and through LibreOffice: each slide's transition and moving on
// by itself, gradient backgrounds, slide numbers (on all, or all but the first) and looping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { odpFromDeck, deckFromOdp } from '../src/office/odp.js';
import { powerPointFromDeck, deckFromPowerPoint } from '../src/office/powerpoint.js';

const T = (id, text) => ({ id, type: 'text', x: 10, y: 10, w: 80, h: 20, text });
const deck = { theme: 'light', numbers: 'skip-first', loop: true, slides: [
  { id: 'a', bg: '#ffffff', items: [T('t1', 'One')], transition: 'fade', advance: 5 },
  { id: 'b', bg: '#112233', bgGrad: '#445566 90', items: [T('t2', 'Two')], transition: 'push' },
  { id: 'c', bg: '#ffffff', items: [T('t3', 'Three')], transition: 'zoom', advance: 12 },
  { id: 'd', bg: '#ffffff', bgGrad: '#ff0000 180', items: [T('t4', 'Four')] },
] };
const show = (d) => ({ numbers: d.numbers || null, loop: !!d.loop, slides: d.slides.map((s) => [s.transition || null, s.advance || null, s.bg || null, s.bgGrad || null, (s.items || []).map((it) => it.text).join()]) });
const want = show(deck);
const sp = async () => 'x';

test('.odp out: transitions and timings on each slide\'s page, gradients, a number box, the show looping', async () => {
  const zip = await JSZip.loadAsync(await odpFromDeck(deck, { title: 'T' }));
  const xml = await zip.file('content.xml').async('string');
  const page = (n) => { const st = new RegExp(`<draw:page draw:name="page${n}" draw:style-name="([^"]+)"`).exec(xml)[1]; return new RegExp(`<style:style style:name="${st}"[^>]*><style:drawing-page-properties ([^>]*)/>`).exec(xml)[1]; };
  assert.match(page(1), /presentation:transition-type="automatic" presentation:duration="PT5S" presentation:transition-speed="medium" smil:type="fade" smil:subtype="crossfade" presentation:display-page-number="false"/);
  assert.match(page(2), /draw:fill="gradient" draw:fill-gradient-name="grad1"[^]*smil:type="pushWipe" smil:subtype="fromBottom" presentation:display-page-number="true"/);
  assert.doesNotMatch(page(2), /transition-type="automatic"/);
  assert.match(page(3), /presentation:duration="PT12S"[^]*smil:type="zoom"/);
  assert.match(page(4), /^draw:fill="gradient" draw:fill-gradient-name="grad2"[^]*presentation:display-page-number="true"$/);
  const styles = await zip.file('styles.xml').async('string');
  assert.match(styles, /<draw:gradient draw:name="grad1" draw:style="linear" draw:start-color="#112233" draw:end-color="#445566"[^>]*draw:angle="90deg"/, 'left to right');
  assert.match(styles, /<draw:gradient draw:name="grad2"[^>]*draw:end-color="#ff0000"[^>]*draw:angle="0deg"/, 'top to bottom');
  assert.equal((xml.match(/presentation:class="page-number"/g) || []).length, 3, 'the first slide has no number');
  assert.match(xml, /<draw:frame presentation:class="page-number" [^>]*><draw:text-box><text:p [^>]*><text:span [^>]*><text:page-number>2<\/text:page-number>/);
  assert.match(xml, /<\/draw:page><presentation:settings presentation:endless="true" presentation:pause="P0D"\/><\/office:presentation>/);
  const plain = await (await JSZip.loadAsync(await odpFromDeck({ theme: 'light', slides: [{ id: 'x', items: [] }] }, {}))).file('content.xml').async('string');
  assert.doesNotMatch(plain, /smil:type|presentation:duration|page-number"|presentation:settings/);
});

test('.odp in: what went out comes back; LibreOffice\'s other transitions as the nearest, an old angle in tenths', async () => {
  assert.deepEqual(show(await deckFromOdp(await odpFromDeck(deck, { title: 'T' }), { savePicture: sp })), want);
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:smil="urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.presentation');
  zip.file('styles.xml', `<office:document-styles ${NS}><office:styles><draw:gradient draw:name="g" draw:style="linear" draw:start-color="#000000" draw:end-color="#ffffff" draw:angle="900"/></office:styles></office:document-styles>`);
  zip.file('content.xml', `<office:document-content ${NS}><office:automatic-styles>
    <style:style style:name="p1" style:family="drawing-page"><style:drawing-page-properties smil:type="barWipe" presentation:transition-type="automatic" presentation:duration="PT1M30S" draw:fill="gradient" draw:fill-gradient-name="g"/></style:style>
    <style:style style:name="p2" style:family="drawing-page"><style:drawing-page-properties smil:type="checkerBoardWipe" presentation:transition-type="manual" presentation:duration="PT3S"/></style:style>
  </office:automatic-styles><office:body><office:presentation><draw:page draw:name="A" draw:style-name="p1"/><draw:page draw:name="B" draw:style-name="p2"/></office:presentation></office:body></office:document-content>`);
  const back = await deckFromOdp(await zip.generateAsync({ type: 'nodebuffer' }), { savePicture: sp });
  assert.deepEqual(back.slides.map((s) => [s.transition, s.advance ?? null, s.bg ?? null, s.bgGrad ?? null]), [['push', 90, '#000000', '#ffffff 90'], ['fade', null, null, null]], 'moving on by itself only when it is automatic');
  assert.equal(back.numbers, undefined);
  assert.equal(back.loop, undefined);
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('through LibreOffice: our .odp saved again as .odp, and our .pptx saved as .odp, show the same way', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-odpshow-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  try {
    fs.writeFileSync(path.join(dir, 'd.odp'), await odpFromDeck(deck, { title: 'T' }));
    fs.writeFileSync(path.join(dir, 'd.pptx'), await powerPointFromDeck(deck, { title: 'T' }));
    assert.deepEqual(show(await deckFromOdp(lo('d.odp', 'odp', 'a'), { savePicture: sp })), want, '.odp saved again as .odp');
    assert.deepEqual(show(await deckFromOdp(lo('d.pptx', 'odp', 'b'), { savePicture: sp })), want, '.pptx saved as .odp');
    // As .pptx, LibreOffice 24.2 leaves the zoom transition out (it writes an empty one); the rest is kept.
    const wantPptx = { ...want, slides: want.slides.map((s, i) => (i === 2 ? [null, ...s.slice(1)] : s)) };
    assert.deepEqual(show(await deckFromPowerPoint(lo('d.odp', 'pptx', 'c'), { savePicture: sp })), wantPptx, '.odp saved as .pptx');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
