// Task reminders while Workspace is open: each morning (from 9:00, or when Workspace is first opened
// after that) a note of the tasks due today and overdue; and a note when someone gives you a task.
// Shown in one tab only, with a desktop notification too when those are on and the tab is hidden.
import { useEffect } from 'react';
import { get, onLive } from './api.js';
import { desktopOn } from './mailNotify.js';
import { claim } from './eventReminders.js';
import { dueAt } from './apps/tasks/taskmath.js';
import { isPaused } from './pause.js';

export const MORNING_HOUR = 9;
const pad = (n) => String(n).padStart(2, '0');
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The morning note for open tasks (with `due` dates), or null when nothing is due. */
export function morningSummary(tasks, now = new Date()) {
  const today = isoDay(now);
  const dueToday = tasks.filter((t) => !t.done && t.due === today);
  const overdue = tasks.filter((t) => !t.done && t.due && t.due < today);
  if (!dueToday.length && !overdue.length) return null;
  const parts = [];
  if (dueToday.length) parts.push(dueToday.length === 1 ? `“${dueToday[0].title}” is due today` : `${dueToday.length} tasks are due today`);
  if (overdue.length) parts.push(`${overdue.length} ${overdue.length === 1 ? 'is' : 'are'} overdue`);
  return { text: parts.join(', and '), dueToday: dueToday.length, overdue: overdue.length };
}

/** Open tasks with a due time still to come in the next day: [{ task, at }], soonest first. */
export function comingTimed(tasks, now = Date.now()) {
  return tasks.filter((t) => !t.done && t.due && t.due_time).map((t) => ({ task: t, at: dueAt(t.due, t.due_time) }))
    .filter((x) => x.at > now && x.at - now <= 864e5).sort((a, b) => a.at - b.at);
}

/** Milliseconds until the next morning note (0: it's time now). */
export function untilMorning(now = new Date()) {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), MORNING_HOUR);
  return now >= at ? 0 : at - now;
}

function desktop(title, body, onClick, tag) {
  if (!desktopOn() || !document.hidden) return;
  try { const n = new Notification(title, { body, tag, icon: '/favicon.svg' }); n.onclick = () => { window.focus(); onClick(); n.close(); }; } catch { /* only allowed from a service worker */ }
}

export function useTaskReminders({ toast, navigate }) {
  useEffect(() => {
    let stopped = false, timer = null;
    const morning = async () => {
      const today = isoDay(new Date());
      let tasks;
      try { tasks = await get(`/tasks/due?from=2000-01-01&to=${today}`); } catch { return; }
      const note = morningSummary(tasks);
      if (stopped || !note || isPaused() || !(await claim(`tasks:${today}`)) || stopped) return;
      // Given to you: they're all under Assigned to me; otherwise the list your own due task is on.
      const due = tasks.filter((t) => t.due <= today);
      const open = () => navigate(due.some((t) => t.assignee_id) ? '/tasks/assigned' : `/tasks/${due[0].list_id}`);
      toast(note.text, 'info', { action: { label: 'Open Tasks', onClick: open }, duration: 15000 });
      desktop('Tasks', note.text, open, `tasks-${today}`);
    };
    const plan = () => {
      clearTimeout(timer);
      const wait = untilMorning();
      if (wait === 0) morning();
      // Then again tomorrow morning (or this morning, if it's not 9 yet).
      const next = wait || new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1, MORNING_HOUR) - Date.now();
      timer = setTimeout(plan, next + 1000);
    };
    plan();
    // Tasks with a due time: a note at that time.
    let timed = [];
    const planTimed = async () => {
      const now = new Date(), tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      let tasks;
      try { tasks = await get(`/tasks/due?from=${isoDay(now)}&to=${isoDay(tomorrow)}`); } catch { return; }
      if (stopped) return;
      timed.forEach(clearTimeout);
      timed = comingTimed(tasks).map(({ task: t, at }) => setTimeout(() => {
        claim(`task-due:${t.id}:${t.due}T${t.due_time}`).then((mine) => {
          if (!mine || stopped || isPaused()) return;
          const open = () => navigate(`/tasks/${t.list_id}?task=${t.id}`);
          const text = `“${t.title}” is due now (${t.due_time})`;
          toast(text, 'info', { action: { label: 'Open', onClick: open }, duration: 15000 });
          desktop('Task due', text, open, `task-due-${t.id}`);
        });
      }, at - Date.now()));
    };
    planTimed();
    const hourly = setInterval(planTimed, 36e5);
    const offChanged = onLive((m) => { if (m.type === 'tasks-changed') planTimed(); });
    const wake = () => { if (!document.hidden) { plan(); planTimed(); } }; // timers stop while a laptop sleeps
    document.addEventListener('visibilitychange', wake);
    const off = onLive((m) => {
      if (m.type !== 'task-assigned' || !m.task) return;
      const open = () => navigate(`/tasks/${m.task.list_id}?task=${m.task.id}`);
      claim(`task-assigned:${m.task.id}:${m.at}`).then((mine) => {
        if (!mine || stopped || isPaused()) return;
        const text = `${m.from} gave you “${m.task.title}”${m.task.list_name ? ` on ${m.task.list_name}` : ''}`;
        toast(text, 'info', { action: { label: 'Open', onClick: open } });
        desktop('New task', text, open, `task-${m.task.id}`);
      });
    });
    return () => { stopped = true; clearTimeout(timer); timed.forEach(clearTimeout); clearInterval(hourly); off(); offChanged(); document.removeEventListener('visibilitychange', wake); };
  }, [toast, navigate]);
}
