// A form's look (as the server keeps it, server/src/formtheme.js): accent colour, tinted page, font, header picture.
export const FORM_COLORS = [
  ['purple', 'Purple', '#673ab7'], ['blue', 'Blue', '#3f51b5'], ['sky', 'Sky', '#0288d1'], ['teal', 'Teal', '#00897b'], ['green', 'Green', '#43a047'],
  ['orange', 'Orange', '#ef6c00'], ['red', 'Red', '#e53935'], ['pink', 'Pink', '#d81b60'], ['grey', 'Grey', '#607d8b'],
];
export const FORM_FONTS = [
  ['basic', 'Basic', 'inherit'],
  ['decorative', 'Decorative', 'Georgia, "Palatino Linotype", Palatino, serif'],
  ['formal', 'Formal', '"Times New Roman", Times, serif'],
  ['playful', 'Playful', '"Trebuchet MS", "Comic Sans MS", "Segoe Print", sans-serif'],
];

export const colorOf = (theme) => FORM_COLORS.find(([k]) => k === theme?.color)?.[2] || null;

/** The style for the page people fill in: CSS variables for the accent and font, and the tint behind it. */
export function themeStyle(theme) {
  const c = colorOf(theme);
  const font = FORM_FONTS.find(([k]) => k === theme?.font)?.[2];
  const style = {};
  if (c) { style['--form-accent'] = c; style['--accent'] = c; }
  if (font && font !== 'inherit') style['--form-font'] = font;
  if (theme?.background === 'tinted') style['--form-page'] = `color-mix(in srgb, ${c || 'var(--accent)'} 12%, var(--bg))`;
  return style;
}

/** A change to the theme: patch merged in, defaults dropped (null when nothing is left: the plain look). */
export function withTheme(theme, patch) {
  const next = { ...(theme || {}), ...patch };
  for (const [k, v] of Object.entries(next)) if (v == null || v === '' || (k === 'font' && v === 'basic') || (k === 'background' && v === 'plain')) delete next[k];
  if (!next.header) delete next.header_alt;
  return Object.keys(next).length ? next : null;
}
