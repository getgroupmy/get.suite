// New mail on phones and computers with Workspace notifications on (push.js), even with Workspace
// closed: the mail server tells the app about each delivery (mail/rootfs/etc/dovecot/nw-push.lua, on
// the internal policy service), and the app passes on the ones in the folders the person follows
// (the Inbox, plus any they chose), unless they turned "New email" off in notification settings.
import { q } from '../db.js';
import { pushTo } from '../push.js';
import { offFor } from '../notifications.js';
import { followedFolders } from './notify.js';
import { withFolder } from './imap.js';
import { reactionPart, cleanEmoji } from './reaction.js';

/** MIME encoded words (RFC 2047: =?UTF-8?Q?Jos=C3=A9?=, =?utf-8?B?...?=) as text: headers come from the mail server as written. */
export function decodeWords(s) {
  return String(s ?? '').replace(/(=\?[^?\s]+\?[QqBb]\?[^?\s]*\?=)\s+(?==\?)/g, '$1') // the space between two encoded words isn't text
    .replace(/=\?([^?\s*]+)(?:\*[^?]*)?\?([QqBb])\?([^?\s]*)\?=/g, (all, charset, enc, text) => {
      try {
        const bytes = /b/i.test(enc) ? Buffer.from(text, 'base64')
          : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
        return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes);
      } catch { return all; } // a character set we don't know: left as it is
    });
}
const nameOf = (from) => { const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(String(from || '')); return (m?.[1] || String(from || '').replace(/[<>]/g, '')).trim() || 'Someone'; };

/**
 * Which of these new messages are emoji reactions (RFC 9078), from their structure: uid → emoji. Only
 * replies are looked at, and only briefly (the notification goes anyway, as an ordinary email).
 */
async function imapReactions(user, folder, uids) {
  const out = new Map();
  const look = withFolder(user, folder, async (client) => {
    // Told as it's delivered: the message may not be readable for a moment yet.
    for (let i = 0; i < 8; i++) {
      const have = new Set();
      for await (const m of client.fetch(uids.join(','), { uid: true }, { uid: true })) have.add(m.uid);
      if (uids.every((u) => have.has(u))) break;
      await new Promise((r) => setTimeout(r, 250));
      await client.noop();
    }
    const found = [];
    for await (const m of client.fetch(uids.join(','), { uid: true, bodyStructure: true, size: true }, { uid: true })) {
      const part = m.size < 64 * 1024 && reactionPart(m.bodyStructure);
      if (part) found.push([m.uid, part]);
    }
    // (Each part is fetched once that listing is over: one command at a time on the connection.)
    for (const [uid, part] of found) {
      const one = await client.fetchOne(String(uid), { bodyParts: [part] }, { uid: true });
      const raw = one?.bodyParts?.get(part);
      const emoji = cleanEmoji(raw?.toString('utf8')) || cleanEmoji(raw && Buffer.from(raw.toString('ascii').trim(), 'base64').toString('utf8'));
      if (emoji) out.set(uid, emoji);
    }
  });
  await Promise.race([look.catch(() => {}), new Promise((r) => setTimeout(r, 3000).unref?.())]);
  return out;
}
const baseOf = (s) => String(s || '').replace(/^\s*((re|aw|sv|antw)\s*:\s*)+/i, '').trim() || '(No subject)';

/** { user, messages: [{ folder, uid, from, subject }] } from the mail server. Returns how many were sent on. */
export async function handleMailNew(body, { reactionsOf = imapReactions } = {}) {
  body = { ...body, messages: (Array.isArray(body?.messages) ? body.messages : []).map((x) => ({ ...x, from: decodeWords(x?.from), subject: decodeWords(x?.subject) })) };
  const user = q('SELECT * FROM users WHERE username = ? AND disabled = 0').get(String(body?.user || ''));
  if (!user || offFor(user.id).includes('mail')) return 0;
  const follow = new Set(followedFolders(user.id).map((f) => f.toUpperCase()));
  const list = (Array.isArray(body.messages) ? body.messages : []).filter((m) => follow.has(String(m.folder || '').toUpperCase())).slice(0, 20);
  if (!list.length) return 0;
  const one = list.length === 1;
  const m = list[0];
  const folder = String(m.folder || 'INBOX');
  // A reaction reads as one: "Reacted 🎉 to “Contract signed?”", not "Re: Contract signed?".
  const replies = list.filter((x) => x.uid && /^\s*(re|aw|sv|antw)\s*:/i.test(x.subject || '') && String(x.folder || 'INBOX') === folder);
  const reacted = replies.length ? await reactionsOf(user, folder, replies.map((x) => Number(x.uid))).catch(() => new Map()) : new Map();
  const line = (x) => (reacted.has(Number(x.uid)) ? `Reacted ${reacted.get(Number(x.uid))} to “${baseOf(x.subject)}”` : String(x.subject || '(No subject)'));
  return pushTo(user.id, {
    title: one ? nameOf(m.from) : `${list.length} new emails`,
    body: one ? line(m) : list.map((x) => `${nameOf(x.from)}: ${line(x)}`).join('\n'),
    link: one && m.uid ? `/mail/${encodeURIComponent(folder)}/${Number(m.uid)}` : `/mail/${encodeURIComponent(folder)}`,
    tag: 'mail',
    private: one ? { title: nameOf(m.from), body: reacted.has(Number(m.uid)) ? `Reacted ${reacted.get(Number(m.uid))}` : 'New email' } : { title: `${list.length} new emails`, body: 'Open Workspace to read them' },
  });
}
