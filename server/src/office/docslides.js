// A presentation from a document's outline (Docs → Make a presentation): a title slide with the document's name (and its
// first paragraph before any heading, as the subtitle), then a slide for each Heading 1, titled with it, holding what
// comes under it as points: paragraphs and list items a line each, items of lists inside lists a level in (a tab at the
// start, as slide lists keep them), Heading 2 and below as points too. A numbered list keeps its numbering; checklists and
// bulleted lists are bullets. A slide whose points would be too many (more than MAX_POINTS) carries on in "(cont.)".
import crypto from 'node:crypto';
import { flattenTabs } from './doctabs.js';
import { NUMBERINGS } from './liststyle.js';

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
      slides.push({ id: newId(), items });
    });
  }
  return { theme: 'light', slides };
}
