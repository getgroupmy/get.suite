// New mail on phones and computers with Workspace notifications on (push.js), even with Workspace
// closed: the mail server tells the app about each delivery (mail/rootfs/etc/dovecot/nw-push.lua, on
// the internal policy service), and the app passes on the ones in the folders the person follows
// (the Inbox, plus any they chose), unless they turned "New email" off in notification settings.
import { q } from '../db.js';
import { pushTo } from '../push.js';
import { offFor } from '../notifications.js';
import { followedFolders } from './notify.js';

const nameOf = (from) => { const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(String(from || '')); return (m?.[1] || String(from || '').replace(/[<>]/g, '')).trim() || 'Someone'; };

/** { user, messages: [{ folder, uid, from, subject }] } from the mail server. Returns how many were sent on. */
export async function handleMailNew(body) {
  const user = q('SELECT id FROM users WHERE username = ? AND disabled = 0').get(String(body?.user || ''));
  if (!user || offFor(user.id).includes('mail')) return 0;
  const follow = new Set(followedFolders(user.id).map((f) => f.toUpperCase()));
  const list = (Array.isArray(body.messages) ? body.messages : []).filter((m) => follow.has(String(m.folder || '').toUpperCase())).slice(0, 20);
  if (!list.length) return 0;
  const one = list.length === 1;
  const m = list[0];
  const folder = String(m.folder || 'INBOX');
  return pushTo(user.id, {
    title: one ? nameOf(m.from) : `${list.length} new emails`,
    body: one ? String(m.subject || '(No subject)') : list.map((x) => `${nameOf(x.from)}: ${x.subject || '(No subject)'}`).join('\n'),
    link: one && m.uid ? `/mail/${encodeURIComponent(folder)}/${Number(m.uid)}` : `/mail/${encodeURIComponent(folder)}`,
    tag: 'mail',
  });
}
