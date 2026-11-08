// Pure helpers for Forms: the question types, a new question of each kind, and the summary of answers.

export const TYPES = [
  ['short', 'Short answer'], ['paragraph', 'Paragraph'], ['choice', 'Multiple choice'], ['checkbox', 'Tick boxes'],
  ['dropdown', 'Dropdown'], ['scale', 'Linear scale'], ['date', 'Date'], ['file', 'File upload'],
  ['grid', 'Multiple choice grid'], ['checkgrid', 'Tick box grid'],
];
export const HAS_OPTIONS = new Set(['choice', 'checkbox', 'dropdown']);
export const GRIDS = new Set(['grid', 'checkgrid']);

export const newId = () => Math.random().toString(36).slice(2, 10);

/** A blank question; switching type keeps the title and what still fits. */
export function retype(q, type) {
  const next = { id: q?.id || newId(), type, title: q?.title || '', required: !!q?.required };
  if (q?.help) next.help = q.help;
  if (HAS_OPTIONS.has(type)) next.options = q?.options?.length ? q.options : ['Option 1'];
  if (type === 'scale') Object.assign(next, { max: q?.max || 5, low: q?.low || '', high: q?.high || '' });
  if (type === 'file') next.max_files = q?.max_files || 1;
  if (GRIDS.has(type)) Object.assign(next, { rows: q?.rows?.length ? q.rows : ['Row 1'], columns: q?.columns?.length ? q.columns : (q?.options?.length ? q.options : ['Column 1']) });
  return next;
}

/** The options in a random order (each person sees their own), when the question asks for it. */
export function shuffled(list, rand = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * Answers to start a form with, from a pre-filled link (?prefill=… JSON): only questions the form has,
 * in the shape each takes; anything else is dropped. People can still change them before sending.
 */
export function prefillFrom(questions, raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out = {};
  for (const q of questions || []) {
    const v = data[q.id];
    if (v === undefined || v === null || q.type === 'file' || q.type === 'section') continue;
    if (q.type === 'checkbox') { const l = [v].flat().map(String).filter((x) => q.options.includes(x)); if (l.length) out[q.id] = l; }
    else if (HAS_OPTIONS.has(q.type)) { if (q.options.includes(String(v))) out[q.id] = String(v); }
    else if (q.type === 'scale') { const n = Number(v); if (Number.isInteger(n) && n >= 1 && n <= (q.max || 5)) out[q.id] = n; }
    else if (GRIDS.has(q.type)) {
      if (typeof v !== 'object' || Array.isArray(v)) continue;
      const g = {};
      for (const row of q.rows || []) {
        const c = v[row];
        if (q.type === 'checkgrid') { const l = [c ?? []].flat().map(String).filter((x) => q.columns.includes(x)); if (l.length) g[row] = l; }
        else if (c != null && q.columns.includes(String(c))) g[row] = String(c);
      }
      if (Object.keys(g).length) out[q.id] = g;
    } else if (typeof v === 'string' || typeof v === 'number') out[q.id] = String(v).slice(0, q.type === 'paragraph' ? 5000 : 500);
  }
  return out;
}
/** The text for ?prefill= from answers, leaving out the empty ones. */
export function prefillParam(answers) {
  const kept = Object.fromEntries(Object.entries(answers || {}).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length) && !(v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)));
  return Object.keys(kept).length ? JSON.stringify(kept) : '';
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
    } else if (GRIDS.has(q.type)) {
      // Per row: how many chose each column.
      out.grid = (q.rows || []).map((row) => {
        const picks = answers.map((a) => a?.[row]).filter((v) => v !== undefined);
        return { row, answered: picks.length, bars: (q.columns || []).map((c) => { const n = picks.filter((v) => [v].flat().includes(c)).length; return { label: c, count: n, share: picks.length ? n / picks.length : 0 }; }) };
      });
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
    if (q.type === 'section') out.push({ id: q.id, title: q.title || '', help: q.help || '', after: q.after || null, items: [] });
    else out[out.length - 1].items.push(q);
  }
  // A form that starts with a section doesn't need an empty first page.
  return out[0].items.length || out.length === 1 ? out : out.slice(1);
}

/** Where to go after page i, given the answers: a page index, or the number of pages (= submit). */
export function nextPage(pages, i, answers) {
  let next = i + 1;
  // The section's own "after this section" (a later section, or the end); an answer can still say otherwise.
  const after = pages[i].after;
  if (after === 'submit') next = pages.length;
  else if (after) { const j = pages.findIndex((p) => p.id === after); if (j > i) next = j; }
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
