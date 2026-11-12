// Google Tasks, as Google Takeout exports it (Tasks/Tasks.json): { kind: 'tasks#taskLists', items: [ { title,
// items: [ { id, title, notes, status: 'needsAction' | 'completed', due, completed, parent, position, deleted } ] } ] }.
// Subtasks (a parent) become steps of their task; deleted ones are left out.

const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const when = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

/** The lists in a Google Tasks export: [{ name, tasks: [{ title, notes, due, done_at, steps: [{ title, done }] }] }], or { error }. */
export function listsFromGoogleTasks(data) {
  const lists = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : null;
  if (!lists || !lists.every((l) => l && typeof l === 'object')) return { error: 'That isn’t a Google Tasks export (Tasks.json from Google Takeout)' };
  const out = [];
  for (const l of lists) {
    const all = (Array.isArray(l.items) ? l.items : []).filter((t) => t && !t.deleted && String(t.title ?? '').trim());
    const byPos = (a, b) => String(a.position ?? '').localeCompare(String(b.position ?? ''));
    const ids = new Set(all.map((t) => t.id));
    const tops = all.filter((t) => !t.parent || !ids.has(t.parent)).sort(byPos);
    out.push({
      name: String(l.title ?? '').trim().slice(0, 100) || 'Imported tasks',
      tasks: tops.map((t) => ({
        title: String(t.title).trim().slice(0, 500),
        notes: String(t.notes ?? '').slice(0, 10000) || null,
        due: day(t.due),
        done_at: t.status === 'completed' ? when(t.completed) || when(t.updated) || Date.now() : null,
        steps: all.filter((s) => s.parent === t.id).sort(byPos).map((s) => ({ title: String(s.title).trim().slice(0, 500), done: s.status === 'completed' })),
      })),
    });
  }
  return { lists: out };
}
