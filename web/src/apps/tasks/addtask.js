// "Add to Tasks" from Mail and Chat: a task on the list you chose for it (your first list, My tasks, unless you say otherwise), linking back to where it came from.
import { get, post } from '../../api.js';
import { parseQuickEvent } from '../calendar/quickevent.js';

/** The task's title from a chat message: its first line, without markup, at most 200 characters. */
export function titleFromText(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const plain = line.replace(/[*_~`]+/g, '').replace(/^>\s*/, '').replace(/\s+/g, ' ').trim();
  return plain.length > 200 ? `${plain.slice(0, 199)}…` : plain;
}

/**
 * "Create event" on a chat message: a new event named after its first line, an hour from the next half hour, with
 * what it says, who wrote it and a link back in the description; when its first line names a day or a time, then.
 * `now` is a timestamp.
 */
export function eventFromMessage(m, link = '', now = Date.now()) {
  const start = Math.ceil(now / 18e5) * 18e5;
  const said = String(m.body || '').trim().slice(0, 4000);
  const description = [said, [m.user_name && `From ${m.user_name} in Chat`, link].filter(Boolean).join(': ')].filter(Boolean).join('\n\n');
  // A day or time in its first line ("Demo thursday 3pm", "lunch tomorrow") sets when, as Calendar's quick add reads it.
  const first = titleFromText(m.body), d = new Date(now), pad = (n) => String(n).padStart(2, '0');
  const q = first ? parseQuickEvent(first, { today: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }) : null;
  if (q) return { title: q.title || first, start: q.start, end: q.end, all_day: q.all_day, location: '', description };
  return { title: first, start, end: start + 36e5, all_day: 0, location: '', description };
}

/** Where an email's task links to: by Message-ID when it has one (so it's found after it's moved). */
export function mailLink(m) {
  return m.messageId ? `/mail?open=${encodeURIComponent(m.messageId)}` : `/mail/${encodeURIComponent(m.folder)}/${m.uid}`;
}

export async function addToTasks({ title, notes, link, ...more }) {
  const { lists } = await get('/tasks/lists');
  const list = lists.find((l) => l.inbox) || lists.find((l) => l.mine) || lists[0]; // (the list chosen with “Use for Add to Tasks”, or your first)
  // more: what quick add read (due, due_time, repeat, important, priority, tags), when it came from there
  const task = await post(`/tasks/lists/${list.id}/tasks`, { title: title || 'Untitled', notes: notes || null, ...(link && { link }), ...more });
  return { task, list };
}

/** Add it and say so, with a button to open it in Tasks. */
export async function addToTasksWithToast(toast, navigate, item) {
  try {
    const { task, list } = await addToTasks(item);
    toast(`Added to ${list.name}`, 'info', { action: { label: 'Open', onClick: () => navigate(`/tasks/${list.id}?task=${task.id}`) } });
  } catch (e) { toast(e.message, 'error'); }
}
