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

const port = Number(process.env.PORT || 8080);
const app = createApp();
const server = http.createServer(app);
server.requestTimeout = 0; // large uploads can take a long time
attachHub(server);

// Housekeeping: purge expired sessions hourly; snapshot the database daily.
setInterval(() => q('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600e3).unref();
scheduleBackups();
setInterval(() => purgeAuthLog(), 3600e3).unref();
if (mailEnabled()) { startPolicyServer(); startMailNotifications(); startRsvpWatcher(); }

server.listen(port, () => console.log(`NAS Workspace listening on :${port} (data: ${DATA_DIR})`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { saveOpenDocuments(); } catch (e) { console.error(e); } // documents being co-edited right now
    server.close();
    db.close();
    process.exit(0);
  });
}
