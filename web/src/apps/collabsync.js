// The shared (Yjs) form of spreadsheets and presentations: the same code as the end of
// server/src/collabdoc.js, which the server uses to load and save them. Keep the two in step
// (web/src/apps/collabsync.test.js checks).
import * as Y from 'yjs';

// ---- spreadsheets: a list of sheets, each with cells, column widths, formats and charts as maps, so two
// people changing different cells at once both keep their change (the same cell: the later wins).
const SHEET_MAPS = ['cells', 'colWidths', 'formats', 'charts']; // charts: id → { type, range, title, x, y, w, h }

/** Make a Y.Map for one sheet from its JSON. */
function sheetMap(sheet) {
  const m = new Y.Map();
  m.set('name', sheet.name || 'Sheet');
  if (sheet.frozen) m.set('frozen', sheet.frozen); // { rows, cols } kept in view while scrolling
  if (sheet.rules?.length) m.set('rules', sheet.rules); // conditional formatting
  if (sheet.validations?.length) m.set('validations', sheet.validations); // dropdowns and tick boxes
  for (const k of SHEET_MAPS) {
    const inner = new Y.Map();
    for (const [key, v] of Object.entries(sheet[k] || {})) inner.set(key, v);
    m.set(k, inner);
  }
  return m;
}

export function sheetDocFromJson(json) {
  const doc = new Y.Doc();
  doc.transact(() => { doc.getArray('sheets').push((json?.sheets?.length ? json.sheets : [{ name: 'Sheet1' }]).map(sheetMap)); });
  return doc;
}

export function jsonFromSheetDoc(doc) {
  return { sheets: doc.getArray('sheets').toArray().map((m) => {
    const s = { name: m.get('name') };
    if (m.get('frozen')) s.frozen = m.get('frozen');
    if (m.get('rules')?.length) s.rules = m.get('rules');
    if (m.get('validations')?.length) s.validations = m.get('validations');
    for (const k of SHEET_MAPS) { const inner = m.get(k); s[k] = inner ? inner.toJSON() : {}; }
    for (const k of ['formats', 'charts']) if (!Object.keys(s[k]).length) delete s[k];
    return s;
  }) };
}

/**
 * Bring the shared spreadsheet in line with `next` using the smallest changes (cell by cell), so
 * concurrent edits elsewhere are kept. Used by the editor for each change it makes.
 */
export function applySheetJson(doc, next) {
  const arr = doc.getArray('sheets');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  doc.transact(() => {
    const want = next.sheets || [];
    if (arr.length > want.length) arr.delete(want.length, arr.length - want.length);
    want.forEach((sheet, i) => {
      if (i >= arr.length) { arr.push([sheetMap(sheet)]); return; }
      const m = arr.get(i);
      if (m.get('name') !== sheet.name) m.set('name', sheet.name);
      if (!same(m.get('frozen') || null, sheet.frozen || null)) { if (sheet.frozen) m.set('frozen', sheet.frozen); else m.delete('frozen'); }
      if (!same(m.get('rules') || [], sheet.rules || [])) { if (sheet.rules?.length) m.set('rules', sheet.rules); else m.delete('rules'); }
      if (!same(m.get('validations') || [], sheet.validations || [])) { if (sheet.validations?.length) m.set('validations', sheet.validations); else m.delete('validations'); }
      for (const k of SHEET_MAPS) {
        let inner = m.get(k);
        if (!inner) { inner = new Y.Map(); m.set(k, inner); }
        const target = sheet[k] || {};
        for (const key of [...inner.keys()]) if (!(key in target)) inner.delete(key);
        for (const [key, v] of Object.entries(target)) if (!same(inner.get(key), v)) inner.set(key, v);
      }
    });
  });
}

// ---- presentations: slide order, and each slide's boxes by id, so different boxes (or slides)
// changed at once both stay; the same box keeps the later change.
function slideMap(slide) {
  const m = new Y.Map();
  if (slide.bg) m.set('bg', slide.bg);
  if (slide.notes) m.set('notes', slide.notes); // speaker notes
  const order = new Y.Array();
  order.push((slide.items || []).map((it) => it.id));
  m.set('order', order);
  const items = new Y.Map();
  for (const it of slide.items || []) items.set(it.id, it);
  m.set('items', items);
  return m;
}

export function deckDocFromJson(json) {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getMap('deck').set('theme', json?.theme || 'light');
    const slides = json?.slides?.length ? json.slides : [{ id: 's1', items: [] }];
    doc.getArray('order').push(slides.map((s) => s.id));
    const all = doc.getMap('slides');
    for (const s of slides) all.set(s.id, slideMap(s));
  });
  return doc;
}

export function jsonFromDeckDoc(doc) {
  const all = doc.getMap('slides');
  return {
    theme: doc.getMap('deck').get('theme') || 'light',
    slides: doc.getArray('order').toArray().filter((id) => all.has(id)).map((id) => {
      const m = all.get(id);
      const items = m.get('items');
      const s = { id, items: m.get('order').toArray().filter((iid) => items.has(iid)).map((iid) => items.get(iid)) };
      if (m.get('bg')) s.bg = m.get('bg');
      if (m.get('notes')) s.notes = m.get('notes');
      return s;
    }),
  };
}

/** Bring the shared presentation in line with `next` with the smallest changes. */
export function applyDeckJson(doc, next) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const setOrder = (arr, ids) => { if (!same(arr.toArray(), ids)) { arr.delete(0, arr.length); arr.push(ids); } };
  doc.transact(() => {
    const deck = doc.getMap('deck');
    if (deck.get('theme') !== next.theme) deck.set('theme', next.theme);
    const all = doc.getMap('slides');
    const want = next.slides || [];
    for (const id of [...all.keys()]) if (!want.some((s) => s.id === id)) all.delete(id);
    for (const s of want) {
      if (!all.has(s.id)) { all.set(s.id, slideMap(s)); continue; }
      const m = all.get(s.id);
      if ((m.get('bg') || null) !== (s.bg || null)) { if (s.bg) m.set('bg', s.bg); else m.delete('bg'); }
      if ((m.get('notes') || '') !== (s.notes || '')) { if (s.notes) m.set('notes', s.notes); else m.delete('notes'); }
      const items = m.get('items');
      for (const iid of [...items.keys()]) if (!s.items.some((it) => it.id === iid)) items.delete(iid);
      for (const it of s.items) if (!same(items.get(it.id), it)) items.set(it.id, it);
      setOrder(m.get('order'), s.items.map((it) => it.id));
    }
    setOrder(doc.getArray('order'), want.map((s) => s.id));
  });
}
