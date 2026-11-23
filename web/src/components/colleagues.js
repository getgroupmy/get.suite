// Finding a colleague by what's typed in a box that names one (ColleagueInput, Drive's Share window).
import { matchesFilter } from '../apps/contacts/contactfilter.js';

/** The colleagues what's typed fits (none once it is someone's exact address). */
export const colleaguesFor = (people, text, max = 6) => {
  const typed = String(text || '').trim();
  if (!typed || people.some((p) => p.username === typed.toLowerCase())) return [];
  return people.filter((p) => matchesFilter({ name: p.name, username: p.username }, typed)).slice(0, max);
};

/** The address meant by what's typed: the address itself, or that of the one colleague a name fits; null when it fits nobody or several. */
export const colleagueAddress = (people, text) => {
  const typed = String(text || '').trim();
  if (typed.includes('@')) return typed.toLowerCase();
  const found = colleaguesFor(people, typed, 2);
  return found.length === 1 ? found[0].username : null;
};
