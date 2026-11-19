// Converting a document between its stored JSON (ProseMirror/TipTap) and the shared Yjs form the
// editors co-edit, the same way TipTap's Yjs bridge (y-tiptap) does: elements carry their non-null
// attributes, runs of text become one XmlText with marks as formatting attributes.
import * as Y from 'yjs';
import { withoutSuggestions as acceptedText } from './office/suggestions.js';

function fill(parent, nodes) {
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.type === 'text') {
      const text = new Y.XmlText();
      const delta = [];
      for (; i < nodes.length && nodes[i].type === 'text'; i++) {
        const t = nodes[i];
        delta.push({ insert: t.text || '', attributes: Object.fromEntries((t.marks || []).map((m) => [m.type, m.attrs || {}])) });
      }
      i--;
      out.push([text, delta]);
    } else {
      const el = new Y.XmlElement(n.type);
      for (const [k, v] of Object.entries(n.attrs || {})) if (v !== null && v !== undefined && k !== 'ychange') el.setAttribute(k, v);
      out.push([el, n.content || []]);
    }
  }
  parent.insert(parent.length, out.map(([t]) => t));
  // Children are filled once their parent is part of the document.
  for (const [t, inner] of out) { if (t instanceof Y.XmlText) t.applyDelta(inner); else fill(t, inner); }
}

/** A new Yjs document holding this JSON document. */
export function docFromJson(json, field = 'default') {
  const doc = new Y.Doc();
  doc.transact(() => fill(doc.getXmlFragment(field), json?.content || []));
  return doc;
}

/**
 * Where blocks added to the end of a document go: the document itself, or, in one made of tabs, the tab
 * titled `tab` (any capitals) or else the last. `titles` are the tabs' titles in order ([] for none).
 * Returns { index } (-1: the document itself) or throws with the tabs it has.
 */
export function appendTarget(titles, tab) {
  if (!titles.length) return { index: -1 };
  if (!tab) return { index: titles.length - 1 };
  const i = titles.findIndex((t) => t.toLowerCase() === String(tab).toLowerCase());
  if (i < 0) { const e = new Error(`No tab called “${tab}”: it has ${titles.map((t) => `“${t}”`).join(', ')}`); e.status = 400; throw e; }
  return { index: i };
}
const tabTitle = (attrs, i) => String(attrs?.title || '') || `Tab ${i + 1}`;

/** Add blocks (TipTap JSON nodes) to the end of a live document (or of one of its tabs). Returns the tab's title or null. */
export function appendToYDoc(doc, nodes, tab = null, field = 'default') {
  const frag = doc.getXmlFragment(field);
  const tabs = frag.toArray().filter((x) => x instanceof Y.XmlElement && x.nodeName === 'docTab');
  const { index } = appendTarget(tabs.map((t, i) => tabTitle(t.getAttributes(), i)), tab);
  doc.transact(() => fill(index < 0 ? frag : tabs[index], nodes));
  return index < 0 ? null : tabTitle(tabs[index].getAttributes(), index);
}

/** The same for a stored document: { json, tab }. */
export function appendToJson(json, nodes, tab = null) {
  const content = [...(json?.content || [])];
  const tabs = content.map((n, i) => [n, i]).filter(([n]) => n.type === 'docTab');
  const { index } = appendTarget(tabs.map(([n], i) => tabTitle(n.attrs, i)), tab);
  if (index < 0) return { json: { ...json, type: 'doc', content: [...content, ...nodes] }, tab: null };
  const [node, at] = tabs[index];
  content[at] = { ...node, content: [...(node.content || []), ...nodes] };
  return { json: { ...json, content }, tab: tabTitle(node.attrs, index) };
}

/** The JSON document held in a Yjs document. */
export function jsonFromDoc(doc, field = 'default') {
  const serialize = (item) => {
    if (item instanceof Y.XmlText) {
      return item.toDelta().map((d) => {
        const t = { type: 'text', text: d.insert };
        if (d.attributes && Object.keys(d.attributes).length) {
          t.marks = Object.entries(d.attributes).map(([k, attrs]) => ({ type: k.split('--')[0], ...(attrs && Object.keys(attrs).length && { attrs }) }));
        }
        return t;
      });
    }
    const n = { type: item.nodeName };
    const attrs = item.getAttributes();
    if (Object.keys(attrs).length) n.attrs = attrs;
    const children = item.toArray();
    if (children.length) n.content = children.flatMap(serialize);
    return n;
  };
  return { type: 'doc', content: doc.getXmlFragment(field).toArray().flatMap(serialize) };
}

/**
 * Mark the first place `quote` appears (within one paragraph) with a comment mark, the way a comment made in
 * Docs marks its words, in a live document. Returns whether it was found.
 */
export function markQuoteInYDoc(doc, quote, commentId, field = 'default') {
  let done = false;
  const walk = (node) => {
    for (const child of node.toArray()) {
      if (done) return;
      if (child instanceof Y.XmlText) {
        const plain = child.toDelta().map((d) => (typeof d.insert === 'string' ? d.insert : '￼')).join('');
        const at = plain.indexOf(quote);
        if (at >= 0) { doc.transact(() => child.format(at, quote.length, { comment: { id: commentId } })); done = true; }
      } else if (child instanceof Y.XmlElement) walk(child);
    }
  };
  walk(doc.getXmlFragment(field));
  return done;
}

/** The same for a stored document: { json, found }. Text nodes are split where the mark starts and ends. */
export function markQuoteInJson(json, quote, commentId) {
  let found = false;
  const visit = (node) => {
    if (found || !Array.isArray(node.content)) return node;
    const kids = node.content;
    if (kids.some((k) => k.type === 'text')) {
      // Runs of text nodes (with anything else between them counting as one character, as in the editor).
      const plain = kids.map((k) => (k.type === 'text' ? k.text || '' : '￼')).join('');
      const at = plain.indexOf(quote);
      if (at >= 0) {
        found = true;
        const end = at + quote.length, out = [];
        let pos = 0;
        for (const k of kids) {
          const len = k.type === 'text' ? (k.text || '').length : 1;
          const s = pos, e = pos + len; pos = e;
          if (k.type !== 'text' || e <= at || s >= end) { out.push(k); continue; }
          const cut = (a, b, mark) => { if (b > a) out.push({ ...k, text: k.text.slice(a - s, b - s), ...(mark ? { marks: [...(k.marks || []).filter((m) => m.type !== 'comment'), { type: 'comment', attrs: { id: commentId } }] } : {}) }); };
          cut(s, Math.max(s, at), false); cut(Math.max(s, at), Math.min(e, end), true); cut(Math.min(e, end), e, false);
        }
        return { ...node, content: out };
      }
    }
    return { ...node, content: kids.map(visit) };
  };
  const out = visit(json || { type: 'doc', content: [] });
  return { json: out, found };
}

// ---- find and replace in a document's text (an assistant's "change X to Y"): a paragraph's text at a time, so a match
// may cross formatting; the replacement takes the formatting of the match's first letter. At most `limit` places.
const occurrences = (plain, find, matchCase, all, taken = null) => {
  const hay = matchCase ? plain : plain.toLowerCase(), needle = matchCase ? find : find.toLowerCase();
  const out = [];
  for (let at = hay.indexOf(needle); at >= 0 && needle; at = hay.indexOf(needle, at + needle.length)) {
    if (taken && taken(at, at + needle.length)) continue; // (suggesting: not words already in a suggestion)
    if (!/￼/.test(plain.slice(at, at + needle.length))) out.push(at); // (not across a picture, chip or other object)
    if (!all && out.length) break;
  }
  return out;
};

// Suggesting ("track changes"), as Docs' suggesting mode marks it: who, when, and an id shared by a replacement's two halves.
const suggestionMark = (who) => ({ id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, by: who.by || null, name: who.name || '', at: who.at || Date.now() });
const withoutSuggestions = (a) => { const { suggestDelete, suggestInsert, ...rest } = a || {}; return rest; };
const SUGGEST_MARKS = new Set(['suggestDelete', 'suggestInsert']);

/** Replace in a live document: { count }. With suggest ({ by, name }), as suggestions to accept or reject instead. */
export function replaceInYDoc(doc, find, replace, { all = true, matchCase = true, limit = 1000, field = 'default', suggest = null } = {}) {
  let count = 0;
  const walk = (node) => {
    for (const child of node.toArray()) {
      if (count >= limit || (!all && count)) return;
      if (child instanceof Y.XmlText) {
        const delta = child.toDelta();
        const plain = delta.map((d) => (typeof d.insert === 'string' ? d.insert : '￼')).join('');
        const suggested = (from, to) => { let p = 0; for (const d of delta) { const len = typeof d.insert === 'string' ? d.insert.length : 1; if (p < to && p + len > from && (d.attributes?.suggestDelete || d.attributes?.suggestInsert)) return true; p += len; } return false; };
        const hits = occurrences(plain, find, matchCase, all, suggest ? suggested : null).slice(0, limit - count);
        if (!hits.length) continue;
        const attrsAt = (pos) => { let p = 0; for (const d of delta) { const len = typeof d.insert === 'string' ? d.insert.length : 1; if (pos < p + len) return d.attributes || {}; p += len; } return {}; };
        doc.transact(() => {
          for (const at of [...hits].reverse()) {
            const a = attrsAt(at);
            if (suggest) { // (a suggestion: the words struck through, the new ones after them, one id for both)
              const mark = suggestionMark(suggest);
              child.format(at, find.length, { suggestDelete: mark });
              if (replace) child.insert(at + find.length, replace, { ...withoutSuggestions(a), suggestInsert: mark });
            } else { child.delete(at, find.length); if (replace) child.insert(at, replace, a); }
          }
        });
        count += hits.length;
      } else if (child instanceof Y.XmlElement) walk(child);
    }
  };
  walk(doc.getXmlFragment(field));
  return { count };
}

/** The same for a stored document: { json, count }. */
export function replaceInJson(json, find, replace, { all = true, matchCase = true, limit = 1000, suggest = null } = {}) {
  let count = 0;
  const visit = (node) => {
    if (!Array.isArray(node.content) || count >= limit || (!all && count)) return node;
    const kids = node.content;
    if (!kids.some((k) => k.type === 'text')) return { ...node, content: kids.map(visit) };
    // Each character with the node it came from; anything not text is one object character.
    const chars = kids.flatMap((k) => (k.type === 'text' ? [...(k.text || '')].map((ch) => ({ ch, k })) : [{ ch: '￼', k }]));
    // (positions in UTF-16 units, as indexOf counts them)
    const units = []; chars.forEach((c, i) => { for (let u = 0; u < c.ch.length; u++) units.push(i); });
    const plain = chars.map((c) => c.ch).join('');
    const suggested = (a, b) => { for (let u = a; u < b; u++) if ((chars[units[u]].k.marks || []).some((m) => SUGGEST_MARKS.has(m.type))) return true; return false; };
    const hits = occurrences(plain, find, matchCase, all, suggest ? suggested : null).slice(0, limit - count);
    if (!hits.length) return { ...node, content: kids.map(visit) };
    let out = [...chars];
    for (const at of [...hits].reverse()) {
      const from = units[at], to = units[at + find.length - 1] + 1;
      const k = out[from].k;
      if (suggest) { // (struck through where they are, the new words after them)
        const mark = suggestionMark(suggest), copies = new Map();
        const struck = out.slice(from, to).map((c) => {
          if (c.k.type !== 'text') return c;
          if (!copies.has(c.k)) copies.set(c.k, { ...c.k, marks: [...(c.k.marks || []), { type: 'suggestDelete', attrs: mark }] });
          return { ch: c.ch, k: copies.get(c.k) };
        });
        const ins = { ...k, marks: [...(k.marks || []).filter((m) => !SUGGEST_MARKS.has(m.type)), { type: 'suggestInsert', attrs: mark }] };
        out.splice(from, to - from, ...struck, ...[...replace].map((ch) => ({ ch, k: ins })));
        continue;
      }
      out.splice(from, to - from, ...[...replace].map((ch) => ({ ch, k })));
    }
    count += hits.length;
    // Back into nodes: neighbouring characters from the same text node (same marks) together.
    const content = [];
    for (const c of out) {
      if (c.k.type !== 'text') { content.push(c.k); continue; }
      const last = content[content.length - 1];
      if (last && last.type === 'text' && last.__from === c.k) last.text += c.ch;
      else content.push({ ...c.k, text: c.ch, __from: c.k });
    }
    return { ...node, content: content.filter((n) => n.type !== 'text' || n.text).map(({ __from, ...n }) => n) };
  };
  return { json: visit(json), count };
}

// ---- pending suggestions (Docs' suggesting mode): listed, and accepted or rejected, as the editor does. A suggestion is
// the text marked suggestDelete and/or suggestInsert with one id; accepting removes what's struck through and keeps what's
// added (unmarked), rejecting the opposite. `pick(suggestion)` chooses which.
const SUGG = ['suggestDelete', 'suggestInsert'];

/** The suggestions in a stored document, in order: [{ id, by, name, at, deleted, inserted }]. */
export function suggestionsInJson(json) {
  const out = new Map();
  const visit = (n) => {
    if (n?.type === 'text') {
      for (const m of n.marks || []) {
        if (!SUGG.includes(m.type) || !m.attrs?.id) continue;
        if (!out.has(m.attrs.id)) out.set(m.attrs.id, { id: m.attrs.id, by: m.attrs.by || null, name: m.attrs.name || '', at: m.attrs.at || 0, deleted: '', inserted: '' });
        out.get(m.attrs.id)[m.type === 'suggestDelete' ? 'deleted' : 'inserted'] += n.text || '';
      }
    }
    (n?.content || []).forEach(visit);
  };
  visit(json);
  return [...out.values()];
}

/** Accept (or reject) the chosen suggestions in a stored document: { json, count } (count: suggestions resolved). */
export function resolveSuggestionsInJson(json, pick, accept) {
  const chosen = new Set(suggestionsInJson(json).filter(pick).map((x) => x.id));
  if (!chosen.size) return { json, count: 0 };
  const gone = accept ? 'suggestDelete' : 'suggestInsert';
  const visit = (n) => {
    if (!Array.isArray(n.content)) return n;
    const content = [];
    for (const k of n.content) {
      if (k.type === 'text') {
        const marks = k.marks || [];
        if (marks.some((m) => m.type === gone && chosen.has(m.attrs?.id))) continue; // (this text goes)
        const kept = marks.filter((m) => !(SUGG.includes(m.type) && chosen.has(m.attrs?.id)));
        const node = { ...k };
        if (kept.length) node.marks = kept; else delete node.marks;
        const prev = content[content.length - 1];
        if (prev?.type === 'text' && JSON.stringify(prev.marks || []) === JSON.stringify(node.marks || [])) { prev.text += node.text; continue; }
        content.push(node);
      } else content.push(visit(k));
    }
    return { ...n, content };
  };
  return { json: visit(json), count: chosen.size };
}

/** The suggestions in a live document. */
export function suggestionsInYDoc(doc, field = 'default') { return suggestionsInJson(jsonFromDoc(doc, field)); }

/** Accept (or reject) the chosen suggestions in a live document: { count }. */
export function resolveSuggestionsInYDoc(doc, pick, accept, field = 'default') {
  const chosen = new Set(suggestionsInYDoc(doc, field).filter(pick).map((x) => x.id));
  if (!chosen.size) return { count: 0 };
  const gone = accept ? 'suggestDelete' : 'suggestInsert';
  const walk = (node) => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) {
        const runs = []; let pos = 0;
        for (const d of child.toDelta()) {
          const len = typeof d.insert === 'string' ? d.insert.length : 1;
          const a = d.attributes || {};
          // (attribute keys are the mark's name, or name--hash for one of several)
          const mine = Object.keys(a).filter((k) => SUGG.includes(k.split('--')[0]) && chosen.has(a[k]?.id));
          if (mine.length) runs.push({ at: pos, len, drop: mine.some((k) => k.split('--')[0] === gone), unmark: mine });
          pos += len;
        }
        if (runs.length) doc.transact(() => {
          for (const r of [...runs].reverse()) {
            if (r.drop) child.delete(r.at, r.len);
            else child.format(r.at, r.len, Object.fromEntries(r.unmark.map((t) => [t, null])));
          }
        });
      } else if (child instanceof Y.XmlElement) walk(child);
    }
  };
  walk(doc.getXmlFragment(field));
  return { count: chosen.size };
}

// (The editor writes a node's default settings, e.g. a paragraph's indent 0, once it has touched it: an absent setting
// and an empty one are the same here.)
const plainOf = (n) => {
  if (Array.isArray(n)) return n.map(plainOf);
  if (!n || typeof n !== 'object') return n;
  const out = {};
  for (const [k, v] of Object.entries(n)) {
    if (k === 'attrs' && v && typeof v === 'object') {
      const kept = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined && x !== 0 && x !== false && x !== ''));
      if (Object.keys(kept).length) out.attrs = plainOf(kept);
    } else out[k] = plainOf(v);
  }
  return out;
};

/**
 * Whether a change (before → after, stored JSON) by someone who may only suggest touches nothing but their own
 * suggestions: the text as it stands is the same, everyone else's suggestions are as they were, and any new or
 * changed suggestion is theirs. (Commenters suggest edits this way.)
 */
export function onlyOwnSuggestions(before, after, userId) {
  if (JSON.stringify(plainOf(acceptedText(before))) !== JSON.stringify(plainOf(acceptedText(after)))) return false;
  const was = new Map(suggestionsInJson(before).map((x) => [x.id, x]));
  const now = new Map(suggestionsInJson(after).map((x) => [x.id, x]));
  const same = (a, b) => a && b && a.deleted === b.deleted && a.inserted === b.inserted && a.by === b.by;
  for (const [id, x] of was) if (x.by !== userId && !same(x, now.get(id))) return false; // someone else's: untouched
  for (const [id, x] of now) if (!same(x, was.get(id)) && x.by !== userId) return false; // new or changed: theirs
  return true;
}

// ---- spreadsheets: a list of sheets, each with cells, column widths, formats and charts as maps, so two
// people changing different cells at once both keep their change (the same cell: the later wins).
const SHEET_MAPS = ['cells', 'colWidths', 'rowHeights', 'formats', 'charts', 'notes', 'slicers', 'views']; // charts: id → { type, range, title, x, y, w, h }; notes: cell → text; rowHeights: row number → pixels; views: id → filter view

/** Make a Y.Map for one sheet from its JSON. */
function sheetMap(sheet) {
  const m = new Y.Map();
  m.set('name', sheet.name || 'Sheet');
  if (sheet.frozen) m.set('frozen', sheet.frozen); // { rows, cols } kept in view while scrolling
  if (sheet.rules?.length) m.set('rules', sheet.rules); // conditional formatting
  if (sheet.validations?.length) m.set('validations', sheet.validations); // dropdowns and tick boxes
  if (sheet.filter) m.set('filter', sheet.filter); // { range, hidden: { col: [values] } }
  if (sheet.tabColor) m.set('tabColor', sheet.tabColor); // '#rrggbb': the tab's colour
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
    // (blank: made for a spreadsheet started offline, whose own first sheet comes with its copy)
    doc.getArray('sheets').push((json?.sheets?.length ? json.sheets : json?.blank ? [] : [{ name: 'Sheet1' }]).map(sheetMap));
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
    if (m.get('tabColor')) s.tabColor = m.get('tabColor');
    if (m.get('merges')?.length) s.merges = m.get('merges');
    if (m.get('hide')) s.hide = m.get('hide');
    if (m.get('groups')) s.groups = m.get('groups');
    if (m.get('pivot')) s.pivot = m.get('pivot');
    if (m.get('names')) s.names = m.get('names');
    if (m.get('protected')?.length) s.protected = m.get('protected');
    if (m.get('bands')?.length) s.bands = m.get('bands');
    for (const k of SHEET_MAPS) { const inner = m.get(k); s[k] = inner ? inner.toJSON() : {}; }
    for (const k of ['rowHeights', 'formats', 'charts', 'notes', 'slicers', 'views']) if (!Object.keys(s[k]).length) delete s[k];
    return s;
  }), ...(doc.getMap('book').get('functions')?.length && { functions: doc.getMap('book').get('functions') }),
  ...(!doc.getArray('sheets').length && { blank: true }) }; // saved before its offline copy came: still no sheet of its own
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
      if ((m.get('tabColor') || null) !== (sheet.tabColor || null)) { if (sheet.tabColor) m.set('tabColor', sheet.tabColor); else m.delete('tabColor'); }
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
const SLIDE_KEYS = ['bg', 'bgGrad', 'bgImage', 'notes', 'transition', 'skip', 'advance']; // bgGrad: "#rrggbb angle", a fade into that colour; bgImage: a picture behind the slide; advance: seconds before moving on by itself
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
    const slides = json?.slides?.length ? json.slides : json?.blank ? [] : [{ id: 's1', items: [] }]; // (blank: started offline, see sheetDocFromJson)
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
    ...(!doc.getArray('order').length && { blank: true }), // saved before its offline copy came
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
