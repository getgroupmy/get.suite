// Renaming several files at once (Drive → select → Rename): find and replace in the names (plain text,
// any case or exact), and text added before and after. "After" goes before a file's extension
// (report.pdf → report (final).pdf); folders, documents, spreadsheets and presentations have none.
const hasExtension = (kind) => kind === 'file';

/** The new name for `name` (of a file of `kind`), or the same name when nothing applies. */
export function renamed(name, kind, { find = '', replace = '', prefix = '', suffix = '', matchCase = false } = {}) {
  let n = String(name);
  if (find) {
    const re = new RegExp(String(find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi');
    n = n.replace(re, () => String(replace));
  }
  if (suffix) {
    const m = hasExtension(kind) ? /^(.+?)(\.[A-Za-z0-9]{1,8})$/.exec(n) : null;
    n = m ? `${m[1]}${suffix}${m[2]}` : `${n}${suffix}`;
  }
  if (prefix) n = `${prefix}${n}`;
  return n.trim();
}
