import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { cleanZipPath, zipEntries, extractZip } from '../src/zipfiles.js';

const zipOf = async (files) => { const z = new JSZip(); for (const [p, c] of Object.entries(files)) z.file(p, c); return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); };
const fakeDrive = () => {
  const made = [];
  return { made, checkSpace: () => {}, makeFolder: (name, parentId) => { made.push({ kind: 'folder', name, parentId }); return `d${made.length}`; },
    makeFile: (f) => { made.push({ kind: 'file', ...f }); return `f${made.length}`; } };
};

test('zip paths are cleaned: no climbing out, no junk', () => {
  assert.deepEqual(cleanZipPath('a/b/c.txt'), ['a', 'b', 'c.txt']);
  assert.deepEqual(cleanZipPath('../../etc/passwd'), ['etc', 'passwd']);
  assert.deepEqual(cleanZipPath('/abs\\win\\path.txt'), ['abs', 'win', 'path.txt']);
  assert.deepEqual(cleanZipPath('./x/./y'), ['x', 'y']);
  assert.equal(cleanZipPath('__MACOSX/._a.txt'), null);
  assert.equal(cleanZipPath('photos/.DS_Store'), null);
  assert.equal(cleanZipPath('../'), null);
  assert.deepEqual(cleanZipPath('bad\u0000name\u0007.txt'), ['badname.txt']);
});

test('what is inside a zip: files with sizes, folders implied by paths, junk left out', async () => {
  const buf = await zipOf({ 'Report.pdf': 'pdfpdf', 'photos/2026/a.jpg': 'jpgjpgjpg', '__MACOSX/photos/._a.jpg': 'x', 'photos/b.jpg': 'b' });
  const z = await zipEntries(buf);
  assert.deepEqual(z.entries.map((e) => [e.path, e.dir, e.size]), [['photos', true, 0], ['photos/2026', true, 0], ['photos/2026/a.jpg', false, 9], ['photos/b.jpg', false, 1], ['Report.pdf', false, 6]]);
  assert.deepEqual([z.files, z.folders, z.size, z.more], [3, 2, 16, 0]);
  await assert.rejects(zipEntries(Buffer.from('not a zip at all')), /couldn't be read/);
});

test('unpacking makes the folders once and puts each file in its folder', async () => {
  const buf = await zipOf({ 'a.txt': 'A', 'docs/b.txt': 'BB', 'docs/deep/c.txt': 'CCC', '../escape.txt': 'E' });
  const d = fakeDrive();
  const r = await extractZip(buf, { ...d, rootName: 'Pack', parentId: 'p0' });
  assert.deepEqual([r.files, r.folders], [4, 2]);
  const names = d.made.map((m) => `${m.kind}:${m.name}<${m.parentId}`);
  assert.deepEqual(names.filter((n) => n.startsWith('folder')), ['folder:Pack<p0', 'folder:docs<d1', 'folder:deep<d2']);
  assert.ok(names.includes('file:escape.txt<d1'), 'a "../" path lands inside the new folder');
  assert.ok(names.includes('file:c.txt<d3'));
  assert.equal(d.made.find((m) => m.name === 'c.txt').size, 3);
  assert.equal(d.made.find((m) => m.name === 'a.txt').mime, 'text/plain');
});

test('unpacking checks the space first and catches a zip that lies about its size', async () => {
  const buf = await zipOf({ 'big.bin': Buffer.alloc(3 * 1024 * 1024) });
  await assert.rejects(extractZip(buf, { ...fakeDrive(), checkSpace: (n) => { if (n > 1000) throw new Error('No room'); }, rootName: 'x', parentId: null }), /No room/);
  // Claim it unpacks to 10 bytes (in the central directory, where the size is read from).
  const lie = Buffer.from(buf);
  const cd = lie.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lie.writeUInt32LE(10, cd + 24);
  const d = fakeDrive();
  await assert.rejects(extractZip(lie, { ...d, rootName: 'x', parentId: null }), (e) => /more than it says/.test(e.message) && e.root === 'd1');
});
