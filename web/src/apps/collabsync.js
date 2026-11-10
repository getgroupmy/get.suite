// The shared (Yjs) form of spreadsheets and presentations: the same code as the end of
// server/src/collabdoc.js, which the server uses to load and save them. Keep the two in step
// (web/src/apps/collabsync.test.js checks).
import * as Y from 'yjs';

// ---- spreadsheets: a list of sheets, each with cells, column widths, formats and charts as maps, so two
// people changing different cells at once both keep their change (the same cell: the later wins).
const SHEET_MAPS = ['cells', 'colWidths', 'rowHeights', 'formats', 'charts', 'notes', 'slicers']; // charts: id → { type, range, title, x, y, w, h }; notes: cell → text; rowHeights: row number → pixels

/** Make a Y.Map for one sheet from its JSON. */
function sheetMap(sheet) {
  const m = new Y.Map();
  m.set('name', sheet.name || 'Sheet');
  if (sheet.frozen) m.set('frozen', sheet.frozen); // { rows, cols } kept in view while scrolling
  if (sheet.rules?.length) m.set('rules', sheet.rules); // conditional formatting
  if (sheet.validations?.length) m.set('validations', sheet.validations); // dropdowns and tick boxes
  if (sheet.filter) m.set('filter', sheet.filter); // { range, hidden: { col: [values] } }
  if (sheet.merges?.length) m.set('merges', sheet.merges); // merged cells: ["A1:C1", …]
  if (sheet.hide) m.set('hide', sheet.hide); // hidden rows and columns: { rows: [2, 3], cols: [0] }
  if (sheet.groups) m.set('groups', sheet.groups); // grouped rows and columns: [{ axis, from, to, collapsed }]
  if (sheet.pivot) m.set('pivot', sheet.pivot); // a pivot table: { source, c1, c2, r1, rows, cols, value, fn }
  if (sheet.names) m.set('names', sheet.names); // named ranges: { Tax: 'B1', Sales: 'A2:A10' }
  if (sheet.protected?.length) m.set('protected', sheet.protected); // protected ranges (sheetprotect.js)
  if (sheet.bands?.length) m.set('bands', sheet.bands); // alternating colours: [{ id, range, header, footer, head, odd, even, foot }]
  for (const k of SHEET_MAPS) {
    const inner = new Y.Map();
    for (const [key, v] of Object.entries(sheet[k] || {})) inner.set(key, v);
    m.set(k, inner);
  }
  return m;
}

export function sheetDocFromJson(json) {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getArray('sheets').push((json?.sheets?.length ? json.sheets : [{ name: 'Sheet1' }]).map(sheetMap));
    if (json?.functions?.length) doc.getMap('book').set('functions', json.functions); // named functions, for the whole spreadsheet
  });
  return doc;
}

export function jsonFromSheetDoc(doc) {
  return { sheets: doc.getArray('sheets').toArray().map((m) => {
    const s = { name: m.get('name') };
    if (m.get('frozen')) s.frozen = m.get('frozen');
    if (m.get('rules')?.length) s.rules = m.get('rules');
    if (m.get('validations')?.length) s.validations = m.get('validations');
    if (m.get('filter')) s.filter = m.get('filter');
    if (m.get('merges')?.length) s.merges = m.get('merges');
    if (m.get('hide')) s.hide = m.get('hide');
    if (m.get('groups')) s.groups = m.get('groups');
    if (m.get('pivot')) s.pivot = m.get('pivot');
    if (m.get('names')) s.names = m.get('names');
    if (m.get('protected')?.length) s.protected = m.get('protected');
    if (m.get('bands')?.length) s.bands = m.get('bands');
    for (const k of SHEET_MAPS) { const inner = m.get(k); s[k] = inner ? inner.toJSON() : {}; }
    for (const k of ['rowHeights', 'formats', 'charts', 'notes', 'slicers']) if (!Object.keys(s[k]).length) delete s[k];
    return s;
  }), ...(doc.getMap('book').get('functions')?.length && { functions: doc.getMap('book').get('functions') }) };
}

/**
 * Bring the shared spreadsheet in line with `next` using the smallest changes (cell by cell), so
 * concurrent edits elsewhere are kept. Used by the editor for each change it makes.
 */
export function applySheetJson(doc, next) {
  const arr = doc.getArray('sheets');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  doc.transact(() => {
    const book = doc.getMap('book');
    if (!same(book.get('functions') || [], next.functions || [])) { if (next.functions?.length) book.set('functions', next.functions); else book.delete('functions'); }
    const want = next.sheets || [];
    if (arr.length > want.length) arr.delete(want.length, arr.length - want.length);
    want.forEach((sheet, i) => {
      if (i >= arr.length) { arr.push([sheetMap(sheet)]); return; }
      const m = arr.get(i);
      if (m.get('name') !== sheet.name) m.set('name', sheet.name);
      if (!same(m.get('frozen') || null, sheet.frozen || null)) { if (sheet.frozen) m.set('frozen', sheet.frozen); else m.delete('frozen'); }
      if (!same(m.get('rules') || [], sheet.rules || [])) { if (sheet.rules?.length) m.set('rules', sheet.rules); else m.delete('rules'); }
      if (!same(m.get('validations') || [], sheet.validations || [])) { if (sheet.validations?.length) m.set('validations', sheet.validations); else m.delete('validations'); }
      if (!same(m.get('filter') || null, sheet.filter || null)) { if (sheet.filter) m.set('filter', sheet.filter); else m.delete('filter'); }
      if (!same(m.get('merges') || [], sheet.merges || [])) { if (sheet.merges?.length) m.set('merges', sheet.merges); else m.delete('merges'); }
      if (!same(m.get('hide') || null, sheet.hide || null)) { if (sheet.hide) m.set('hide', sheet.hide); else m.delete('hide'); }
      if (!same(m.get('groups') || null, sheet.groups || null)) { if (sheet.groups) m.set('groups', sheet.groups); else m.delete('groups'); }
      if (!same(m.get('pivot') || null, sheet.pivot || null)) { if (sheet.pivot) m.set('pivot', sheet.pivot); else m.delete('pivot'); }
      if (!same(m.get('names') || null, sheet.names || null)) { if (sheet.names) m.set('names', sheet.names); else m.delete('names'); }
      if (!same(m.get('protected') || [], sheet.protected || [])) { if (sheet.protected?.length) m.set('protected', sheet.protected); else m.delete('protected'); }
      if (!same(m.get('bands') || [], sheet.bands || [])) { if (sheet.bands?.length) m.set('bands', sheet.bands); else m.delete('bands'); }
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
const SLIDE_KEYS = ['bg', 'bgImage', 'notes', 'transition', 'skip', 'advance']; // bgImage: a picture behind the slide; advance: seconds before moving on by itself
const DECK_KEYS = ['numbers', 'loop', 'custom', 'master']; // slide numbers (true or 'skip-first'); start again after the last slide; its own theme { bg, text, accent, font }; a logo and footer on every slide
function slideMap(slide) {
  const m = new Y.Map();
  for (const k of SLIDE_KEYS) if (slide[k]) m.set(k, slide[k]); // background, speaker notes, transition, skipped when presenting
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
    for (const k of DECK_KEYS) if (json?.[k]) doc.getMap('deck').set(k, json[k]);
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
    ...Object.fromEntries(DECK_KEYS.filter((k) => doc.getMap('deck').get(k)).map((k) => [k, doc.getMap('deck').get(k)])),
    slides: doc.getArray('order').toArray().filter((id) => all.has(id)).map((id) => {
      const m = all.get(id);
      const items = m.get('items');
      const s = { id, items: m.get('order').toArray().filter((iid) => items.has(iid)).map((iid) => items.get(iid)) };
      for (const k of SLIDE_KEYS) if (m.get(k)) s[k] = m.get(k);
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
    for (const k of DECK_KEYS) if (!same(deck.get(k) || null, next[k] || null)) { if (next[k]) deck.set(k, next[k]); else deck.delete(k); }
    const all = doc.getMap('slides');
    const want = next.slides || [];
    for (const id of [...all.keys()]) if (!want.some((s) => s.id === id)) all.delete(id);
    for (const s of want) {
      if (!all.has(s.id)) { all.set(s.id, slideMap(s)); continue; }
      const m = all.get(s.id);
      for (const k of SLIDE_KEYS) if ((m.get(k) || null) !== (s[k] || null)) { if (s[k]) m.set(k, s[k]); else m.delete(k); }
      const items = m.get('items');
      for (const iid of [...items.keys()]) if (!s.items.some((it) => it.id === iid)) items.delete(iid);
      for (const it of s.items) if (!same(items.get(it.id), it)) items.set(it.id, it);
      setOrder(m.get('order'), s.items.map((it) => it.id));
    }
    setOrder(doc.getArray('order'), want.map((s) => s.id));
  });
}
