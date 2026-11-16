// A presentation from an outline (an assistant's "make me slides for…", through the create_presentation
// tool): each slide a title with points under it, or, with no points, a title slide (big and centred,
// with an optional subtitle). Speaker notes go with each slide. Content as the Slides editor keeps it.
import crypto from 'node:crypto';
import { bad } from './util.js';

export const MAX_SLIDES = 100, MAX_POINTS = 20;
const id = () => crypto.randomBytes(6).toString('hex');
const text = (role, t, x, y, w, h, size, more = {}) => ({ id: id(), type: 'text', role, text: t, x, y, w, h, size, ...more });
const str = (v, max) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max);

/** { theme, slides } from [{ title, subtitle?, points?: [text], notes? }]. Throws (400) on an unusable outline. */
export function deckFromOutline(outline, { theme = 'light' } = {}) {
  if (!Array.isArray(outline) || !outline.length) throw bad('Give the slides: a list, each with a title and the points on it');
  if (outline.length > MAX_SLIDES) throw bad(`At most ${MAX_SLIDES} slides`);
  const slides = outline.map((s, i) => {
    if (!s || typeof s !== 'object') throw bad(`Slide ${i + 1} must be { title, points?, subtitle?, notes? }`);
    const title = str(s.title, 300);
    const points = (Array.isArray(s.points) ? s.points : s.points == null ? [] : [s.points]).map((p) => str(p, 1000)).filter(Boolean);
    if (points.length > MAX_POINTS) throw bad(`Slide ${i + 1} has more than ${MAX_POINTS} points: split it`);
    if (!title && !points.length) throw bad(`Slide ${i + 1} is empty: give it a title or points`);
    const items = points.length
      ? [text('title', title, 6, 8, 88, 14, 40, { bold: true }),
        text('body', points.map((p) => `• ${p}`).join('\n'), 6, 26, 88, 66, points.length <= 5 && points.join('').length < 400 ? 26 : points.length <= 9 ? 20 : 16)]
      : [text('title', title, 10, s.subtitle ? 30 : 38, 80, 20, 54, { align: 'center', bold: true }),
        ...(s.subtitle ? [text('subtitle', str(s.subtitle, 300), 10, 55, 80, 10, 24, { align: 'center' })] : [])];
    return { id: id(), items, ...(s.notes && { notes: str(s.notes, 10000) }) };
  });
  return { theme, slides };
}
