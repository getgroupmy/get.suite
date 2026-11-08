// Mail merge: one message written with placeholders ({{First name}}, {{Company}}) sent as a separate,
// personal email to each row of a spreadsheet. web/src/apps/sheets/mailmerge.js is a copy (kept alike
// by a test) for the preview.

const PLACE = /\{\{\s*([^{}]{1,60}?)\s*\}\}/g;
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

/** The placeholders used in some text (as written). */
export function placeholders(text) {
  return [...new Set([...String(text || '').matchAll(PLACE)].map((m) => m[1].trim()))];
}

/** The text with each {{Column}} replaced by the row's value (any case; unknown ones left as they are). */
export function fillTemplate(text, fields, escape = (s) => s) {
  const byName = new Map(Object.entries(fields || {}).map(([k, v]) => [norm(k), v]));
  return String(text || '').replace(PLACE, (m, name) => (byName.has(norm(name)) ? escape(String(byName.get(norm(name)) ?? '')) : m));
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** A plain-text message as simple HTML (paragraphs and line breaks), with the row's values escaped. */
export function mergeHtml(text, fields) {
  return String(text || '').split(/\n{2,}/).map((p) => `<p>${fillTemplate(esc(p), fields, esc).replace(/\n/g, '<br>')}</p>`).join('\n');
}

/** Placeholders in the subject or message that aren't columns (so they'd go out as typed). */
export function unknownPlaceholders(subject, text, columns) {
  const known = new Set(columns.map(norm));
  return [...new Set([...placeholders(subject), ...placeholders(text)])].filter((p) => !known.has(norm(p)));
}
