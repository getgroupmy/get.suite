import http from 'node:http';
import { createApp } from './app.js';
import { attachHub } from './hub.js';
import { db, q, DATA_DIR, restored } from './db.js';
import { audit } from './audit.js';
import { notify } from './notifications.js';
import { scheduleBackups } from './backup.js';
import { scheduleHealthChecks } from './health.js';
import { mailEnabled } from './mail/config.js';
import { startPolicyServer } from './security/policyServer.js';
import { startMailNotifications } from './mail/notify.js';
import { startRsvpWatcher } from './mail/rsvp.js';
import { saveAll as saveOpenDocuments } from './collab.js';
import { purge as purgeAuthLog } from './security/guard.js';
import { startIndexer } from './search.js';
import { startScheduledSending } from './routes/webmail.js';
import { startChatScheduler } from './routes/chat.js';
import { startNotesScheduler } from './routes/notes.js';
import { startShareExpiry } from './shareexpiry.js';
import { purgeAudit } from './audit.js';
import { emptyOldTrash } from './routes/files.js';
import { purgeOldChat } from './routes/chat.js';
import { refreshDueFeeds } from './calfeeds.js';
import { sendDueDigests } from './digest.js';
import { sendBookingReminders } from './routes/booking.js';
import { sendChatEmails } from './chatmail.js';

const port = Number(process.env.PORT || 8080);
const app = createApp();
const server = http.createServer(app);
server.requestTimeout = 0; // large uploads can take a long time
attachHub(server);

// Housekeeping: purge expired sessions hourly; snapshot the database daily.
setInterval(() => q('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600e3).unref();
scheduleHealthChecks(); // the platform owners hear about problems (disk, snapshots, mail, certificate)
scheduleBackups();
// Just put a snapshot back (Admin → System): say so in the activity log and to the platform owners.
if (restored) {
  audit(null, 'backup.restore', { target: restored.name, details: { kept: restored.kept, by: restored.by?.name || null }, org: null, actor: null });
  notify(q('SELECT id FROM users WHERE is_super = 1 AND disabled = 0').all().map((u) => u.id), { kind: 'system', title: `The database was restored from ${restored.name}`,
    body: `As asked by ${restored.by?.name || 'a platform owner'}. The database as it was is kept as ${restored.kept}.`, link: '/admin?tab=system', actor: null });
}
setInterval(() => purgeAuthLog(), 3600e3).unref();
setInterval(() => purgeAudit(), 6 * 3600e3).unref(); // activity older than AUDIT_DAYS
setInterval(() => emptyOldTrash(), 3600e3).unref(); // Drive: trash older than each company keeps it
setTimeout(() => emptyOldTrash(), 60e3).unref();
setInterval(() => { try { purgeOldChat(); } catch (e) { console.error('[chat] keeping:', e.message); } }, 3600e3).unref(); // Chat: messages older than each company keeps them
setTimeout(() => { try { purgeOldChat(); } catch {} }, 90e3).unref();
setInterval(() => sendChatEmails().catch((e) => console.error('[chat] email:', e.message)), 5 * 60e3).unref(); // unread mentions and direct messages
setInterval(() => sendDueDigests().catch((e) => console.error('[digest]', e.message)), 5 * 60e3).unref(); // morning summaries
setInterval(() => sendBookingReminders().catch((e) => console.error('[booking] reminders:', e.message)), 10 * 60e3).unref(); // visitors, the day before
setInterval(() => refreshDueFeeds().catch((e) => console.error('[calendar] feeds:', e.message)), 15 * 60e3).unref(); // subscribed calendars, every few hours each
if (mailEnabled()) { startPolicyServer(); startMailNotifications(); startRsvpWatcher(); }

startIndexer(); // search inside files: indexes what changed, in the background
startScheduledSending(); // mail scheduled for later
startChatScheduler(); // chat messages scheduled for later
startNotesScheduler(); // note reminders
startShareExpiry(); // shares that end by themselves
server.listen(port, () => console.log(`NAS Workspace listening on :${port} (data: ${DATA_DIR})`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { saveOpenDocuments(); } catch (e) { console.error(e); } // documents being co-edited right now
    server.close();
    db.close();
    process.exit(0);
  });
}
