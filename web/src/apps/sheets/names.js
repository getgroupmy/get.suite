// Named ranges: a name for a cell or a block of cells ("Tax" for B1, "Sales" for A2:A10), used in
// formulas instead of the address (=SUM(Sales)*Tax). Kept on the sheet as { names: { Tax: 'B1' } }.
import { parseRef } from './formula.js';

/** Why a name can't be used, or null. `names` are the sheet's names; `was` is the one being renamed. */
export function nameProblem(name, names = {}, was = null) {
  const n = String(name || '').trim();
  if (!n) return 'Give it a name';
  if (n.length > 50) return 'Up to 50 characters';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) return 'Use letters, numbers and _ only, starting with a letter';
  if (/^[A-Za-z]{1,3}\d+$/.test(n) || /^(TRUE|FALSE)$/i.test(n)) return 'That looks like a cell or a value: pick another name';
  const clash = Object.keys(names).find((k) => k.toUpperCase() === n.toUpperCase() && k !== was);
  return clash ? `There's already a range called ${clash}` : null;
}

/** "a2 : a10" -> "A2:A10", "b1" -> "B1"; null when it isn't a cell or range. */
export function cleanTarget(text) {
  const parts = String(text || '').replace(/\$/g, '').replace(/\s+/g, '').toUpperCase().split(':');
  if (parts.length > 2 || !parts.every((p) => parseRef(p))) return null;
  return parts.length === 2 && parts[0] !== parts[1] ? `${parts[0]}:${parts[1]}` : parts[0];
}

/** The name for a target, matched whatever the case (for the name box): the target, or null. */
export const targetOf = (names, name) => {
  const k = Object.keys(names || {}).find((x) => x.toUpperCase() === String(name || '').trim().toUpperCase());
  return k ? names[k] : null;
};
