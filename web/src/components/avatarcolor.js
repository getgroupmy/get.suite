// An avatar's colour from a name: the same name always gets the same hue, made dark enough that
// its white initials can be read (contrast of at least 4.5:1, as for normal text).

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
const lum = ([r, g, b]) => { const c = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b); };
/** Contrast of white text on this colour. */
export const whiteContrast = (h, s, l) => 1.05 / (lum(hslToRgb(h, s, l)) + 0.05);

/** A hue's avatar colour: as light as 45%, darker where white wouldn't stand out enough. */
export function colorForHue(h) {
  let l = 45;
  while (l > 20 && whiteContrast(h, 55, l) < 4.5) l -= 1;
  return { h, s: 55, l, css: `hsl(${h} 55% ${l}%)` };
}

export function avatarColor(name = '?') {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return colorForHue(h).css;
}
