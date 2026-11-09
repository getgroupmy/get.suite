// Uploaded files on the NAS (data/files) against what the database lists, for Admin → System:
//   unused:  files nothing refers to, neither the database nor any snapshot kept in data/backups
//            (so a restore still finds its files): left over after a restore or a crash. Removable.
//   missing: files the database lists that aren't on disk (deleted since a restored snapshot was
//            taken, say). Shown, so the platform owner knows which ones won't open.
// A file written in the last hour is never "unused": an upload may be finishing.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { q, FILES_DIR } from './db.js';
import { BACKUP_DIR, listBackups } from './backup.js';

// Every place a stored file is named: table, column.
const REFS = [['files', 'storage'], ['file_versions', 'storage'], ['form_uploads', 'storage'], ['note_pictures', 'storage'], ['orgs', 'logo']];

function namesIn(query) {
  const out = new Set();
  for (const [t, c] of REFS) {
    try { for (const r of query(`SELECT ${c} AS s FROM ${t} WHERE ${c} IS NOT NULL`)) out.add(String(r.s)); } catch { /* not in this database (an older snapshot) */ }
  }
  return out;
}

const live = () => namesIn((sql) => q(sql).all());
function inSnapshots(dir) {
  const out = new Set();
  for (const b of listBackups(dir)) {
    let d;
    try { d = new DatabaseSync(path.join(dir, b.name), { readOnly: true }); for (const s of namesIn((sql) => d.prepare(sql).all())) out.add(s); }
    catch { /* not readable: ignored */ }
    finally { try { d?.close(); } catch { /* closed */ } }
  }
  return out;
}

/** { files, bytes, unused: { count, bytes }, kept_for_snapshots, missing: { count, list: [{ id, name, owner }] } } */
export function checkBlobs({ filesDir = FILES_DIR, backupDir = BACKUP_DIR, now = Date.now(), minAgeMs = 3600e3 } = {}) {
  const used = live(), snap = inSnapshots(backupDir);
  let files = 0, bytes = 0, keptForSnapshots = 0;
  const unused = [];
  for (const name of fs.readdirSync(filesDir)) {
    let st; try { st = fs.statSync(path.join(filesDir, name)); } catch { continue; }
    if (!st.isFile()) continue;
    files++; bytes += st.size;
    if (used.has(name)) continue;
    if (snap.has(name)) { keptForSnapshots++; continue; }
    if (now - st.mtimeMs < minAgeMs) continue;
    unused.push({ name, size: st.size });
  }
  const gone = [...used].filter((s) => !fs.existsSync(path.join(filesDir, s)));
  const list = gone.length ? q(`SELECT f.id, f.name, u.name AS owner FROM files f LEFT JOIN users u ON u.id = f.owner_id WHERE f.storage IN (SELECT value FROM json_each(?)) ORDER BY f.name LIMIT 50`).all(JSON.stringify(gone)) : [];
  return { files, bytes, unused: { count: unused.length, bytes: unused.reduce((n, u) => n + u.size, 0), names: unused.map((u) => u.name) }, kept_for_snapshots: keptForSnapshots, missing: { count: gone.length, list } };
}

/** Remove the unused files (as checkBlobs finds them now). Returns { count, bytes }. */
export function removeUnused(opts = {}) {
  const { unused } = checkBlobs(opts);
  const dir = opts.filesDir || FILES_DIR;
  for (const n of unused.names) fs.rmSync(path.join(dir, n), { force: true });
  return { count: unused.count, bytes: unused.bytes };
}
