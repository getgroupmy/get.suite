// Videos and sounds on slides go out in .pptx and .odp files as media that plays there, and come back as videos and
// sounds by their names (not as pictures of them), also from files LibreOffice saved again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { odpFromDeck, deckFromOdp } from '../src/office/odp.js';
import { powerPointFromDeck, deckFromPowerPoint } from '../src/office/powerpoint.js';

const deckWith = (files) => ({
  deck: { theme: 'light', slides: [{ id: 'a', items: [
    { id: 't', type: 'text', x: 5, y: 5, w: 50, h: 10, text: 'Demo' },
    { id: 'v', type: 'video', fileId: 'vid', name: 'Product demo.mp4', x: 10, y: 20, w: 48, h: 27 },
    { id: 's', type: 'audio', fileId: 'snd', name: 'Chime & bell.mp3', x: 82, y: 80, w: 14, h: 12 },
    { id: 'n', type: 'video', fileId: 'gone', name: 'Missing.mp4', x: 60, y: 20, w: 30, h: 17 },
  ] }] },
  pictureData: async (id) => files[id] || null,
});
const fake = { vid: { data: Buffer.from('fake mp4 bytes'), mime: 'video/mp4' }, snd: { data: Buffer.from('fake mp3 bytes'), mime: 'audio/mpeg' } };
const saving = () => { const saved = []; return { saved, savePicture: async (name, data, mime) => { saved.push([name, mime, data.toString('base64').slice(0, 12)]); return `f${saved.length}`; } }; };
const media = (d) => d.slides[0].items.filter((it) => it.type === 'video' || it.type === 'audio').map((it) => [it.type, it.name, [it.x, it.y, it.w, it.h].map(Math.round).join(',')]);
const want = [['video', 'Product demo.mp4', '10,20,48,27'], ['audio', 'Chime & bell.mp3', '82,80,14,12']];

test('.odp out: a media object for each video and sound, its file kept, its name as its title; one without its file is named', async () => {
  const { deck, pictureData } = deckWith(fake);
  const zip = await JSZip.loadAsync(await odpFromDeck(deck, { pictureData }));
  const xml = await zip.file('content.xml').async('string');
  assert.match(xml, /<draw:frame draw:name="Product demo\.mp4" [^>]*><draw:plugin xlink:href="Media\/1\.mp4" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="video\/mp4">(?:(?!<\/draw:frame>).)*<svg:title>Product demo\.mp4<\/svg:title><svg:desc>Product demo\.mp4<\/svg:desc><\/draw:frame>/);
  assert.match(xml, /<draw:plugin xlink:href="Media\/2\.mp3"[^>]*draw:mime-type="audio\/mpeg">(?:(?!<\/draw:frame>).)*<svg:title>Chime &amp; bell\.mp3<\/svg:title>/);
  assert.match(xml, /▶ Missing\.mp4/, 'a video whose file isn\'t there: its name, as before');
  assert.equal(await zip.file('Media/1.mp4').async('string'), 'fake mp4 bytes');
  assert.match(await zip.file('META-INF/manifest.xml').async('string'), /full-path="Media\/2\.mp3" manifest:media-type="audio\/mpeg"/);
});

test('.pptx and .odp in: videos and sounds come back as themselves, by their names, their files saved', async () => {
  const { deck, pictureData } = deckWith(fake);
  for (const [kind, buf, read] of [['pptx', await powerPointFromDeck(deck, { pictureData }), deckFromPowerPoint], ['odp', await odpFromDeck(deck, { pictureData }), deckFromOdp]]) {
    const { saved, savePicture } = saving();
    const back = await read(buf, { savePicture });
    assert.deepEqual(media(back), want, kind);
    assert.deepEqual(saved.slice(0, 2), [['Product demo.mp4', 'video/mp4', Buffer.from('fake mp4 bytes').toString('base64').slice(0, 12)], ['Chime & bell.mp3', 'audio/mpeg', Buffer.from('fake mp3 bytes').toString('base64').slice(0, 12)]], kind);
    assert.ok(!back.slides[0].items.some((it) => it.type === 'image'), `${kind}: not as pictures of them`);
  }
});

const has = (cmd) => { try { execFileSync(cmd, ['-version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { try { execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } } };
const ready = has('soffice') && has('ffmpeg');
test('through LibreOffice: real media in our .pptx and .odp, saved again by it in either format, come back by name', { skip: !ready && 'LibreOffice or ffmpeg isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-media-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  try {
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=1', '-pix_fmt', 'yuv420p', path.join(dir, 'v.mp4')], { stdio: 'ignore', timeout: 60000 });
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', path.join(dir, 'a.mp3')], { stdio: 'ignore', timeout: 60000 });
    const real = { vid: { data: fs.readFileSync(path.join(dir, 'v.mp4')), mime: 'video/mp4' }, snd: { data: fs.readFileSync(path.join(dir, 'a.mp3')), mime: 'audio/mpeg' } };
    const { deck, pictureData } = deckWith(real);
    deck.slides[0].items.pop(); // (just the two with files)
    fs.writeFileSync(path.join(dir, 'd.pptx'), await powerPointFromDeck(deck, { pictureData }));
    fs.writeFileSync(path.join(dir, 'd.odp'), await odpFromDeck(deck, { pictureData }));
    for (const [name, buf, read] of [['.pptx as .odp', lo('d.pptx', 'odp', 'a'), deckFromOdp], ['.pptx as .pptx', lo('d.pptx', 'pptx', 'b'), deckFromPowerPoint], ['.odp as .odp', lo('d.odp', 'odp', 'c'), deckFromOdp], ['.odp as .pptx', lo('d.odp', 'pptx', 'e'), deckFromPowerPoint]]) {
      const { saved, savePicture } = saving();
      assert.deepEqual(media(await read(buf, { savePicture })), want, name);
      assert.deepEqual(saved.map(([, mime]) => mime), ['video/mp4', 'audio/mpeg'], name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
