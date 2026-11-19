// A sheet copied into a spreadsheet (Sheets: the tab's ▾ → Copy to another spreadsheet…), as the editor copies one
// within a spreadsheet (web/src/apps/sheets/sheetorder.js): new ids where a spreadsheet needs them unique (charts,
// which documents show by id; slicers; filter views), its tables without their names (a table's name is the whole
// file's), shown, and by its own name unless that's taken there ("Copy of …", then "Copy of … 2").
import crypto from 'node:crypto';

/** A name for the sheet among `names`: its own when free, else "Copy of …" (then "… 2"…), whatever their case. */
export function freeSheetName(name, names) {
  const taken = new Set(names.map((x) => String(x).toLowerCase()));
  const own = String(name || 'Sheet').slice(0, 30);
  if (!taken.has(own.toLowerCase())) return own;
  const base = `Copy of ${own}`.slice(0, 26);
  if (!taken.has(base.toLowerCase())) return base;
  for (let k = 2; ; k++) if (!taken.has(`${base} ${k}`.toLowerCase())) return `${base} ${k}`;
}

/** The copy of `sheet` to add to a spreadsheet whose sheets are named `names`. */
export function sheetCopyFor(sheet, names, newId = () => crypto.randomBytes(9).toString('base64url')) {
  const copy = JSON.parse(JSON.stringify(sheet));
  copy.name = freeSheetName(sheet.name, names);
  delete copy.hidden;
  for (const key of ['charts', 'slicers', 'views']) {
    if (!copy[key]) continue;
    copy[key] = Object.fromEntries(Object.values(copy[key]).map((v) => { const id = newId(); return [id, { ...v, id }]; }));
  }
  if (copy.bands) copy.bands = copy.bands.map(({ name, ...b }) => b);
  return copy;
}
