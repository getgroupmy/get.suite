// More on a contact: dates besides the birthday (an anniversary, when they started…) and fields of your
// own (a customer number, a parking space…), each with a label; and related people (a spouse, a manager…). Kept as JSON lists on the contact:
// dates [{ label, date: 'YYYY-MM-DD' | '--MM-DD' }], custom_fields [{ label, value }], up to ten each.
// On a vCard, dates are written the way iPhones and Macs read them (itemN.X-ABDATE with an X-ABLabel;
// ANNIVERSARY is read too), and fields as X-WORKSPACE-FIELD lines carrying their label.
import { birthdayOf } from './birthday.js';
import { escapeText, unescapeText } from './ics.js';

export const MAX_FIELDS = 10;
const parse = (v) => { if (Array.isArray(v)) return v; try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const cleanLabel = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

/** Dates as kept (bad ones left out, or an error when strict). */
export function cleanDates(list, { strict = false } = {}) {
  const out = [];
  for (const x of parse(list)) {
    const label = cleanLabel(x?.label) || 'Anniversary';
    const date = birthdayOf(x?.date);
    if (!date) { if (strict && String(x?.date ?? '').trim()) throw new Error(`“${label}” needs a date (YYYY-MM-DD, or --MM-DD without the year)`); continue; }
    out.push({ label, date });
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}
/** The kinds of related person offered (any other label is kept as written). */
export const RELATIONS = ['Spouse', 'Partner', 'Child', 'Parent', 'Sibling', 'Friend', 'Manager', 'Assistant', 'Relative', 'Other'];
/** Related people as kept: [{ label, name }], a name each (its label "Other" when none); empty ones left out. */
export function cleanRelated(list, { strict = false } = {}) {
  const out = [];
  for (const x of parse(list)) {
    const name = String(x?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200), label = cleanLabel(x?.label);
    if (!name) { if (strict && label && label !== 'Other') throw new Error(`“${label}” needs a name`); continue; }
    out.push({ label: label || 'Other', name });
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}
/** Fields of your own as kept: a label and a value each; empty ones left out. */
export function cleanCustom(list, { strict = false } = {}) {
  const out = [];
  for (const x of parse(list)) {
    const value = String(x?.value ?? '').trim().slice(0, 500), label = cleanLabel(x?.label);
    if (!value && !label) continue;
    if (!label) { if (strict) throw new Error('Each field needs a label'); continue; }
    if (!value) continue;
    out.push({ label, value });
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}

const APPLE = { anniversary: '_$!<Anniversary>!$_', other: '_$!<Other>!$_' };
// The labels iPhones and Macs give related names; vCard 4's RELATED types.
const APPLE_REL = { spouse: 'Spouse', partner: 'Partner', child: 'Child', mother: 'Mother', father: 'Father', parent: 'Parent', brother: 'Brother', sister: 'Sister', friend: 'Friend', manager: 'Manager', assistant: 'Assistant', other: 'Other' };
const REL_TYPES = { spouse: 'Spouse', child: 'Child', parent: 'Parent', sibling: 'Sibling', friend: 'Friend', kin: 'Relative', 'co-worker': 'Colleague', colleague: 'Colleague', sweetheart: 'Partner', agent: 'Assistant' };
const relLabel = (l) => (APPLE_REL[l.toLowerCase()] ? `_$!<${APPLE_REL[l.toLowerCase()]}>!$_` : escapeText(l));
const appleLabel = (l) => APPLE[l.toLowerCase()] || escapeText(l);
const fromApple = (l) => { const m = /^_\$!<(.+)>!\$_$/.exec(l); return m ? m[1] : unescapeText(l); };
const param = (s) => `"${String(s).replace(/"/g, "'")}"`;

/** Card lines for the dates, fields and related people (groups numbered from 9001, clear of a phone's own item1, item2…). */
export function fieldsToLines(dates, custom, related) {
  const lines = [];
  cleanDates(dates).forEach((d, i) => {
    const g = `item${9001 + i}`;
    lines.push(`${g}.X-ABDATE${d.date.startsWith('--') ? ';X-APPLE-OMIT-YEAR=1604' : ''}:${d.date.startsWith('--') ? `1604${d.date.slice(1)}` : d.date}`, `${g}.X-ABLabel:${appleLabel(d.label)}`);
  });
  for (const f of cleanCustom(custom)) lines.push(`X-WORKSPACE-FIELD;LABEL=${param(f.label)}:${escapeText(f.value)}`);
  cleanRelated(related).forEach((x, i) => lines.push(`item${9101 + i}.X-ABRELATEDNAMES:${escapeText(x.name)}`, `item${9101 + i}.X-ABLabel:${relLabel(x.label)}`));
  return lines;
}

/**
 * The dates and fields on a card ({ name, params, value } lines as contentLines gives, in order), and which
 * of those lines they came from (so they aren't kept twice among the card's other lines).
 */
export function fieldsFromLines(lines) {
  const used = new Set();
  const dates = [], custom = [], related = [];
  const groupOf = (l) => (/^([\w-]+)\./.exec(l.name) || [])[1];
  for (const l of lines) {
    const base = l.name.replace(/^[\w-]+\./, '');
    if (base === 'X-ABDATE' || base === 'ANNIVERSARY' || base === 'X-ANNIVERSARY') {
      const g = groupOf(l);
      const labelLine = g ? lines.find((x) => x.name.toUpperCase() === `${g}.X-ABLABEL`.toUpperCase()) : null;
      const label = labelLine ? fromApple(labelLine.value) : 'Anniversary';
      const date = birthdayOf(l.value);
      used.add(l); if (labelLine) used.add(labelLine);
      if (date) dates.push({ label, date });
    } else if (base === 'X-ABRELATEDNAMES') { // Apple's: the label on its group's X-ABLabel
      const g = groupOf(l);
      const labelLine = g ? lines.find((x) => x.name.toUpperCase() === `${g}.X-ABLABEL`.toUpperCase()) : null;
      used.add(l); if (labelLine) used.add(labelLine);
      related.push({ label: labelLine ? fromApple(labelLine.value) : 'Other', name: unescapeText(l.value) });
    } else if (base === 'RELATED' && !/^(urn|https?|mailto):/i.test(l.value.trim())) { // vCard 4, as text
      used.add(l);
      const type = String(l.params.TYPE || '').toLowerCase().split(',').find((t) => REL_TYPES[t]);
      related.push({ label: type ? REL_TYPES[type] : 'Other', name: unescapeText(l.value) });
    } else if (base === 'X-WORKSPACE-FIELD') {
      used.add(l);
      custom.push({ label: String(l.params.LABEL || '').replace(/^"|"$/g, ''), value: unescapeText(l.value) });
    }
  }
  return { dates: cleanDates(dates), custom_fields: cleanCustom(custom), related: cleanRelated(related), used };
}

/** The dates falling between two days (YYYY-MM-DD), for the calendar: [{ label, date, years }]. */
export function datesBetween(list, from, to, between) {
  return cleanDates(list).flatMap((d) => between(d.date, from, to).map((x) => ({ label: d.label, date: x.date, years: x.age })));
}
