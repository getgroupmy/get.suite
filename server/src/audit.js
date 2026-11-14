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
  'mail.sent_outside': 'Sent an email outside the company (after being asked)', 'mail.forwarding_requested': 'Asked to forward their mail (code sent)', 'mail.forwarding_on': 'Turned on forwarding of their mail', 'mail.forwarding_off': 'Turned off forwarding of their mail',
  'sign-in': 'Signed in', 'sign-in.failed': 'Failed sign-in', 'sign-out': 'Signed out',
  'password.change': 'Changed their password', '2fa.on': 'Turned on two-step verification', '2fa.off': 'Turned off two-step verification',
  'session.revoke': 'Signed out a device', 'mail-app.create': 'Made a mail-app password', 'mail-app.remove': 'Removed the mail-app password',
  'user.create': 'Added a person', 'user.update': 'Changed a person', 'user.delete': 'Deleted a person',
  'company.update': 'Changed company settings', 'domain.update': 'Changed a mail domain', 'alias.create': 'Added an alias', 'alias.update': 'Changed an alias', 'alias.delete': 'Deleted an alias',
  'file.share': 'Changed sharing', 'file.template': 'Made a company template', 'file.untemplate': 'Removed a company template', 'link.create': 'Made a public link', 'link.delete': 'Removed a public link', 'file.delete': 'Deleted forever', 'trash.empty': 'Emptied the trash',
  'group.create': 'Made a group', 'group.members': 'Changed a group\'s members', 'group.delete': 'Deleted a group', 'group.email': 'Changed a group\'s email address', 'data.export': 'Downloaded their data', 'meet.chat_delete': 'Deleted a kept meeting chat',
  'oidc.app_added': 'Added a sign-in app', 'oidc.app_secret': 'Made a new secret for a sign-in app', 'oidc.app_removed': 'Removed a sign-in app', 'oidc.signin': 'Signed in to another app',
  'passkey.added': 'Added a passkey', 'passkey.removed': 'Removed a passkey', 'recovery.set': 'Set a recovery email', 'recovery.remove': 'Removed their recovery email',
  'password.reset_requested': 'Asked for a password reset link', 'password.reset': 'Reset their password with an emailed link',
  'api_token.create': 'Made an API token', 'api_token.revoke': 'Revoked an API token',
  'user.hold': 'Put a person on legal hold', 'user.release': 'Took a person off legal hold', 'user.export': 'Downloaded the people list',
  'user.bulk.suspend': 'Suspended people', 'user.bulk.restore': 'Restored suspended people', 'user.bulk.signout': 'Signed people out everywhere', 'user.bulk.department': 'Moved people to a department',
  'mail.phishing': 'Reported a phishing email', 'mail.blocked': 'Blocked a sender for everyone', 'mail.unblocked': 'Unblocked a sender', 'mail.swept': 'Removed a sender\'s mail from everyone\'s Inbox',
  'mail.delegate': 'Let someone read and send their mail', 'mail.undelegate': 'Stopped someone reading their mail', 'mail.merge': 'Sent a mail merge',
  'shared_mailbox.create': 'Made a shared mailbox', 'shared_mailbox.update': 'Changed a shared mailbox', 'shared_mailbox.delete': 'Deleted a shared mailbox',
  'dlp.blocked': 'Was stopped from sharing sensitive data', 'dlp.sent_anyway': 'Sent sensitive data after a warning', 'dlp.rule_add': 'Added a data protection rule', 'dlp.rule_change': 'Changed a data protection rule', 'dlp.rule_delete': 'Deleted a data protection rule',
  'checkup.remind': 'Sent a security checkup reminder', 'announcement.post': 'Posted an announcement', 'announcement.remove': 'Took down an announcement',
  'link.request': 'Made a file request link', 'link.expiry': 'Changed when a public link expires', 'link.password': 'Changed a public link\'s password', 'link.enforce': 'Applied the public link rules to old links', 'link.stopall': 'Stopped all of a person\'s public links', 'link.export': 'Downloaded the list of public links',
  'file.publish': 'Published a file to the web', 'file.unpublish': 'Stopped publishing a file', 'file.transfer': 'Moved a person\'s files to someone else',
  'pdf.combine': 'Combined PDFs', 'pdf.extract': 'Took pages out of a PDF', 'pdf.sign': 'Signed a PDF', 'pdf.organize': 'Reordered a PDF\'s pages',
  'calendar.editor': 'Let someone edit their calendar', 'calendar.added_shared': 'Added an event to someone\'s shared calendar', 'calendar.changed_shared': 'Changed an event in someone\'s shared calendar', 'calendar.deleted_shared': 'Deleted an event from someone\'s shared calendar',
  'calendar.added_for': 'Added an event for someone (as their delegate)', 'calendar.changed_for': 'Changed an event for someone (as their delegate)', 'calendar.deleted_for': 'Deleted an event for someone (as their delegate)', 'event.copy_week': 'Copied a week of events',
  'chat.import': 'Imported chat history', 'takeout.restore': 'Restored data from an export',
  'backup.create': 'Took a database snapshot', 'backup.download': 'Downloaded a database snapshot', 'backup.restore': 'Put a database snapshot back', 'files.clean': 'Removed unused uploaded files', 'mail-queue.delete': 'Deleted a message waiting to go out', 'drive.create': 'Made a shared drive', 'drive.join': 'Added themselves to a shared drive (admin)',
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
