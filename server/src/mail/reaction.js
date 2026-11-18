// Emoji reactions to emails (RFC 9078): a short reply whose body has a part with
// Content-Disposition: reaction holding just the emoji, threaded to the message it reacts to
// with In-Reply-To. Mail apps that don't know reactions show the plain sentence beside it.
import crypto from 'node:crypto';
import { encodeWord, encodeWords } from 'nodemailer/lib/mime-funcs/index.js';

/** The reactions offered (any single emoji is accepted). */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏', '😮'];

/** One emoji (with its skin tone, joiners and variation selectors), or null. */
export function cleanEmoji(s) {
  const t = String(s ?? '').trim();
  if (!t || t.length > 16) return null;
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(t)];
  if (graphemes.length !== 1) return null;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(t) ? t : null;
}

/** A parsed message's reaction ({ emoji, to: the Message-ID it reacts to }), or null. */
export function reactionOf(parsed) {
  const part = (parsed?.attachments || []).find((a) => String(a.contentDisposition || '').toLowerCase() === 'reaction');
  if (!part) return null;
  const emoji = cleanEmoji(part.content?.toString('utf8'));
  const to = [].concat(parsed.inReplyTo || [])[0] || null;
  return emoji && to ? { emoji, to } : null;
}

/** The parsed message without its reaction part (so it isn't listed as an attachment), and the reaction. */
export function splitReaction(parsed) {
  const reaction = reactionOf(parsed);
  if (parsed?.attachments?.some((a) => String(a.contentDisposition || '').toLowerCase() === 'reaction')) {
    parsed.attachments = parsed.attachments.filter((a) => String(a.contentDisposition || '').toLowerCase() !== 'reaction');
  }
  return reaction;
}

const line = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const addr = ({ name, address }) => (name ? `${encodeWord(line(name), 'Q', 52)} <${address}>` : `<${address}>`);
const reSubject = (s) => (/^\s*re:/i.test(s || '') ? line(s) : `Re: ${line(s) || '(no subject)'}`);

/** The reaction, as a raw message: from, to ([{ name, address }]), the emoji, about the parsed original. */
export function buildReaction(original, { from, to, emoji, host, now = new Date() }) {
  const boundary = `----=_reaction_${crypto.randomBytes(8).toString('hex')}`;
  const id = line(original.messageId);
  const refs = [...[].concat(original.references || []).map(line), id].filter(Boolean).slice(-20);
  const fallback = `${from.name || from.address} reacted to your message with ${emoji}`;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    `From: ${addr(from)}`,
    `To: ${to.map(addr).join(', ')}`,
    `Subject: ${encodeWords(reSubject(original.subject), 'Q', 52)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${host}>`,
    `In-Reply-To: ${id}`,
    `References: ${refs.join(' ')}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    // The reaction first: a mail app shows the last kind it understands, so ones that don't know
    // reactions show the sentence.
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    'Content-Disposition: reaction',
    '',
    emoji,
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    fallback,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    `<p>${esc(fallback)}</p>`,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
