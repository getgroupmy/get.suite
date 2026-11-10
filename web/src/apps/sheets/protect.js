// Protected sheets and ranges (Sheets): the same rules as server/src/sheetprotect.js (keep the two
// alike). A sheet's `protected` list holds entries like
// { id, range: 'A1:C9' | null (the whole sheet), editors: [user ids], by, desc, warn }. Only the
// file's owner, whoever set one up and its listed editors may change what it covers; `warn` ones
// just ask for a confirmation first.

const REF = /^([A-Z]+)([0-9]+)$/;
function ref(text) {
  const m = REF.exec(String(text || '').toUpperCase());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
  return { c: c - 1, r: Number(m[2]) - 1 };
}

/** { c1, r1, c2, r2 } of "A1:C9" (or "B4"), or null. */
export function rangeBox(text) {
  const [a, b = a] = String(text || '').split(':');
  const p = ref(a), q = ref(b);
  if (!p || !q) return null;
  return { c1: Math.min(p.c, q.c), r1: Math.min(p.r, q.r), c2: Math.max(p.c, q.c), r2: Math.max(p.r, q.r) };
}

/** May this person change what the protection covers? */
export function mayEdit(p, userId, ownerId) {
  return !!p && (userId === ownerId || p.by === userId || (p.editors || []).includes(userId));
}

/** The protections on a sheet that cover a cell ("B4"). */
export function protectionsAt(sheet, key) {
  const at = ref(key);
  if (!at) return [];
  return (sheet?.protected || []).filter((p) => {
    if (!p.range) return true;
    const b = rangeBox(p.range);
    return b && at.c >= b.c1 && at.c <= b.c2 && at.r >= b.r1 && at.r <= b.r2;
  });
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const withoutList = (s) => { const { protected: _p, views: _v, ...rest } = s || {}; return rest; }; // filter views change no data

/** Does a change to `sheet` touch anything inside the box? */
function touched(before, after, box) {
  for (const k of ['cells', 'formats']) {
    const a = before?.[k] || {}, b = after?.[k] || {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = ref(key);
      if (!p || p.c < box.c1 || p.c > box.c2 || p.r < box.r1 || p.r > box.r2) continue;
      if (!same(a[key], b[key])) return true;
    }
  }
  return false;
}

/**
 * The protections a change from `before` to `after` (whole spreadsheets: { sheets }) breaks.
 * Each is { p, sheet: name }. With `{ warnings: true }` warn-only protections count too (the
 * browser asks about those); otherwise only the enforced ones, which the server refuses.
 */
export function brokenProtections(before, after, userId, ownerId, { warnings = false } = {}) {
  const out = [];
  const afterSheets = after?.sheets || [];
  const find = (id) => {
    for (const s of afterSheets) { const p = (s.protected || []).find((x) => x.id === id); if (p) return { s, p }; }
    return null;
  };
  for (const s of before?.sheets || []) {
    for (const p of s.protected || []) {
      if (mayEdit(p, userId, ownerId) || (p.warn && !warnings)) continue;
      const now = find(p.id);
      // Taking the protection off, changing it, or deleting its sheet.
      if (!now || !same(now.p, p)) { out.push({ p, sheet: s.name }); continue; }
      const broke = p.range ? (() => { const box = rangeBox(p.range); return box && touched(s, now.s, box); })()
        : !same(withoutList(s), withoutList(now.s));
      if (broke) out.push({ p, sheet: s.name });
    }
  }
  return out;
}
