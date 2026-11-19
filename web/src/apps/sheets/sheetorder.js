// Moving, copying and deleting sheets (the tab's ▾ menu). What refers to a sheet by its place (comments: { sheet, cell })
// follows it: `placesAfter` says where each sheet is afterwards.

/** Where each sheet (by its place, 0…n-1) is after `op`: an array of new places, null for one that's gone.
 *  op: { move: [from, to] } | { copy: i } (a copy right after it) | { remove: i } */
export function placesAfter(n, op) {
  const out = Array.from({ length: n }, (_, i) => i);
  if (op.move) {
    const [from, to] = op.move;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return out;
    return out.map((i) => (i === from ? to : from < to && i > from && i <= to ? i - 1 : from > to && i >= to && i < from ? i + 1 : i));
  }
  if (op.copy !== undefined) return out.map((i) => (i > op.copy ? i + 1 : i));
  if (op.remove !== undefined) return out.map((i) => (i === op.remove ? null : i > op.remove ? i - 1 : i));
  return out;
}

/** The sheets after moving the one at `from` to `to`. */
export function moveSheet(sheets, from, to) {
  if (from === to || to < 0 || to >= sheets.length) return sheets;
  const next = sheets.slice();
  const [s] = next.splice(from, 1);
  next.splice(to, 0, s);
  return next;
}

/** A copy's name: "Copy of Budget", then "Copy of Budget 2"… (names are unique, whatever their case). */
export function copyName(name, names) {
  const taken = new Set(names.map((x) => String(x).toLowerCase()));
  const base = `Copy of ${name}`.slice(0, 26);
  if (!taken.has(base.toLowerCase())) return base;
  for (let k = 2; ; k++) if (!taken.has(`${base} ${k}`.toLowerCase())) return `${base} ${k}`;
}

/**
 * A copy of a sheet, to sit right after it: everything it holds, with new ids where the file needs them unique
 * (charts, which documents show by id; slicers; filter views), and its tables without their names (a table's name
 * is the file's: the copy keeps the colours).
 */
export function copySheet(sheet, names, newId) {
  const copy = JSON.parse(JSON.stringify(sheet));
  copy.name = copyName(sheet.name, names);
  for (const key of ['charts', 'slicers', 'views']) {
    if (!copy[key]) continue;
    copy[key] = Object.fromEntries(Object.values(copy[key]).map((v) => { const id = newId(); return [id, { ...v, id }]; }));
  }
  if (copy.bands) copy.bands = copy.bands.map(({ name, ...b }) => b);
  return copy;
}
