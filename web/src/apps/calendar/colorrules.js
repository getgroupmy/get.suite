// Colours by title (Calendar settings): events with no colour of their own (the usual blue) whose
// title has one of your words show in that word's colour. Only how they look to you: nothing is saved
// on the events. The first matching rule wins.
export const DEFAULT_COLOR = '#1a73e8';
let rules = [];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let compiled = [];
export function setColorRules(list) {
  if (list === rules) return;
  rules = Array.isArray(list) ? list : [];
  compiled = rules.map((r) => ({ re: new RegExp(`(?<![\\p{L}\\p{N}])${esc(r.word).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu'), color: r.color }));
}
/** The colour a rule gives this title, or null. */
export function ruleColor(title) {
  const t = String(title || '');
  return compiled.find((r) => r.re.test(t))?.color || null;
}
/** The colour to draw an event in: its own, else a rule's, else the usual blue. */
export function eventColor(ev, fallback = DEFAULT_COLOR) {
  const own = ev?.color && ev.color.toLowerCase() !== DEFAULT_COLOR ? ev.color : null;
  return own || ruleColor(ev?.title) || ev?.color || fallback;
}
