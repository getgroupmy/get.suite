// Pure helpers for presentations: boxes in percent of a 16:9 slide, slide list changes, themes.

export const THEMES = {
  light: { name: 'Light', bg: '#ffffff', text: '#202124', accent: '#1a73e8' },
  dark: { name: 'Dark', bg: '#202124', text: '#f1f3f4', accent: '#8ab4f8' },
  ocean: { name: 'Ocean', bg: '#0b57d0', text: '#ffffff', accent: '#ffd666' },
  sand: { name: 'Sand', bg: '#f7f1e3', text: '#3c2f1e', accent: '#b5651d' },
};
export const MIN = 3; // smallest box, in percent of the slide
export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Keep a box on the slide and at least MIN big. */
export function clampBox(b) {
  const w = clamp(b.w, MIN, 100), h = clamp(b.h, MIN, 100);
  return { ...b, w, h, x: clamp(b.x, 0, 100 - w), y: clamp(b.y, 0, 100 - h) };
}

export const moveBox = (b, dx, dy) => clampBox({ ...b, x: b.x + dx, y: b.y + dy });

/**
 * Resize by dragging a handle ('n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'). With `ratio` (w / h in
 * percent units) the box keeps its shape, as pictures do.
 */
export function resizeBox(b, handle, dx, dy, ratio = null) {
  let { x, y, w, h } = b;
  const right = x + w, bottom = y + h;
  if (handle.includes('e')) w = clamp(w + dx, MIN, 100 - x);
  if (handle.includes('s')) h = clamp(h + dy, MIN, 100 - y);
  if (handle.includes('w')) { x = clamp(x + dx, 0, right - MIN); w = right - x; }
  if (handle.includes('n')) { y = clamp(y + dy, 0, bottom - MIN); h = bottom - y; }
  if (ratio) {
    // Follow the larger change; anchor the opposite corner.
    const byW = handle === 'n' || handle === 's' ? false : handle === 'e' || handle === 'w' ? true : Math.abs(dx) >= Math.abs(dy);
    if (byW) h = w / ratio; else w = h * ratio;
    if (w > 100 || h > 100) { const k = Math.min(100 / w, 100 / h); w *= k; h *= k; }
    if (handle.includes('w')) x = right - w;
    if (handle.includes('n')) y = bottom - h;
  }
  return clampBox({ ...b, x, y, w, h });
}

/** Layouts for a new slide. */
export function layoutItems(layout) {
  const t = (role, x, y, w, h, size, extra = {}) => ({ id: newId(), type: 'text', role, x, y, w, h, text: '', size, ...extra });
  if (layout === 'title') return [t('title', 8, 30, 84, 20, 44, { bold: true, align: 'center' }), t('subtitle', 15, 54, 70, 12, 24, { align: 'center' })];
  if (layout === 'section') return [t('title', 8, 40, 84, 20, 40, { bold: true })];
  if (layout === 'title-body') return [t('title', 6, 6, 88, 16, 36, { bold: true }), t('body', 6, 26, 88, 64, 22)];
  if (layout === 'two') return [t('title', 6, 6, 88, 16, 36, { bold: true }), t('body', 6, 26, 42, 64, 20), t('body', 52, 26, 42, 64, 20)];
  return [];
}
export const LAYOUTS = [['title-body', 'Title and text'], ['title', 'Title slide'], ['section', 'Section header'], ['two', 'Two columns'], ['blank', 'Blank']];

/** Slide list changes; each returns a new deck. */
export function addSlide(deck, after, layout = 'title-body') {
  const slides = [...deck.slides];
  slides.splice(after + 1, 0, { id: newId(), items: layoutItems(layout) });
  return { ...deck, slides };
}
export function duplicateSlide(deck, i) {
  const s = deck.slides[i];
  const copy = { ...JSON.parse(JSON.stringify(s)), id: newId() };
  copy.items = copy.items.map((it) => ({ ...it, id: newId() }));
  const slides = [...deck.slides];
  slides.splice(i + 1, 0, copy);
  return { ...deck, slides };
}
export function removeSlide(deck, i) {
  if (deck.slides.length <= 1) return { ...deck, slides: [{ id: newId(), items: [] }] };
  return { ...deck, slides: deck.slides.filter((_, k) => k !== i) };
}
export function moveSlide(deck, from, to) {
  if (to < 0 || to >= deck.slides.length || from === to) return deck;
  const slides = [...deck.slides];
  const [s] = slides.splice(from, 1);
  slides.splice(to, 0, s);
  return { ...deck, slides };
}

/** Change one item on one slide. */
export function updateItem(deck, slideIndex, itemId, change) {
  return { ...deck, slides: deck.slides.map((s, i) => (i !== slideIndex ? s : { ...s, items: s.items.map((it) => (it.id === itemId ? { ...it, ...(typeof change === 'function' ? change(it) : change) } : it)) })) };
}
export function addItem(deck, slideIndex, item) {
  return { ...deck, slides: deck.slides.map((s, i) => (i !== slideIndex ? s : { ...s, items: [...s.items, item] })) };
}
export function removeItem(deck, slideIndex, itemId) {
  return { ...deck, slides: deck.slides.map((s, i) => (i !== slideIndex ? s : { ...s, items: s.items.filter((it) => it.id !== itemId) })) };
}
/** Bring to front (+1) or send to back (-1). */
export function restack(deck, slideIndex, itemId, dir) {
  return { ...deck, slides: deck.slides.map((s, i) => {
    if (i !== slideIndex) return s;
    const it = s.items.find((x) => x.id === itemId);
    const rest = s.items.filter((x) => x.id !== itemId);
    return { ...s, items: dir > 0 ? [...rest, it] : [it, ...rest] };
  }) };
}

/** A picture's box: fit inside 60% of the slide, centred, keeping its shape (slide is 16:9). */
export function pictureBox(naturalW, naturalH) {
  const ratioPct = (naturalW / naturalH) * (9 / 16); // width/height in percent units
  let w = 60, h = w / ratioPct;
  if (h > 60) { h = 60; w = h * ratioPct; }
  return clampBox({ x: (100 - w) / 2, y: (100 - h) / 2, w, h });
}

/** Transitions a slide can have when presenting. */
export const TRANSITIONS = [['', 'None'], ['fade', 'Fade'], ['push', 'Push'], ['zoom', 'Zoom']];
/** Change one slide's own settings (transition, skip...); a falsy value removes the setting. */
export function setSlide(deck, i, change) {
  const s = { ...deck.slides[i] };
  for (const [k, v] of Object.entries(change)) { if (v) s[k] = v; else delete s[k]; }
  return { ...deck, slides: deck.slides.map((x, j) => (j === i ? s : x)) };
}
/**
 * Presenting: the slide to show after (dir 1) or before (dir -1) slide i, passing over skipped
 * ones. Stays at i when there's nowhere to go.
 */
export function stepSlide(deck, i, dir) {
  for (let j = i + dir; j >= 0 && j < deck.slides.length; j += dir) if (!deck.slides[j].skip) return j;
  return i;
}
/** The first slide to show from i on (i itself unless it's skipped and another follows). */
export const firstShown = (deck, i) => (deck.slides[i]?.skip ? (stepSlide(deck, i, 1) !== i ? stepSlide(deck, i, 1) : i) : i);
