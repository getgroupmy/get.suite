import http from 'node:http';
import { createApp } from './app.js';
import { attachHub } from './hub.js';
import { db, q, DATA_DIR } from './db.js';
import { scheduleBackups } from './backup.js';
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

const port = Number(process.env.PORT || 8080);
const app = createApp();
const server = http.createServer(app);
server.requestTimeout = 0; // large uploads can take a long time
attachHub(server);

// Housekeeping: purge expired sessions hourly; snapshot the database daily.
setInterval(() => q('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600e3).unref();
scheduleBackups();
setInterval(() => purgeAuthLog(), 3600e3).unref();
setInterval(() => purgeAudit(), 6 * 3600e3).unref(); // activity older than AUDIT_DAYS
setInterval(() => emptyOldTrash(), 3600e3).unref(); // Drive: trash older than each company keeps it
setTimeout(() => emptyOldTrash(), 60e3).unref();
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
