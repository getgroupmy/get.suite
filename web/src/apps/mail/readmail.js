// What Read aloud says for an email: who it's from and its subject, then the message a sentence at a time,
// without quoted history (lines starting with ">", or the folded-away earlier messages) or the signature.
import { splitSentences } from '../docs/readaloud.js';

/** → [{ text }] */
export function mailSentences({ subject, from, text }) {
  const out = [];
  const who = from?.name || from?.address;
  if (who) out.push({ text: `From ${who}.` });
  if (subject) out.push({ text: `${subject}.`.replace(/([.!?…])\.$/, '$1') });
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const kept = [];
  for (const line of lines) {
    if (/^-- ?$/.test(line)) break; // the signature
    if (/^On .{4,200} wrote:\s*$/.test(line.trim())) break; // the quoted history starts
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  // Paragraphs are blank-line separated; lines inside one are joined (mail wraps at ~76 characters).
  for (const para of kept.join('\n').split(/\n\s*\n/)) {
    const t = para.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    for (const s of splitSentences(t)) out.push({ text: t.slice(s.start, s.end) });
  }
  return out;
}
