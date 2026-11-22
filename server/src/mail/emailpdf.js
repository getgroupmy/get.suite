// An email as a PDF (Mail → Save to Drive as PDF): its subject, who it's from and to, the date, its text, and the
// names of its attachments, laid out by the document PDF writer (office/pdfdoc.js).
import { splitTextQuote } from './quotesplit.js';
import { pdfFromDoc } from '../office/pdfdoc.js';
import { docFromHtml } from '../office/word.js';
import { forwardHtml } from './forwardhtml.js';

const P = (text, marks) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text, ...(marks && { marks }) }] } : {}) });
const who = (list) => (list?.value || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).filter(Boolean).join(', ');

/**
 * The email as a document (TipTap JSON) and the name to keep it under ("Subject (2026-11-21)"): its subject, headers, a
 * line, its words, and its attachments' names. `rich`: its formatting as written (bold, lists and their look, tables,
 * links, colours: the email's HTML read as replies and forwards read it, pictures left out), else its plain text.
 */
export function emailDoc(parsed, { timeZone = 'UTC', rich = false } = {}) {
  const subject = String(parsed.subject || '(no subject)').trim();
  const date = parsed.date instanceof Date && !Number.isNaN(parsed.date.valueOf()) ? parsed.date : null;
  const when = date ? date.toLocaleString('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'short' }).replace(/\s+/g, ' ') : ''; // (plain spaces: the date's own are ones PDF fonts lack)
  const head = [['From', who(parsed.from)], ['To', who(parsed.to)], ['Cc', who(parsed.cc)], ['Date', when]].filter(([, v]) => v)
    .map(([k, v]) => ({ type: 'paragraph', content: [{ type: 'text', text: `${k}: `, marks: [{ type: 'bold' }] }, { type: 'text', text: v }] }));
  const text = String(parsed.text || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  let body = null;
  if (rich && parsed.html) { try { body = docFromHtml(forwardHtml(parsed.html, () => null).html).content.filter((n) => n.type !== 'paragraph' || n.content?.length); } catch { body = null; } }
  if (!body?.length) body = text ? text.split('\n').map((l) => P(l)) : [P('(no text)', [{ type: 'italic' }])];
  const files = (parsed.attachments || []).filter((a) => !a.related && a.filename);
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: subject }] },
    ...head,
    { type: 'horizontalRule' },
    ...body,
    ...(files.length ? [{ type: 'horizontalRule' }, P(`Attachments (${files.length})`, [{ type: 'bold' }]), { type: 'bulletList', content: files.map((a) => ({ type: 'listItem', content: [P(`${a.filename} (${Math.max(1, Math.round((a.size || a.content?.length || 0) / 1024))} KB)`)] })) }] : []),
  ] };
  const day = date ? date.toISOString().slice(0, 10) : '';
  const name = `${subject.replace(/[\\/:*?"<>|\r\n\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Email'}${day ? ` (${day})` : ''}`;
  return { doc, name, subject };
}

/** `parsed` is mailparser's message. Returns { buf, name }. */
export async function pdfFromEmail(parsed, { timeZone = 'UTC' } = {}) {
  const { doc, name, subject } = emailDoc(parsed, { timeZone });
  const buf = await pdfFromDoc(doc, subject, { setup: { size: 'a4', margin: 'normal' } });
  return { buf, name: `${name}.pdf` };
}

export const NOTE_TEXT = 15000; // (a note holds 20,000 characters: room for the lines around it)
/**
 * An email as a note (Mail → Save to Notes): its subject as the title; who it's from and when, then what it says
 * (without the quoted history under a reply, at most NOTE_TEXT characters), its attachments' names, and `link` to
 * open the email again.
 */
export function emailNote(parsed, { timeZone = 'UTC', link = '' } = {}) {
  const date = parsed.date instanceof Date && !Number.isNaN(parsed.date.valueOf()) ? parsed.date : null;
  const when = date ? date.toLocaleString('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).replace(/\s+/g, ' ') : '';
  let text = splitTextQuote(String(parsed.text || '')).main.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > NOTE_TEXT) text = `${text.slice(0, NOTE_TEXT).trimEnd()}…`;
  const files = (parsed.attachments || []).filter((a) => !a.related && a.filename).map((a) => a.filename);
  const body = [
    [who(parsed.from) && `From: ${who(parsed.from)}`, when].filter(Boolean).join(' · '),
    text,
    files.length ? `Attachments: ${files.join(', ')}` : '',
    link ? `Open the email: ${link}` : '',
  ].filter(Boolean).join('\n\n');
  return { title: String(parsed.subject || '(no subject)').trim().slice(0, 300), body };
}
