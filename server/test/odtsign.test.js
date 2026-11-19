// A signed document's OpenDocument download ends with its signatures page, as the Word one does: each signature
// (drawn, as a picture; typed, as the name), who, when and from where, and the document's fingerprint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { odtFromDoc } from '../src/office/odt.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const signatures = { completed_at: Date.UTC(2026, 10, 3, 10, 0), hash: 'ab12cd34', signers: [
  { name: 'Kim Park', email: 'kim@acme.example', signed_at: Date.UTC(2026, 10, 3, 9, 30), ip: '203.0.113.5', image: PNG },
  { name: 'Lee <Chan>', email: 'lee@acme.example', signed_at: Date.UTC(2026, 10, 3, 9, 45), ip: null, image: null },
] };
const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The lease terms.' }] }] };

test('.odt out: the signatures page after the document, a page of its own', async () => {
  const zip = await JSZip.loadAsync(await odtFromDoc(doc, 'Lease', { signatures }));
  const xml = await zip.file('content.xml').async('string');
  assert.match(xml, /The lease terms\.(?:(?!Signatures).)*<text:p text:style-name="PageBreak"\/><text:h text:style-name="Heading_20_1" text:outline-level="1">Signatures<\/text:h>/);
  assert.match(xml, /<draw:frame draw:name="Signature 1" text:anchor-type="as-char" svg:width="5\.82cm" svg:height="1\.69cm"><draw:image xlink:href="Pictures\/1\.png"[^>]*\/><svg:title>Signature<\/svg:title><svg:desc>Signature of Kim Park<\/svg:desc><\/draw:frame>/);
  assert.match(xml, /<text:p text:style-name="SignatureLine"><text:span text:style-name="T\d+">Kim Park<\/text:span> <text:s text:c="1"\/>kim@acme\.example<\/text:p>/);
  assert.match(xml, /Signed 2026-11-03 09:30 UTC from 203\.0\.113\.5 · drawn signature/);
  assert.match(xml, />Lee &lt;Chan&gt;<\/text:span><\/text:p>/, 'a typed signature: the name, escaped');
  assert.match(xml, /Signed 2026-11-03 09:45 UTC · typed signature/);
  assert.match(xml, /Signed electronically in Workspace; completed 2026-11-03 10:00 UTC\. Document fingerprint \(SHA-256\): ab12cd34/);
  assert.deepEqual(await zip.file('Pictures/1.png').async('nodebuffer'), Buffer.from(PNG.split(',')[1], 'base64'));
  assert.match(await zip.file('styles.xml').async('string'), /<style:style style:name="SignatureLine"[^>]*><style:paragraph-properties [^>]*fo:border-top="0\.75pt solid #999999"/);
  const unsigned = await (await JSZip.loadAsync(await odtFromDoc(doc, 'Lease'))).file('content.xml').async('string');
  assert.doesNotMatch(unsigned, /Signatures/);
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('through LibreOffice: the page prints as a second page with every signer and the fingerprint', { skip: !soffice && 'LibreOffice isn’t installed here' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-odtsign-'));
  try {
    fs.writeFileSync(path.join(dir, 's.odt'), await odtFromDoc(doc, 'Lease', { signatures }));
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 's.odt')], { stdio: 'ignore', timeout: 120000 });
    let pages;
    try { pages = execFileSync('pdftotext', [path.join(dir, 's.pdf'), '-']).toString().split('\f'); } catch { t.diagnostic('pdftotext not installed: its part skipped'); return; }
    assert.match(pages[0], /The lease terms\./);
    assert.doesNotMatch(pages[0], /Signatures/);
    assert.match(pages[1], /Signatures[\s\S]*Kim Park[\s\S]*203\.0\.113\.5[\s\S]*Lee <Chan>[\s\S]*ab12cd34/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
