// A presentation as plain text (.txt): each slide in turn, "Slide 3: its title", then the words on it in reading
// order (top to bottom, then left to right), tables by tabs, a chart's title and figures, a picture's description;
// skipped slides say so, and speaker notes follow their slide. A list box reads as its bullets or numbers show.
import { chartTable } from './sheetchart.js';
import { slideListLines } from './liststyle.js';

const words = (it) => {
  // (a list box: each line with its bullet or number, points under others indented, as the slide shows it)
  if (it.type === 'text' && it.list) return slideListLines(String(it.text || '').replace(/\r/g, ''), it.list).filter((l) => l.text.trim()).map((l) => `${'  '.repeat(l.level)}${l.marker} ${l.text.trim()}`).join('\n');
  if (it.type === 'text' || (it.type === 'shape' && it.text)) return String(it.text || '').replace(/\r/g, '').trim();
  if (it.type === 'table') return (it.cells || []).map((r) => r.map((c) => String(c ?? '').replace(/\s*\n+\s*/g, ' ')).join('\t')).join('\n');
  if (it.type === 'chart') { const { title, rows } = chartTable({ title: it.title, chartType: it.chartType, data: it.data }); return [title, ...rows.map((r) => r.join('\t'))].filter(Boolean).join('\n'); }
  if (it.type === 'image') return it.alt ? `[${it.alt}]` : '';
  if (it.type === 'video' || it.type === 'audio') return it.name ? `[${it.name}]` : '';
  return '';
};

export function textFromDeck(deck) {
  const slides = deck?.slides || [];
  return slides.map((s, i) => {
    const items = (s.items || []).filter((it) => words(it));
    const title = items.find((it) => it.type === 'text' && it.role === 'title');
    const rest = items.filter((it) => it !== title).sort((a, b) => (Math.abs((a.y || 0) - (b.y || 0)) > 2 ? (a.y || 0) - (b.y || 0) : (a.x || 0) - (b.x || 0)));
    const head = `Slide ${i + 1}${title ? `: ${words(title).replace(/\n+/g, ' ')}` : ''}${s.skip ? ' (skipped)' : ''}`;
    const notes = String(s.notes || '').trim();
    return [head, ...rest.map(words), ...(notes ? [`Notes: ${notes}`] : [])].join('\n\n');
  }).join('\n\n\n') + '\n';
}
