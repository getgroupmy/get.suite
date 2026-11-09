// Find and replace (Slides): the text of every text box, table cell and speaker note, slide by slide,
// searched with the same options as Docs (match case, whole words, regular expressions).
import { findPattern, replacementFor } from '../docs/findReplace.js';

/** Every piece of text in the deck, in reading order: { slide, item, cell: [r, c] | null, notes, text }. */
export function placesOf(deck) {
  const out = [];
  (deck?.slides || []).forEach((s, slide) => {
    for (const it of s.items || []) {
      if ((it.type === 'text' || it.type === 'shape') && it.text) out.push({ slide, item: it.id, cell: null, notes: false, text: it.text });
      else if (it.type === 'table') (it.cells || []).forEach((row, r) => row.forEach((v, c) => { if (v) out.push({ slide, item: it.id, cell: [r, c], notes: false, text: String(v) }); }));
    }
    if (s.notes) out.push({ slide, item: null, cell: null, notes: true, text: s.notes });
  });
  return out;
}

const MAX = 5000;

/** The matches of `term`, in reading order: { slide, item, cell, notes, from, to, text, groups }, or { error }. */
export function findInDeck(deck, term, options = {}) {
  if (!term) return { matches: [] };
  const { re, error } = findPattern(term, options);
  if (error) return { matches: [], error };
  const matches = [];
  for (const p of placesOf(deck)) {
    for (const m of p.text.matchAll(re)) {
      if (!m[0]) continue; // an empty match (say, "a*") finds nothing
      matches.push({ ...p, from: m.index, to: m.index + m[0].length, groups: [...m] });
      if (matches.length >= MAX) return { matches };
    }
  }
  return { matches };
}

const samePlace = (a, b) => a.slide === b.slide && a.item === b.item && a.notes === b.notes && String(a.cell) === String(b.cell);

/** A copy of the deck with the given matches replaced (with $1… when `regex`); matches are from findInDeck on this deck. */
export function replaceInDeck(deck, matches, replace, regex = false) {
  if (!matches.length) return deck;
  const swap = (text, place) => {
    const here = matches.filter((m) => samePlace(m, place)).sort((a, b) => b.from - a.from);
    let out = text;
    for (const m of here) out = out.slice(0, m.from) + replacementFor(replace, m, regex) + out.slice(m.to);
    return out;
  };
  const touched = new Set(matches.map((m) => m.slide));
  return {
    ...deck,
    slides: deck.slides.map((s, slide) => {
      if (!touched.has(slide)) return s;
      const items = (s.items || []).map((it) => {
        if ((it.type === 'text' || it.type === 'shape') && it.text) {
          const next = swap(it.text, { slide, item: it.id, cell: null, notes: false });
          return next === it.text ? it : { ...it, text: next || (it.type === 'shape' ? undefined : '') };
        }
        if (it.type === 'table') {
          let changed = false;
          const cells = (it.cells || []).map((row, r) => row.map((v, c) => {
            if (!v) return v;
            const next = swap(String(v), { slide, item: it.id, cell: [r, c], notes: false });
            if (next !== v) changed = true;
            return next;
          }));
          return changed ? { ...it, cells } : it;
        }
        return it;
      });
      const notes = s.notes ? swap(s.notes, { slide, item: null, cell: null, notes: true }) : s.notes;
      return { ...s, items, ...(s.notes !== undefined && { notes: notes || undefined }) };
    }),
  };
}

/** A few words around a match, for the find bar: { before, match, after }. */
export function contextOf(m, room = 30) {
  const before = m.text.slice(Math.max(0, m.from - room), m.from);
  const after = m.text.slice(m.to, m.to + room);
  return { before: (m.from > room ? '…' : '') + before, match: m.text.slice(m.from, m.to), after: after + (m.to + room < m.text.length ? '…' : '') };
}
