// Recently deleted: a task list, form, booking page or contact group deleted by mistake can be put back for 30 days. Deleting takes a
// copy of the item and of everything that goes with it (the rows the database would delete along with it,
// found from the tables' own foreign keys, so a table added later is covered too), then deletes it as before.
// Restoring puts the rows back, and links that were cleared (ON DELETE SET NULL) are set again.
import { q, tx, db } from './db.js';
import { uid, HttpError } from './util.js';
import { notify } from './notifications.js';

q(`CREATE TABLE IF NOT EXISTS recycle_bin (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                    -- 'task_list' | 'form' | 'booking_page' | 'contact_group'
  item_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  deleted_by TEXT,
  deleted_at INTEGER NOT NULL,
  data TEXT NOT NULL                     -- { rows: [{ table, row }], relinks: [{ table, column, rowid, value }] }
)`).run();
q('CREATE INDEX IF NOT EXISTS recycle_bin_owner ON recycle_bin(owner_id, deleted_at)').run();

export const KEEP_DAYS = 30;
const TABLES = { task_list: 'task_lists', form: 'forms', booking_page: 'booking_pages', contact_group: 'contact_groups', room: 'rooms' };

// Which tables point at which: { parent: [{ table, from, to, onDelete }] }.
let refs = null;
function referencesTo(parent) {
  if (!refs) {
    refs = {};
    for (const { name } of q("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      let fks = [];
      try { fks = db.prepare(`PRAGMA foreign_key_list("${name}")`).all(); } catch { continue; }
      for (const fk of fks) (refs[fk.table] ||= []).push({ table: name, from: fk.from, to: fk.to, onDelete: String(fk.on_delete).toUpperCase() });
    }
  }
  return refs[parent] || [];
}
const pkOf = (table) => db.prepare(`PRAGMA table_info("${table}")`).all().find((c) => c.pk === 1)?.name || 'rowid';

/** Everything that would go with these rows: [{ table, row }] parents first, and the links that would be cleared. */
function collect(table, column, values, out, seen) {
  if (!values.length) return;
  const rows = [];
  for (let i = 0; i < values.length; i += 500) {
    const part = values.slice(i, i + 500);
    rows.push(...db.prepare(`SELECT rowid AS __rowid, * FROM "${table}" WHERE "${column}" IN (${part.map(() => '?').join(',')})`).all(...part));
  }
  const fresh = rows.filter((r) => { const k = `${table}:${r.__rowid}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!fresh.length) return;
  for (const r of fresh) { const { __rowid, ...row } = r; out.rows.push({ table, row }); }
  for (const ref of referencesTo(table)) {
    const key = ref.to || pkOf(table);
    const vals = [...new Set(fresh.map((r) => r[key]).filter((v) => v !== null && v !== undefined))];
    if (!vals.length) continue;
    if (ref.onDelete === 'CASCADE') collect(ref.table, ref.from, vals, out, seen);
    else if (ref.onDelete === 'SET NULL') {
      for (let i = 0; i < vals.length; i += 500) {
        const part = vals.slice(i, i + 500);
        for (const r of db.prepare(`SELECT rowid AS __rowid, "${ref.from}" AS v FROM "${ref.table}" WHERE "${ref.from}" IN (${part.map(() => '?').join(',')})`).all(...part)) {
          out.relinks.push({ table: ref.table, column: ref.from, rowid: r.__rowid, value: r.v });
        }
      }
    }
  }
}

/** Delete a task list or form, keeping a copy to restore. Returns the bin entry's id. */
export function binAndDelete(kind, itemId, { ownerId, name, by }) {
  const table = TABLES[kind];
  if (!table) throw new Error(`Unknown kind ${kind}`);
  const out = { rows: [], relinks: [] };
  const id = uid();
  tx(() => {
    collect(table, 'id', [itemId], out, new Set());
    q('INSERT INTO recycle_bin (id, kind, item_id, owner_id, name, deleted_by, deleted_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, kind, itemId, ownerId, String(name || '').slice(0, 300), by || null, Date.now(), JSON.stringify(out));
    q(`DELETE FROM ${table} WHERE id = ?`).run(itemId);
  });
  return id;
}

/** Put it back. Rows that can't go back (someone since deleted, say) are left out. Returns { kind, item_id }. */
export function restoreFromBin(binId, ownerId) {
  const e = q('SELECT * FROM recycle_bin WHERE id = ? AND owner_id = ?').get(binId, ownerId);
  if (!e) return null;
  const { rows, relinks } = JSON.parse(e.data);
  tx(() => {
    if (q(`SELECT 1 FROM ${TABLES[e.kind]} WHERE id = ?`).get(e.item_id)) throw new HttpError(409, 'It is already back');
    for (const { table, row } of rows) {
      const cols = Object.keys(row);
      try { db.prepare(`INSERT OR IGNORE INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c])); }
      catch { /* its person or parent has gone since: left out */ }
    }
    for (const l of relinks) {
      try { db.prepare(`UPDATE "${l.table}" SET "${l.column}" = ? WHERE rowid = ? AND "${l.column}" IS NULL`).run(l.value, l.rowid); } catch { /* gone */ }
    }
    q('DELETE FROM recycle_bin WHERE id = ?').run(binId);
  });
  return { kind: e.kind, item_id: e.item_id };
}

/** Your recently deleted lists or forms. */
export const binOf = (ownerId, kind) => q('SELECT id, kind, item_id, name, deleted_at FROM recycle_bin WHERE owner_id = ? AND kind = ? ORDER BY deleted_at DESC').all(ownerId, kind)
  .map((x) => ({ ...x, until: x.deleted_at + KEEP_DAYS * 864e5 }));

export function purgeBin(t = Date.now()) {
  return q('DELETE FROM recycle_bin WHERE deleted_at < ?').run(t - KEEP_DAYS * 864e5).changes;
}
setInterval(() => { try { purgeBin(); } catch (e) { console.error('[bin]', e.message); } }, 6 * 3600e3).unref();

// Telling others once it's clear the deletion stands: kept until the moment to Undo has passed (stored, so a
// restart meanwhile doesn't lose it), then sent only if the item is still in the bin.
q(`CREATE TABLE IF NOT EXISTS bin_notices (
  id TEXT PRIMARY KEY, bin_id TEXT NOT NULL, user_ids TEXT NOT NULL, notice TEXT NOT NULL, due_at INTEGER NOT NULL
)`).run();
export const UNDO_GRACE_MS = () => Number(process.env.BIN_NOTICE_MS) || 15000;
export function noticeAfterUndo(binId, userIds, notice) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return;
  q('INSERT INTO bin_notices (id, bin_id, user_ids, notice, due_at) VALUES (?, ?, ?, ?, ?)').run(uid(), binId, JSON.stringify(ids), JSON.stringify(notice), Date.now() + UNDO_GRACE_MS());
  setTimeout(() => sendBinNotices(), UNDO_GRACE_MS() + 50).unref();
}
/** Send the notices that are due (for items still deleted). Returns how many people were told. */
export function sendBinNotices(t = Date.now()) {
  let n = 0;
  for (const r of q('SELECT * FROM bin_notices WHERE due_at <= ?').all(t)) {
    q('DELETE FROM bin_notices WHERE id = ?').run(r.id);
    if (!q('SELECT 1 FROM recycle_bin WHERE id = ?').get(r.bin_id)) continue; // undone
    const ids = JSON.parse(r.user_ids);
    try { notify(ids, JSON.parse(r.notice)); n += ids.length; } catch (e) { console.error('[bin]', e.message); }
  }
  return n;
}
setInterval(() => { try { sendBinNotices(); } catch (e) { console.error('[bin]', e.message); } }, 5000).unref();
