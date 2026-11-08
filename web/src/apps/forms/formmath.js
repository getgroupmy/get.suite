// Pure helpers for Forms: the question types, a new question of each kind, and the summary of answers.

export const TYPES = [
  ['short', 'Short answer'], ['paragraph', 'Paragraph'], ['choice', 'Multiple choice'], ['checkbox', 'Tick boxes'],
  ['dropdown', 'Dropdown'], ['scale', 'Linear scale'], ['date', 'Date'], ['file', 'File upload'],
];
export const HAS_OPTIONS = new Set(['choice', 'checkbox', 'dropdown']);

export const newId = () => Math.random().toString(36).slice(2, 10);

/** A blank question; switching type keeps the title and what still fits. */
export function retype(q, type) {
  const next = { id: q?.id || newId(), type, title: q?.title || '', required: !!q?.required };
  if (q?.help) next.help = q.help;
  if (HAS_OPTIONS.has(type)) next.options = q?.options?.length ? q.options : ['Option 1'];
  if (type === 'scale') Object.assign(next, { max: q?.max || 5, low: q?.low || '', high: q?.high || '' });
  if (type === 'file') next.max_files = q?.max_files || 1;
  return next;
}

/** "Option 3": the next unused option name. */
export function nextOption(options) {
  for (let n = options.length + 1; ; n++) if (!options.includes(`Option ${n}`)) return `Option ${n}`;
}

/**
 * Per question: how many answered, and for choices (and scales) the count for each option with its share
 * of the responses; for the rest, the answers themselves, newest first.
 */
export function summarize(questions, responses) {
  return questions.filter((q) => q.type !== 'section').map((q) => {
    const answers = responses.map((r) => r.answers?.[q.id]).filter((a) => a !== undefined && a !== '' && !(Array.isArray(a) && !a.length));
    const out = { id: q.id, title: q.title, type: q.type, answered: answers.length };
    if (HAS_OPTIONS.has(q.type) || q.type === 'scale') {
      const keys = q.type === 'scale' ? Array.from({ length: q.max || 5 }, (_, i) => i + 1) : q.options || [];
      const counts = new Map(keys.map((k) => [String(k), 0]));
      for (const a of answers) for (const v of Array.isArray(a) ? a : [a]) if (counts.has(String(v))) counts.set(String(v), counts.get(String(v)) + 1);
      out.bars = keys.map((k) => ({ label: String(k), count: counts.get(String(k)), share: answers.length ? counts.get(String(k)) / answers.length : 0 }));
      if (q.type === 'scale' && answers.length) out.average = Math.round((answers.reduce((s, a) => s + Number(a), 0) / answers.length) * 10) / 10;
    } else if (q.type === 'file') {
      out.files = answers.slice().reverse().flat().filter((f) => f && typeof f === 'object'); // newest first
    } else {
      out.texts = answers.slice().reverse().map(String);
    }
    return out;
  });
}

/** "42%" */
export const percent = (share) => `${Math.round(share * 100)}%`;

// ---- sections and "go to section" (the same as server/src/formpath.js) ----

/** The pages: [{ id, title, help, items: [questions] }]; the first has id null (before any section). */
export function sectionsOf(questions) {
  const out = [{ id: null, title: '', help: '', items: [] }];
  for (const q of questions || []) {
    if (q.type === 'section') out.push({ id: q.id, title: q.title || '', help: q.help || '', items: [] });
    else out[out.length - 1].items.push(q);
  }
  // A form that starts with a section doesn't need an empty first page.
  return out[0].items.length || out.length === 1 ? out : out.slice(1);
}

/** Where to go after page i, given the answers: a page index, or the number of pages (= submit). */
export function nextPage(pages, i, answers) {
  let next = i + 1;
  for (const q of pages[i].items) {
    const to = q.goto && answers?.[q.id] !== undefined ? q.goto[String(answers[q.id])] : undefined;
    if (!to) continue;
    if (to === 'submit') next = pages.length;
    else { const j = pages.findIndex((p) => p.id === to); if (j > i) next = j; }
  }
  return next;
}

/** The pages someone goes through with these answers (indexes, in order). */
export function pathOf(pages, answers) {
  const seen = [];
  for (let i = 0; i < pages.length && !seen.includes(i); i = nextPage(pages, i, answers)) seen.push(i);
  return seen;
}

/** The questions someone was shown (in the pages on their path). */
export const shownQuestions = (questions, answers) => { const pages = sectionsOf(questions); return pathOf(pages, answers).flatMap((i) => pages[i].items); };
