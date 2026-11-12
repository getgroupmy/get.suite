// A Trello board, as Trello exports it (Board menu → Print, export and share → Export as JSON): { name, lists: [{ id,
// name, closed, pos }], cards: [{ name, desc, idList, closed, pos, due, dueComplete, idChecklists, labels: [{ name, color }] }],
// checklists: [{ id, name, checkItems: [{ name, state: 'complete' | 'incomplete', pos }] }] }.
// Read as one task list: Trello's lists are its sections, cards its tasks, checklist items their steps, labels their tags.

/** { name, sections: [{ name, tasks: [{ title, notes, due, done, steps: [{ title, done }], tags }] }] }, or { error }. */
export function boardFromTrello(b) {
  if (!b || typeof b !== 'object' || !Array.isArray(b.lists) || !Array.isArray(b.cards)) return { error: 'That isn’t a Trello board export (its JSON)' };
  const byPos = (x, y) => (Number(x.pos) || 0) - (Number(y.pos) || 0);
  const checklists = new Map((Array.isArray(b.checklists) ? b.checklists : []).map((c) => [c.id, c]));
  const sections = b.lists.filter((l) => l && !l.closed).sort(byPos).map((l) => ({
    name: String(l.name ?? '').trim().slice(0, 100) || 'Untitled',
    tasks: b.cards.filter((c) => c && !c.closed && c.idList === l.id && String(c.name ?? '').trim()).sort(byPos).map((c) => ({
      title: String(c.name).trim().slice(0, 500),
      notes: String(c.desc ?? '').slice(0, 10000) || null,
      due: typeof c.due === 'string' && /^\d{4}-\d{2}-\d{2}/.test(c.due) ? c.due.slice(0, 10) : null,
      done: !!c.dueComplete,
      steps: (Array.isArray(c.idChecklists) ? c.idChecklists : []).map((id) => checklists.get(id)).filter(Boolean)
        .flatMap((cl) => [...(cl.checkItems || [])].sort(byPos).map((i) => ({ title: String(i.name ?? '').trim().slice(0, 500), done: i.state === 'complete' })))
        .filter((s) => s.title).slice(0, 100),
      tags: [...new Set((Array.isArray(c.labels) ? c.labels : []).map((l) => String(l?.name || l?.color || '').trim().toLowerCase()).filter(Boolean))].slice(0, 10),
    })),
  }));
  return { name: String(b.name ?? '').trim().slice(0, 100) || 'Trello board', sections };
}
