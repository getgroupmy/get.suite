// Answers to outside invitations sent with the guest's own mail app (Outlook's Accept, Gmail's
// Yes): they arrive in the organizer's inbox as an email with a calendar REPLY. Every couple of
// minutes, for organizers still waiting on outside answers, new ones are read and recorded. The
// email stays in the inbox (tagged, so it's read once); only a reply from the guest's own address
// counts.
import { simpleParser } from 'mailparser';
import { q } from '../db.js';
import { withFolder } from './imap.js';
import { sendTo } from '../hub.js';

const DONE = '$WorkspaceRsvp';
const ANSWER = { ACCEPTED: 'yes', TENTATIVE: 'maybe', DECLINED: 'no' };
const INTERVAL_MS = Number(process.env.MAIL_RSVP_INTERVAL_MS || 120e3);

/** { uid, answers: [{ email, status }] } from an iCalendar REPLY, or null. */
export function parseReply(text) {
  const lines = String(text || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  if (!lines.some((l) => /^METHOD:REPLY$/i.test(l.trim()))) return null;
  const uid = lines.find((l) => /^UID[:;]/i.test(l))?.replace(/^UID[^:]*:/i, '').trim();
  const answers = lines.filter((l) => /^ATTENDEE[:;]/i.test(l)).map((l) => {
    const email = (l.match(/:mailto:([^;:\s]+)\s*$/i) || [])[1]?.toLowerCase();
    const stat = (l.match(/;PARTSTAT=([A-Z-]+)/i) || [])[1]?.toUpperCase();
    return email && ANSWER[stat] ? { email, status: ANSWER[stat] } : null;
  }).filter(Boolean);
  return uid && answers.length ? { uid, answers } : null;
}

/** Read new calendar replies in one organizer's inbox. Returns how many answers were recorded. */
export async function checkUser(user) {
  let recorded = 0;
  await withFolder(user, 'INBOX', async (c) => {
    const since = new Date(Date.now() - 30 * 864e5);
    const uids = await c.search({ since, body: 'METHOD:REPLY', unKeyword: DONE }, { uid: true });
    for (const uid of (uids || []).slice(-50)) {
      const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (msg?.source && msg.source.length < 2e6) {
        const parsed = await simpleParser(msg.source);
        const from = parsed.from?.value?.[0]?.address?.toLowerCase();
        const parts = [...(parsed.attachments || []).filter((a) => /calendar/i.test(a.contentType)).map((a) => a.content.toString('utf8')), parsed.text || ''];
        for (const part of parts) {
          const reply = parseReply(part);
          if (!reply) continue;
          const eventId = reply.uid.split('@')[0];
          for (const a of reply.answers) {
            if (a.email !== from) continue; // someone else can't answer for them
            const info = q(`UPDATE event_outside_guests SET status = ?, answered_at = ?
                            WHERE event_id = ? AND email = ? AND event_id IN (SELECT id FROM events WHERE owner_id = ?)`)
              .run(a.status, Date.now(), eventId, a.email, user.id);
            recorded += info.changes;
          }
          break;
        }
      }
      await c.messageFlagsAdd(String(uid), [DONE], { uid: true });
    }
  });
  if (recorded) sendTo([user.id], { type: 'events-changed' });
  return recorded;
}

/** Organizers with outside guests on events that haven't finished (or keep repeating). */
function waitingOrganizers() {
  const now = Date.now();
  return q(`SELECT DISTINCT u.id, u.username, u.name FROM event_outside_guests g JOIN events e ON e.id = g.event_id JOIN users u ON u.id = e.owner_id
            WHERE u.disabled = 0 AND (e.end > ? OR (e.rrule IS NOT NULL AND (e.repeat_until IS NULL OR e.repeat_until > ?)))`).all(now - 864e5, now);
}

export async function checkReplies() {
  let n = 0;
  for (const user of waitingOrganizers()) {
    try { n += await checkUser(user); } catch (e) { console.error(`[calendar] reading replies for ${user.username} failed:`, e.message); }
  }
  return n;
}

let timer = null;
export function startRsvpWatcher() {
  if (timer) return;
  timer = setInterval(() => { checkReplies().catch(() => {}); }, INTERVAL_MS);
  timer.unref();
}
export function stopRsvpWatcher() { clearInterval(timer); timer = null; }
