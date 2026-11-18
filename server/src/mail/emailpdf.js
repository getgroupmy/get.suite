// An email as a PDF (Mail → Save to Drive as PDF): its subject, who it's from and to, the date, its text, and the
// names of its attachments, laid out by the document PDF writer (office/pdfdoc.js).
import { pdfFromDoc } from '../office/pdfdoc.js';

const P = (text, marks) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text, ...(marks && { marks }) }] } : {}) });
const who = (list) => (list?.value || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).filter(Boolean).join(', ');

/** `parsed` is mailparser's message. Returns { buf, name }. */
export async function pdfFromEmail(parsed, { timeZone = 'UTC' } = {}) {
  const subject = String(parsed.subject || '(no subject)').trim();
  const date = parsed.date instanceof Date && !Number.isNaN(parsed.date.valueOf()) ? parsed.date : null;
  const when = date ? date.toLocaleString('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'short' }).replace(/\s+/g, ' ') : ''; // (plain spaces: the date's own are ones PDF fonts lack)
  const head = [['From', who(parsed.from)], ['To', who(parsed.to)], ['Cc', who(parsed.cc)], ['Date', when]].filter(([, v]) => v)
    .map(([k, v]) => ({ type: 'paragraph', content: [{ type: 'text', text: `${k}: `, marks: [{ type: 'bold' }] }, { type: 'text', text: v }] }));
  const text = String(parsed.text || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const body = text ? text.split('\n').map((l) => P(l)) : [P('(no text)', [{ type: 'italic' }])];
  const files = (parsed.attachments || []).filter((a) => !a.related && a.filename);
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: subject }] },
    ...head,
    { type: 'horizontalRule' },
    ...body,
    ...(files.length ? [{ type: 'horizontalRule' }, P(`Attachments (${files.length})`, [{ type: 'bold' }]), { type: 'bulletList', content: files.map((a) => ({ type: 'listItem', content: [P(`${a.filename} (${Math.max(1, Math.round((a.size || a.content?.length || 0) / 1024))} KB)`)] })) }] : []),
  ] };
  const buf = await pdfFromDoc(doc, subject, { setup: { size: 'a4', margin: 'normal' } });
  const day = date ? date.toISOString().slice(0, 10) : '';
  const name = `${subject.replace(/[\\/:*?"<>|\r\n\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Email'}${day ? ` (${day})` : ''}.pdf`;
  return { buf, name };
}
