import { securityAlert } from './alerts.js';
// The activity log company admins see: sign-ins, account and security changes, sharing and
// deleting files, and mail settings. Each entry belongs to one company (the one whose account,
// file or setting it is about). Kept for AUDIT_DAYS days (365 unless set).
import { q } from './db.js';

q(`CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT,                      -- the company it's about (null: the whole server)
  at INTEGER NOT NULL,
  actor_id TEXT,                    -- who did it (null: nobody signed in, e.g. a failed sign-in)
  actor_name TEXT,                  -- kept as it was, in case the account is deleted later
  action TEXT NOT NULL,             -- e.g. sign-in, user.create, file.share
  target TEXT,                      -- what it was done to, in words (an address, a file name)
  details TEXT,                     -- JSON: anything more
  ip TEXT
)`).run();
q('CREATE INDEX IF NOT EXISTS audit_log_org ON audit_log(org_id, at)').run();

export const ACTIONS = {
  'sign-in': 'Signed in', 'sign-in.failed': 'Failed sign-in', 'sign-out': 'Signed out',
  'password.change': 'Changed their password', '2fa.on': 'Turned on two-step verification', '2fa.off': 'Turned off two-step verification',
  'session.revoke': 'Signed out a device', 'mail-app.create': 'Made a mail-app password', 'mail-app.remove': 'Removed the mail-app password',
  'user.create': 'Added a person', 'user.update': 'Changed a person', 'user.delete': 'Deleted a person',
  'company.update': 'Changed company settings', 'domain.update': 'Changed a mail domain', 'alias.create': 'Added an alias', 'alias.update': 'Changed an alias', 'alias.delete': 'Deleted an alias',
  'file.share': 'Changed sharing', 'file.template': 'Made a company template', 'file.untemplate': 'Removed a company template', 'link.create': 'Made a public link', 'link.delete': 'Removed a public link', 'file.delete': 'Deleted forever', 'trash.empty': 'Emptied the trash',
  'group.create': 'Made a group', 'group.members': 'Changed a group\'s members', 'group.delete': 'Deleted a group', 'data.export': 'Downloaded their data',
  'backup.create': 'Took a database snapshot', 'backup.download': 'Downloaded a database snapshot', 'mail-queue.delete': 'Deleted a message waiting to go out', 'drive.create': 'Made a shared drive',
};

const DAYS = Math.max(7, Number(process.env.AUDIT_DAYS) || 365);

/**
 * Record something. `req` gives who did it and from where (or pass { user, ip }); `org` is the
 * company it's about (defaults to the actor's).
 */
export function audit(req, action, { target = null, details = null, org, actor } = {}) {
  try {
    const who = actor !== undefined ? actor : req?.user || null;
    q('INSERT INTO audit_log (org_id, at, actor_id, actor_name, action, target, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(org !== undefined ? org : who?.org_id ?? null, Date.now(), who?.id ?? null, who ? (who.name || who.username || null) : null, action,
        target === null ? null : String(target).slice(0, 300), details ? JSON.stringify(details).slice(0, 4000) : null, req?.ip ?? null);
    const orgId = org !== undefined ? org : who?.org_id ?? null;
    securityAlert({ orgId, action, actor: who, target, details });
  } catch (e) { console.error('[audit]', e.message); } // never let logging break the action itself
}

export const purgeAudit = () => q('DELETE FROM audit_log WHERE at < ?').run(Date.now() - DAYS * 864e5);
