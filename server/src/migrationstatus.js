// Admin → Moving here: how far each person in the company has got bringing their things over — their
// latest mail import (from another account, an .mbox, Microsoft 365 or Google) and the last time they
// (or an admin, for them) brought in an export .zip, with what came in.
import { q } from './db.js';

/** A short line for what an export brought in ("120 files, 35 events, 80 contacts…"). */
export function broughtIn(d = {}) {
  const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
  return [
    d.drive?.files ? n(d.drive.files, 'file', 'files') : null,
    d.mail?.folders ? `${n(d.mail.folders, 'mail folder', 'mail folders')}${d.mail.started ? '' : ' (not started)'}` : null,
    d.calendar?.added ? n(d.calendar.added, 'event', 'events') : null,
    d.contacts?.added ? n(d.contacts.added, 'contact', 'contacts') : null,
    d.tasks?.tasks ? n(d.tasks.tasks, 'task', 'tasks') : null,
    d.notes?.added ? n(d.notes.added, 'note', 'notes') : null,
  ].filter(Boolean).join(', ') || 'nothing new';
}

/** Everyone in the company: { people: [{ id, name, email, mail, data }], counts }. */
export function migrationOf(orgId) {
  const people = q('SELECT id, name, username FROM users WHERE org_id = ? AND disabled = 0 ORDER BY name COLLATE NOCASE').all(orgId);
  const imports = new Map(q(`SELECT m.* FROM mail_imports m JOIN users u ON u.id = m.user_id WHERE u.org_id = ?
                             AND m.started_at = (SELECT MAX(started_at) FROM mail_imports x WHERE x.user_id = m.user_id)`).all(orgId).map((m) => [m.user_id, m]));
  const byName = new Map(people.map((p) => [p.username.toLowerCase(), p.id]));
  const restores = new Map();
  for (const a of q("SELECT actor_id, target, details, at FROM audit_log WHERE org_id = ? AND action = 'takeout.restore' ORDER BY at").all(orgId)) {
    const who = a.target ? byName.get(String(a.target).toLowerCase()) : a.actor_id; // an admin's for someone names them
    if (!who) continue;
    let d = {}; try { d = JSON.parse(a.details || '{}') || {}; } catch { /* keep {} */ }
    restores.set(who, { at: a.at, from: d.from || (d.source ? null : 'Workspace'), summary: broughtIn(d), by_admin: !!a.target });
  }
  const out = people.map((p) => {
    const m = imports.get(p.id);
    return {
      id: p.id, name: p.name, email: p.username,
      mail: m ? { status: m.status, from: m.host === 'file' ? `${m.username} (file)` : m.username, host: m.host, copied: m.copied, skipped: m.skipped, total: m.total, error: m.error, started_at: m.started_at, finished_at: m.finished_at } : null,
      data: restores.get(p.id) || null,
    };
  });
  const counts = {
    people: out.length,
    mail_done: out.filter((p) => p.mail?.status === 'done').length,
    mail_running: out.filter((p) => p.mail?.status === 'running').length,
    mail_failed: out.filter((p) => p.mail?.status === 'failed').length,
    data: out.filter((p) => p.data).length,
    nothing: out.filter((p) => !p.mail && !p.data).length,
  };
  return { people: out, counts };
}
