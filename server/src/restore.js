// Putting a database snapshot back (Admin → System → Database snapshots → Restore). Asking for it
// leaves a note in the data folder and the app stops; Docker starts it again (restart: unless-stopped),
// and before the database is opened the snapshot is copied into place. The database as it was is kept
// beside the snapshots (workspace-<date>-before-restore-<time>.db), so a restore can itself be undone.
// Uploaded files aren't in snapshots: ones added since stay in the folder unused, ones deleted since
// are gone.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SNAPSHOT_NAME = /^workspace-\d{4}-\d{2}-\d{2}(-before-restore-\d{6})?\.db$/;
const NOTE = 'restore-pending.json';

/** Ask for a snapshot to be put back at the next start. */
export function requestRestore(dataDir, name, by) {
  if (!SNAPSHOT_NAME.test(String(name)) || !fs.existsSync(path.join(dataDir, 'backups', name))) throw new Error('No such snapshot');
  fs.writeFileSync(path.join(dataDir, NOTE), JSON.stringify({ name, by, at: Date.now() }));
}

/**
 * At start, before the database is opened: put the asked-for snapshot in place. Returns what was
 * done ({ name, by, at, kept }) or null. A note naming a missing snapshot is dropped, with a message.
 */
export function applyPendingRestore(dataDir, { now = new Date(), log = console.log } = {}) {
  const note = path.join(dataDir, NOTE);
  let want;
  try { want = JSON.parse(fs.readFileSync(note, 'utf8')); } catch { return null; }
  fs.rmSync(note, { force: true });
  const src = SNAPSHOT_NAME.test(String(want?.name)) ? path.join(dataDir, 'backups', want.name) : null;
  if (!src || !fs.existsSync(src)) { log(`Restore skipped: snapshot ${want?.name} not found`); return null; }
  const db = path.join(dataDir, 'workspace.db');
  const stamp = now.toISOString();
  const kept = `workspace-${stamp.slice(0, 10)}-before-restore-${stamp.slice(11, 19).replace(/:/g, '')}.db`;
  // The current database, kept whole in one file: its write-ahead log folded in first.
  if (fs.existsSync(db)) {
    try { const d = new DatabaseSync(db); d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); d.close(); } catch (e) { log(`Restore: couldn't tidy the current database first (${e.message})`); }
    fs.renameSync(db, path.join(dataDir, 'backups', kept));
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(db + ext)) fs.renameSync(db + ext, path.join(dataDir, 'backups', kept + ext));
  }
  fs.copyFileSync(src, db);
  log(`Restored the database from ${want.name}; the previous one is kept as backups/${kept}`);
  return { ...want, kept };
}
