// Sections in a form: a { type: 'section' } item starts a new page. A multiple-choice or dropdown
// question can send people elsewhere depending on their answer: goto { option: sectionId | 'submit' }
// (only forward, so a form can't loop). (A copy of this lives in web/src/apps/forms/formmath.js.)

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
