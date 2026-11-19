// Live connections (the update channel, co-editing a file, a meeting) are signed in when they open. They're
// kept here with their session, so that when the session ends (signed out on that device or everywhere, the
// person suspended, the session expired) they close too: someone signed out can't keep editing an open file.
// Closed with code 4401, which the web app takes as "signed out".
import { q } from './db.js';

export const SIGNED_OUT = 4401;
const live = new Map(); // session token -> Set<WebSocket>

/** Keep `ws` with the session it was opened with (closed when that session ends). */
export function trackSession(ws, token) {
  if (!token) return;
  let set = live.get(token);
  if (!set) live.set(token, (set = new Set()));
  set.add(ws);
  ws.on('close', () => { set.delete(ws); if (!set.size && live.get(token) === set) live.delete(token); });
}

const stillValid = (token) => !!q(`SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = ? AND s.expires_at > ? AND u.disabled = 0`).get(token, Date.now());

/** Close the connections of sessions that have ended. Returns how many were closed. */
export function sweepSessions() {
  let n = 0;
  for (const [token, set] of live) {
    if (stillValid(token)) continue;
    live.delete(token);
    for (const ws of set) {
      n++;
      try { ws.close(SIGNED_OUT, 'Signed out'); } catch { /* already gone */ }
      setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 3000).unref();
    }
  }
  return n;
}
/** Connections open for a session (for tests). */
export const liveCount = (token) => live.get(token)?.size || 0;

// Sessions end in many places (and by expiring): checked every few seconds, and straight after a sign-out.
let soon = null;
export function sweepSoon() { if (!soon) soon = setTimeout(() => { soon = null; sweepSessions(); }, 0); }
setInterval(sweepSessions, 5000).unref();
