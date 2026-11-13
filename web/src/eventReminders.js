// Calendar reminders while Workspace is open: a toast, and a desktop notification when those are on
// and the tab is in the background. Each reminder is shown once, even with several tabs open.
import { useEffect } from 'react';
import { isPaused } from './pause.js';
import { get, post, onLive } from './api.js';
import { expandAll } from './apps/calendar/calmath.js';
import { desktopOn } from './mailNotify.js';

const HORIZON = 26 * 36e5; // reminders worked out a day ahead, again every few minutes and on changes
const LATE = 5 * 6e4; // a reminder missed by up to five minutes (the computer was asleep) still shows

/** The reminders due between now (less a few minutes) and `horizon` ahead: [{ key, at, ev, minutes }]. */
export function dueReminders(occurrences, now, horizon = HORIZON) {
  const out = [];
  for (const ev of occurrences) {
    if (ev.role === 'guest' && ev.my_status === 'no') continue; // declined
    for (const m of ev.reminders || []) {
      const at = ev.start - m * 6e4;
      if (at >= now - LATE && at <= now + horizon && ev.end >= now) out.push({ key: `${ev.id}@${ev.start}:${m}`, at, ev, minutes: m });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** "in 10 minutes", "in 1 hour", "tomorrow at 9:00", "now". */
export function startsIn(ev, now = Date.now()) {
  const mins = Math.round((ev.start - now) / 6e4);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`;
  if (mins < 24 * 60 && mins % 60 === 0) return `in ${mins / 60} hour${mins === 60 ? '' : 's'}`;
  const time = new Date(ev.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (mins < 24 * 60) return `at ${time}`;
  return `${new Date(ev.start).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}${ev.all_day ? '' : ` at ${time}`}`;
}

/**
 * Only one tab shows each reminder. Tabs fire at the same moment, so a lock decides (the first
 * tab holds it for a while); what was shown is also remembered for tabs that open later.
 */
export function claim(key) {
  if (!navigator.locks) return Promise.resolve(remembers(key));
  return new Promise((decide) => {
    navigator.locks.request(`nw-reminder:${key}`, { ifAvailable: true }, async (lock) => {
      if (!lock) { decide(false); return; } // another tab has it
      decide(remembers(key));
      await new Promise((r) => setTimeout(r, 15000)); // held while the other tabs' timers go off
    }).catch(() => decide(remembers(key)));
  });
}
function remembers(key) {
  try {
    const k = `nw:reminded:${key}`;
    if (localStorage.getItem(k)) return false;
    localStorage.setItem(k, String(Date.now()));
    // Forget ones older than a week.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const name = localStorage.key(i);
      if (name?.startsWith('nw:reminded:') && Date.now() - Number(localStorage.getItem(name)) > 7 * 864e5) localStorage.removeItem(name);
    }
  } catch { /* storage blocked: every tab shows it */ }
  return true;
}

export function useEventReminders(enabled, { toast, openCalendar }) {
  useEffect(() => {
    if (!enabled) return undefined;
    let timers = [];
    let stopped = false;
    const fire = async ({ key, ev }) => {
      if (stopped || isPaused() || !(await claim(key)) || stopped) return;
      const when = startsIn(ev);
      // Join (with a video meeting), and on an event with others: say you're running late, there and then.
      const late = (n) => ({ label: `${n} min late`, onClick: () => post(`/events/${ev.id}/late`, { minutes: n, at: ev.start }).then(() => toast(`Everyone on “${ev.title}” knows you’re running ${n} minutes late`)).catch((e) => toast(e.message, 'error')) });
      const others = (ev.guests?.length || 0) > 0 || ev.my_status != null; // guests on yours, or you're a guest
      const actions = [...(ev.meet_code ? [{ label: 'Join', onClick: () => window.open(`/meet/${ev.meet_code}`, '_blank', 'noopener') }] : []), ...(others && !ev.all_day && ev.my_status !== 'no' ? [late(5), late(10)] : [])];
      toast(`${ev.title} ${when === 'now' ? 'is starting now' : `starts ${when}`}${ev.location ? ` · ${ev.location}` : ''}`, 'info', actions.length ? { actions, duration: 20000 } : undefined);
      if (desktopOn() && document.hidden) {
        const body = `${when === 'now' ? 'Starting now' : `Starts ${when}`}${ev.location ? ` · ${ev.location}` : ''}`;
        // With the service worker, the notification has buttons too: Join, and running late (handled there).
        const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => null);
        if (reg?.active && reg.showNotification) {
          const buttons = [...(ev.meet_code ? [{ action: 'join', title: 'Join' }] : []), ...(others && !ev.all_day && ev.my_status !== 'no' ? [{ action: 'late5', title: '5 min late' }, { action: 'late10', title: '10 min late' }] : [])];
          try {
            await reg.showNotification(ev.title, { body, tag: `reminder-${key}`, icon: '/icons/icon-192.png', actions: buttons.slice(0, 2),
              data: { link: ev.meet_code ? `/meet/${ev.meet_code}` : '/calendar', join: ev.meet_code ? `/meet/${ev.meet_code}` : null, late: { id: ev.id, at: ev.start, title: ev.title } } });
            return;
          } catch { /* fall back to a plain one */ }
        }
        try {
          const n = new Notification(ev.title, { body, tag: `reminder-${key}`, icon: '/favicon.svg' });
          n.onclick = () => { window.focus(); if (ev.meet_code) window.open(`/meet/${ev.meet_code}`, '_blank', 'noopener'); else openCalendar(); n.close(); };
        } catch { /* some browsers only allow notifications from a service worker */ }
      }
    };
    const schedule = async () => {
      const now = Date.now();
      let list;
      try { list = await get(`/events?from=${now - 864e5}&to=${now + HORIZON + 864e5}`); } catch { return; }
      if (stopped) return;
      timers.forEach(clearTimeout);
      timers = dueReminders(expandAll(list, now - 864e5, now + HORIZON + 864e5), Date.now()).map((d) => setTimeout(() => fire(d), Math.max(0, d.at - Date.now())));
    };
    schedule();
    const every = setInterval(schedule, 5 * 6e4);
    const off = onLive((m) => { if (m.type === 'events-changed' || m.type === 'live-connected') schedule(); });
    const wake = () => { if (!document.hidden) schedule(); }; // timers stop while a laptop sleeps
    document.addEventListener('visibilitychange', wake);
    return () => { stopped = true; timers.forEach(clearTimeout); clearInterval(every); off(); document.removeEventListener('visibilitychange', wake); };
  }, [enabled, toast, openCalendar]);
}
