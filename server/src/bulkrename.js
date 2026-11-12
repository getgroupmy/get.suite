// Renaming several files at once (Drive → select → Rename): find and replace in the names (plain text,
// any case or exact), and text added before and after. "After" goes before a file's extension
// (report.pdf → report (final).pdf); folders, documents, spreadsheets and presentations have none.
const hasExtension = (kind) => kind === 'file';

const splitExt = (name, kind) => {
  const m = hasExtension(kind) ? /^(.+?)(\.[A-Za-z0-9]{1,8})$/.exec(name) : null;
  return m ? [m[1], m[2]] : [name, ''];
};

/**
 * The new name for `name` (of a file of `kind`), or the same name when nothing applies. `base` replaces the whole
 * name (its extension kept); `number` (1, 2, … with `digits` places) is added after it, as for photos.
 */
export function renamed(name, kind, { find = '', replace = '', prefix = '', suffix = '', matchCase = false, base = '', number = null, digits = 1 } = {}) {
  let n = String(name);
  if (base) { const [, ext] = splitExt(n, kind); n = `${base}${ext}`; }
  if (number !== null && number !== undefined) {
    const [stem, ext] = splitExt(n, kind);
    n = `${stem}${stem && !/\s$/.test(stem) ? ' ' : ''}${String(number).padStart(digits, '0')}${ext}`;
  }
  if (find) {
    const re = new RegExp(String(find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi');
    n = n.replace(re, () => String(replace));
  }
  if (suffix) {
    const [stem, ext] = splitExt(n, kind);
    n = `${stem}${suffix}${ext}`;
  }
  if (prefix) n = `${prefix}${n}`;
  return n.trim();
}

/** The order to number things in: by name, with numbers inside names taken as numbers (img2 before img10). */
export const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
