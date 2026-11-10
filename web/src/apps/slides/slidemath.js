// Pure helpers for presentations: boxes in percent of a 16:9 slide, slide list changes, themes.

export const THEMES = {
  light: { name: 'Light', bg: '#ffffff', text: '#202124', accent: '#1a73e8' },
  dark: { name: 'Dark', bg: '#202124', text: '#f1f3f4', accent: '#8ab4f8' },
  ocean: { name: 'Ocean', bg: '#0b57d0', text: '#ffffff', accent: '#ffd666' },
  sand: { name: 'Sand', bg: '#f7f1e3', text: '#3c2f1e', accent: '#b5651d' },
};
// A presentation's own theme (theme: 'custom'): its colours and font, as { bg, text, accent, font }.
export const THEME_FONTS = ['Arial', 'Georgia', 'Times New Roman', 'Verdana', 'Trebuchet MS', 'Courier New'];
const HEX = /^#[0-9a-f]{6}$/i;
export function cleanCustom(c, base = THEMES.light) {
  const col = (v, d) => (HEX.test(String(v || '')) ? String(v).toLowerCase() : d);
  return { bg: col(c?.bg, base.bg), text: col(c?.text, base.text), accent: col(c?.accent, base.accent), ...(THEME_FONTS.includes(c?.font) && { font: c.font }) };
}
// What goes on every slide (a master): a logo in a corner and a line of footer text, optionally not
// on the first slide. { logo: fileId, corner: 'tl' | 'tr' | 'bl' | 'br', footer, skipFirst }.
export const CORNERS = [['tr', 'Top right'], ['tl', 'Top left'], ['br', 'Bottom right'], ['bl', 'Bottom left']];
export function cleanMaster(m) {
  if (!m || typeof m !== 'object') return null;
  const logo = typeof m.logo === 'string' && /^[\w-]{1,64}$/.test(m.logo) ? m.logo : null;
  const footer = typeof m.footer === 'string' ? m.footer.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  if (!logo && !footer) return null;
  return { ...(logo && { logo, corner: CORNERS.some(([k]) => k === m.corner) ? m.corner : 'tr' }), ...(footer && { footer }), ...(m.skipFirst && { skipFirst: true }) };
}
/**
 * The theme a presentation's slides are drawn with: one of THEMES, or its own colours and font; with
 * its master (logo and footer) and which slide is first (a master can leave that one out).
 */
export function themeOf(deck) {
  const base = THEMES[deck?.theme] || THEMES.light;
  const t = deck?.theme === 'custom' && deck.custom ? { name: 'Custom', ...cleanCustom(deck.custom) } : base;
  const master = cleanMaster(deck?.master);
  return master ? { ...t, master, firstId: deck?.slides?.[0]?.id } : t;
}
/** Whether a slide shows the master's logo and footer. */
export const masterOn = (theme, slide) => !!theme?.master && !(theme.master.skipFirst && slide?.id === theme.firstId);

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

/**
 * Several slides (by index) moved together so they land at position `to` (an index in the deck as it
 * is, 0..length: "before the slide now at `to`"), keeping their order. Returns { deck, first } with
 * where the first moved slide ends up.
 */
export function moveSlides(deck, indexes, to) {
  const set = new Set(indexes.filter((i) => i >= 0 && i < deck.slides.length));
  if (!set.size) return { deck, first: to };
  const moving = deck.slides.filter((_, i) => set.has(i));
  const rest = deck.slides.filter((_, i) => !set.has(i));
  const at = to - [...set].filter((i) => i < to).length;
  const slides = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  if (slides.every((x, i) => x === deck.slides[i])) return { deck, first: at };
  return { deck: { ...deck, slides }, first: at };
}
/** Copies of several slides, each placed after the last of them. */
export function duplicateSlides(deck, indexes) {
  const sorted = [...new Set(indexes)].filter((i) => i >= 0 && i < deck.slides.length).sort((a, b) => a - b);
  if (!sorted.length) return deck;
  const copies = sorted.map((i) => { const c = { ...JSON.parse(JSON.stringify(deck.slides[i])), id: newId() }; c.items = c.items.map((it) => ({ ...it, id: newId() })); return c; });
  const after = sorted[sorted.length - 1] + 1;
  return { ...deck, slides: [...deck.slides.slice(0, after), ...copies, ...deck.slides.slice(after)] };
}
/** Several slides deleted (a presentation keeps at least one, blank). */
export function removeSlides(deck, indexes) {
  const set = new Set(indexes);
  const slides = deck.slides.filter((_, i) => !set.has(i));
  return { ...deck, slides: slides.length ? slides : [{ id: newId(), items: [] }] };
}

/** Change one item on one slide. */
const dropUndefined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
export function updateItem(deck, slideIndex, itemId, change) {
  return { ...deck, slides: deck.slides.map((s, i) => (i !== slideIndex ? s : { ...s, items: s.items.map((it) => (it.id === itemId ? dropUndefined({ ...it, ...(typeof change === 'function' ? change(it) : change) }) : it)) })) };
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

// ---- tables: { type: 'table', cells: [[text]], header, size }, at most 20 rows and 10 columns
export const MAX_ROWS = 20, MAX_COLS = 10;
export const newTable = (rows = 3, cols = 3) => Array.from({ length: rows }, () => Array(cols).fill(''));
/** The cells with rows/columns added at the end or taken off the end (keeping what's typed in the rest). */
export function resizeTable(cells, rows, cols) {
  rows = Math.max(1, Math.min(MAX_ROWS, rows)); cols = Math.max(1, Math.min(MAX_COLS, cols));
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => cells[r]?.[c] ?? ''));
}
export const setCell = (cells, r, c, text) => cells.map((row, i) => (i === r ? row.map((v, j) => (j === c ? text : v)) : row));

// ---- animations: a box with { anim: 'appear' | 'fade' | 'fly', animAt: n } comes in on a click while
// presenting, in the order they were given an animation (animAt).
export const ANIMATIONS = [['', 'None'], ['appear', 'Appear'], ['fade', 'Fade in'], ['fly', 'Fly in']];
/** The slide's animated boxes, in the order they come in. */
/** Does slide i show its number? deck.numbers: true (every slide) or 'skip-first' (all but the title slide). Same as the server's. */
export const numberShown = (deck, i) => !!deck?.numbers && !(deck.numbers === 'skip-first' && i === 0);

export const builds = (slide) => (slide?.items || []).filter((it) => it.anim).sort((a, b) => (a.animAt || 0) - (b.animAt || 0));
/** A box's animation change: a new one goes last in the order; none takes it out. */
export function animChange(slide, item, anim) {
  if (!anim) return { anim: undefined, animAt: undefined };
  if (item.anim) return { anim }; // a different effect keeps its place
  return { anim, animAt: Math.max(0, ...builds(slide).map((it) => it.animAt || 0)) + 1 };
}
/**
 * Presenting with animations: from { i, b } (slide i with its first b boxes in), the next click
 * (dir 1) brings in the next box or goes to the next slide; back (dir -1) takes the last one away,
 * or goes to the previous slide with all its boxes in.
 */
export function stepPresent(deck, at, dir) {
  const n = builds(deck.slides[at.i]).length;
  if (dir > 0 && at.b < n) return { i: at.i, b: at.b + 1 };
  if (dir < 0 && at.b > 0) return { i: at.i, b: at.b - 1 };
  const j = stepSlide(deck, at.i, dir);
  if (j === at.i) return at;
  return { i: j, b: dir > 0 ? 0 : builds(deck.slides[j]).length };
}

/** Choices for a slide moving on by itself: seconds (0: only when you move on). */
export const ADVANCES = [0, 5, 10, 15, 30, 60];
export const advanceLabel = (secs) => (!secs ? 'Never' : secs < 60 ? `After ${secs} seconds` : secs === 60 ? 'After 1 minute' : `After ${Math.round(secs / 60)} minutes`);

/** Forward one step; past the last slide, back to the first one shown when the presentation loops. */
export function nextPresent(deck, at) {
  const n = stepPresent(deck, at, 1);
  return n === at && deck.loop ? { i: firstShown(deck, 0), b: 0 } : n;
}

// ---- what changed since an earlier version: slides added, deleted, moved or changed (and how)
const boxName = (it) => (it.type === 'text' ? 'text box' : it.type === 'image' ? 'picture' : it.type === 'table' ? 'table' : 'shape');
const textOf = (it) => (it.type === 'text' ? it.text || '' : it.type === 'table' ? (it.cells || []).map((r) => r.join(' | ')).join(' / ') : '');
const titleOf = (s) => (s?.items || []).find((it) => it.type === 'text' && it.role === 'title' && it.text)?.text || (s?.items || []).find((it) => it.type === 'text' && it.text)?.text || '';
/**
 * [{ id, n, was, status: 'added' | 'removed' | 'changed' | 'moved', title, details: [{ kind, what, was?, now? }] }]
 * n: its number now (or then, for a removed one); was: its number then.
 */
export function slideChanges(before, after) {
  const old = before?.slides || [], now = after?.slides || [];
  const oldAt = new Map(old.map((s, i) => [s.id, i]));
  const out = [];
  now.forEach((s, i) => {
    if (!oldAt.has(s.id)) { out.push({ id: s.id, n: i + 1, status: 'added', title: titleOf(s), details: [] }); return; }
    const o = old[oldAt.get(s.id)];
    const details = [];
    const oItems = new Map((o.items || []).map((it) => [it.id, it]));
    for (const it of s.items || []) {
      const p = oItems.get(it.id);
      if (!p) details.push({ kind: 'add', what: boxName(it), now: textOf(it) });
      else if (textOf(p) !== textOf(it)) details.push({ kind: 'edit', what: boxName(it), was: textOf(p), now: textOf(it) });
      else if (JSON.stringify(p) !== JSON.stringify(it)) details.push({ kind: 'look', what: boxName(it), now: textOf(it) });
    }
    for (const p of o.items || []) if (!(s.items || []).some((it) => it.id === p.id)) details.push({ kind: 'del', what: boxName(p), was: textOf(p) });
    if ((o.notes || '') !== (s.notes || '')) details.push({ kind: 'edit', what: 'speaker notes', was: o.notes || '', now: s.notes || '' });
    for (const k of ['bg', 'bgImage', 'transition', 'skip']) if ((o[k] || '') !== (s[k] || '')) details.push({ kind: 'look', what: { bg: 'background', bgImage: 'background picture', transition: 'transition', skip: 'skipping' }[k] });
    const moved = oldAt.get(s.id) !== i;
    if (details.length || moved) out.push({ id: s.id, n: i + 1, was: oldAt.get(s.id) + 1, status: details.length ? 'changed' : 'moved', title: titleOf(s), details });
  });
  old.forEach((o, i) => { if (!now.some((s) => s.id === o.id)) out.push({ id: o.id, n: i + 1, status: 'removed', title: titleOf(o), details: [] }); });
  return out;
}

/**
 * Smart guides: while a box is dragged, its left, centre or right edge (and top, middle or bottom)
 * snaps to the slide's edges and centre and to the other boxes' edges and centres when within `tol`
 * percent. Gives the snapped box and the guide lines to draw: [{ axis: 'x' | 'y', at }].
 */
export function snapBox(box, others, tol = 1.2) {
  const lines = (axis) => {
    const out = [0, 50, 100];
    for (const o of others) if (axis === 'x') out.push(o.x, o.x + o.w / 2, o.x + o.w); else out.push(o.y, o.y + o.h / 2, o.y + o.h);
    return out;
  };
  const best = (start, size, targets) => {
    let hit = null;
    for (const [k, p] of [[0, start], [0.5, start + size / 2], [1, start + size]]) {
      for (const t of targets) {
        const d = Math.abs(t - p);
        if (d <= tol && (!hit || d < hit.d)) hit = { d, start: t - k * size, at: t };
      }
    }
    return hit;
  };
  const hx = best(box.x, box.w, lines('x')), hy = best(box.y, box.h, lines('y'));
  const snapped = clampBox({ ...box, ...(hx && { x: hx.start }), ...(hy && { y: hy.start }) });
  const guides = [];
  // Every line the snapped box now touches (it can line up with several things at once).
  for (const [axis, start, size] of [['x', snapped.x, snapped.w], ['y', snapped.y, snapped.h]]) {
    if (!(axis === 'x' ? hx : hy)) continue;
    const pts = [start, start + size / 2, start + size];
    for (const t of new Set(lines(axis))) if (pts.some((p) => Math.abs(p - t) < 0.01)) guides.push({ axis, at: t });
  }
  return { box: snapped, guides };
}

/** An angle as kept on a box: whole degrees from -179 to 180 (0 = upright). */
export function normAngle(deg) {
  if (!Number.isFinite(deg)) return 0;
  let a = Math.round(deg) % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

/** The rotation that points a box's top at (px, py) from its centre (cx, cy); in 15° steps when `steps`. */
export function angleTo(cx, cy, px, py, steps = true) {
  const deg = (Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90;
  return normAngle(steps ? Math.round(deg / 15) * 15 : deg);
}

/** Line several boxes up: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' (to the group's own edges). */
export function alignItems(deck, slideIndex, ids, how) {
  const pick = new Set(ids);
  const items = deck.slides[slideIndex].items.filter((it) => pick.has(it.id));
  if (items.length < 2) return deck;
  const left = Math.min(...items.map((b) => b.x)), right = Math.max(...items.map((b) => b.x + b.w));
  const top = Math.min(...items.map((b) => b.y)), bottom = Math.max(...items.map((b) => b.y + b.h));
  const place = (b) => ({
    left: { x: left }, center: { x: (left + right) / 2 - b.w / 2 }, right: { x: right - b.w },
    top: { y: top }, middle: { y: (top + bottom) / 2 - b.h / 2 }, bottom: { y: bottom - b.h },
  }[how] || {});
  return setSlide(deck, slideIndex, { items: deck.slides[slideIndex].items.map((it) => (pick.has(it.id) ? clampBox({ ...it, ...place(it) }) : it)) });
}

/** Space three or more boxes evenly between the first and last: axis 'x' (across) or 'y' (down). */
export function distributeItems(deck, slideIndex, ids, axis) {
  const pick = new Set(ids);
  const [pos, size] = axis === 'y' ? ['y', 'h'] : ['x', 'w'];
  const items = deck.slides[slideIndex].items.filter((it) => pick.has(it.id)).sort((a, b) => a[pos] - b[pos]);
  if (items.length < 3) return deck;
  const start = items[0][pos], end = items.at(-1)[pos] + items.at(-1)[size];
  const gap = (end - start - items.reduce((n, b) => n + b[size], 0)) / (items.length - 1);
  const at = new Map();
  let p = start;
  for (const b of items) { at.set(b.id, p); p += b[size] + gap; }
  return setSlide(deck, slideIndex, { items: deck.slides[slideIndex].items.map((it) => (at.has(it.id) ? clampBox({ ...it, [pos]: at.get(it.id) }) : it)) });
}

/** Move several boxes together by (dx, dy), stopping where the first one would leave the slide. */
export function moveItems(deck, slideIndex, ids, dx, dy) {
  const pick = new Set(ids);
  const items = deck.slides[slideIndex].items.filter((it) => pick.has(it.id));
  if (!items.length) return deck;
  const left = Math.min(...items.map((b) => b.x)), right = Math.max(...items.map((b) => b.x + b.w));
  const top = Math.min(...items.map((b) => b.y)), bottom = Math.max(...items.map((b) => b.y + b.h));
  const mx = Math.min(Math.max(dx, -left), 100 - right), my = Math.min(Math.max(dy, -top), 100 - bottom);
  return setSlide(deck, slideIndex, { items: deck.slides[slideIndex].items.map((it) => (pick.has(it.id) ? { ...it, x: it.x + mx, y: it.y + my } : it)) });
}

/**
 * Paste copies of boxes onto a slide: new ids, and nudged down and right (2%) for as long as a box
 * would land exactly on one already there, so a copy never hides behind its original.
 * Gives the deck and the new boxes' ids.
 */
export function pasteItems(deck, slideIndex, items) {
  const there = deck.slides[slideIndex].items;
  const taken = (dx) => items.some((c) => there.some((o) => Math.abs(o.x - (c.x + dx)) < 0.01 && Math.abs(o.y - (c.y + dx)) < 0.01));
  let shift = 0;
  while (shift < 20 && taken(shift)) shift += 2;
  const copies = items.map((c) => { const { anim, ...rest } = c; return clampBox({ ...JSON.parse(JSON.stringify(rest)), id: newId(), x: c.x + shift, y: c.y + shift }); });
  return { deck: setSlide(deck, slideIndex, { items: [...there, ...copies] }), ids: copies.map((c) => c.id) };
}
