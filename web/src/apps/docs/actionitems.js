// Action items (Docs): unticked checklist items that @mention someone. Each becomes a task for each
// person mentioned, titled with the item's words (without the mentions); a date or time in it
// ("by Friday", "tomorrow 3pm") becomes the task's due date, as in Tasks' quick add.
import { parseQuickAdd } from '../tasks/quickadd.js';

/** The item's own text and mentions (not those of items nested inside it). */
function itemParts(item) {
  let text = '';
  const people = [];
  const walk = (n) => {
    if (n.type === 'taskList' || n.type === 'bulletList' || n.type === 'orderedList') return; // nested lists are items of their own
    if (n.type === 'text') text += n.text || '';
    else if (n.type === 'mention') { text += `@${n.attrs?.name || ''}`; if (n.attrs?.id) people.push({ id: n.attrs.id, name: n.attrs.name }); }
    else if (n.type === 'hardBreak') text += ' ';
    for (const c of n.content || []) walk(c);
    if (n.type === 'paragraph') text += ' ';
  };
  for (const c of item.content || []) walk(c);
  return { text: text.replace(/\s+/g, ' ').trim(), people };
}

/** [{ text, title, due, due_time, user_id, name }] for every unticked item with a mention. */
export function actionItems(doc, today) {
  const out = [];
  const visit = (n) => {
    if (n.type === 'taskItem' && !n.attrs?.checked) {
      const { text, people } = itemParts(n);
      const seen = new Set();
      for (const p of people) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        // "@Kim and @Lee", "@Kim, @Lee" go as a whole; "for" or "with" left hanging at the end goes too.
        const one = `(?:${people.map((x) => `@${x.name}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
        const plain = text.replace(new RegExp(`${one}(?:\\s*(?:,|and|&)\\s*${one})*`, 'g'), ' ').replace(/\s+/g, ' ').trim();
        const q = parseQuickAdd(plain, { today });
        const title = q.title.replace(/^[,:;–-]\s*/, '').replace(/\s+(?:for|with|to|and|by)$/i, '').trim();
        if (title) out.push({ text, title, due: q.due, due_time: q.due_time, user_id: p.id, name: p.name });
      }
    }
    for (const c of n.content || []) visit(c);
  };
  visit(doc || {});
  return out;
}
