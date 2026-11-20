// When an account is deleted, the pictures, videos and sounds it owned that are in colleagues' documents,
// spreadsheets, presentations and forms would go with it (or to whoever gets its Drive, who usually can't edit those
// files, so they still wouldn't show). They go instead to the owner of a file that uses them, into a "Pictures from …"
// folder: nothing in that file changes. Used by several people's files, the others get copies of their own, and
// their files then point at those.
import fs from 'node:fs';
import path from 'node:path';
import { q, FILES_DIR } from './db.js';
import { uid } from './util.js';
import { insertFile, uniqueName, picturesIn } from './routes/files.js';
import { saveAll, resetRoom } from './collab.js';

const parse = (t) => { try { return JSON.parse(t || '{}'); } catch { return {}; } };
const formUses = (f, id) => f.theme?.includes(id) || parse(f.questions).some?.((qu) => qu.image === id || Object.values(qu.option_images || {}).includes(id));

/** Hand `userId`'s media used in others' files to those files' owners. Returns how many were kept: { given, copied }. */
export function rehomeSharedMedia(userId) {
  const media = q(`SELECT * FROM files WHERE owner_id = ? AND kind = 'file' AND trashed = 0
                   AND (mime LIKE 'image/%' OR mime LIKE 'video/%' OR mime LIKE 'audio/%')`).all(userId);
  if (!media.length) return { given: 0, copied: 0 };
  saveAll(); // what's being typed right now counts too
  const name = q('SELECT name FROM users WHERE id = ?').get(userId)?.name || 'a former colleague';
  const folders = new Map();
  const folderOf = (owner) => {
    if (!folders.has(owner)) folders.set(owner, insertFile({ owner, parentId: null, name: `Pictures from ${name}`.slice(0, 255), kind: 'folder' }));
    return folders.get(owner);
  };
  let given = 0, copied = 0;
  for (const m of media) {
    const like = `%${m.id}%`;
    const docs = q(`SELECT id, owner_id, kind, content FROM files WHERE kind IN ('doc', 'sheet', 'slides') AND owner_id != ? AND trashed = 0 AND content LIKE ?`)
      .all(userId, like).filter((d) => picturesIn(d.kind, parse(d.content)).has(m.id));
    const forms = q('SELECT id, owner_id, questions, theme FROM forms WHERE owner_id != ? AND (questions LIKE ? OR theme LIKE ?)')
      .all(userId, like, like).filter((f) => formUses(f, m.id));
    const owners = [...new Set([...docs, ...forms].map((x) => x.owner_id))];
    if (!owners.length) continue;
    // The first: the file itself becomes theirs.
    const [first, ...others] = owners;
    const into = folderOf(first);
    q('UPDATE files SET owner_id = ?, parent_id = ?, name = ? WHERE id = ?').run(first, into, uniqueName(into, first, m.name), m.id);
    q('DELETE FROM shares WHERE file_id = ? AND user_id = ?').run(m.id, first);
    given++;
    // The others: a copy each, and their files point at it.
    for (const owner of others) {
      const storage = uid();
      try { fs.copyFileSync(path.join(FILES_DIR, m.storage), path.join(FILES_DIR, storage)); } catch { continue; }
      const copy = insertFile({ owner, parentId: folderOf(owner), name: m.name, kind: 'file', mime: m.mime, size: m.size, storage, activity: { action: 'copy', details: { from: `${m.name} (${name})` } } });
      copied++;
      for (const d of docs.filter((x) => x.owner_id === owner)) {
        const now = q('SELECT content FROM files WHERE id = ?').get(d.id).content;
        q('UPDATE files SET content = ?, ydoc = NULL WHERE id = ?').run(now.split(m.id).join(copy), d.id);
        resetRoom(d.id); // anyone with it open loads it again
      }
      for (const f of forms.filter((x) => x.owner_id === owner)) {
        const now = q('SELECT questions, theme FROM forms WHERE id = ?').get(f.id);
        q('UPDATE forms SET questions = ?, theme = ? WHERE id = ?').run(now.questions?.split(m.id).join(copy) ?? now.questions, now.theme?.split(m.id).join(copy) ?? now.theme, f.id);
      }
    }
  }
  return { given, copied };
}
