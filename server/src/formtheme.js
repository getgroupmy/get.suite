// A form's look: an accent colour (the top bar, buttons, ticked options), a tinted page behind it,
// a font style, and a header picture across the top. Kept as JSON on the form; anything not
// recognised is dropped, so the page people fill in only ever gets these known values.
export const FORM_COLORS = {
  purple: '#673ab7', blue: '#3f51b5', sky: '#0288d1', teal: '#00897b', green: '#43a047',
  orange: '#ef6c00', red: '#e53935', pink: '#d81b60', grey: '#607d8b',
};
export const FORM_FONTS = ['basic', 'decorative', 'formal', 'playful'];
export const FORM_BACKGROUNDS = ['plain', 'tinted'];

/** The theme to keep from what was sent (null: the plain default look). */
export function cleanTheme(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  if (Object.hasOwn(FORM_COLORS, raw.color)) out.color = raw.color;
  if (FORM_FONTS.includes(raw.font) && raw.font !== 'basic') out.font = raw.font;
  if (raw.background === 'tinted') out.background = 'tinted';
  if (typeof raw.header === 'string' && /^[\w-]{1,64}$/.test(raw.header)) {
    out.header = raw.header;
    const alt = String(raw.header_alt ?? '').trim().slice(0, 300);
    if (alt) out.header_alt = alt;
  }
  return Object.keys(out).length ? out : null;
}

/** The theme stored on a form row (tolerating bad JSON). */
export function themeOf(form) {
  try { return cleanTheme(JSON.parse(form?.theme || 'null')); } catch { return null; }
}
