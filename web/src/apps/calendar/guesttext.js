// Guests from what's typed or pasted into an event's Guests box: plain addresses separated by commas,
// semicolons, spaces or line breaks, and addresses as mail programs write them — Ann Lee <ann@x.org>,
// "Lee, Ann" <ann@x.org> — so a To line copied from an email can be pasted whole.
import { parseAddresses } from '../../components/addresses.js';

/** [{ email, name }] (each address once, lower case; name '' when none was written). */
export function guestsFromText(text) {
  const { list, bad } = parseAddresses(text);
  const out = [...list];
  // What isn't one address may be several with only spaces between them (or an address in stray brackets).
  for (const part of bad) for (const word of part.split(/\s+/)) {
    const m = /^[<("']*([^\s<>()"']+@[^\s<>()"']+\.[^\s<>()"']+?)[>)"'.]*$/.exec(word);
    if (m) out.push({ name: '', email: m[1].toLowerCase() });
  }
  const seen = new Set();
  return out.filter((g) => !seen.has(g.email) && seen.add(g.email));
}
