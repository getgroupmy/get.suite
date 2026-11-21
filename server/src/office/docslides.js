// A presentation from a document's outline (Docs → Make a presentation): a title slide with the document's name (and its
// first paragraph before any heading, as the subtitle), then a slide for each Heading 1, titled with it, holding what
// comes under it as points: paragraphs and list items a line each, items of lists inside lists a level in (a tab at the
// start, as slide lists keep them), Heading 2 and below as points too. A numbered list keeps its numbering; checklists and
// bulleted lists are bullets. A slide whose points would be too many (more than MAX_POINTS) carries on in "(cont.)". A quote
// starting "Speaker notes:" (as Make a document writes them) is the slide's notes.
import crypto from 'node:crypto';
import { flattenTabs } from './doctabs.js';
import { NUMBERINGS, BULLETS, slideListLines } from './liststyle.js';
const BULLET_KEYS = new Set(BULLETS.map((b) => b[0]));

export const MAX_POINTS = 8;
const LEVELS = 4;
const newId = () => crypto.randomBytes(6).toString('base64url');

/** The words of a node, chips and equations as their text. */
const words = (n) => (n.type === 'text' ? n.text || '' : n.type === 'hardBreak' ? ' ' : n.type === 'math' ? n.attrs?.latex || '' : (n.content || []).map(words).join(''));
const clean = (s) => String(s).replace(/\s+/g, ' ').trim();

/** The deck (as the Slides editor keeps one), from a document (TipTap JSON) called `title`. */
export function deckFromDoc(doc, title = 'Presentation') {
  doc = flattenTabs(doc);
  const sections = []; // { title, points: [{ text, level }], numbering }
  let intro = '';
  let cur = null;
  const point = (text, level) => { if (!cur) return; const t = clean(text); if (t) cur.points.push({ text: t, level: Math.min(LEVELS - 1, level) }); };
  const walk = (nodes, level) => {
    for (const n of nodes || []) {
      if (n.type === 'heading' && (n.attrs?.level || 1) === 1) { cur = { title: clean(words(n)), points: [], numbering: null }; sections.push(cur); continue; }
      if (!cur) { if (!intro && (n.type === 'paragraph' || n.type === 'heading')) intro = clean(words(n)); continue; }
      if (n.type === 'paragraph' || n.type === 'heading') point(words(n), level);
      else if (n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'taskList') {
        // (the box's numbering: the first numbered list's style at the top, as a box has one look for all its points)
        if (n.type === 'orderedList' && level === 0 && !cur.numbering && !cur.points.length) cur.numbering = NUMBERINGS.some(([k]) => k === n.attrs?.listStyle) ? n.attrs.listStyle : 'decimal';
        for (const li of n.content || []) {
          const [first, ...rest] = li.content || [];
          if (first) point(words(first), level);
          walk(rest, level + 1);
        }
      } else if (n.type === 'blockquote' && level === 0 && /^Speaker notes:/i.test(clean(words(n.content?.[0] || {})))) {
        // (as Make a document writes a slide's notes: its notes again)
        cur.notes = (n.content || []).map((c, k) => clean(words(c)).replace(k ? /^$/ : /^Speaker notes:\s*/i, '')).filter(Boolean).join('\n');
      } else if (n.type === 'blockquote') walk(n.content, level);
      else if (n.type === 'table') for (const row of n.content || []) point((row.content || []).map((c) => clean(words(c))).filter(Boolean).join(' · '), level);
      else if (n.type === 'codeBlock') for (const line of words(n).split('\n')) point(line, level);
    }
  };
  walk(doc?.content || [], 0);

  const t = (role, x, y, w, h, size, extra = {}) => ({ id: newId(), type: 'text', role, x, y, w, h, size, ...extra });
  const slides = [{ id: newId(), items: [t('title', 8, 30, 84, 20, 44, { bold: true, align: 'center', text: clean(title) || 'Presentation' }), ...(intro ? [t('subtitle', 15, 54, 70, 12, 24, { align: 'center', text: intro.slice(0, 300) })] : [])] }];
  for (const s of sections) {
    const chunks = [];
    for (let i = 0; i < Math.max(1, s.points.length); i += MAX_POINTS) chunks.push(s.points.slice(i, i + MAX_POINTS));
    chunks.forEach((pts, k) => {
      const items = [t('title', 6, 6, 88, 16, 36, { bold: true, text: `${s.title || 'Untitled'}${k ? ' (cont.)' : ''}` })];
      if (pts.length) items.push(t('body', 6, 26, 88, 64, pts.length > 6 ? 20 : 22, { text: pts.map((p) => '\t'.repeat(p.level) + p.text).join('\n'), list: s.numbering || 'disc' }));
      slides.push({ id: newId(), items, ...(k === 0 && s.notes && { notes: s.notes }) });
    });
  }
  return { theme: 'light', slides };
}

/**
 * A document from a presentation (Slides → Make a document): a first slide that's a title slide opening it with its subtitle
 * (the document's name being its title), then a Heading 1 for each slide (its title, or "Slide N"), its text
 * boxes under it, a list box as a list (points under others in lists inside, its numbering or bullet kept), other boxes and
 * shapes with words as paragraphs, tables as tables, and its speaker notes as a quote. Skipped slides are left out.
 */
export function docFromDeck(deck) {
  const P = (text) => ({ type: 'paragraph', ...(text && { content: [{ type: 'text', text }] }) });
  const listNode = (lines, list) => {
    const numbered = NUMBERINGS.some(([k]) => k === list);
    const make = () => ({ type: numbered ? 'orderedList' : 'bulletList', attrs: numbered ? { start: 1, ...(list !== 'decimal' && { listStyle: list }) } : (list && list !== 'disc' && BULLET_KEYS.has(list) ? { bullet: list } : {}), content: [] });
    const root = make();
    const stack = [{ node: root, level: 0 }];
    for (const { text, level } of lines) {
      if (!text.trim()) continue;
      while (stack.length > 1 && stack[stack.length - 1].level > level) stack.pop();
      let top = stack[stack.length - 1];
      if (level > top.level && top.node.content.length) { // a point under the last one: a list inside its item
        const inner = { ...make(), attrs: numbered ? { start: 1, ...(list !== 'decimal' && { listStyle: list }) } : {} };
        top.node.content[top.node.content.length - 1].content.push(inner);
        stack.push(top = { node: inner, level });
      }
      top.node.content.push({ type: 'listItem', content: [P(text)] });
    }
    return root.content.length ? root : null;
  };
  const content = [];
  (deck?.slides || []).forEach((s, i) => {
    if (s.skip) return;
    const items = (s.items || []).filter((it) => it && (it.type === 'text' || it.type === 'table' || (it.type === 'shape' && it.text)));
    // The first slide as a title slide (a title and a subtitle): the document's name is its title; the subtitle opens the document.
    if (!content.length && items.some((it) => it.role === 'subtitle')) {
      for (const it of items) if (it.role === 'subtitle') for (const l of String(it.text || '').split('\n')) if (l.trim()) content.push(P(clean(l)));
      if (content.length) return;
    }
    const titleBox = items.find((it) => it.type === 'text' && it.role === 'title' && String(it.text || '').trim());
    content.push({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: clean(titleBox?.text || '') || `Slide ${i + 1}` }] });
    for (const it of [...items].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0))) {
      if (it === titleBox) continue;
      if (it.type === 'table') {
        const rows = (it.cells || []).filter((r) => r.length);
        if (rows.length) content.push({ type: 'table', content: rows.map((r, ri) => ({ type: 'tableRow', content: r.map((c) => ({ type: it.header && ri === 0 ? 'tableHeader' : 'tableCell', content: [P(clean(c ?? ''))] })) })) });
        continue;
      }
      const lines = it.list ? slideListLines(it.text, it.list) : String(it.text || '').split('\n').map((t) => ({ text: t, level: 0 }));
      const node = it.list ? listNode(lines, it.list) : null;
      if (node) content.push(node);
      else for (const l of lines) if (l.text.trim()) content.push(P(clean(l.text)));
    }
    if (String(s.notes || '').trim()) content.push({ type: 'blockquote', content: String(s.notes).split('\n').filter((l) => l.trim()).map((l, k) => P(k ? clean(l) : `Speaker notes: ${clean(l)}`)) });
  });
  return { type: 'doc', content: content.length ? content : [P('')] };
}
