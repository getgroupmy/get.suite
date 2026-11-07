// Pure helpers for Forms: the question types, a new question of each kind, and the summary of answers.

export const TYPES = [
  ['short', 'Short answer'], ['paragraph', 'Paragraph'], ['choice', 'Multiple choice'], ['checkbox', 'Tick boxes'],
  ['dropdown', 'Dropdown'], ['scale', 'Linear scale'], ['date', 'Date'],
];
export const HAS_OPTIONS = new Set(['choice', 'checkbox', 'dropdown']);

export const newId = () => Math.random().toString(36).slice(2, 10);

/** A blank question; switching type keeps the title and what still fits. */
export function retype(q, type) {
  const next = { id: q?.id || newId(), type, title: q?.title || '', required: !!q?.required };
  if (q?.help) next.help = q.help;
  if (HAS_OPTIONS.has(type)) next.options = q?.options?.length ? q.options : ['Option 1'];
  if (type === 'scale') Object.assign(next, { max: q?.max || 5, low: q?.low || '', high: q?.high || '' });
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
  return questions.map((q) => {
    const answers = responses.map((r) => r.answers?.[q.id]).filter((a) => a !== undefined && a !== '' && !(Array.isArray(a) && !a.length));
    const out = { id: q.id, title: q.title, type: q.type, answered: answers.length };
    if (HAS_OPTIONS.has(q.type) || q.type === 'scale') {
      const keys = q.type === 'scale' ? Array.from({ length: q.max || 5 }, (_, i) => i + 1) : q.options || [];
      const counts = new Map(keys.map((k) => [String(k), 0]));
      for (const a of answers) for (const v of Array.isArray(a) ? a : [a]) if (counts.has(String(v))) counts.set(String(v), counts.get(String(v)) + 1);
      out.bars = keys.map((k) => ({ label: String(k), count: counts.get(String(k)), share: answers.length ? counts.get(String(k)) / answers.length : 0 }));
      if (q.type === 'scale' && answers.length) out.average = Math.round((answers.reduce((s, a) => s + Number(a), 0) / answers.length) * 10) / 10;
    } else {
      out.texts = answers.slice().reverse().map(String);
    }
    return out;
  });
}

/** "42%" */
export const percent = (share) => `${Math.round(share * 100)}%`;
