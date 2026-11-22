import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, onLive } from '../api.js';
import Icon from './Icon.jsx';
import { Menu, useToast } from './ui.jsx';
import { addToTasksWithToast } from '../apps/tasks/addtask.js';

/**
 * Open tasks about something (`url`: the path tasks made with Add to Tasks link back to), on any list you can see:
 * a count that lists them, each opening in Tasks. Nothing when there are none. `bump` changes to count again.
 */
export default function TasksAbout({ url, what = 'file', bump = 0, className = 'btn small' }) {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState([]);
  useEffect(() => {
    let gone = false;
    const load = () => get(`/tasks/about?url=${encodeURIComponent(url)}`).then((r) => { if (!gone) setTasks(Array.isArray(r) ? r : []); }).catch(() => {});
    load();
    // Kept up to date: a task ticked off or added elsewhere (by you or someone on a shared list) changes the count here.
    const off = onLive((m) => { if (m.type === 'tasks-changed') load(); });
    return () => { gone = true; off(); };
  }, [url, bump]);
  if (!tasks.length) return null;
  const label = `${tasks.length === 1 ? '1 task' : `${tasks.length} tasks`} to do about this ${what}`; // (not “open”: buttons named Open sit nearby)
  return <Menu trigger={(p) => <button type="button" className={className} aria-label={label} title={label} {...p}><Icon name="check" size={16} /> {tasks.length}</button>}
    items={tasks.map((t) => ({ label: `${t.title}${t.due ? ` · due ${t.due}` : ''}`, icon: 'check', onClick: () => navigate(`/tasks/${t.list_id}?task=${t.id}`) }))} />;
}

/** The ✓ icon button that adds `item` ({ title, link: { url, label } }) to Tasks, with the open tasks already about it beside it. */
export function AddToTasksButton({ item, what }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [bump, setBump] = useState(0);
  return <>
    <button type="button" className="icon-btn" aria-label="Add to Tasks" title="Add to Tasks" onClick={() => addToTasksWithToast(toast, navigate, item).then(() => setBump((n) => n + 1))}><Icon name="check" /></button>
    <TasksAbout url={item.link.url} what={what} bump={bump} />
  </>;
}
