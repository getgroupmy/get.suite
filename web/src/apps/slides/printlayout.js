// Printing a presentation: one slide per landscape page, each slide with its speaker notes, or handouts
// of 2, 3 (with lines to write on) or 6 slides per portrait page.
export const PRINT_LAYOUTS = [
  ['slides', 'Slides: one per page'],
  ['notes', 'Slides with speaker notes'],
  ['h2', 'Handouts: 2 slides per page'],
  ['h3', 'Handouts: 3 slides per page, with lines for notes'],
  ['h6', 'Handouts: 6 slides per page'],
];
const PER_PAGE = { slides: 1, notes: 1, h2: 2, h3: 3, h6: 6 };

/** The pages to print: [[{ slide, number }]], numbers as in the presentation (skipped slides left out when asked). */
export function printPages(slides, { layout = 'slides', skipHidden = true } = {}) {
  const per = PER_PAGE[layout] || 1;
  const shown = (slides || []).map((slide, i) => ({ slide, number: i + 1 })).filter((x) => !(skipHidden && x.slide.skip));
  const pages = [];
  for (let i = 0; i < shown.length; i += per) pages.push(shown.slice(i, i + per));
  return pages;
}

/** Landscape for slides on their own; portrait for notes and handouts. */
export const isPortrait = (layout) => layout !== 'slides';
