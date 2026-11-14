// Filtering a form's responses by one question's answer (the Responses tab, and its downloads):
// those who chose an option (a tick box among theirs; "Other" for anything typed instead), gave a
// number on a scale or rating, put an option first in a ranking, or whose written answer contains
// some words; or simply those who answered a question, or left it blank. The server has the same rules (server/src/formfilter.js).

export const ANSWERED = '__answered__';
export const BLANK = '__blank__';
export const OTHER = '__other__';
const blank = (a) => a === undefined || a === null || a === '' || (Array.isArray(a) && !a.length) || (typeof a === 'object' && !Array.isArray(a) && !Object.keys(a).length);

/** { q, v } from a request's ?fq=&fv=, or null for no filter. */
export const filterFrom = (query) => (query?.fq ? { q: String(query.fq).slice(0, 100), v: String(query.fv ?? '').slice(0, 200) } : null);

/** Does one response's answers pass the filter? No filter, or one on a question that isn't there: all do. */
export function matchesFilter(questions, answers, filter) {
  const qu = filter && questions.find((x) => x.id === filter.q);
  if (!qu) return true;
  const a = answers?.[qu.id];
  const v = String(filter.v ?? '');
  if (v === ANSWERED) return !blank(a);
  if (v === BLANK) return blank(a);
  if (blank(a)) return false;
  switch (qu.type) {
    case 'choice': case 'dropdown': case 'checkbox': {
      const picks = [a].flat().map(String);
      return v === OTHER ? picks.some((x) => !(qu.options || []).includes(x)) : picks.includes(v);
    }
    case 'scale': case 'rating': return Number(a) === Number(v);
    case 'rank': return Array.isArray(a) && a[0] === v;
    case 'short': case 'paragraph': case 'date': case 'time': return !v.trim() || String(a).toLowerCase().includes(v.trim().toLowerCase());
    default: return true; // grids, files, signatures: answered or blank only
  }
}

/** What to filter by on a question: [value, label] pairs, and whether words can be typed (written answers). */
export function filterOptions(qu) {
  const ends = [[ANSWERED, 'Answered'], [BLANK, 'Left blank']];
  switch (qu?.type) {
    case 'choice': case 'dropdown': case 'checkbox':
      return { values: [...(qu.options || []).map((o) => [o, o]), ...(qu.other ? [[OTHER, 'Other (typed)']] : []), ...ends], words: false };
    case 'scale': case 'rating': return { values: [...Array.from({ length: qu.max || 5 }, (_, i) => [String(i + 1), String(i + 1)]), ...ends], words: false };
    case 'rank': return { values: [...(qu.options || []).map((o) => [o, `${o} first`]), ...ends], words: false };
    case 'short': case 'paragraph': case 'date': case 'time': return { values: [['', 'Contains…'], ...ends], words: true };
    default: return { values: ends, words: false };
  }
}
