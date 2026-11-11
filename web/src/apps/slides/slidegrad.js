// A slide background that fades from its colour into another (stored on the slide as bgGrad: "#rrggbb angle").
// The angle is CSS's: 180 runs top to bottom, 90 left to right, 135 from the top left corner.
export const GRAD_COLORS = [['#ffffff', 'White'], ['#e8f0fe', 'Light blue'], ['#fef7e0', 'Light yellow'], ['#e6f4ea', 'Light green'], ['#f3e8fd', 'Light purple'], ['#0b57d0', 'Blue'], ['#174ea6', 'Dark blue'], ['#8430ce', 'Purple'], ['#188038', 'Green'], ['#d93025', 'Red'], ['#202124', 'Black']];
export const GRAD_ANGLES = [[180, '↓ Top to bottom'], [90, '→ Left to right'], [135, '↘ Corner to corner'], [45, '↗ Bottom corner up'], [0, '↑ Bottom to top']];

/** { to, angle } from a slide's bgGrad, or null. */
export function gradOf(v) {
  const m = /^(#[0-9a-f]{6}) (\d{1,3})$/i.exec(String(v || ''));
  if (!m || Number(m[2]) > 359) return null;
  return { to: m[1].toLowerCase(), angle: Number(m[2]) };
}
export const gradValue = (to, angle = 180) => `${to.toLowerCase()} ${((Math.round(angle) % 360) + 360) % 360}`;

/** The CSS background for a slide: its colour (or the theme's), fading into the gradient's colour. */
export function gradCss(from, v) {
  const g = gradOf(v);
  return g ? `linear-gradient(${g.angle}deg, ${from}, ${g.to})` : from;
}
