// Uploading a file whose name is already in the folder: replace it (a new version: the old one stays in
// its version history) or keep both ("report (1).pdf", as the server names it).

/**
 * The uploads (straight into this folder, not inside a folder being uploaded) whose name an uploaded file
 * here already has: Map(upload id → that file). Names must match exactly, as the server compares them ("Report.pdf" and "report.pdf" can sit side by side).
 * `canReplace` says whether that file can take a new version (an uploaded file you may edit, not locked).
 */
export function findClashes(items, here = []) {
  const byName = new Map();
  for (const f of here) if (f && !f.trashed && f.kind === 'file') byName.set(f.name, f);
  const out = new Map();
  for (const it of items) {
    if (it.dir?.length) continue;
    const f = byName.get(it.file.name);
    if (f) out.set(it.id, { ...f, canReplace: (f.role === 'owner' || f.role === 'editor') && !f.locked_at });
  }
  return out;
}

/** What the question says: one file by name, or how many. */
export function clashQuestion(clashes) {
  const list = [...clashes.values()];
  return list.length === 1 ? `“${list[0].name}” is already in this folder` : `${list.length} files with these names are already in this folder`;
}
