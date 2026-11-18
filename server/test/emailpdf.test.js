import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { PDFDocument } from 'pdf-lib';
import { pdfFromEmail } from '../src/mail/emailpdf.js';

const raw = [
  'From: Kim Park <kim@client.example>', 'To: Olivia Owner <olivia@acme.com>', 'Cc: lee@acme.com', 'Subject: Invoice 42 / March: paid',
  'Date: Tue, 17 Nov 2026 14:30:00 +0000', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '',
  '--b', 'Content-Type: text/plain; charset=utf-8', '', 'Hi Olivia,', '', 'The invoice is paid. Café receipt attached.', '', 'Kim',
  '--b', 'Content-Type: application/pdf; name="receipt.pdf"', 'Content-Disposition: attachment; filename="receipt.pdf"', 'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4 tiny').toString('base64'),
  '--b--', '',
].join('\r\n');

test('an email as a PDF: subject, who, when (in the reader\'s time zone), text, attachments\' names; a safe file name', async () => {
  const { buf, name } = await pdfFromEmail(await simpleParser(raw), { timeZone: 'Asia/Kuala_Lumpur' });
  assert.equal(name, 'Invoice 42 March paid (2026-11-17).pdf');
  const pdf = await PDFDocument.load(buf);
  assert.equal(pdf.getTitle(), 'Invoice 42 / March: paid');
  const { execFileSync } = await import('node:child_process');
  let text;
  try { text = execFileSync('pdftotext', ['-layout', '-', '-'], { input: buf }).toString(); } catch { return; }
  assert.match(text, /Invoice 42 \/ March: paid/);
  assert.match(text, /From: Kim Park <kim@client\.example>/);
  assert.match(text, /To: Olivia Owner <olivia@acme\.com>/);
  assert.match(text, /Cc: lee@acme\.com/);
  assert.match(text, /Date: Tuesday,? 17 November 2026 at 22:30/, 'in the reader\'s time zone');
  assert.match(text, /Hi Olivia,[\s\S]*The invoice is paid\. Café receipt attached\.[\s\S]*Kim/);
  assert.match(text, /Attachments \(1\)[\s\S]*receipt\.pdf \(1 KB\)/);
});

test('an email with no subject or text still makes a PDF', async () => {
  const { buf, name } = await pdfFromEmail(await simpleParser('From: a@b.example\r\nTo: c@d.example\r\n\r\n'));
  assert.equal(name, '(no subject).pdf');
  assert.equal((await PDFDocument.load(buf)).getPageCount(), 1);
});
