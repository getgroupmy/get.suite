// An email saved as a file (.eml: an attachment forwarded "as attachment", or a file in Drive or Chat),
// read for the viewer: who it's from and to, when, the subject, its text, and what's attached. Only text
// is shown (an HTML-only message is turned into text), so nothing in the file runs in Workspace.
import { simpleParser } from 'mailparser';

export const MAX_EML = 25 * 1024 * 1024;
const people = (a) => (a?.value || []).map((x) => ({ name: x.name || '', address: x.address || '' }));
/** Text from HTML: line breaks where blocks end, tags gone, the common entities decoded. */
export function htmlText(html) {
  return String(html || '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, '\n').replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** { from, to, cc, date, subject, text, attachments: [{ filename, size, contentType }] } of a raw message. */
export async function emlView(buf) {
  if (buf.length > MAX_EML) throw Object.assign(new Error('This email is too large to show here (25 MB at most): download it instead'), { status: 400 });
  const p = await simpleParser(buf);
  const text = (p.text && p.text.trim()) ? p.text : htmlText(p.html);
  return {
    from: people(p.from)[0] || null, to: people(p.to), cc: people(p.cc),
    date: p.date ? p.date.valueOf() : null, subject: p.subject || '',
    text: text.length > 200000 ? `${text.slice(0, 200000)}\n…` : text,
    attachments: (p.attachments || []).filter((a) => !a.related).map((a) => ({ filename: a.filename || 'attachment', size: a.size || a.content?.length || 0, contentType: a.contentType || '' })),
  };
}
