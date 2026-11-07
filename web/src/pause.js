// "Pause notifications" (do not disturb): until a time, no pop-up notes or desktop notifications
// for new mail, mentions, reminders or tasks. Everything still lands in the bell and the apps.
import { useEffect, useState } from 'react';
import { get, put, onLive } from './api.js';

let until = null;
const listeners = new Set();
const set = (v) => { until = v && v > Date.now() ? v : null; listeners.forEach((f) => f(until)); };

export const isPaused = (now = Date.now()) => !!until && until > now;
export const pausedUntil = () => (isPaused() ? until : null);
export async function loadPause() { try { set((await get('/users/me/pause')).paused_until); } catch { /* signed out */ } }
export async function pauseUntil(at) { set((await put('/users/me/pause', { until: at })).paused_until); }

/** Choices for the menu: [label, until]. */
export function pauseChoices(now = new Date()) {
  const t = now.getTime();
  const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9);
  return [['For 30 minutes', t + 30 * 60e3], ['For 1 hour', t + 36e5], ['For 2 hours', t + 2 * 36e5], ['Until tomorrow, 9:00', morning.getTime()]];
}

/** The pause, kept up to date (other tabs, and when it runs out). */
export function usePause(userId) {
  const [v, setV] = useState(pausedUntil());
  useEffect(() => {
    const f = (x) => setV(x);
    listeners.add(f);
    loadPause();
    const off = onLive((m) => { if (m.type === 'status-changed' && m.user_id === userId) loadPause(); });
    const tick = setInterval(() => { if (until && until <= Date.now()) set(null); }, 30e3);
    return () => { listeners.delete(f); off(); clearInterval(tick); };
  }, [userId]);
  return v;
}
