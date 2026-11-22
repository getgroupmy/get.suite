import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get } from '../api.js';
import Icon from './Icon.jsx';
import { Menu } from './ui.jsx';

/**
 * Open tasks about something (`url`: the path tasks made with Add to Tasks link back to), on any list you can see:
 * a count that lists them, each opening in Tasks. Nothing when there are none. `bump` changes to count again.
 */
export default function TasksAbout({ url, what = 'file', bump = 0, className = 'btn small' }) {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState([]);
  useEffect(() => {
    let gone = false;
    get(`/tasks/about?url=${encodeURIComponent(url)}`).then((r) => { if (!gone) setTasks(Array.isArray(r) ? r : []); }).catch(() => {});
    return () => { gone = true; };
  }, [url, bump]);
  if (!tasks.length) return null;
  const label = `${tasks.length === 1 ? '1 open task' : `${tasks.length} open tasks`} about this ${what}`;
  return <Menu trigger={(p) => <button type="button" className={className} aria-label={label} title={label} {...p}><Icon name="check" size={16} /> {tasks.length}</button>}
    items={tasks.map((t) => ({ label: `${t.title}${t.due ? ` · due ${t.due}` : ''}`, icon: 'check', onClick: () => navigate(`/tasks/${t.list_id}?task=${t.id}`) }))} />;
}
