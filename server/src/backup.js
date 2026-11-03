import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');

/**
 * Write a consistent snapshot of the database (safe while the app is running)
 * and keep the newest `keep` snapshots. Uploaded files live in data/files and
 * are already plain files, so Hyper Backup can copy them directly.
 */
export function backupDatabase({ keep = 7, date = new Date() } = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = date.toISOString().slice(0, 10);
  const target = path.join(BACKUP_DIR, `workspace-${stamp}.db`);
  fs.rmSync(target, { force: true });
  db.prepare('VACUUM INTO ?').run(target);
  const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^workspace-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  return target;
}

export function scheduleBackups() {
  const run = () => {
    try { console.log(`Database backup written to ${backupDatabase()}`); }
    catch (e) { console.error('Database backup failed:', e); }
  };
  // Shortly after start, then every 24 hours.
  setTimeout(run, 60e3).unref();
  setInterval(run, 864e5).unref();
}
