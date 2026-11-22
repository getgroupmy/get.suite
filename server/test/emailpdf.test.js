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

test('as a document to edit: headers, then its formatting as written (lists and their look, tables, bold), attachments’ names', async () => {
  const { emailDoc } = await import('../src/mail/emailpdf.js');
  const parsed = {
    subject: 'Order 1234', date: new Date(Date.UTC(2026, 10, 21, 9, 30)),
    from: { value: [{ name: 'Kim Park', address: 'kim@example.com' }] }, to: { value: [{ address: 'olivia@acme.com' }] },
    html: '<p>Hi, <b>please</b> confirm:</p><ol type="i"><li>Size</li><li>Colour</li></ol><table><tr><td>Qty</td><td>3</td></tr></table><img src="cid:x">',
    text: 'Hi, please confirm', attachments: [{ filename: 'quote.pdf', size: 2048 }, { filename: 'logo.png', related: true }],
  };
  const { doc, name } = emailDoc(parsed, { timeZone: 'Europe/London', rich: true });
  assert.equal(name, 'Order 1234 (2026-11-21)');
  const types = doc.content.map((n) => n.type);
  assert.deepEqual(types.slice(0, 5), ['heading', 'paragraph', 'paragraph', 'paragraph', 'horizontalRule'], 'subject, From, To, Date, a line');
  assert.match(doc.content[3].content[1].text, /^Saturday,? 21 November 2026 at 09:30$/);
  const ol = doc.content.find((n) => n.type === 'orderedList');
  assert.equal(ol.attrs.listStyle, 'lower-roman');
  assert.ok(doc.content.some((n) => n.type === 'table'));
  assert.ok(JSON.stringify(doc).includes('"bold"'));
  assert.ok(!JSON.stringify(doc).includes('cid:'), 'pictures left out');
  assert.match(JSON.stringify(doc.content.at(-1)), /quote\.pdf \(2 KB\)/);
  assert.ok(!JSON.stringify(doc).includes('logo.png'), 'not the pictures inside it');
  // Plain text only: its lines.
  const plain = emailDoc({ ...parsed, html: '' }, { rich: true }).doc;
  assert.ok(plain.content.some((n) => n.content?.[0]?.text === 'Hi, please confirm'));
});

test('as a note: the subject its title; who and when, what it says without the quoted history, attachments, a link back', async () => {
  const { emailNote, NOTE_TEXT } = await import('../src/mail/emailpdf.js');
  const reply = [
    'From: Kim Park <kim@client.example>', 'To: olivia@acme.com', 'Subject: Re: Delivery date', 'Date: Tue, 17 Nov 2026 14:30:00 +0000',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '',
    '--b', 'Content-Type: text/plain; charset=utf-8', '', 'Thursday works.   ', '', '', '', 'Kim', '', 'On Mon, 16 Nov 2026, Olivia wrote:', '> When can you deliver?', '> Thanks',
    '--b', 'Content-Type: application/pdf; name="plan.pdf"', 'Content-Disposition: attachment; filename="plan.pdf"', '', 'x',
    '--b--', '',
  ].join('\r\n');
  const n = emailNote(await simpleParser(reply), { timeZone: 'Europe/Paris', link: 'https://ws.example/mail?open=%3Cx%40y%3E' });
  assert.equal(n.title, 'Re: Delivery date');
  assert.equal(n.body, 'From: Kim Park <kim@client.example> · 17 Nov 2026, 15:30\n\nThursday works.\n\nKim\n\nAttachments: plan.pdf\n\nOpen the email: https://ws.example/mail?open=%3Cx%40y%3E');
  // A long one is cut; one with nothing still has a title.
  const long = emailNote({ subject: 'Long', text: 'word '.repeat(NOTE_TEXT) });
  assert.ok(long.body.length < 20000 && long.body.endsWith('…'));
  assert.deepEqual(emailNote({}), { title: '(no subject)', body: '' });
});
