// "Add to Tasks" from Mail and Chat: a task on your own first list (My tasks), linking back to where it came from.
import { get, post } from '../../api.js';

/** The task's title from a chat message: its first line, without markup, at most 200 characters. */
export function titleFromText(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const plain = line.replace(/[*_~`]+/g, '').replace(/^>\s*/, '').replace(/\s+/g, ' ').trim();
  return plain.length > 200 ? `${plain.slice(0, 199)}…` : plain;
}

/** Where an email's task links to: by Message-ID when it has one (so it's found after it's moved). */
export function mailLink(m) {
  return m.messageId ? `/mail?open=${encodeURIComponent(m.messageId)}` : `/mail/${encodeURIComponent(m.folder)}/${m.uid}`;
}

export async function addToTasks({ title, notes, link }) {
  const { lists } = await get('/tasks/lists');
  const list = lists.find((l) => l.mine) || lists[0];
  const task = await post(`/tasks/lists/${list.id}/tasks`, { title: title || 'Untitled', notes: notes || null, link });
  return { task, list };
}

/** Add it and say so, with a button to open it in Tasks. */
export async function addToTasksWithToast(toast, navigate, item) {
  try {
    const { task, list } = await addToTasks(item);
    toast(`Added to ${list.name}`, 'info', { action: { label: 'Open', onClick: () => navigate(`/tasks/${list.id}?task=${task.id}`) } });
  } catch (e) { toast(e.message, 'error'); }
}
