import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { nameRisk, attachmentRisk } from '../src/mail/attachrisk.js';

const RLO = String.fromCharCode(0x202e); // right-to-left override

test('programs and scripts are dangerous; ordinary files are fine', () => {
  for (const n of ['setup.exe', 'run.BAT', 'invoice.js', 'payload.vbs', 'update.msi', 'shortcut.lnk', 'disk.iso', 'App.HTA', 'script.ps1']) assert.equal(nameRisk(n)?.level, 'danger', n);
  for (const n of ['report.pdf', 'photo.jpg', 'budget.xlsx', 'letter.docx', 'notes.txt', 'archive.zip', 'deck.pptx', '']) assert.equal(nameRisk(n), null, n);
});

test('a program pretending to be a document says so', () => {
  assert.match(nameRisk('invoice.pdf.exe').reasons[0], /pretending to be a \.pdf file/);
  assert.match(nameRisk('photo.jpg      .scr').reasons[0], /pretending to be a \.jpg/);
  assert.match(nameRisk('setup.exe').reasons[0], /opening it runs it/);
});

test('a right-to-left trick in the name is dangerous', () => {
  const r = nameRisk(`invoice${RLO}fdp.exe`);
  assert.equal(r.level, 'danger');
  assert.match(r.reasons.join(' '), /hidden characters/);
  assert.equal(nameRisk(`report${RLO}.pdf`).level, 'danger', 'even when the end looks harmless');
});

test('macros, web pages and sealed archives are a warning', () => {
  assert.equal(nameRisk('Q3.xlsm').level, 'warning');
  assert.match(nameRisk('Q3.xlsm').reasons[0], /macros/);
  assert.equal(nameRisk('login.html').level, 'warning');
  assert.equal(nameRisk('logo.svg').level, 'warning');
  assert.equal(nameRisk('files.7z').level, 'warning');
  assert.equal(nameRisk('files.rar').level, 'warning');
});

test('what the file is, not just its name', async () => {
  const mz = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]);
  assert.equal((await attachmentRisk({ filename: 'scan.pdf', content: mz })).level, 'danger');
  assert.match((await attachmentRisk({ filename: 'scan.pdf', content: mz })).reasons[0], /Windows program, although its name says \.pdf/);
  assert.equal(await attachmentRisk({ filename: 'scan.pdf', content: Buffer.from('%PDF-1.7 hello') }), null);
  // An old Word file with a macro project.
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600), Buffer.from('_VBA_PROJECT', 'utf16le'), Buffer.alloc(100)]);
  assert.equal((await attachmentRisk({ filename: 'old.doc', content: ole })).level, 'warning');
  const plainOle = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
  assert.equal(await attachmentRisk({ filename: 'old.doc', content: plainOle }), null);
});

test('a .zip is looked into (names only)', async () => {
  const zip = async (files) => { const z = new JSZip(); for (const [n, c] of Object.entries(files)) z.file(n, c); return z.generateAsync({ type: 'nodebuffer' }); };
  assert.equal(await attachmentRisk({ filename: 'photos.zip', content: await zip({ 'a.jpg': 'x', 'b/c.png': 'y' }) }), null);
  const bad = await attachmentRisk({ filename: 'invoice.zip', content: await zip({ 'Invoice.pdf.exe': 'x', 'readme.txt': 'y' }) });
  assert.equal(bad.level, 'danger');
  assert.match(bad.reasons[0], /contains a program: Invoice\.pdf\.exe/);
  const careful = await attachmentRisk({ filename: 'q.zip', content: await zip({ 'Q3.xlsm': 'x' }) });
  assert.equal(careful.level, 'warning');
  // Office files are .zip files too, and aren't looked into.
  assert.equal(await attachmentRisk({ filename: 'letter.docx', content: await zip({ 'word/document.xml': '<x/>', 'evil.exe': 'x' }) }), null);
  // Password-protected: the flag bit set in the first entry's header.
  const enc = await zip({ 'secret.pdf': 'x' });
  enc.writeUInt16LE(enc.readUInt16LE(6) | 1, 6);
  assert.match((await attachmentRisk({ filename: 'locked.zip', content: enc })).reasons.join(' '), /password-protected/);
});
