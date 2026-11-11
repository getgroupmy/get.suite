// A form's look: an accent colour (the top bar, buttons, ticked options), a tinted page behind it,
// a font style, and a header picture across the top. Kept as JSON on the form; anything not
// recognised is dropped, so the page people fill in only ever gets these known values.
// Each dark enough for white text on it (4.5:1 or more, WCAG AA), since buttons on the form use it.
export const FORM_COLORS = {
  purple: '#673ab7', blue: '#3f51b5', sky: '#0277bd', teal: '#00796b', green: '#2e7d32',
  orange: '#c25400', red: '#d32f2f', pink: '#d81b60', grey: '#546e7a',
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
