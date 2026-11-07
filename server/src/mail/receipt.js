// Read receipts (RFC 8098): a message may ask for one with Disposition-Notification-To. Workspace
// never sends one by itself; the reader is asked. The receipt is a multipart/report naming the
// original message, and says only that it was displayed.
import crypto from 'node:crypto';
import { encodeWord, encodeWords } from 'nodemailer/lib/mime-funcs/index.js';

const ADDR_RE = /<?([^\s<>@,;"]+@[a-z0-9.-]+\.[a-z]{2,})>?/i;

/** Where to send a receipt for a parsed message, or null (no request, or it's from one of your own addresses). */
export function receiptRequest(parsed, mine = []) {
  const h = parsed.headers?.get('disposition-notification-to');
  const raw = typeof h === 'string' ? h : h?.text || h?.value?.[0]?.address || '';
  const m = ADDR_RE.exec(String(raw));
  if (!m) return null;
  const to = m[1].toLowerCase();
  const own = new Set(mine.map((a) => a.toLowerCase()));
  const from = (parsed.from?.value?.[0]?.address || '').toLowerCase();
  if (own.has(to) || own.has(from)) return null;
  return to;
}

const line = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const addr = ({ name, address }) => (name ? `${encodeWord(line(name), 'Q', 52)} <${address}>` : `<${address}>`);

/** The receipt, as a raw message. */
export function buildReceipt(parsed, { from, to, host, now = new Date() }) {
  const boundary = `----=_report_${crypto.randomBytes(8).toString('hex')}`;
  const subject = line(parsed.subject || '');
  const when = parsed.date ? new Date(parsed.date).toUTCString() : '';
  const text = `Your message${subject ? ` "${subject}"` : ''}${when ? ` sent ${when}` : ''} to ${from.address} was displayed on ${now.toUTCString()}.\r\n\r\nThis only means the message was opened; it doesn't mean it was read or understood.`;
  return [
    `From: ${addr(from)}`,
    `To: <${to}>`,
    `Subject: ${encodeWords(`Read: ${subject || '(no subject)'}`, 'Q', 52)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${host}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-replied',
    `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    `--${boundary}`,
    'Content-Type: message/disposition-notification',
    '',
    `Reporting-UA: ${host}; Workspace`,
    `Final-Recipient: rfc822;${from.address}`,
    ...(parsed.messageId ? [`Original-Message-ID: ${line(parsed.messageId)}`] : []),
    'Disposition: manual-action/MDN-sent-manually; displayed',
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
