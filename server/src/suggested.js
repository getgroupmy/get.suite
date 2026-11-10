// Suggested files at the top of My Drive: what you're likely to want next, each with why. Files attached to
// your meetings in the next day first, then files someone else changed this week, then what you've opened
// most lately. Only files you can still open; at most 8.
import { q } from './db.js';
import { roleFor } from './access.js';

const DAY = 864e5;
export const MAX_SUGGESTED = 8;

export function suggestedFor(userId, t = Date.now()) {
  const out = new Map(); // file id -> reason
  const add = (id, reason) => { if (!out.has(id) && out.size < MAX_SUGGESTED * 3) out.set(id, reason); };
  // 1. Attached to a meeting of yours in the next 24 hours (yours, or one you haven't said no to).
  const meetings = q(`SELECT e.id, e.title, e.start, e.attachments FROM events e LEFT JOIN event_guests g ON g.event_id = e.id AND g.user_id = ?
                      WHERE (e.owner_id = ? OR (g.user_id IS NOT NULL AND g.status != 'no')) AND e.attachments IS NOT NULL AND e.start >= ? AND e.start < ? AND e.rrule IS NULL
                      ORDER BY e.start LIMIT 20`).all(userId, userId, t - 3600e3, t + DAY);
  for (const m of meetings) {
    let list = [];
    try { list = JSON.parse(m.attachments) || []; } catch { /* none */ }
    for (const a of list) if (a?.id) add(a.id, { kind: 'meeting', title: m.title || 'a meeting', at: m.start });
  }
  // 2. Changed by someone else in the last week, in files you can open (your own, or shared with you).
  const edited = q(`SELECT f.id, f.updated_at, u.name FROM files f JOIN users u ON u.id = f.updated_by
                    WHERE f.updated_by IS NOT NULL AND f.updated_by != ? AND f.updated_at > ? AND f.trashed = 0 AND f.kind != 'folder'
                      AND (f.owner_id = ? OR f.id IN (SELECT file_id FROM shares WHERE user_id = ?))
                    ORDER BY f.updated_at DESC LIMIT 20`).all(userId, t - 7 * DAY, userId, userId);
  for (const e of edited) add(e.id, { kind: 'edited', by: e.name, at: e.updated_at });
  // 3. Opened by you lately: most often first.
  for (const v of q(`SELECT file_id, last_at FROM file_views WHERE user_id = ? AND last_at > ? ORDER BY times DESC, last_at DESC LIMIT 20`).all(userId, t - 14 * DAY)) {
    add(v.file_id, { kind: 'opened', at: v.last_at });
  }
  const files = [];
  for (const [id, reason] of out) {
    const f = q("SELECT id, name, kind, mime, owner_id, trashed FROM files WHERE id = ? AND kind != 'folder'").get(id);
    if (!f || f.trashed) continue;
    const role = roleFor(f.id, userId);
    if (!role) continue;
    files.push({ id: f.id, name: f.name, kind: f.kind, mime: f.mime, role, reason });
    if (files.length >= MAX_SUGGESTED) break;
  }
  return files;
}
